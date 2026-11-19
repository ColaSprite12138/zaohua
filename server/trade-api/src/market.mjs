// 交易市场：订单簿（同质商品撮合）+ 寄售（唯一实例装备）。
//
// 两条市场为什么必须分开：
//   订单簿的撮合数学依赖「同质化」—— 买家挂「我要 3001，出 80」时，系统要能拿
//   任意一份 3001 交割。收藏品/材料满足这一点。但装备有词条（`affix.ts`：词条只属于
//   物品实例，同一把 10003 属性可以不同）和耐久，两把同名装备并非同一商品，
//   按价格撮合交割必然错配。所以装备走 listings：固定价、成交即转移那个特定实例。
//
// 所有成交都在**单个事务**里完成（扣钱 → 转账 → 开 claim → 改单状态 → 记流水），
// 中途失败整笔回滚，不会出现「钱扣了货没给」。

import crypto from 'node:crypto'
import { applyDeltaNoTx, balanceOf, get, tx } from './db.mjs'
import { HttpError } from './errors.mjs'

export const FEE_BP = 500 // 5%，万分比

export const limits = {
  maxPrice: 1_000_000,
  maxQty: 999,
  maxOpenOrders: 20,   // 每人同时挂着的买单+卖单总数
  maxOpenListings: 20,
  maxSnapshotBytes: 2048
}

const ITEM_ID_RE = /^[A-Za-z0-9_:.-]{1,40}$/

function checkItemId (itemId) {
  const s = String(itemId || '').trim()
  if (!ITEM_ID_RE.test(s)) throw new HttpError(400, 'bad_item_id', 'itemId 格式不合法')
  return s
}

function checkPrice (p) {
  const n = Number(p)
  if (!Number.isInteger(n) || n <= 0 || n > limits.maxPrice) {
    throw new HttpError(400, 'bad_price', `单价必须是 1–${limits.maxPrice} 的整数`)
  }
  return n
}

function checkQty (q) {
  const n = Number(q)
  if (!Number.isInteger(n) || n <= 0 || n > limits.maxQty) {
    throw new HttpError(400, 'bad_qty', `数量必须是 1–${limits.maxQty} 的整数`)
  }
  return n
}

function countOpenOrders (d, userId) {
  return d.prepare("SELECT COUNT(*) c FROM book_orders WHERE user_id = ? AND status = 'open'").get(userId).c
}

function requireBalance (d, userId, need) {
  const row = d.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(userId)
  const bal = row ? Number(row.balance) : 0
  if (bal < need) throw new HttpError(400, 'insufficient_balance', `余额不足：需要 ${need}，当前 ${bal}`)
}

function statusOf (qty, filled) {
  return filled >= qty ? 'filled' : (filled > 0 ? 'partial' : 'open')
}

