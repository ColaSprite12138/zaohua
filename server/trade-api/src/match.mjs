// 撮合：把「有人」变成「同一间房」。
//
// 为什么撮合必须在我们自己的服务器上：
//   造化的房间是「客户端建房、平台托管」——文档明确写了 public matchmaking 不在平台能力内，
//   而且平台不给第三方可验签的身份（user.id 来自宿主 postMessage，客户端可伪造）。
//   所以这里只当「导演」：决定谁建房、谁加入、什么时候开。房间本身仍归平台，
//   我们从不创建房间，也拿不到房间的准入 token。
//
// 规则（用户 2026-11-20 拍板）：
//   · 满 4 人立即开局，取当前队列全部（上限 16，平台房间上限）
//   · 不足 4 人时，最久等待者等满 60s 且队列 >= 2 人 → 开局
//   · 只有 1 个人等满 60s 不成局，由客户端提示「继续等 / 取消」
//   · 一人同时只有一张票；版本（ruleset）不同的人配不到一起
//
// 状态机：
//   queued ──凑够 4 人或等满 60s──▶ formed（等 host 建房，15s）
//        ──host 回报 roomId────────▶ ready（等全员 seated，20s）
//        ──全员 seated─────────────▶ playing ──游戏结束──▶ closed
//   任一环节失败/超时：失败方直接出队，其他人「回队一次」重新匹配，第二次失败才出队。
//
// 为什么是短轮询而不是 WebSocket：
//   排队阶段的延迟预算是「秒」，不是「帧」；1s 轮询足够，且零依赖（不用手写 RFC6455 握手）。
//   等 P1 真机联调出现请求量问题，再换成长轮询或 WS，接口形状不用变。

import crypto from 'node:crypto'
import { get, tx } from './db.mjs'
import { HttpError } from './errors.mjs'

export const limits = {
  waitMs: 60_000,          // 不足 4 人时的兜底等待
  formAt: 4,               // 满几人立即开局
  maxPlayers: 16,          // 一局上限（平台房间上限）
  roomDeadlineMs: 15_000,  // formed → host 必须在这个时间内回报 roomId
  seatDeadlineMs: 20_000,  // ready → 全员必须在这个时间内入座
  maxRequeue: 1,           // 被连累的人最多回队几次
  maxKeepWaiting: 10       // 「继续等」最多按几次，防止无限占位
}

const MODES = new Set(['extract'])
const RULESET_RE = /^[A-Za-z0-9._:+-]{1,64}$/

function checkMode (m) {
  const s = String(m || '').trim()
  if (!MODES.has(s)) throw new HttpError(400, 'bad_mode', '不支持的匹配模式')
  return s
}

// ruleset = 构建 hash / 规则表版本。不同版本进不同队列，
// 否则两端各跑一套数值，帧同步第一帧就分叉。
function checkRuleset (r) {
  const s = String(r || '').trim()
  if (!RULESET_RE.test(s)) throw new HttpError(400, 'bad_ruleset', 'ruleset 格式不合法')
  return s
}

const newId = (prefix) => prefix + crypto.randomBytes(8).toString('hex')
const newSeed = () => crypto.randomInt(1, 2 ** 31 - 1)

function ticketRow (id) {
  return get().prepare('SELECT * FROM match_tickets WHERE id = ?').get(id)
}

function activeTicketOf (userId) {
  return get().prepare(
    `SELECT * FROM match_tickets
      WHERE user_id = ? AND state IN ('queued','formed','ready','seated')`
  ).get(userId)
}

function memberRows (matchId) {
  return get().prepare(
    `SELECT * FROM match_tickets WHERE match_id = ? ORDER BY
       CASE role WHEN 'host' THEN 0 ELSE 1 END, rowid`
  ).all(matchId)
}

/**
 * 对外视图。roomId / roomCode 只给这个 match 的成员 —— 房间在平台的目录里是公开的，
 * 谁能 join 全靠这两个值不外泄（外加建房时设的房间密码）。
 */
