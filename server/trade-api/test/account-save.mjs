// 账号体系 + 云存档 的端到端自测（内存库 + 随机端口）
// 跑法：node test/account-save.mjs

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
  return { status: r.status, body: json }
}

db.open(':memory:')
const server = await start({ port: 0, host: '127.0.0.1', handler: createApp({ db, auth, wallet, market, save }) })
const BASE = `http://127.0.0.1:${server.address().port}`
console.log('\n服务起在', BASE)

// 注册/登录只要用户名和口令 —— 没有公钥、没有签名、没有 nonce。
const PASS = 'hunter2hunter2'
const reg = (username, password = PASS) => call('POST', '/api/v1/auth/account/register', {
  body: { username, password }
})

// ---------- 1. 注册即登录 ----------
console.log('\n[1] 注册')
let accountToken, accountUser
{
  const r = await reg('旅者甲')
  ok(r.status === 200 && r.body.kind === 'password', '注册成功，kind=password')
  ok(/^u[0-9a-f]{16}$/.test(r.body.userId), 'user_id 是随机 16 hex')
  ok(r.body.token && r.body.token.length >= 40, '注册直接返回 token（不用再走一次登录）')
  ok(!('deviceBound' in r.body) && !('pubkey' in r.body), '响应里没有任何设备字段')
  accountToken = r.body.token
  accountUser = r.body.userId

  const me = await call('GET', '/api/v1/me', { token: accountToken })
  ok(me.body.username === '旅者甲' && me.body.kind === 'password', '/me 显示用户名')
  ok(me.body.saves && me.body.saves.limits.maxSlots === 20, '/me 带出存档配额')
}

// ---------- 2. 库里的账号只有用户名和口令哈希 ----------
console.log('\n[2] 账号数据面（只存用户名 + 哈希）')
{
  const row = db.get().prepare('SELECT * FROM accounts WHERE user_id = ?').get(accountUser)
  const cols = Object.keys(row).sort()
  ok(JSON.stringify(cols) === JSON.stringify(
    ['banned', 'created_at', 'display', 'kind', 'password_hash', 'user_id', 'username', 'username_lc']
  ), 'accounts 列就只有这些：' + cols.join(','))
  ok(row.password_hash.startsWith('scrypt$'), '口令以 scrypt 哈希存储')
  ok(!row.password_hash.includes(PASS), '哈希里不含明文口令')
  ok(row.username === '旅者甲', '用户名按原样存（登录名 = 昵称）')

  // 废弃表必须已经不存在
  const tables = db.get().prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name)
  ok(!tables.includes('device_keys'), 'device_keys 表不存在')
  ok(!tables.includes('challenges'), 'challenges 表不存在')
}

// ---------- 3. 注册校验 ----------
console.log('\n[3] 注册参数校验')
{
  const short = await reg('新玩家', '1234567')
  ok(short.status === 400 && short.body.code === 'bad_password', '密码少于 8 位被拒')

  const badName = await reg('a b')
  ok(badName.status === 400 && badName.body.code === 'bad_username', '用户名含空格被拒')

  const taken = await reg('旅者甲')
  ok(taken.status === 409 && taken.body.code === 'username_taken', '用户名重复 → 409 username_taken')

  const one = await reg('新玩家')
  ok(one.status === 200, '全新用户名直接注册成功（无任何前置条件）')

  const two = await reg('新玩家二号')
  ok(two.status === 200, '同一浏览器可以连续注册第二个账号（服务端不认设备）')
  ok(two.body.userId !== one.body.userId, '两个账号 user_id 不同')

  // 只有用户名+口令，多传的字段一律忽略，不会因此报错
  const extra = await call('POST', '/api/v1/auth/account/register', {
    body: { username: '多传字段的人', password: PASS, pubkey: 'whatever', nonce: 'n', signature: 's' }
  })
  ok(extra.status === 200, '多余字段（pubkey/nonce/signature）被忽略，不影响注册')
}

// ---------- 4. 密码登录 ----------
console.log('\n[4] 密码登录')
{
  const wrong = await call('POST', '/api/v1/auth/login', { body: { username: '旅者甲', password: 'wrong-password' } })
  ok(wrong.status === 401 && wrong.body.code === 'bad_credentials', '密码错误 → 401（不暴露账号是否存在）')

  const ghost = await call('POST', '/api/v1/auth/login', { body: { username: '不存在的人', password: 'whatever123' } })
  ok(ghost.status === 401 && ghost.body.code === 'bad_credentials', '账号不存在 → 同样 401')

  const r = await call('POST', '/api/v1/auth/login', { body: { username: '旅者甲', password: PASS } })
  ok(r.status === 200 && r.body.userId === accountUser, '登录成功且回到同一账号')
  ok(!('deviceBound' in r.body), '登录响应里没有设备绑定字段')

  // 大小写不敏感
  const upper = await call('POST', '/api/v1/auth/login', { body: { username: '旅者甲', password: PASS } })
  ok(upper.status === 200, '重复登录可用（不锁死正常用户）')

  // 旧的设备接口必须已经下线
  const gone = await call('POST', '/api/v1/auth/challenge', { body: { userId: accountUser } })
  ok(gone.status === 404, '老的 /auth/challenge 已不存在')
  const gone2 = await call('POST', '/api/v1/auth/pubkey-challenge', { body: { pubkey: 'x'.repeat(40) } })
  ok(gone2.status === 404, '老的 /auth/pubkey-challenge 已不存在')
}

// ---------- 5. 登录限流 ----------
console.log('\n[5] 登录限流')
{
  let blocked = null
  for (let i = 0; i < 13; i++) {
    const r = await call('POST', '/api/v1/auth/login', { body: { username: '灌库攻击目标', password: 'x'.repeat(8) } })
    if (r.status === 429) { blocked = r; break }
  }
  ok(blocked && blocked.body.code === 'too_many_attempts', '连续失败后触发 429')
}