// 成交一笔（事务内的原子片段）
function settle (d, ctx) {
  const { itemId, take, takePrice, buyerId, buyerPrice, sellerId, buyOrderId, sellOrderId, listingId, snapshot, market } = ctx
  const gross = takePrice * take
  const fee = Math.floor(gross * FEE_BP / 10000)

  const info = d
    .prepare(`INSERT INTO trades (market, item_id, qty, price, gross, fee, buyer_id, seller_id, buy_order, sell_order, listing_id, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(market, itemId, take, takePrice, gross, fee, buyerId, sellerId, buyOrderId, sellOrderId, listingId, Date.now())
  const tradeId = Number(info.lastInsertRowid)

  // 卖家净得（物品已在下单时托管，这里只加钱）
  applyDeltaNoTx(d, sellerId, gross - fee, 'trade_sell', 't' + tradeId)

  // 买家在下单时按「自己的出价」锁了钱，实际按 maker 价成交，差额退回
  const refund = (buyerPrice - takePrice) * take
  if (refund > 0) applyDeltaNoTx(d, buyerId, refund, 'order_refund', 't' + tradeId)

  // 交割：进待领取队列，客户端本地入包
  d.prepare('INSERT INTO claims (user_id, item_id, qty, snapshot, source, trade_id, claimed, created_at) VALUES (?,?,?,?,\'trade\',?,0,?)')
    .run(buyerId, itemId, take, snapshot || null, tradeId, Date.now())

  // 注意：这里**不再给买家记一条 ledger**。买家真正的余额变化发生在「下买单锁钱」时
  // （一次 -need），成交只消耗锁定额度、并把差价退回去。若这里再记 -gross，
  // sum(ledger.delta) 就和 balance 对不上，对账会假报警。
  // 成交金额已经在 trades 表里（gross / fee / buyer_id），审计查那张表。

  return { tradeId, gross, fee, refund, takePrice }
}

// 撮合：taker 订单吃对手方挂单。价格优先、时间优先。
function match (d, taker) {
  const isBuy = taker.side === 'buy'
  const fills = []
  let remain = taker.qty

  // 同一份订单可能在循环里多次被吃，每次重新读最新的 filled
  while (remain > 0) {
    const row = isBuy
      ? d.prepare(`SELECT * FROM book_orders
                   WHERE item_id = ? AND side = 'sell' AND status IN ('open','partial')
                     AND filled < qty AND price <= ? AND user_id <> ? AND id <> ?
                   ORDER BY price ASC, id ASC LIMIT 1`).get(taker.itemId, taker.price, taker.userId, taker.id)
      : d.prepare(`SELECT * FROM book_orders
                   WHERE item_id = ? AND side = 'buy' AND status IN ('open','partial')
                     AND filled < qty AND price >= ? AND user_id <> ? AND id <> ?
                   ORDER BY price DESC, id DESC LIMIT 1`).get(taker.itemId, taker.price, taker.userId, taker.id)
    if (!row) break

    const makerQty = Number(row.qty)
    const makerFilled = Number(row.filled)
    const take = Math.min(remain, makerQty - makerFilled)
    if (take <= 0) break // SQL 的 filled < qty 已排除，纯防御，避免死循环

    const takePrice = Number(row.price) // maker 定价：taker 接受对手挂单价
    const buyerIsTaker = isBuy
    const buyerId = buyerIsTaker ? taker.userId : row.user_id
    const buyerPrice = buyerIsTaker ? Number(taker.price) : takePrice
    const sellerId = buyerIsTaker ? row.user_id : taker.userId

    const r = settle(d, {
      market: 'book',
      itemId: taker.itemId,
      take,
      takePrice,
      buyerId,
      buyerPrice,
      sellerId,
      buyOrderId: isBuy ? taker.id : row.id,
      sellOrderId: isBuy ? row.id : taker.id,
      listingId: null,
      snapshot: null
    })
    fills.push({ qty: take, price: takePrice, tradeId: r.tradeId, counterparty: row.user_id })

    // 更新 maker 订单
    const newFilled = makerFilled + take
    d.prepare('UPDATE book_orders SET filled = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(newFilled, statusOf(makerQty, newFilled), Date.now(), row.id)

    remain -= take
  }

  // 更新 taker 订单
  const takerFilled = Number(taker.filled) + (taker.qty - remain)
  d.prepare('UPDATE book_orders SET filled = ?, status = ?, updated_at = ? WHERE id = ?')
    .run(takerFilled, statusOf(taker.qty, takerFilled), Date.now(), taker.id)

  // 买单没成交完的额度继续锁着；卖单剩余部分就是继续挂着
  return { fills, filled: taker.qty - remain, remain }
}

// 统一成 camelCase，避免撮合逻辑里混用 snake_case 的列名
function loadOrder (d, orderId) {
  const row = d.prepare('SELECT * FROM book_orders WHERE id = ?').get(orderId)
  if (!row) throw new HttpError(404, 'no_such_order', '订单不存在')
  return {
    id: Number(row.id),
    userId: row.user_id,
    side: row.side,
    itemId: row.item_id,
    price: Number(row.price),
    qty: Number(row.qty),
    filled: Number(row.filled)
  }
}

// ---------------- 订单簿 ----------------

export function placeBuy (userId, itemId, price, qty) {
  const iid = checkItemId(itemId)
  const p = checkPrice(price)
  const q = checkQty(qty)

  return tx((d) => {
    if (countOpenOrders(d, userId) >= limits.maxOpenOrders) {
      throw new HttpError(429, 'too_many_open_orders', `最多同时挂 ${limits.maxOpenOrders} 个单`)
    }
    const need = p * q
    requireBalance(d, userId, need)

    const now = Date.now()
    const info = d.prepare(`INSERT INTO book_orders (user_id, side, item_id, price, qty, filled, status, created_at, updated_at)
                            VALUES (?, 'buy', ?, ?, ?, 0, 'open', ?, ?)`).run(userId, iid, p, q, now, now)
    const orderId = Number(info.lastInsertRowid)

    // 下单即锁全额资金，防止「挂了买单其实没钱」
    applyDeltaNoTx(d, userId, -need, 'order_lock', 'o' + orderId)

    const taker = loadOrder(d, orderId)
    const res = match(d, taker)
    return {
      orderId,
      locked: p * res.remain, // 只有未成交部分还锁着钱（成交的已按成交价结算并退了差价）
      matched: res.fills,
      filled: res.filled,
      remaining: res.remain,
      balance: balanceOf(userId)
    }
  })
}

export function placeSell (userId, itemId, price, qty) {
  const iid = checkItemId(itemId)
  const p = checkPrice(price)
  const q = checkQty(qty)

  return tx((d) => {
    if (countOpenOrders(d, userId) >= limits.maxOpenOrders) {
      throw new HttpError(429, 'too_many_open_orders', `最多同时挂 ${limits.maxOpenOrders} 个单`)
    }
    const now = Date.now()
    const info = d.prepare(`INSERT INTO book_orders (user_id, side, item_id, price, qty, filled, status, created_at, updated_at)
                            VALUES (?, 'sell', ?, ?, ?, 0, 'open', ?, ?)`).run(userId, iid, p, q, now, now)
    const orderId = Number(info.lastInsertRowid)

    // 卖单不扣物品（服务端没有背包），物品由客户端在下单时本地移除；
    // 撤单时用 claim 还回去，成交时用 claim 给买家 —— 一进一出闭环。
    const taker = loadOrder(d, orderId)
    const res = match(d, taker)
    return {
      orderId,
      matched: res.fills,
      filled: res.filled,
      remaining: res.remain,
      balance: balanceOf(userId)
    }
  })
}

export function cancelOrder (userId, orderId) {
  return tx((d) => {
    const o = d.prepare("SELECT * FROM book_orders WHERE id = ? AND user_id = ? AND status IN ('open','partial')").get(orderId, userId)
    if (!o) throw new HttpError(404, 'no_such_order', '没有这个可撤销的挂单')

    const remainQty = Number(o.qty) - Number(o.filled)
    if (remainQty <= 0) throw new HttpError(400, 'nothing_to_cancel', '该单已全部成交')

    if (o.side === 'buy') {
      // 退还剩余锁定的钱
      const refund = Number(o.price) * remainQty
      applyDeltaNoTx(d, userId, refund, 'order_cancel_refund', 'o' + o.id)
    } else {
      // 卖单托管中的物品还给卖家
      d.prepare("INSERT INTO claims (user_id, item_id, qty, snapshot, source, trade_id, claimed, created_at) VALUES (?,?,?,NULL,'sell_order_cancel',NULL,0,?)")
        .run(userId, o.item_id, remainQty, Date.now())
    }

    d.prepare("UPDATE book_orders SET status = 'cancelled', updated_at = ? WHERE id = ?").run(Date.now(), o.id)
    return { orderId: Number(o.id), cancelledQty: remainQty, refunded: o.side === 'buy' ? Number(o.price) * remainQty : 0, balance: balanceOf(userId) }
  })
}

// 盘口：按价格档位聚合，买盘降序、卖盘升序
export function bookOf (itemId) {
  const iid = checkItemId(itemId)
  const d = get()
  const rows = d.prepare(`SELECT side, price, SUM(qty - filled) AS qty, COUNT(*) AS orders
                          FROM book_orders
                          WHERE item_id = ? AND status IN ('open','partial') AND qty > filled
                          GROUP BY side, price`).all(iid)
  const bids = rows.filter((r) => r.side === 'buy').map((r) => ({ price: Number(r.price), qty: Number(r.qty), orders: Number(r.orders) })).sort((a, b) => b.price - a.price)
  const asks = rows.filter((r) => r.side === 'sell').map((r) => ({ price: Number(r.price), qty: Number(r.qty), orders: Number(r.orders) })).sort((a, b) => a.price - b.price)
  const trades = d.prepare('SELECT price, qty, created_at AS at FROM trades WHERE item_id = ? ORDER BY id DESC LIMIT 10').all(iid)
  return {
    itemId: iid,
    bids,
    asks,
    lastPrice: trades.length ? Number(trades[0].price) : null,
    recentTrades: trades.map((t) => ({ price: Number(t.price), qty: Number(t.qty), at: Number(t.at) }))
  }
}

export function myOrders (userId) {
  const d = get()
  const open = d.prepare("SELECT * FROM book_orders WHERE user_id = ? AND status IN ('open','partial') ORDER BY id DESC").all(userId)
    .map((o) => ({
      id: Number(o.id),
      side: o.side,
      itemId: o.item_id,
      price: Number(o.price),
      qty: Number(o.qty),
      filled: Number(o.filled),
      status: o.status,
      createdAt: Number(o.created_at)
    }))
  return open
}

// ---------------- 寄售（唯一实例） ----------------

export function placeListing (userId, itemId, price, snapshot) {
  const iid = checkItemId(itemId)
  const p = checkPrice(price)
  if (typeof snapshot !== 'string' && typeof snapshot !== 'object') {
    throw new HttpError(400, 'bad_snapshot', 'snapshot 必须是对象或 JSON 字符串')
  }
  const snap = typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot)
  const bytes = Buffer.byteLength(snap)
  if (bytes > limits.maxSnapshotBytes) {
    throw new HttpError(400, 'snapshot_too_large', `实例快照不能超过 ${limits.maxSnapshotBytes} 字节（当前 ${bytes}）`)
  }
  let parsed
  try { parsed = JSON.parse(snap) } catch { throw new HttpError(400, 'bad_snapshot', 'snapshot 不是合法 JSON') }
  if (!parsed || typeof parsed !== 'object') throw new HttpError(400, 'bad_snapshot', 'snapshot 必须是对象')

  // 指纹 = 实例内容哈希：同一件装备（词条/耐久完全一致）同时只能有一个在售
  const fingerprint = crypto.createHash('sha256').update(snap).digest('hex').slice(0, 32)

  return tx((d) => {
    const openCount = d.prepare("SELECT COUNT(*) c FROM listings WHERE user_id = ? AND status = 'open'").get(userId).c
    if (openCount >= limits.maxOpenListings) {
      throw new HttpError(429, 'too_many_listings', `最多同时寄售 ${limits.maxOpenListings} 件`)
    }
    const now = Date.now()
    try {
      const info = d.prepare(`INSERT INTO listings (user_id, item_id, price, snapshot, fingerprint, status, created_at)
                              VALUES (?,?,?,?,?,'open',?)`).run(userId, iid, p, snap, fingerprint, now)
      return { listingId: Number(info.lastInsertRowid), itemId: iid, price: p, fingerprint }
    } catch (e) {
      if (/UNIQUE constraint/i.test(e.message || '')) {
        throw new HttpError(409, 'duplicate_listing', '这件装备已经有一个在售挂单了（同一实例不能重复上架）')
      }
      throw e
    }
  })
}

export function buyListing (userId, listingId) {
  return tx((d) => {
    const l = d.prepare("SELECT * FROM listings WHERE id = ? AND status = 'open'").get(listingId)
    if (!l) throw new HttpError(404, 'no_such_listing', '该寄售不存在或已售出')
    if (l.user_id === userId) throw new HttpError(400, 'self_trade', '不能买自己的挂单')

    const price = Number(l.price)
    requireBalance(d, userId, price)

    const upd = d.prepare('UPDATE listings SET status = ?, buyer_id = ?, sold_at = ? WHERE id = ? AND status = ?')
      .run('sold', userId, Date.now(), listingId, 'open')
    if (Number(upd.changes) === 0) {
      throw new HttpError(409, 'listing_taken', '手慢了，这单已被别人买走')
    }

    // 买家付款
    applyDeltaNoTx(d, userId, -price, 'listing_buy', 'l' + listingId)

    const r = settle(d, {
      market: 'listing',
      itemId: l.item_id,
      take: 1,
      takePrice: price,
      buyerId: userId,
      buyerPrice: price,
      sellerId: l.user_id,
      buyOrderId: null,
      sellOrderId: null,
      listingId: Number(l.id),
      snapshot: l.snapshot
    })

    return { listingId: Number(l.id), itemId: l.item_id, price, fee: r.fee, tradeId: r.tradeId, balance: balanceOf(userId) }
  })
}

export function cancelListing (userId, listingId) {
  return tx((d) => {
    const l = d.prepare("SELECT * FROM listings WHERE id = ? AND user_id = ? AND status = 'open'").get(listingId, userId)
    if (!l) throw new HttpError(404, 'no_such_listing', '没有这个可撤销的寄售')
    d.prepare("UPDATE listings SET status = 'cancelled' WHERE id = ?").run(listingId)
    d.prepare("INSERT INTO claims (user_id, item_id, qty, snapshot, source, trade_id, claimed, created_at) VALUES (?,?,1,?,'listing_cancel',NULL,0,?)")
      .run(userId, l.item_id, l.snapshot, Date.now())
    return { listingId: Number(l.id), itemId: l.item_id }
  })
}

export function listListings ({ itemId = null, limit = 50 } = {}) {
  const d = get()
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 100)
  const rows = itemId
    ? d.prepare("SELECT * FROM listings WHERE status = 'open' AND item_id = ? ORDER BY price ASC, id ASC LIMIT ?").all(checkItemId(itemId), lim)
    : d.prepare("SELECT * FROM listings WHERE status = 'open' ORDER BY id DESC LIMIT ?").all(lim)
  return rows.map((l) => ({
    listingId: Number(l.id),
    itemId: l.item_id,
    price: Number(l.price),
    snapshot: safeJson(l.snapshot),
    seller: l.user_id.slice(0, 6) + '…',
    createdAt: Number(l.created_at)
  }))
}

function safeJson (s) {
  try { return JSON.parse(s) } catch { return null }
}

// ---------------- 交割 ----------------

export function myClaims (userId) {
  return get()
    .prepare('SELECT * FROM claims WHERE user_id = ? AND claimed = 0 ORDER BY id ASC LIMIT 100')
    .all(userId)
    .map((c) => ({
      claimId: Number(c.id),
      itemId: c.item_id,
      qty: Number(c.qty),
      snapshot: safeJson(c.snapshot),
      source: c.source,
      createdAt: Number(c.created_at)
    }))
}

export function claim (userId, claimId) {
  return tx((d) => {
    const c = d.prepare('SELECT * FROM claims WHERE id = ? AND user_id = ? AND claimed = 0').get(claimId, userId)
    if (!c) throw new HttpError(404, 'no_claim', '没有这个待领取记录（可能已经领过了）')
    d.prepare('UPDATE claims SET claimed = 1 WHERE id = ?').run(c.id)
    return { claimId: Number(c.id), itemId: c.item_id, qty: Number(c.qty), snapshot: safeJson(c.snapshot) }
  })
}
