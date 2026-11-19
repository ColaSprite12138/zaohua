// 云存档：粒度 = (user_id, slot)，一条记录一个 JSON payload
//
// 与造化平台对齐的部分：都是「账号 + 存档位」的粒度。
// 刻意补上的部分（造化没有的）：
//   1) rev 乐观锁 —— 造化 version 恒为 1，两端同时在线就是后写覆盖
//   2) 可枚举 —— 造化只有按 slot_id 取，没有列表接口
//   3) 可删除 —— 造化只支持 get/save 两种 action
//
// 存 payload 原文（TEXT）而不是拆字段：存档结构会随版本演进，服务端不做业务解释，
// 只保证「原样往返 + 字节数可审计」。

import { get } from './db.mjs'
import { HttpError } from './errors.mjs'

export const limits = {
  maxSlots: 20,
  maxPayloadBytes: 256 * 1024,
  slotPattern: /^[A-Za-z0-9_-]{1,32}$/
}

// 对外输出的版本：RegExp 直接 JSON.stringify 会变成 {}，必须给字符串
export const limitsInfo = {
  maxSlots: limits.maxSlots,
  maxPayloadBytes: limits.maxPayloadBytes,
  slotPattern: limits.slotPattern.source
}

function checkSlot (slot) {
  const s = String(slot ?? '').trim()
  if (!limits.slotPattern.test(s)) {
    throw new HttpError(400, 'bad_slot', '存档位只能包含字母、数字、下划线或短横线，长度 1–32')
  }
  return s
}

function serialize (payload) {
  if (payload === undefined) throw new HttpError(400, 'bad_payload', '缺少 payload')
  let text
  try {
    text = JSON.stringify(payload)
  } catch {
    throw new HttpError(400, 'bad_payload', 'payload 无法序列化为 JSON（含循环引用或 BigInt）')
  }
  if (text === undefined) throw new HttpError(400, 'bad_payload', 'payload 不能是函数或 undefined')
  const bytes = Buffer.byteLength(text)
  if (bytes > limits.maxPayloadBytes) {
    throw new HttpError(413, 'payload_too_large', `单份存档不能超过 ${Math.floor(limits.maxPayloadBytes / 1024)}KB（当前 ${Math.ceil(bytes / 1024)}KB）`)
  }
  return { text, bytes }
}

// 列表不带 payload，避免拉一次列表就把整份存档搬一遍
export function list (userId) {
  const rows = get()
    .prepare(`SELECT slot, rev, bytes, updated_at FROM saves WHERE user_id = ? ORDER BY updated_at DESC`)
    .all(userId)
  return rows.map((r) => ({ slot: r.slot, rev: r.rev, bytes: r.bytes, updatedAt: r.updated_at }))
}

export function getSlot (userId, slot) {
  const s = checkSlot(slot)
  const row = get()
    .prepare('SELECT slot, rev, payload, bytes, created_at, updated_at FROM saves WHERE user_id = ? AND slot = ?')
    .get(userId, s)
  if (!row) return { slot: s, rev: 0, payload: null, bytes: 0, updatedAt: null }
  let payload
  try {
    payload = JSON.parse(row.payload)
  } catch {
    // 理论上不会发生（写入前必然 stringify 过），真坏了要报出来而不是静默当空档
    throw new HttpError(500, 'corrupt_save', `存档位 ${s} 的内容已损坏，请联系管理员`)
  }
  return { slot: row.slot, rev: row.rev, payload, bytes: row.bytes, createdAt: row.created_at, updatedAt: row.updated_at }
}

// 写入。baseRev 用于乐观锁：
//   baseRev 省略  → 强制覆盖（首次上传 / 明确要覆盖）
//   baseRev 给出  → 必须等于服务端当前 rev，否则 409 并把服务端 rev 带回去
export function put (userId, slot, payload, baseRev) {
  const s = checkSlot(slot)
  const { text, bytes } = serialize(payload)
  const d = get()
  const now = Date.now()

  const existing = d.prepare('SELECT rev FROM saves WHERE user_id = ? AND slot = ?').get(userId, s)

  if (!existing) {
    const count = d.prepare('SELECT COUNT(*) AS c FROM saves WHERE user_id = ?').get(userId).c
    if (count >= limits.maxSlots) {
      throw new HttpError(409, 'slot_quota', `存档位已达上限 ${limits.maxSlots} 个，请先删除不用的`)
    }
    d.prepare(`INSERT INTO saves (user_id, slot, rev, payload, bytes, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?)`).run(userId, s, 1, text, bytes, now, now)
    return { slot: s, rev: 1, bytes, created: true, updatedAt: now }
  }

  if (baseRev !== undefined && baseRev !== null && Number(baseRev) !== existing.rev) {
    throw new HttpError(409, 'save_conflict', `存档已被其他设备更新（服务端 rev=${existing.rev}）`)
  }

  const rev = existing.rev + 1
  d.prepare('UPDATE saves SET rev = ?, payload = ?, bytes = ?, updated_at = ? WHERE user_id = ? AND slot = ?')
    .run(rev, text, bytes, now, userId, s)
  return { slot: s, rev, bytes, created: false, updatedAt: now }
}

export function remove (userId, slot) {
  const s = checkSlot(slot)
  const r = get().prepare('DELETE FROM saves WHERE user_id = ? AND slot = ?').run(userId, s)
  return { slot: s, deleted: Number(r.changes) > 0 }
}

export function usage (userId) {
  const row = get()
    .prepare('SELECT COUNT(*) AS slots, COALESCE(SUM(bytes),0) AS bytes FROM saves WHERE user_id = ?')
    .get(userId)
  return { slots: row.slots, bytes: row.bytes, limits: limitsInfo }
}
