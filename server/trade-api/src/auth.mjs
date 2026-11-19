// 鉴权：Ed25519 challenge-response
//
// 为什么不用账号密码 / 不用平台 userId：
//   造化不提供可验签的身份（gameApiTokens 只对平台房间 API 有效），游戏里的
//   `user.getCurrent()` 是客户端返回的字符串，A 改成 B 的 id 就能花 B 的钱。
//   所以身份锚点只能是「玩家自己生成的密钥对」，userId 降级为显示名。
//
// 流程：
//   1) 客户端 WebCrypto 生成 Ed25519 键对，私钥留本地，公钥 POST 注册
//   2) 要操作时先要一个 nonce（challenge），用私钥签 "colasprite-auth:v1:<nonce>"
//   3) 服务端验签 → 发短期 session token，后续请求带 Bearer
//
// 这样每次敏感操作都可以要求重新签名，而日常读接口用 token 就够。

import crypto from 'node:crypto'
import { get } from './db.mjs'
import { HttpError } from './errors.mjs'

const CHALLENGE_TTL = 5 * 60 * 1000
const SESSION_TTL = 7 * 24 * 3600 * 1000
const SIG_PREFIX = 'colasprite-auth:v1:'

// Ed25519 公钥的 SPKI 头（12 字节），用于把裸 32 字节公钥包装成 DER
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function normalizeB64 (s) {
  if (typeof s !== 'string') throw new HttpError(400, 'pubkey_required', '公钥缺失')
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

export function parsePublicKey (b64) {
  const der = normalizeB64(b64)
  let keyObj
  if (der.length === 32) {
    keyObj = { key: Buffer.concat([ED25519_SPKI_PREFIX, der]), format: 'der', type: 'spki' }
  } else {
    keyObj = { key: der, format: 'der', type: 'spki' }
  }
  let pub
  try {
    pub = crypto.createPublicKey(keyObj)
  } catch {
    throw new HttpError(400, 'bad_pubkey', '公钥格式不合法（需要 Ed25519 的 SPKI DER 或 32 字节裸公钥）')
  }
  if (pub.asymmetricKeyType !== 'ed25519') {
    throw new HttpError(400, 'bad_pubkey_type', '只接受 Ed25519 公钥')
  }
  return { pub, der }
}

// user_id 由公钥派生 —— 同一把私钥永远回到同一账号，服务端不需要记住映射
export function userIdFromDer (der) {
  return 'u' + crypto.createHash('sha256').update(der).digest('hex').slice(0, 16)
}

export function register ({ pubkey, display }) {
  const { der } = parsePublicKey(pubkey)
  const userId = userIdFromDer(der)
  const name = String(display || '').trim().slice(0, 24) || '无名旅者'
  const d = get()
  const existing = d.prepare('SELECT user_id FROM accounts WHERE pubkey = ?').get(Buffer.from(der).toString('base64'))
  const pubkeyB64 = Buffer.from(der).toString('base64')
  if (!existing) {
    d.prepare('INSERT INTO accounts (user_id, display, pubkey, created_at) VALUES (?,?,?,?)')
      .run(userId, name, pubkeyB64, Date.now())
    d.prepare('INSERT OR IGNORE INTO wallets (user_id, balance) VALUES (?, 0)').run(userId)
  } else {
    d.prepare('UPDATE accounts SET display = ? WHERE user_id = ?').run(name, existing.user_id)
  }
  const uid = existing ? existing.user_id : userId
  return { userId: uid, display: name, created: !existing }
}

export function issueChallenge (userId) {
  const d = get()
  const acc = d.prepare('SELECT user_id FROM accounts WHERE user_id = ?').get(userId)
  if (!acc) throw new HttpError(404, 'no_account', '该账号不存在，请先注册公钥')
  const nonce = crypto.randomBytes(18).toString('base64url')
  d.prepare('INSERT INTO challenges (nonce, user_id, expires_at, used) VALUES (?,?,?,0)')
    .run(nonce, userId, Date.now() + CHALLENGE_TTL)
  return { nonce, sign: SIG_PREFIX + nonce, expiresInMs: CHALLENGE_TTL }
}

export function verifyChallenge ({ userId, nonce, signature }) {
  const d = get()
  const ch = d.prepare('SELECT * FROM challenges WHERE nonce = ? AND user_id = ?').get(String(nonce || ''), String(userId || ''))
  if (!ch) throw new HttpError(400, 'bad_challenge', 'challenge 不存在')
  if (ch.used) throw new HttpError(400, 'challenge_used', 'challenge 已被使用（防重放）')
  if (ch.expires_at < Date.now()) throw new HttpError(400, 'challenge_expired', 'challenge 已过期')

  const acc = d.prepare('SELECT * FROM accounts WHERE user_id = ?').get(userId)
  if (!acc) throw new HttpError(404, 'no_account', '账号不存在')
  if (acc.banned) throw new HttpError(403, 'banned', '账号已被封禁')

  const { pub } = parsePublicKey(acc.pubkey)
  const sig = normalizeB64(signature)
  let ok = false
  try {
    ok = crypto.verify(null, Buffer.from(SIG_PREFIX + ch.nonce), pub, sig)
  } catch {
    ok = false
  }
  if (!ok) throw new HttpError(401, 'bad_signature', '签名校验失败')

  // 一次性使用，验签成功立刻标记
  d.prepare('UPDATE challenges SET used = 1 WHERE nonce = ?').run(ch.nonce)
  const token = crypto.randomBytes(32).toString('hex')
  d.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?,?,?,?)')
    .run(token, userId, Date.now() + SESSION_TTL, Date.now())

  return { token, userId, display: acc.display, expiresInMs: SESSION_TTL }
}

export function authenticate (req) {
  const h = req.headers.authorization || ''
  const m = /^Bearer\s+([\w-]{20,})$/.exec(h)
  if (!m) throw new HttpError(401, 'no_token', '缺少 Authorization: Bearer <token>')
  const d = get()
  const s = d.prepare('SELECT * FROM sessions WHERE token = ?').get(m[1])
  if (!s) throw new HttpError(401, 'bad_token', 'token 无效')
  if (s.expires_at < Date.now()) throw new HttpError(401, 'token_expired', 'token 已过期，请重新签名登录')
  const acc = d.prepare('SELECT * FROM accounts WHERE user_id = ?').get(s.user_id)
  if (!acc) throw new HttpError(401, 'no_account', '账号不存在')
  if (acc.banned) throw new HttpError(403, 'banned', '账号已被封禁')
  return { userId: acc.user_id, display: acc.display }
}
