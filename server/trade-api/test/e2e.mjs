// 端到端自测：不起外部依赖，内嵌内存库 + 随机端口
// 跑法：node test/e2e.mjs        失败即非 0 退出，可直接进 CI

import * as db from '../src/db.mjs'
import * as auth from '../src/auth.mjs'
import * as wallet from '../src/wallet.mjs'
import * as market from '../src/market.mjs'
import * as save from '../src/save.mjs'
import { createApp, start } from '../src/http.mjs'

let pass = 0
const fails = []
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓', name); return }
  fails.push(name + (extra ? ' → ' + JSON.stringify(extra) : ''))
  console.log('  ✗', name, extra ? JSON.stringify(extra) : '')
}

async function call (method, path, { body, token } = {}) {
  const headers = {}
  if (body) headers['content-type'] = 'application/json'
  if (token) headers.authorization = 'Bearer ' + token
  const r = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  })
  let json
  try { json = await r.json() } catch { json = null }
  return { status: r.status, body: json, headers: r.headers }
}

db.open(':memory:')
const server = await start({ port: 0, host: '127.0.0.1', handler: createApp({ db, auth, wallet, market, save }) })
const BASE = `http://127.0.0.1:${server.address().port}`
console.log('\n服务起在', BASE, '\n')

// ---------- 1. 基础 ----------
console.log('[1] 基础与 CORS')
{
  const r = await call('GET', '/api/v1/health')
  ok(r.status === 200 && r.body.ok === true, 'GET /health 200')
  ok(r.headers.get('access-control-allow-origin') === '*', 'ACAO 是 *（不是白名单）')
  const o = await call('OPTIONS', '/api/v1/me')
  ok(o.status === 204, 'OPTIONS 预检 204')
  ok(o.headers.get('access-control-allow-headers').includes('Authorization'), '预检放行 Authorization 头')
  const nf = await call('GET', '/api/v1/nope')
  ok(nf.status === 404 && nf.body.code === 'not_found', '未知路由 404')
}

// ---------- 2. 注册 ----------
// 注册只认用户名和口令：请求体里没有公钥、签名、nonce、设备标识。
let userId, token

console.log('\n[2] 账号注册')
{
  const r = await call('POST', '/api/v1/auth/account/register', {
    body: { username: '测试旅者', password: 'test-pass-1234' }
  })
  ok(r.status === 200 && r.body.ok, '注册成功')
  ok(/^u[0-9a-f]{16}$/.test(r.body.userId), 'user_id 是随机 16 hex (' + r.body.userId + ')')
  ok(r.body.token && r.body.token.length >= 40, '注册直接拿到 token')
  ok(r.body.kind === 'password' && r.body.username === '测试旅者', '返回 kind/username')
  userId = r.body.userId

  const again = await call('POST', '/api/v1/auth/account/register', {
    body: { username: '测试旅者', password: 'another-pass-99' }
  })
  ok(again.status === 409 && again.body.code === 'username_taken', '同名注册 → 409')

  const other = await call('POST', '/api/v1/auth/account/register', {
    body: { username: '另一个人', password: 'test-pass-1234' }
  })
  ok(other.body.userId !== userId, '不同用户名 → 不同 user_id')

  const bad = await call('POST', '/api/v1/auth/account/register', {
    body: { username: 'a b', password: 'test-pass-1234' }
  })
  ok(bad.status === 400 && bad.body.code === 'bad_username', '非法用户名被拒')

  const shortPw = await call('POST', '/api/v1/auth/account/register', {
    body: { username: '短密码的人', password: '1234567' }
  })
  ok(shortPw.status === 400 && shortPw.body.code === 'bad_password', '密码不足 8 位被拒')
}