// ---------- 6. 云存档：基本读写 ----------
console.log('\n[6] 云存档读写')
{
  const noAuth = await call('GET', '/api/v1/save?slot=main')
  ok(noAuth.status === 401, '未登录读存档 → 401')

  const empty = await call('GET', '/api/v1/save?slot=main', { token: accountToken })
  ok(empty.status === 200 && empty.body.rev === 0 && empty.body.payload === null, '空档 rev=0, payload=null')

  const w1 = await call('POST', '/api/v1/save', {
    token: accountToken,
    body: { slot: 'main', payload: { level: 3, gold: 120, bag: [1, 2, 3] } }
  })
  ok(w1.status === 200 && w1.body.rev === 1 && w1.body.created === true, '首次写入 rev=1')

  const got = await call('GET', '/api/v1/save?slot=main', { token: accountToken })
  ok(got.body.payload.level === 3 && got.body.payload.bag.length === 3, '原样读回（含嵌套结构）')

  const w2 = await call('POST', '/api/v1/save', {
    token: accountToken,
    body: { slot: 'main', payload: { level: 4 }, baseRev: 1 }
  })
  ok(w2.status === 200 && w2.body.rev === 2, '带正确 baseRev 写入 → rev=2')

  const conflict = await call('POST', '/api/v1/save', {
    token: accountToken,
    body: { slot: 'main', payload: { level: 99 }, baseRev: 1 }
  })
  ok(conflict.status === 409 && conflict.body.code === 'save_conflict', 'baseRev 过期 → 409（乐观锁生效）')

  const after = await call('GET', '/api/v1/save?slot=main', { token: accountToken })
  ok(after.body.payload.level === 4, '冲突写入没有覆盖数据')

  const force = await call('POST', '/api/v1/save', {
    token: accountToken,
    body: { slot: 'main', payload: { level: 5 } }
  })
  ok(force.status === 200 && force.body.rev === 3, '不带 baseRev = 强制覆盖，rev 自增')

  const list = await call('GET', '/api/v1/saves', { token: accountToken })
  ok(list.status === 200 && list.body.items.length === 1, '列表 1 个存档位')
  ok(list.body.items[0].payload === undefined, '列表不带 payload（省流量）')
  ok(list.body.usage.slots === 1 && list.body.usage.bytes > 0, 'usage 统计槽位与字节数')

  const del = await call('DELETE', '/api/v1/save/main', { token: accountToken })
  ok(del.status === 200 && del.body.deleted === true, '删除存档位')
  const gone = await call('GET', '/api/v1/save?slot=main', { token: accountToken })
  ok(gone.body.rev === 0, '删除后回到空档')
  const del2 = await call('DELETE', '/api/v1/save/main', { token: accountToken })
  ok(del2.body.deleted === false, '重复删除 deleted=false')
}

// ---------- 7. 云存档：校验与配额 ----------
console.log('\n[7] 云存档校验与配额')
{
  const badSlot = await call('POST', '/api/v1/save', { token: accountToken, body: { slot: 'a b', payload: {} } })
  ok(badSlot.status === 400 && badSlot.body.code === 'bad_slot', '非法存档位名被拒')

  const huge = await call('POST', '/api/v1/save', {
    token: accountToken,
    body: { slot: 'big', payload: { blob: 'x'.repeat(300 * 1024) } }
  })
  ok(huge.status === 413 && huge.body.code === 'payload_too_large', '超 256KB 被拒（413）')

  const noPayload = await call('POST', '/api/v1/save', { token: accountToken, body: { slot: 'x' } })
  ok(noPayload.status === 400 && noPayload.body.code === 'bad_payload', '缺少 payload 被拒')

  let quotaHit = null
  for (let i = 1; i <= 21; i++) {
    const r = await call('POST', '/api/v1/save', { token: accountToken, body: { slot: 'slot' + i, payload: { i } } })
    if (r.status === 409 && r.body.code === 'slot_quota') { quotaHit = r; break }
  }
  ok(quotaHit, '超过 20 个存档位 → 409 slot_quota')

  const usage = await call('GET', '/api/v1/saves', { token: accountToken })
  ok(usage.body.usage.slots === 20, '实际落库 20 个槽位')
}

// ---------- 8. 跨账号隔离 ----------
console.log('\n[8] 跨账号隔离')
{
  const b = await reg('账号乙')
  const tb = b.body.token

  await call('POST', '/api/v1/save', { token: accountToken, body: { slot: 'isolate', payload: { secret: 'A' } } })
  const bView = await call('GET', '/api/v1/save?slot=isolate', { token: tb })
  ok(bView.body.rev === 0 && bView.body.payload === null, 'B 读不到 A 的同名存档位')

  const bList = await call('GET', '/api/v1/saves', { token: tb })
  ok(bList.body.items.length === 0, 'B 的存档列表为空')
}

// ---------- 9. token 校验 ----------
console.log('\n[9] token 校验')
{
  const bad = await call('GET', '/api/v1/saves', { token: 'f'.repeat(64) })
  ok(bad.status === 401 && bad.body.code === 'bad_token', '伪造 token → 401')

  // 过期 token
  db.get().prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(Date.now() - 1000, accountToken)
  const expired = await call('GET', '/api/v1/saves', { token: accountToken })
  ok(expired.status === 401 && expired.body.code === 'token_expired', '过期 token → 401 token_expired')
}

console.log(`\n=== ${pass} 通过, ${fails.length} 失败 ===`)
if (fails.length) {
  for (const f of fails) console.log('  -', f)
  process.exit(1)
}
server.close()
