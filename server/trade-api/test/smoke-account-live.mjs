// 线上冒烟：打真实域名，覆盖「注册 → 登录 → 云存档」全链路
// 跑法：node test/smoke-account-live.mjs
// 注意：会留下一个以 smoke_ 开头的测试账号（用户名可从输出里看到，便于清理）

const BASE = process.env.API_BASE || 'https://api.colasprite.net'
const tag = 'smoke_' + Math.random().toString(36).slice(2, 8)
const PASS = 'smoke-pass-1234'

let pass = 0
const fails = []
const ok = (c, name, extra) => {
  if (c) { pass++; console.log('  ✓', name); return }
  fails.push(name + (extra ? ' → ' + JSON.stringify(extra) : ''))
  console.log('  ✗', name, extra ? JSON.stringify(extra) : '')
}

async function call (method, path, { body, token } = {}) {
  const headers = {}
  if (body) headers['content-type'] = 'application/json'
  if (token) headers.authorization = 'Bearer ' + token
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  let json = null
  try { json = await r.json() } catch {}
  return { status: r.status, body: json }
}

console.log('\n线上冒烟 @', BASE, '| 测试用户名：', tag)

const h = await call('GET', '/api/v1/health')
ok(h.status === 200 && h.body.version >= 3, 'health 在线且 version>=3')
ok(h.body.limits?.save?.maxSlots === 20, 'health 暴露存档配额')

// 注册：只发用户名 + 口令
const reg = await call('POST', '/api/v1/auth/account/register', { body: { username: tag, password: PASS } })
ok(reg.status === 200 && reg.body.kind === 'password', '注册成功（无任何设备/签名参数）')
ok(!('deviceBound' in reg.body), '响应里没有设备字段')
const userId = reg.body.userId
const token = reg.body.token

const me = await call('GET', '/api/v1/me', { token })
ok(me.body.username === tag && me.body.kind === 'password', '/me 已是密码账号')

const login = await call('POST', '/api/v1/auth/login', { body: { username: tag, password: PASS } })
ok(login.status === 200 && login.body.userId === userId, '口令登录回到同一账号')
const tok2 = login.body.token

const w1 = await call('POST', '/api/v1/save', { token: tok2, body: { slot: 'smoke', payload: { lv: 7, gold: 42 } } })
ok(w1.status === 200 && w1.body.rev === 1, '写云存档 rev=1')

const g1 = await call('GET', '/api/v1/save?slot=smoke', { token: tok2 })
ok(g1.body.payload?.gold === 42, '读回存档内容一致')

const c1 = await call('POST', '/api/v1/save', { token: tok2, body: { slot: 'smoke', payload: { lv: 8 }, baseRev: 0 } })
ok(c1.status === 409 && c1.body.code === 'save_conflict', '过期 baseRev → 409')

const d1 = await call('DELETE', '/api/v1/save/smoke', { token: tok2 })
ok(d1.body.deleted === true, '删除存档位')

const cross = await call('GET', '/api/v1/saves')
ok(cross.status === 401, '未带 token 读列表 → 401')

// 废弃的设备接口必须已经下线
const legacy = await call('POST', '/api/v1/auth/challenge', { body: { userId } })
ok(legacy.status === 404, '老 /auth/challenge 已下线')

console.log(`\n=== ${pass} 通过, ${fails.length} 失败 ===`)
if (fails.length) { for (const f of fails) console.log('  -', f); process.exit(1) }
console.log('清理：DELETE FROM accounts WHERE username_lc = \'' + tag + '\';')
