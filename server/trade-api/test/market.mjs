// 撮合引擎测试：直接打 market API（内存库），重点验证
//   1. 价格优先 / 时间优先 / maker 定价 / 退差价
//   2. 部分成交与剩余锁定
//   3. 手续费从卖家扣、且不凭空生钱
//   4. **资金守恒**：sum(余额) + 未成交买单锁定 + 累计手续费 == 初始存入
//   5. 寄售的唯一实例语义（同一 fingerprint 不能重复上架）

import crypto from 'node:crypto'
import * as db from '../src/db.mjs'
import * as auth from '../src/auth.mjs'
import * as wallet from '../src/wallet.mjs'
import * as market from '../src/market.mjs'

let pass = 0
const fails = []
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓', name); return }
  fails.push(name)
  console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : '')
}

db.open(':memory:')

const D = () => db.get()
const bal = (u) => Number(D().prepare('SELECT balance FROM wallets WHERE user_id = ?').get(u)?.balance ?? 0)
const balSum = () => Number(D().prepare('SELECT COALESCE(SUM(balance),0) s FROM wallets').get().s)
const lockedSum = () => Number(D().prepare("SELECT COALESCE(SUM(price*(qty-filled)),0) s FROM book_orders WHERE side='buy' AND status IN ('open','partial')").get().s)
const feeSum = () => Number(D().prepare('SELECT COALESCE(SUM(fee),0) s FROM trades').get().s)
const claimsOf = (u) => D().prepare('SELECT * FROM claims WHERE user_id = ? AND claimed = 0').all(u)
let SEEDED = 0

function newUser (name, seed = 0) {
  const { publicKey } = crypto.generateKeyPairSync('ed25519')
  const r = auth.register({ pubkey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), display: name })
  if (seed) { db.applyDelta(r.userId, seed, 'test_seed'); SEEDED += seed }
  return r.userId
}
function expectErr (fn, code, name) {
  try { fn(); ok(false, name, '没有抛错') } catch (e) { ok(e.code === code, name, { got: e.code, msg: e.message }) }
}

// ================= T1 基本撮合 =================
console.log('\n[T1] 卖单挂出 → 买单吃 → maker 定价 + 退差价 + 抽佣')
const A = newUser('A', 1000)
const B = newUser('B', 1000)
{
  const s = market.placeSell(B, 'item:3001', 80, 2)
  ok(s.remaining === 2, 'B 挂卖 2 个 @80，全部挂单', s)

  const before = { a: bal(A), b: bal(B) }
  const r = market.placeBuy(A, 'item:3001', 100, 2)
  ok(r.filled === 2 && r.remaining === 0, 'A 买 2 个全部成交')
  ok(r.matched.length === 1 && r.matched[0].price === 80, '成交价是卖单价 80（maker 定价），不是 A 的出价 100', r.matched)

  ok(bal(A) === before.a - 160, `A 实付 160（不是 200）：${before.a} → ${bal(A)}`)
  ok(bal(B) === before.b + 152, `B 实收 152（160 扣 5% 佣金 8）：${before.b} → ${bal(B)}`)
  ok(feeSum() === 8, `累计手续费 8 = floor(160×5%)`, feeSum())

  const c = claimsOf(A)
  ok(c.length === 1 && Number(c[0].qty) === 2 && c[0].item_id === 'item:3001', 'A 拿到 2 个待领取', c)

  const book = market.bookOf('item:3001')
  ok(book.asks.length === 0 && book.bids.length === 0, '盘口清空')
  ok(book.lastPrice === 80, '最近成交价 80')
}

// ================= T2 部分成交 =================
console.log('\n[T2] 部分成交：买单量大，卖单不够')
{
  const C = newUser('C', 2000)
  market.placeSell(B, 'item:3002', 50, 3)
  const r = market.placeBuy(C, 'item:3002', 50, 5)
  ok(r.filled === 3 && r.remaining === 2, '成交 3，剩 2 挂着', { filled: r.filled, remaining: r.remaining })
  ok(r.locked === 100, '剩余 2 个仍锁定 100', r.locked)
  const book = market.bookOf('item:3002')
  ok(book.bids.length === 1 && book.bids[0].qty === 2, '买盘剩 2', book.bids)
}