function view (t, now = Date.now()) {
  if (!t) return null
  const m = t.match_id
    ? get().prepare('SELECT * FROM matches WHERE id = ?').get(t.match_id)
    : null
  const members = m ? memberRows(m.id) : []
  return {
    ticketId: t.id,
    state: t.state,
    mode: t.mode,
    ruleset: t.ruleset,
    role: t.role || null,
    waitedMs: t.state === 'queued' ? Math.max(0, now - t.wait_started_at) : 0,
    canKeepWaiting: t.state === 'queued' && now - t.wait_started_at >= limits.waitMs,
    requeues: t.requeues,
    match: m
      ? {
          id: m.id,
          state: m.state,
          seed: m.seed,
          roomId: m.room_id || null,
          roomCode: m.room_code || null,
          deadline: m.deadline || null,
          createdAt: m.created_at,
          closeReason: m.close_reason || null,
          members: members.map((x) => ({
            userId: x.user_id,
            role: x.role,
            state: x.state
          }))
        }
      : null
  }
}

// ============ 排队 ============

/** 入队。同一账号重复调用返回同一张票（幂等），不会插两条。 */
export function enqueue ({ userId, mode, ruleset, now = Date.now() }) {
  const m = checkMode(mode)
  const r = checkRuleset(ruleset)

  const existing = activeTicketOf(userId)
  if (existing) return view(existing, now)

  const id = newId('mt')
  get().prepare(
    `INSERT INTO match_tickets
       (id, user_id, mode, ruleset, state, match_id, role, seed, requeues, wait_started_at, created_at, updated_at)
     VALUES (?,?,?,?,'queued',NULL,NULL,NULL,0,?,?,?)`
  ).run(id, userId, m, r, now, now, now)

  tryForm(m, r, now)
  return view(ticketRow(id), now)
}

/**
 * 把队列里「该开局的那些人」配成一局。
 * 一条规则一个入口，入队与定时器都走它，避免两处判定不一致。
 */
export function tryForm (mode, ruleset, now = Date.now()) {
  const rows = get().prepare(
    `SELECT * FROM match_tickets
      WHERE state = 'queued' AND mode = ? AND ruleset = ?
      ORDER BY wait_started_at, rowid`
  ).all(mode, ruleset)
  if (!rows.length) return null

  const oldestWait = now - rows[0].wait_started_at
  const enoughPeople = rows.length >= limits.formAt
  const waitedEnough = rows.length >= 2 && oldestWait >= limits.waitMs
  if (!enoughPeople && !waitedEnough) return null

  const picked = rows.slice(0, limits.maxPlayers)
  const matchId = newId('m')
  const seed = newSeed()
  const deadline = now + limits.roomDeadlineMs

  tx((d) => {
    d.prepare(
      `INSERT INTO matches (id, mode, ruleset, seed, state, room_id, room_code, deadline, created_at, updated_at, close_reason)
       VALUES (?,?,?,?,'formed',NULL,NULL,?,?,?,NULL)`
    ).run(matchId, mode, ruleset, seed, deadline, now, now)

    const upd = d.prepare(
      `UPDATE match_tickets
          SET match_id = ?, role = ?, seed = ?, state = 'formed', updated_at = ?
        WHERE id = ?`
    )
    // 最久等待者建房：FIFO 是唯一不需要额外公平性机制的分法。
    // 并列时用 rowid（插入顺序）而不是 id（随机 hex），否则同一毫秒入队的两个人
    // 谁当建方是随机的 —— 同一张图不同的人建房，出问题无法复现。
    picked.forEach((row, i) => upd.run(matchId, i === 0 ? 'host' : 'guest', seed, now, row.id))
  })
  return matchId
}

/** 「继续等」：重置 60s 计时。只能按 maxKeepWaiting 次，避免一直占着排队位。 */
export function keepWaiting ({ userId, ticketId, now = Date.now() }) {
  const t = requireOwnTicket(userId, ticketId)
  if (t.state !== 'queued') throw new HttpError(409, 'not_queued', '这张票已经不在排队中了')
  if (t.keep_waits >= limits.maxKeepWaiting) {
    throw new HttpError(429, 'keep_waiting_exhausted', '继续等次数过多，请重新匹配')
  }
  // 不复用 requeues —— 那一列是「被连累」，和「我主动继续等」是两件事，混用会让统计失真
  get().prepare(
    'UPDATE match_tickets SET wait_started_at = ?, keep_waits = keep_waits + 1, updated_at = ? WHERE id = ?'
  ).run(now, now, t.id)
  return view(ticketRow(t.id), now)
}

// ============ 查询 ============

export function getTicket ({ userId, ticketId, now = Date.now() }) {
  const t = requireOwnTicket(userId, ticketId)
  return view(t, now)
}

