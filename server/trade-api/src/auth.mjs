// 鉴权：只有一条通道 —— 用户名 + 口令。
//
// 为什么不存设备密钥（Ed25519 公钥）：
//   原先有一套「设备密钥」用于游客身份和免密快登，代价是服务端要为每个浏览器
//   存一把公钥（device_keys 表），换来的能力却都不可用 —— 游客改成纯本地存档后
//   不再需要服务器身份，免密快登也从没接进 UI。既然它唯一的作用是「认这台机器」，
//   那就是设备信息，不该收。现在服务端关于账号只存两样：
//       用户名（username / username_lc）+ 口令哈希（scrypt）
//   没有任何设备标识、IP、UA、指纹。会话表 sessions 只存 token 与过期时间。
//
// 为什么不用造化的 userId：它来自宿主 postMessage，是 JS 里的普通字符串，
// 玩家改一个字段就能冒充别人花别人的钱。身份锚点必须是只有本人知道的口令。
//
// 流程：
//   注册：POST /auth/account/register { username, password } → token
//   登录：POST /auth/login            { username, password } → token
//   日常：Authorization: Bearer <token>

import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { get } from './db.mjs'
import { HttpError } from './errors.mjs'

const scryptAsync = promisify(crypto.scrypt)

const SESSION_TTL = 7 * 24 * 3600 * 1000

// 口令哈希参数：N=16384,r=8 → 16MB 内存/次，约 50–80ms，单机足够且不需要外部依赖
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 }

function randomUserId () {
  return 'u' + crypto.randomBytes(8).toString('hex')
}

// ============ 口令 ============

