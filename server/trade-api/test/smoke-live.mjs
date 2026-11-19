// 真实环境冒烟：打生产域名，走一遍 Ed25519 全链路 + 钱包存取。
//
//   node test/smoke-live.mjs                       # 默认 https://api.colasprite.net
//   node test/smoke-live.mjs --base http://127.0.0.1:8790
//
// ⚠️ 会在目标库创建/更新一个 display='自检脚本' 的账号，跑完自己打印清理命令。
//    （e2e.mjs 用内存库不污染，日常回归优先跑那个）

import crypto from 'node:crypto'

const args = process.argv.slice(2)
const baseIdx = args.indexOf('--base')
const BASE = (baseIdx >= 0 ? args[baseIdx + 1] : null) || process.env.BASE || 'https://api.colasprite.net'

let pass = 0
const fails = []
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ✓', name); return }
  fails.push(name)
  console.log('  ✗', name, extra ? JSON.stringify(extra).slice(0, 240) : '')
}

async function call (method, path, { body, token } = {}) {
  const h = {}
  if (body) h['content-type'] = 'application/json'
  if (token) h.authorization = 'Bearer ' + token
  const r = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined })
  let j = null
  try { j = await r.json() } catch {}
  return { status: r.status, body: j }
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const sign = (m) => crypto.sign(null, Buffer.from(m), privateKey).toString('base64')

console.log('目标:', BASE, '\n')

const reg = await call('POST', '/api/v1/auth/register', { body: { pubkey: pubB64, display: '自检脚本' } })
ok(reg.status === 200 && reg.body.created === true, '注册新账号 ' + reg.body.userId, reg.body)
const userId = reg.body.userId

const c = await call('POST', '/api/v1/auth/challenge', { body: { userId } })
ok(c.status === 200 && !!c.body.nonce, 'challenge 下发')

const wrong = await call('POST', '/api/v1/auth/verify', { body: { userId, nonce: c.body.nonce, signature: sign('bogus') } })
ok(wrong.status === 401, '错误签名 → 401')

const v = await call('POST', '/api/v1/auth/verify', { body: { userId, nonce: c.body.nonce, signature: sign(c.body.sign) } })
ok(v.status === 200 && !!v.body.token, '验签成功拿到 token')
const token = v.body.token

const replay = await call('POST', '/api/v1/auth/verify', { body: { userId, nonce: c.body.nonce, signature: sign(c.body.sign) } })
ok(replay.status === 400 && replay.body.code === 'challenge_used', 'challenge 重放被拒')

const me = await call('GET', '/api/v1/me', { token })
ok(me.status === 200 && me.body.balance === 0, 'GET /me 余额 0')

const d = await call('POST', '/api/v1/wallet/deposit', { token, body: { amount: 500 } })
ok(d.status === 200 && d.body.balance === 500, '存入 500')

const w = await call('POST', '/api/v1/wallet/withdraw', { token, body: { amount: 200 } })
ok(w.status === 200 && w.body.balance === 300, '取出 200 → 300')

const over = await call('POST', '/api/v1/wallet/withdraw', { token, body: { amount: 99999 } })
ok(over.status === 400 && over.body.code === 'insufficient_balance', '超额取出被拒（无负余额）')

const led = await call('GET', '/api/v1/wallet', { token })
ok(led.body?.ledger?.length === 2 && led.body.balance === 300, '流水 2 条、余额 300', led.body)

console.log(`\n=== ${pass} 通过, ${fails.length} 失败 ===`)
console.log(`清理测试账号：在服务器上删除 user_id='${userId}' 的 accounts/wallets/sessions/challenges/ledger 行`)
process.exit(fails.length ? 1 : 0)