/** 当前账号还没结束的那张票（页面刷新后自动回到排队/房间）。没票返回 null。 */
export function currentTicket ({ userId, now = Date.now() }) {
  return view(activeTicketOf(userId), now)
}

function requireOwnTicket (userId, ticketId) {
  const t = ticketRow(String(ticketId || ''))
  if (!t) throw new HttpError(404, 'ticket_not_found', '没有这张匹配票')
  if (t.user_id !== userId) throw new HttpError(403, 'not_your_ticket', '这不是你的匹配票')
  return t
}

// ============ 房间与入座 ============

/** host 建好房以后回报 roomId。客方靠这个值 join，所以只允许 host 调一次（同值幂等）。 */
export function reportRoom ({ userId, matchId, roomId, roomCode, now = Date.now() }) {
  const m = requireMatch(matchId)
  const t = get().prepare('SELECT * FROM match_tickets WHERE match_id = ? AND user_id = ?').get(m.id, userId)
  if (!t) throw new HttpError(403, 'not_in_match', '你不在这一局里')
  if (t.role !== 'host') throw new HttpError(403, 'not_host', '只有建方才回报房间号')

  const rid = String(roomId || '').trim()
  if (!rid || rid.length > 128) throw new HttpError(400, 'bad_room_id', 'roomId 不合法')
  if (m.state === 'ready' || m.state === 'playing') {
    if (m.room_id !== rid) throw new HttpError(409, 'room_changed', '这一局已经绑定了别的房间')
    return view(ticketRow(t.id), now)
  }
  if (m.state !== 'formed') throw new HttpError(409, 'match_closed', '这一局已经结束')

  const code = roomCode == null ? null : String(roomCode).trim().slice(0, 32)
  get().prepare(
    `UPDATE matches SET state = 'ready', room_id = ?, room_code = ?, deadline = ?, updated_at = ?
      WHERE id = ?`
  ).run(rid, code, now + limits.seatDeadlineMs, now, m.id)
  // 票的状态跟着局走：客户端只看 ticket.state 就能判断「该建房 / 该 join / 该进局」，
  // 不用自己拼 match.state 与 role 的组合。
  get().prepare(
    "UPDATE match_tickets SET state = 'ready', updated_at = ? WHERE match_id = ? AND state = 'formed'"
  ).run(now, m.id)
  return view(ticketRow(t.id), now)
}

/** 入座上报。全员到齐才进 playing —— 少一个人就开，等于少一个人打。 */
export function reportSeated ({ userId, matchId, now = Date.now() }) {
  const m = requireMatch(matchId)
  const t = get().prepare('SELECT * FROM match_tickets WHERE match_id = ? AND user_id = ?').get(m.id, userId)
  if (!t) throw new HttpError(403, 'not_in_match', '你不在这一局里')
  if (m.state !== 'ready' && m.state !== 'playing') {
    throw new HttpError(409, 'room_not_ready', '房间还没就绪，先等建方回报房间号')
  }

  get().prepare("UPDATE match_tickets SET state = 'seated', updated_at = ? WHERE id = ?").run(now, t.id)

  const pending = get().prepare(
    "SELECT COUNT(*) AS c FROM match_tickets WHERE match_id = ? AND state != 'seated'"
  ).get(m.id).c
  if (pending === 0 && m.state === 'ready') {
    get().prepare("UPDATE matches SET state = 'playing', deadline = NULL, updated_at = ? WHERE id = ?")
      .run(now, m.id)
  }
  return view(ticketRow(t.id), now)
}

// ============ 失败与退出 ============

/** 主动取消。已经入座的不能「取消」，那是掉线（由游戏侧的托管/踢人处理）。 */
export function cancel ({ userId, ticketId, now = Date.now() }) {
  const t = requireOwnTicket(userId, ticketId)
  if (t.state === 'seated') throw new HttpError(409, 'already_seated', '已经入座，不能取消匹配')
  if (t.state === 'left' || t.state === 'done') return view(t, now)

  if (t.match_id) {
    abortMatch(t.match_id, { byUserId: userId, reason: 'cancelled', now })
  } else {
    get().prepare("UPDATE match_tickets SET state = 'left', updated_at = ? WHERE id = ?").run(now, t.id)
  }
  return view(ticketRow(t.id), now)
}