export async function hashPassword (password) {
  const salt = crypto.randomBytes(16)
  const dk = await scryptAsync(password, salt, SCRYPT.keylen, SCRYPT)
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${dk.toString('base64url')}`
}

export async function verifyPassword (password, stored) {
  if (typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, N, r, p, saltB64, hashB64] = parts
  const salt = Buffer.from(saltB64, 'base64url')
  const expected = Buffer.from(hashB64, 'base64url')
  let dk
  try {
    dk = await scryptAsync(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem
    })
  } catch {
    return false
  }
  return dk.length === expected.length && crypto.timingSafeEqual(dk, expected)
}

// 用户名同时是登录名和默认昵称；中文允许，但大小写不敏感去重
function normalizeUsername (raw) {
  const display = String(raw || '').trim()
  if (display.length < 2 || display.length > 20) {
    throw new HttpError(400, 'bad_username', '用户名长度应为 2–20 个字符')
  }
  if (!/^[\p{L}\p{N}_-]+$/u.test(display)) {
    throw new HttpError(400, 'bad_username', '用户名只能包含中英文、数字、下划线或短横线')
  }
  return { display, lc: display.toLowerCase() }
}

function normalizePassword (raw, usernameLc) {
  if (typeof raw !== 'string') throw new HttpError(400, 'bad_password', '密码缺失')
  const pw = raw
  if (pw.length < 8 || pw.length > 72) {
    throw new HttpError(400, 'bad_password', '密码长度应为 8–72 位')
  }
  if (pw.toLowerCase() === usernameLc) {
    throw new HttpError(400, 'bad_password', '密码不能与用户名相同')
  }
  return pw
}

// ============ 登录失败限流（进程内，单实例够用） ============
// 按 IP+用户名 和 用户名 两个维度计；Caddy 在前面，IP 取 X-Forwarded-For 首个。
// **IP 只在这个 Map 里活 15 分钟，不落库、不写日志** —— 它是防爆破的临时计数，不是数据。

const RATE = { windowMs: 15 * 60 * 1000, ipMax: 10, userMax: 30 }
const failures = new Map()

function bump (key, max) {
  const now = Date.now()
  const e = failures.get(key)
  if (!e || e.resetAt < now) {
    failures.set(key, { n: 1, resetAt: now + RATE.windowMs })
    return
  }
  e.n++
  if (e.n > max) {
    const sec = Math.ceil((e.resetAt - now) / 1000)
    throw new HttpError(429, 'too_many_attempts', `登录尝试过于频繁，请 ${sec} 秒后再试`)
  }
}

export function assertLoginAllowed (ip, usernameLc) {
  const now = Date.now()
  for (const key of [`ip:${ip}|${usernameLc}`, `u:${usernameLc}`]) {
    const e = failures.get(key)
    if (!e || e.resetAt < now) continue
    const max = key.startsWith('ip:') ? RATE.ipMax : RATE.userMax
    if (e.n >= max) {
      const sec = Math.ceil((e.resetAt - now) / 1000)
      throw new HttpError(429, 'too_many_attempts', `登录尝试过于频繁，请 ${sec} 秒后再试`)
    }
  }
}

function noteLoginFailure (ip, usernameLc) {
  bump(`ip:${ip}|${usernameLc}`, RATE.ipMax)
  bump(`u:${usernameLc}`, RATE.userMax)
}

function clearLoginFailures (ip, usernameLc) {
  failures.delete(`ip:${ip}|${usernameLc}`)
  failures.delete(`u:${usernameLc}`)
}

export function sweepLimiter () {
  const now = Date.now()
  let n = 0
  for (const [k, e] of failures) if (e.resetAt < now) { failures.delete(k); n++ }
  return n
}

// 用户不存在时也跑一次 scrypt，避免靠响应时间枚举用户名
let dummyHash = null
async function burnTime (password) {
  if (!dummyHash) dummyHash = await hashPassword('dummy-password-for-timing')
  await verifyPassword(password, dummyHash)
}

// ============ 账号 ============

function issueToken (userId) {
  const token = crypto.randomBytes(32).toString('hex')
  get().prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?,?,?,?)')
    .run(token, userId, Date.now() + SESSION_TTL, Date.now())
  return token
}

function accountOf (userId) {
  return get().prepare('SELECT * FROM accounts WHERE user_id = ?').get(userId)
}

function createAccount ({ userId, display, kind = 'password', username = null, usernameLc = null, passwordHash = null }) {
  const d = get()
  d.prepare(`INSERT INTO accounts (user_id, display, kind, username, username_lc, password_hash, created_at)
             VALUES (?,?,?,?,?,?,?)`)
    .run(userId, display, kind, username, usernameLc, passwordHash, Date.now())
  d.prepare('INSERT OR IGNORE INTO wallets (user_id, balance) VALUES (?, 0)').run(userId)
}

function isUniqueViolation (e) {
  return /UNIQUE constraint failed/.test(String(e && e.message))
}

// 注册：只认用户名 + 口令，没有任何其他前置条件（不需要签名、不需要设备、不需要邮箱手机）。
export async function accountRegister ({ username, password }) {
  const { display, lc } = normalizeUsername(username)
  const pw = normalizePassword(password, lc)

  const taken = get().prepare('SELECT 1 AS x FROM accounts WHERE username_lc = ?').get(lc)
  if (taken) throw new HttpError(409, 'username_taken', '用户名已被占用')

  const passwordHash = await hashPassword(pw)
  const userId = randomUserId()
  try {
    createAccount({ userId, display, kind: 'password', username: display, usernameLc: lc, passwordHash })
  } catch (e) {
    // 并发注册同一名字：唯一索引是最终裁决
    if (isUniqueViolation(e)) throw new HttpError(409, 'username_taken', '用户名已被占用')
    throw e
  }
  return {
    token: issueToken(userId),
    userId,
    display,
    username: display,
    kind: 'password',
    expiresInMs: SESSION_TTL
  }
}

// 账号密码登录
export async function login ({ username, password, ip = 'unknown' }) {
  const raw = String(username || '').trim()
  const lc = raw.toLowerCase()
  if (!raw) throw new HttpError(400, 'bad_username', '用户名缺失')
  assertLoginAllowed(ip, lc)

  const acc = get().prepare('SELECT * FROM accounts WHERE username_lc = ?').get(lc)
  if (!acc || !acc.password_hash) {
    await burnTime(String(password || ''))
    noteLoginFailure(ip, lc)
    throw new HttpError(401, 'bad_credentials', '用户名或密码错误')
  }
  const okPw = await verifyPassword(String(password || ''), acc.password_hash)
  if (!okPw) {
    noteLoginFailure(ip, lc)
    throw new HttpError(401, 'bad_credentials', '用户名或密码错误')
  }
  if (acc.banned) throw new HttpError(403, 'banned', '账号已被封禁')
  clearLoginFailures(ip, lc)

  return {
    token: issueToken(acc.user_id),
    userId: acc.user_id,
    display: acc.display,
    username: acc.username,
    kind: acc.kind,
    expiresInMs: SESSION_TTL
  }
}

export function authenticate (req) {
  const h = req.headers.authorization || ''
  const m = /^Bearer\s+([\w-]{20,})$/.exec(h)
  if (!m) throw new HttpError(401, 'no_token', '缺少 Authorization: Bearer <token>')
  const d = get()
  const s = d.prepare('SELECT * FROM sessions WHERE token = ?').get(m[1])
  if (!s) throw new HttpError(401, 'bad_token', 'token 无效')
  if (s.expires_at < Date.now()) throw new HttpError(401, 'token_expired', 'token 已过期，请重新登录')
  const acc = accountOf(s.user_id)
  if (!acc) throw new HttpError(401, 'no_account', '账号不存在')
  if (acc.banned) throw new HttpError(403, 'banned', '账号已被封禁')
  return { userId: acc.user_id, display: acc.display, kind: acc.kind, username: acc.username }
}