// ================= T3 价格优先 =================
console.log('\n[T3] 价格优先：先吃便宜的卖单')
{
  const Dd = newUser('D', 1000)
  const E = newUser('E', 2000)
  market.placeSell(Dd, 'item:3003', 90, 1)   // 后挂但贵
  market.placeSell(Dd, 'item:3003', 70, 1)   // 便宜
  const r = market.placeBuy(E, 'item:3003', 100, 1)
  ok(r.matched[0].price === 70, '成交价 70（最低卖价）', r.matched)
  const book = market.bookOf('item:3003')
  ok(book.asks.length === 1 && book.asks[0].price === 90, '剩下的卖单是 90 那个', book.asks)
}

// ================= T4 时间优先 =================
console.log('\n[T4] 时间优先：同价先挂先成交')
{
  const F = newUser('F', 500)
  const G = newUser('G', 500)
  const H = newUser('H', 500)
  const o1 = market.placeSell(F, 'item:3004', 60, 1)
  const o2 = market.placeSell(G, 'item:3004', 60, 1)
  market.placeBuy(H, 'item:3004', 60, 1)
  const trades = D().prepare("SELECT seller_id FROM trades WHERE item_id='item:3004'").all()
  ok(trades.length === 1 && trades[0].seller_id === F, 'F（先挂）成交，G 仍挂着', { ordered: [o1.orderId, o2.orderId], seller: trades[0]?.seller_id })
  ok(bal(F) > 500 && bal(G) === 500, 'F 收钱、G 未动')
}

// ================= T5 禁止自成交 =================
console.log('\n[T5] 禁止自成交（防对敲刷量）')
{
  const I = newUser('I', 1000)
  market.placeSell(I, 'item:3005', 50, 1)
  const r = market.placeBuy(I, 'item:3005', 50, 1)
  ok(r.filled === 0, '自己的卖单不会被自己吃', r)
  const book = market.bookOf('item:3005')
  ok(book.bids.length === 1 && book.asks.length === 1, '买卖两边都还挂着')
}

// ================= T6 撤单 =================
console.log('\n[T6] 撤单：买单退钱、卖单退物品')
{
  const J = newUser('J', 1000)
  const buy = market.placeBuy(J, 'item:3006', 30, 4) // 无人卖，锁 120
  const afterBuy = bal(J)
  ok(afterBuy === 880, `下单后余额 880（锁 120）`, afterBuy)

  const c1 = market.cancelOrder(J, buy.orderId)
  ok(c1.refunded === 120 && bal(J) === 1000, '撤买单退 120，余额回到 1000', { refunded: c1.refunded, bal: bal(J) })

  const sell = market.placeSell(J, 'item:3007', 30, 2)
  const cs = market.cancelOrder(J, sell.orderId)
  const cl = claimsOf(J).filter((x) => x.item_id === 'item:3007')
  ok(cs.cancelledQty === 2 && cl.length === 1 && Number(cl[0].qty) === 2, '撤卖单 → 2 个物品进待领取（还回去）', cl)

  expectErr(() => market.cancelOrder(J, buy.orderId), 'no_such_order', '重复撤单被拒')
}