/** 客户端报「我这步失败了」（建房失败、join 失败、进局报错）。 */
export function abort ({ userId, matchId, reason, now = Date.now() }) {
  const m = requireMatch(matchId)
  const t = get().prepare('SELECT * FROM match_tickets WHERE match_id = ? AND user_id = ?').get(m.id, userId)
  if (!t) throw new HttpError(403, 'not_in_match', '你不在这一局里')
  if (m.state === 'closed') return view(ticketRow(t.id), now)
  abortMatch(m.id, { byUserId: userId, reason: String(reason || 'failed').slice(0, 40), now })
  return view(ticketRow(t.id), now)
}

/**
 * 解散一局。
 *   · 失败方（byUserId）：直接出队，不给第二次 —— 否则坏网络会反复坑同一批人
 *   · 其他人：回队一次，计时重置（不会立刻又配到一起），第二次失败才出队
 */
export function abortMatch (matchId, { byUserId = null, reason = 'aborted', now = Date.now() } = {}) {
  const m = get().prepare('SELECT * FROM matches WHERE id = ?').get(matchId)
  if (!m || m.state === 'closed') return false

  tx((d) => {
    d.prepare("UPDATE matches SET state = 'closed', close_reason = ?, deadline = NULL, updated_at = ? WHERE id = ?")
      .run(reason, now, matchId)

    for (const t of d.prepare('SELECT * FROM match_tickets WHERE match_id = ?').all(matchId)) {
      if (t.state === 'seated') {
        // 已经进局的：只关票，不动房间 —— 房间的生死归平台
        d.prepare("UPDATE match_tickets SET state = 'done', updated_at = ? WHERE id = ?").run(now, t.id)
        continue
      }
      if (byUserId && t.user_id === byUserId) {
        d.prepare("UPDATE match_tickets SET state = 'left', updated_at = ? WHERE id = ?").run(now, t.id)
        continue
      }
      const next = t.requeues + 1
      if (next > limits.maxRequeue) {
        d.prepare("UPDATE match_tickets SET state = 'left', requeues = ?, updated_at = ? WHERE id = ?")
          .run(next, now, t.id)
      } else {
        d.prepare(
          `UPDATE match_tickets
              SET state = 'queued', match_id = NULL, role = NULL, requeues = ?,
                  wait_started_at = ?, updated_at = ?
            WHERE id = ?`
        ).run(next, now, now, t.id)
      }
    }
  })
  return true
}

function requireMatch (matchId) {
  const m = get().prepare('SELECT * FROM matches WHERE id = ?').get(String(matchId || ''))
  if (!m) throw new HttpError(404, 'match_not_found', '没有这一局')
  return m
}

// ============ 定时推进 ============

/**
 * 每 500ms 由 server.mjs 调一次。
 * 之所以要有定时器：4 人立即开局可以在入队时判定，但「等满 60s」和「超时解散」
 * 都需要有人在没有请求的时候推进 —— 否则队列里最后两个人永远等不到开局。
 */
export function tick (now = Date.now()) {
  const out = { formed: [], aborted: [] }

  const groups = get().prepare(
    "SELECT DISTINCT mode, ruleset FROM match_tickets WHERE state = 'queued'"
  ).all()
  for (const g of groups) {
    const id = tryForm(g.mode, g.ruleset, now)
    if (id) out.formed.push(id)
  }

  const overdue = get().prepare(
    "SELECT id FROM matches WHERE state IN ('formed','ready') AND deadline IS NOT NULL AND deadline <= ?"
  ).all(now)
  for (const m of overdue) {
    if (abortMatch(m.id, { reason: 'timeout', now })) out.aborted.push(m.id)
  }

  return out
}

/** 清理 24 小时前的历史记录（票与局），避免表无限增长。 */
export function sweep (now = Date.now()) {
  const cutoff = now - 24 * 3600 * 1000
  return tx((d) => {
    const a = d.prepare("DELETE FROM match_tickets WHERE updated_at < ? AND state IN ('left','done')").run(cutoff)
    const b = d.prepare("DELETE FROM matches WHERE updated_at < ? AND state = 'closed'").run(cutoff)
    return Number(a.changes) + Number(b.changes)
  })
}

export function stats () {
  const d = get()
  return {
    queued: d.prepare("SELECT COUNT(*) AS c FROM match_tickets WHERE state = 'queued'").get().c,
    playing: d.prepare("SELECT COUNT(*) AS c FROM matches WHERE state = 'playing'").get().c,
    limits
  }
}
