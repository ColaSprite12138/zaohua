// HTTP 层：零依赖（node:http）。
//
// CORS 一律回 `*` —— 这是刻意选择，不是偷懒：
//   造化宿主 origin 形如 `preview-mcpv3-<gameId>.zaohuaboxcdn.com`，里面嵌了 game_id，
//   且预览域 ≠ 正式发布域。按 origin 配白名单，换环境/换 game_id 就挂。
//   因为鉴权走 Authorization 头 + 签名，不用 cookie，`ACAO: *` 在这里完全安全
//   （绝不能同时加 Access-Control-Allow-Credentials: true，那会被浏览器拒绝）。

import http from 'node:http'
import { authenticate } from './auth.mjs'
import { HttpError } from './errors.mjs'

const MAX_BODY = 32 * 1024

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400'
}

function sendJson (res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj))
  res.writeHead(status, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

async function readJson (req) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > MAX_BODY) throw new HttpError(413, 'body_too_large', '请求体过大')
    chunks.push(c)
  }
  if (!size) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'bad_json', '请求体不是合法 JSON')
  }
}

const str = (v, name, { min = 1, max = 200 } = {}) => {
  if (typeof v !== 'string') throw new HttpError(400, 'bad_' + name, `${name} 必须是字符串`)
  const s = v.trim()
  if (s.length < min || s.length > max) throw new HttpError(400, 'bad_' + name, `${name} 长度应在 ${min}–${max}`)
  return s
}

const int = (v, name, { min = 1, max = 1e9 } = {}) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, 'bad_' + name, `${name} 必须是 ${min}–${max} 的整数`)
  }
  return n
}