// ================= T7 寄售（唯一实例） =================
console.log('\n[T7] 寄售：装备带词条快照，同一实例不能重复上架')
{
  const K = newUser('K', 0)
  const L = newUser('L', 2000)
  const snap = { defId: 10003, affixes: [{ stat: 'dmg_pct', value: 6 }], durability: 88, level: 3 }

  const l1 = market.placeListing(K, 'equip:10003', 500, snap)
  ok(l1.listingId > 0 && l1.fingerprint.length === 32, '上架成功，指纹 32 hex')

  expectErr(() => market.placeListing(K, 'equip:10003', 600, snap), 'duplicate_listing', '同一件（同快照）重复上架被拒')

  const l2 = market.placeListing(K, 'equip:10003', 520, { ...snap, durability: 87 })
  ok(l2.listingId !== l1.listingId, '耐久不同 = 不同实例，可以另挂一单')

  const list = market.listListings({ itemId: 'equip:10003' })
  ok(list.length === 2 && list[0].price === 500, '挂单列表按价格升序', list.map((x) => x.price))

  const beforeB = bal(L)
  const fb = market.buyListing(L, l1.listingId)
  ok(fb.fee === 25 && bal(L) === beforeB - 500, `买家付 500，手续费 25（5%）`, { fee: fb.fee, bal: bal(L) })
  ok(bal(K) === 475, '卖家实收 475', bal(K))

  const kc = claimsOf(L).filter((x) => x.item_id === 'equip:10003')
  const kSnap = kc[0]?.snapshot ? JSON.parse(kc[0].snapshot) : null
  ok(kc.length === 1 && kSnap && Number(kSnap.durability) === 88, '买家拿到的 claim 带着完整实例快照', kc[0]?.snapshot)

  expectErr(() => market.buyListing(L, l1.listingId), 'no_such_listing', '已被买走的挂单不能再买')
  expectErr(() => market.buyListing(K, l2.listingId), 'self_trade', '不能买自己的挂单')
}

// ================= T8 领取幂等 =================
console.log('\n[T8] 领取：一次成功，二次报错（幂等防重复入包）')
{
  const cl = claimsOf(A)[0]
  const r1 = market.claim(A, Number(cl.id))
  ok(r1.qty === 2, '第一次领取成功')
  expectErr(() => market.claim(A, Number(cl.id)), 'no_claim', '重复领取被拒')
  ok(claimsOf(A).length === 0, '待领取队列已清空')
}

// ================= T9 资金守恒 =================
console.log('\n[T9] 资金守恒（最关键）')
{
  const total = balSum() + lockedSum() + feeSum()
  ok(total === SEEDED, `余额合计 ${balSum()} + 锁定 ${lockedSum()} + 手续费 ${feeSum()} = ${total}，应等于存入总额 ${SEEDED}`)

  // 每笔成交的手续费都必须等于 floor(gross*5%)
  const bad = D().prepare('SELECT * FROM trades').all().filter((t) => Number(t.fee) !== Math.floor(Number(t.gross) * 500 / 10000))
  ok(bad.length === 0, '所有成交记录的手续费都精确等于 floor(gross×5%)', bad)

  // 不能被扣成负数
  const neg = D().prepare('SELECT * FROM wallets WHERE balance < 0').all()
  ok(neg.length === 0, '没有任何负余额')
}

// ================= T10 参数与边界 =================
console.log('\n[T10] 参数边界')
{
  const M = newUser('M', 100)
  expectErr(() => market.placeBuy(M, 'item:1', 0, 1), 'bad_price', '价格 0 被拒')
  expectErr(() => market.placeBuy(M, 'item:1', 50, 0), 'bad_qty', '数量 0 被拒')
  expectErr(() => market.placeBuy(M, 'item:1', 200, 1), 'insufficient_balance', '余额不足被拒（200 > 100）')
  expectErr(() => market.placeBuy(M, 'bad id with space', 10, 1), 'bad_item_id', '非法 itemId 被拒')
  expectErr(() => market.placeListing(M, 'equip:x', 10, { pad: 'x'.repeat(3000) }), 'snapshot_too_large', '快照超 2KB 被拒')
  expectErr(() => market.placeListing(M, 'equip:x', 10, 'not json'), 'bad_snapshot', '快照非 JSON 被拒')
}

console.log(`\n=== ${pass} 通过, ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  FAIL:', f)); process.exit(1) }
process.exit(0)
