// 端到端自测：不起外部依赖，内嵌内存库 + 随机端口
// 跑法：node test/e2e.mjs        失败即非 0 退出，可直接进 CI

import crypto from 'node:crypto'
import * as db from '../src/db.mjs'
import * as auth from '../src/auth.mjs'
import * as wallet from '../src/wallet.mjs'
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
const server = await start({ port: 0, host: '127.0.0.1', handler: createApp({ db, auth, wallet }) })
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
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const sign = (msg) => crypto.sign(null, Buffer.from(msg), privateKey).toString('base64')
let userId

console.log('\n[2] 账号注册')
{
  const r = await call('POST', '/api/v1/auth/register', { body: { pubkey: pubB64, display: '测试旅者' } })
  ok(r.status === 200 && r.body.ok, '注册成功')
  ok(r.body.created === true, '首次注册 created=true')
  ok(/^u[0-9a-f]{16}$/.test(r.body.userId), 'user_id 由公钥派生 (' + r.body.userId + ')')
  userId = r.body.userId

  const again = await call('POST', '/api/v1/auth/register', { body: { pubkey: pubB64, display: '改名后' } })
  ok(again.body.created === false && again.body.userId === userId, '同一公钥重复注册 → 同账号，created=false')

  const { publicKey: otherPub } = crypto.generateKeyPairSync('ed25519')
  const other = await call('POST', '/api/v1/auth/register', {
    body: { pubkey: otherPub.export({ type: 'spki', format: 'der' }).toString('base64'), display: 'B' }
  })
  ok(other.body.userId !== userId, '不同公钥 → 不同 user_id')

  const bad = await call('POST', '/api/v1/auth/register', { body: { pubkey: 'not-a-key' } })
  ok(bad.status === 400 && bad.body.code === 'bad_pubkey', '非法公钥被拒')
}

// ---------- 3. 签名登录 ----------
console.log('\n[3] Ed25519 challenge-response')
let token
{
  const c = await call('POST', '/api/v1/auth/challenge', { body: { userId } })
  ok(c.status === 200 && c.body.nonce, '拿到 challenge')
  ok(c.body.sign === 'colasprite-auth:v1:' + c.body.nonce, '待签串格式正确')

  const wrong = await call('POST', '/api/v1/auth/verify', {
    body: { userId, nonce: c.body.nonce, signature: sign('错的串') }
  })
  ok(wrong.status === 401 && wrong.body.code === 'bad_signature', '签错串 → 401')

  const v = await call('POST', '/api/v1/auth/verify', {
    body: { userId, nonce: c.body.nonce, signature: sign(c.body.sign) }
  })
  ok(v.status === 200 && v.body.token && v.body.token.length >= 40, '验签成功拿到 token')
  token = v.body.token

  const replay = await call('POST', '/api/v1/auth/verify', {
    body: { userId, nonce: c.body.nonce, signature: sign(c.body.sign) }
  })
  ok(replay.status === 400 && replay.body.code === 'challenge_used', '同一 nonce 重放被拒（防重放）')

  const ghost = await call('POST', '/api/v1/auth/challenge', { body: { userId: 'u0000000000000000' } })
  ok(ghost.status === 404 && ghost.body.code === 'no_account', '不存在的账号要 challenge → 404')

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
  ok(me.body.display === '改名后', '显示名已被更新')

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
  const { publicKey: pk2, privateKey: sk2 } = crypto.generateKeyPairSync('ed25519')
  const reg = await call('POST', '/api/v1/auth/register', {
    body: { pubkey: pk2.export({ type: 'spki', format: 'der' }).toString('base64'), display: 'B' }
  })
  const c = await call('POST', '/api/v1/auth/challenge', { body: { userId: reg.body.userId } })
  const v = await call('POST', '/api/v1/auth/verify', {
    body: {
      userId: reg.body.userId,
      nonce: c.body.nonce,
      signature: crypto.sign(null, Buffer.from(c.body.sign), sk2).toString('base64')
    }
  })
  const bWallet = await call('GET', '/api/v1/wallet', { token: v.body.token })
  ok(bWallet.body.balance === 0, 'B 的钱包独立，看不到 A 的 40')

  // 直接验证 CHECK 约束：绕过 handler 强行写负余额必须失败
  let threw = false
  try { db.applyDelta(userId, -99_999, 'force_negative') } catch { threw = true }
  ok(threw, '裸扣到负余额被 DB CHECK 拦住（事务回滚）')
  const after = await call('GET', '/api/v1/me', { token })
  ok(after.body.balance === 40, '失败的事务没有污染余额')
}

server.close()
console.log(`\n=== ${pass} 通过, ${fails.length} 失败 ===`)
if (fails.length) {
  fails.forEach((f) => console.log('  FAIL:', f))
  process.exit(1)
}
process.exit(0)