// ---------- 3. 口令登录 ----------
console.log('\n[3] 口令登录')
{
  const wrong = await call('POST', '/api/v1/auth/login', {
    body: { username: '测试旅者', password: 'wrong-password' }
  })
  ok(wrong.status === 401 && wrong.body.code === 'bad_credentials', '密码错误 → 401（不暴露账号是否存在）')

  const ghost = await call('POST', '/api/v1/auth/login', {
    body: { username: '不存在的人', password: 'whatever-1234' }
  })
  ok(ghost.status === 401 && ghost.body.code === 'bad_credentials', '账号不存在 → 同样 401')

  const v = await call('POST', '/api/v1/auth/login', {
    body: { username: '测试旅者', password: 'test-pass-1234' }
  })
  ok(v.status === 200 && v.body.token && v.body.userId === userId, '登录成功回到同一账号')
  token = v.body.token

  const noTok = await call('GET', '/api/v1/me')
  ok(noTok.status === 401 && noTok.body.code === 'no_token', '无 token 访问 /me → 401')

  const fakeTok = await call('GET', '/api/v1/me', { token: 'x'.repeat(64) })
  ok(fakeTok.status === 401 && fakeTok.body.code === 'bad_token', '伪造 token → 401')
}

// ---------- 4. 钱包 ----------
console.log('\n[4] 托管钱包')
{
  const me = await call('GET', '/api/v1/me', { token })
  ok(me.status === 200 && me.body.balance === 0, '新账号余额 0')
  ok(me.body.display === '测试旅者' && me.body.username === '测试旅者', '显示名 = 用户名')

  const d1 = await call('POST', '/api/v1/wallet/deposit', { token, body: { amount: 100 } })
  ok(d1.status === 200 && d1.body.balance === 100, '存入 100 → 余额 100')

  const over = await call('POST', '/api/v1/wallet/deposit', { token, body: { amount: 1e10 } })
  ok(over.status === 400 && over.body.code === 'bad_amount', '超出取值范围的金额被参数层拦住')

  const tooBig = await call('POST', '/api/v1/wallet/deposit', { token, body: { amount: 200_000 } })
  ok(tooBig.status === 400 && tooBig.body.code === 'amount_too_large', '超单次上限 400')

  const w1 = await call('POST', '/api/v1/wallet/withdraw', { token, body: { amount: 200 } })
  ok(w1.status === 400 && w1.body.code === 'insufficient_balance', '余额不足 → 400（不产生负余额）')

  const w2 = await call('POST', '/api/v1/wallet/withdraw', { token, body: { amount: 60 } })
  ok(w2.status === 200 && w2.body.balance === 40, '取出 60 → 余额 40')

  const w3 = await call('GET', '/api/v1/wallet', { token })
  ok(w3.body.ledger.length === 2, '流水 2 条（存/取各一）')
  ok(w3.body.ledger[0].delta === -60 && w3.body.ledger[0].reason === 'withdraw', '最新流水是 -60 withdraw')
  ok(w3.body.todayDeposited === 100, '24h 滚动存入统计 = 100')

  // 日限：把上限临时压到 150 再存 60 应被拒
  wallet.limits.maxDaily = 150
  const daily = await call('POST', '/api/v1/wallet/deposit', { token, body: { amount: 60 } })
  wallet.limits.maxDaily = 300_000
  ok(daily.status === 429 && daily.body.code === 'deposit_daily_limit', '24h 上限生效 → 429')

  // 负数/零被拒
  const zero = await call('POST', '/api/v1/wallet/deposit', { token, body: { amount: 0 } })
  ok(zero.status === 400, '金额 0 被拒')
}

// ---------- 5. 事务与隔离 ----------
console.log('\n[5] 一致性与隔离')
{
  const reg = await call('POST', '/api/v1/auth/account/register', {
    body: { username: '用户乙', password: 'test-pass-1234' }
  })
  const bWallet = await call('GET', '/api/v1/wallet', { token: reg.body.token })
  ok(bWallet.body.balance === 0, 'B 的钱包独立，看不到 A 的 40')

  // 直接验证 CHECK 约束：绕过 handler 强行写负余额必须失败
  let threw = false
  try { db.applyDelta(userId, -99_999, 'force_negative') } catch { threw = true }
  ok(threw, '裸扣到负余额被 DB CHECK 拦住（事务回滚）')
  const after = await call('GET', '/api/v1/me', { token })
  ok(after.body.balance === 40, '失败的事务没有污染余额')
}