export function createApp ({ db, auth, wallet, market }) {
  const routes = []
  const add = (method, path, handler, needAuth = false) => {
    routes.push({ method, parts: path.split('/').filter(Boolean), handler, needAuth })
  }

  // ---------- 基础 ----------
  add('GET', '/api/v1/health', () => ({
    ok: true,
    service: 'trade-api',
    version: 2,
    now: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    feeBp: market.FEE_BP,
    limits: { wallet: wallet.limits, market: market.limits }
  }))

  // ---------- 账号 ----------
  add('POST', '/api/v1/auth/register', async ({ body }) =>
    auth.register({
      pubkey: str(body.pubkey, 'pubkey', { min: 20, max: 400 }),
      display: body.display
    }))

  add('POST', '/api/v1/auth/challenge', async ({ body }) =>
    auth.issueChallenge(str(body.userId, 'userId', { min: 3, max: 40 })))

  add('POST', '/api/v1/auth/verify', async ({ body }) =>
    auth.verifyChallenge({
      userId: str(body.userId, 'userId', { min: 3, max: 40 }),
      nonce: str(body.nonce, 'nonce', { min: 10, max: 100 }),
      signature: str(body.signature, 'signature', { min: 20, max: 400 })
    }))

  // ---------- 用户与钱包 ----------
  add('GET', '/api/v1/me', async ({ user }) => ({
    ok: true,
    userId: user.userId,
    display: user.display,
    balance: wallet.balanceOf(user.userId)
  }), true)

  add('GET', '/api/v1/wallet', async ({ user }) => ({
    ok: true,
    userId: user.userId,
    balance: wallet.balanceOf(user.userId),
    todayDeposited: wallet.rolling24hDeposit(user.userId),
    limits: wallet.limits,
    ledger: db.recentLedger(user.userId, 20)
  }), true)

  add('POST', '/api/v1/wallet/deposit', async ({ user, body }) =>
    wallet.deposit(user.userId, int(body.amount, 'amount')), true)

  add('POST', '/api/v1/wallet/withdraw', async ({ user, body }) =>
    wallet.withdraw(user.userId, int(body.amount, 'amount')), true)

  // ---------- 订单簿（同质商品） ----------
  add('GET', '/api/v1/market/book', async ({ url }) =>
    market.bookOf(str(url.searchParams.get('itemId'), 'itemId', { min: 1, max: 40 })))

  add('POST', '/api/v1/market/orders', async ({ user, body }) => {
    const side = str(body.side, 'side', { min: 3, max: 4 })
    if (side !== 'buy' && side !== 'sell') throw new HttpError(400, 'bad_side', 'side 只能是 buy 或 sell')
    const itemId = str(body.itemId, 'itemId', { min: 1, max: 40 })
    const price = int(body.price, 'price', { min: 1, max: market.limits.maxPrice })
    const qty = int(body.qty, 'qty', { min: 1, max: market.limits.maxQty })
    return side === 'buy'
      ? market.placeBuy(user.userId, itemId, price, qty)
      : market.placeSell(user.userId, itemId, price, qty)
  }, true)

  add('GET', '/api/v1/market/orders', async ({ user }) => ({
    ok: true,
    open: market.myOrders(user.userId)
  }), true)

  add('POST', '/api/v1/market/orders/:id/cancel', async ({ user, params }) =>
    market.cancelOrder(user.userId, int(params.id, 'id')), true)

  // ---------- 寄售（装备等唯一实例） ----------
  add('GET', '/api/v1/market/listings', async ({ url }) =>
    ({ ok: true, items: market.listListings({
      itemId: url.searchParams.get('itemId') || null,
      limit: url.searchParams.get('limit') || 50
    }) }))

  add('POST', '/api/v1/market/listings', async ({ user, body }) =>
    market.placeListing(user.userId, str(body.itemId, 'itemId', { min: 1, max: 40 }), int(body.price, 'price', { min: 1, max: market.limits.maxPrice }), body.snapshot), true)

  add('POST', '/api/v1/market/listings/:id/buy', async ({ user, params }) =>
    market.buyListing(user.userId, int(params.id, 'id')), true)

  add('POST', '/api/v1/market/listings/:id/cancel', async ({ user, params }) =>
    market.cancelListing(user.userId, int(params.id, 'id')), true)

  // ---------- 交割 ----------
  add('GET', '/api/v1/market/claims', async ({ user }) => ({
    ok: true,
    pending: market.myClaims(user.userId)
  }), true)

  add('POST', '/api/v1/market/claims/:id/claim', async ({ user, params }) =>
    market.claim(user.userId, int(params.id, 'id')), true)

  function matchRoute (method, pathname) {
    const parts = pathname.split('/').filter(Boolean)
    for (const r of routes) {
      if (r.method !== method || r.parts.length !== parts.length) continue
      const params = {}
      let hit = true
      for (let i = 0; i < parts.length; i++) {
        const p = r.parts[i]
        if (p.charCodeAt(0) === 58) params[p.slice(1)] = decodeURIComponent(parts[i])
        else if (p !== parts[i]) { hit = false; break }
      }
      if (hit) return { route: r, params }
    }
    return null
  }

  return async function handler (req, res) {
    const t0 = Date.now()
    const url = new URL(req.url || '/', 'http://localhost')
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      return res.end()
    }

    let logUser = '-'
    try {
      const m = matchRoute(req.method, path)
      if (!m) throw new HttpError(404, 'not_found', `没有这个接口：${req.method} ${path}`)

      const user = m.route.needAuth ? authenticate(req) : null
      if (user) logUser = user.userId

      const body = req.method === 'POST' ? await readJson(req) : {}
      const out = await m.route.handler({ req, body, user, url, params: m.params })
      sendJson(res, 200, { ok: true, ...out })
    } catch (e) {
      const isHttp = e instanceof HttpError
      if (!isHttp) console.error('[error]', e)
      sendJson(res, isHttp ? e.status : 500, {
        ok: false,
        code: isHttp ? e.code : 'internal_error',
        // 内部错误不把堆栈和 SQL 细节吐给客户端
        message: isHttp ? e.message : '服务端异常，请查看服务端日志'
      })
    } finally {
      console.log(`${req.method} ${path} ${res.statusCode} ${Date.now() - t0}ms user=${logUser}`)
    }
  }
}

export function start ({ port, host, handler }) {
  const server = http.createServer(handler)
  server.keepAliveTimeout = 30_000
  server.headersTimeout = 35_000
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)))
}