// ---------- 6. 市场路由（HTTP 层：路由匹配、参数解析、鉴权） ----------
console.log('\n[6] 市场路由')
{
  // 新用户 C，充 100
  const reg = await call('POST', '/api/v1/auth/account/register', {
    body: { username: '用户丙', password: 'test-pass-1234' }
  })
  const tokC = reg.body.token
  await call('POST', '/api/v1/wallet/deposit', { token: tokC, body: { amount: 100 } })

  const sell = await call('POST', '/api/v1/market/orders', { token, body: { side: 'sell', itemId: 'item:9001', price: 10, qty: 1 } })
  ok(sell.status === 200 && sell.body.remaining === 1, 'HTTP 挂卖单')

  const book = await call('GET', '/api/v1/market/book?itemId=item:9001')
  ok(book.status === 200 && book.body.asks.length === 1 && book.body.asks[0].price === 10, 'HTTP 查盘口')

  const badSide = await call('POST', '/api/v1/market/orders', { token: tokC, body: { side: 'hodl', itemId: 'item:9001', price: 10, qty: 1 } })
  ok(badSide.status === 400 && badSide.body.code === 'bad_side', 'side 非法被拒')

  const noAuth = await call('POST', '/api/v1/market/orders', { body: { side: 'buy', itemId: 'item:9001', price: 10, qty: 1 } })
  ok(noAuth.status === 401, '下单必须带 token')

  const buy = await call('POST', '/api/v1/market/orders', { token: tokC, body: { side: 'buy', itemId: 'item:9001', price: 10, qty: 1 } })
  ok(buy.status === 200 && buy.body.filled === 1, 'HTTP 买单撮合成交')

  const cl = await call('GET', '/api/v1/market/claims', { token: tokC })
  ok(cl.status === 200 && cl.body.pending.length === 1, '买家有待领取物品')
  const claimId = cl.body.pending[0].claimId
  const c1 = await call('POST', `/api/v1/market/claims/${claimId}/claim`, { token: tokC })
  ok(c1.status === 200, 'HTTP 领取成功')
  const c2 = await call('POST', `/api/v1/market/claims/${claimId}/claim`, { token: tokC })
  ok(c2.status === 404 && c2.body.code === 'no_claim', 'HTTP 重复领取被拒（路径参数解析正常）')

  const lst = await call('POST', '/api/v1/market/listings', {
    token, body: { itemId: 'equip:10003', price: 20, snapshot: { defId: 10003, affixes: [{ stat: 'hp_pct', value: 4 }], durability: 100 } }
  })
  ok(lst.status === 200 && lst.body.listingId > 0, 'HTTP 上架装备')

  const dup = await call('POST', '/api/v1/market/listings', {
    token, body: { itemId: 'equip:10003', price: 25, snapshot: { defId: 10003, affixes: [{ stat: 'hp_pct', value: 4 }], durability: 100 } }
  })
  ok(dup.status === 409 && dup.body.code === 'duplicate_listing', '同一实例重复上架被拒')

  const lstList = await call('GET', '/api/v1/market/listings?itemId=equip:10003')
  ok(lstList.status === 200 && lstList.body.items.length === 1, '装备挂单列表')

  const buyL = await call('POST', `/api/v1/market/listings/${lst.body.listingId}/buy`, { token: tokC })
  ok(buyL.status === 200 && buyL.body.price === 20, 'HTTP 买下装备')

  const selfBuy = await call('POST', `/api/v1/market/listings/${lst.body.listingId}/buy`, { token })
  ok(selfBuy.status === 404, '已售出的挂单不能再买')
}

server.close()
console.log(`\n=== ${pass} 通过, ${fails.length} 失败 ===`)
if (fails.length) {
  fails.forEach((f) => console.log('  FAIL:', f))
  process.exit(1)
}
process.exit(0)
