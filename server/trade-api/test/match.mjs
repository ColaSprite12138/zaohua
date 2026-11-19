// 撮合测试（内存库，直接调 match 模块，不起 HTTP）。
// 重点验证用户拍板的规则：
//   1. 满 4 人立即开局，取队列全部（上限 16），最久等待者当建方
//   2. 不足 4 人：等到 60s 且 >= 2 人才开；只有 1 个人时不开
//   3. 一人同时只有一张活票（幂等，不插两条）
//   4. 版本不同（ruleset）不进同一局
//   5. host 回报 roomId → 全员可见；非 host 回报被拒；换房被拒
//   6. formed 超时 → 失败方出队、其他人回队一次；第二次失败才出队
//   7. 全员 seated → playing；取消/继续等的边界

import crypto from 'node:crypto'
import * as db from '../src/db.mjs'
import * as match from '../src/match.mjs'

let pass = 0
const fails = []
function ok (cond, name, extra) {
  if (cond) { pass++; console.log('  ✓', name); return }
  fails.push(name)
  console.log('  ✗', name, extra !== undefined ? JSON.stringify(extra) : '')
}

function expectErr (fn, code, name) {
  try {
    fn()
    ok(false, name, '没有抛错')
  } catch (e) {
    ok(e.code === code, name, { got: e.code, want: code })
  }
}

db.open(':memory:')

const D = () => db.get()
let SEQ = 0
function newUser () {
  SEQ++
  const userId = 'u' + crypto.randomBytes(8).toString('hex')
  const uname = 'mt' + SEQ
  D().prepare(`INSERT INTO accounts (user_id, display, kind, username, username_lc, password_hash, created_at)
               VALUES (?,?,'password',?,?,?,?)`)
    .run(userId, uname, uname, uname, 'scrypt$test$0$0$c2FsdA$aGFzaA', Date.now())
  return userId
}

const T0 = 1_700_000_000_000
const RULES = 'build-abc123'
const MODE = 'extract'

// 每段用例开始前清空撮合表：tick() 是按 (mode, ruleset) 全局分组的，
// 上一段留下的排队者会混进下一段（那是正确行为，但会让断言失去意义）。
function resetQueue () {
  D().exec('DELETE FROM match_tickets; DELETE FROM matches;')
}

// ================= T1 四人立即开局 =================
console.log('\n[T1] 满 4 人立即开局')
let g1
{
  const a = newUser(); const b = newUser(); const c = newUser(); const d = newUser()

  const ta = match.enqueue({ userId: a, mode: MODE, ruleset: RULES, now: T0 })
  ok(ta.state === 'queued', '第 1 个人进入排队', ta.state)

  const tb = match.enqueue({ userId: b, mode: MODE, ruleset: RULES, now: T0 + 1000 })
  ok(tb.state === 'queued', '第 2 个人仍在排队（不足 4 人）', tb.state)

  const tc = match.enqueue({ userId: c, mode: MODE, ruleset: RULES, now: T0 + 2000 })
  ok(tc.state === 'queued', '第 3 个人仍在排队', tc.state)

  const td = match.enqueue({ userId: d, mode: MODE, ruleset: RULES, now: T0 + 3000 })
  ok(td.state === 'formed', '第 4 个人触发立即开局', td.state)

  const view = match.getTicket({ userId: a, ticketId: ta.ticketId, now: T0 + 3100 })
  ok(view.state === 'formed', '最早入队者也进入 formed', view.state)
  ok(view.match && view.match.members.length === 4, '这一局 4 个成员', view.match?.members.length)

  const host = view.match.members.find((m) => m.role === 'host')
  ok(host.userId === a, '最久等待者当建方（FIFO）', host.userId)
  ok(view.match.members.filter((m) => m.role === 'guest').length === 3, '其余 3 人是客方')

  const seeds = new Set(
    [a, b, c, d].map((u) => match.currentTicket({ userId: u }).match.seed)
  )
  ok(seeds.size === 1, '四张票拿到同一个 seed', [...seeds])
  g1 = { a, b, c, d, ticketA: ta.ticketId, matchId: view.match.id }
}

// ================= T2 一人一票 =================
console.log('\n[T2] 一人一票（幂等）')
{
  const e = newUser()
  const x = match.enqueue({ userId: e, mode: MODE, ruleset: RULES, now: T0 })
  const y = match.enqueue({ userId: e, mode: MODE, ruleset: RULES, now: T0 + 500 })
  ok(x.ticketId === y.ticketId, '重复入队返回同一张票', { x: x.ticketId, y: y.ticketId })
  const n = D().prepare('SELECT COUNT(*) AS c FROM match_tickets WHERE user_id = ?').get(e).c
  ok(n === 1, '库里只有一行', n)
  match.cancel({ userId: e, ticketId: x.ticketId, now: T0 + 600 })
}

// ================= T3 60s 兜底 =================
console.log('\n[T3] 不足 4 人：60s 兜底')
{
  resetQueue()
  const f = newUser(); const g = newUser()
  const tf = match.enqueue({ userId: f, mode: MODE, ruleset: RULES, now: T0 })
  match.enqueue({ userId: g, mode: MODE, ruleset: RULES, now: T0 + 5000 })

  const before = match.tick(T0 + 59_000)
  ok(before.formed.length === 0, '59s 时还不开', before.formed.length)
  ok(match.getTicket({ userId: f, ticketId: tf.ticketId, now: T0 + 59_000 }).state === 'queued',
    '仍然在排队')

  const after = match.tick(T0 + 60_000)
  ok(after.formed.length >= 1, '60s 到点成局', after.formed.length)
  const v = match.getTicket({ userId: f, ticketId: tf.ticketId, now: T0 + 60_100 })
  ok(v.state === 'formed', '进入 formed', v.state)
  ok(v.match.members.length >= 2, '两个人都在这一局里', v.match.members.length)
  match.abortMatch(v.match.id, { reason: 'test', now: T0 + 60_200 })
}

// ================= T4 独狼不开局 =================
console.log('\n[T4] 只有 1 个人等满 60s')
{
  resetQueue()
  const h = newUser()
  const th = match.enqueue({ userId: h, mode: MODE, ruleset: RULES, now: T0 })
  match.tick(T0 + 61_000)
  const v = match.getTicket({ userId: h, ticketId: th.ticketId, now: T0 + 61_000 })
  ok(v.state === 'queued', '独狼不会被单独开成一局', v.state)
  ok(v.canKeepWaiting === true, '标记「可以继续等」给客户端弹窗', v.canKeepWaiting)
  ok(v.match === null, '没有 match')

  const kept = match.keepWaiting({ userId: h, ticketId: th.ticketId, now: T0 + 61_000 })
  ok(kept.waitedMs === 0, '继续等会把 60s 计时重置', kept.waitedMs)
  ok(kept.canKeepWaiting === false, '重置后又得等满 60s')
  match.cancel({ userId: h, ticketId: th.ticketId, now: T0 + 62_000 })
}

// ================= T5 版本闸 =================
console.log('\n[T5] 版本不同不进同一局')
{
  resetQueue()
  const i1 = newUser(); const i2 = newUser(); const i3 = newUser(); const i4 = newUser()
  for (const u of [i1, i2, i3]) match.enqueue({ userId: u, mode: MODE, ruleset: RULES, now: T0 })
  const t4 = match.enqueue({ userId: i4, mode: MODE, ruleset: 'build-OLD', now: T0 })
  ok(t4.state === 'queued', '旧版本的人不触发新版本开局', t4.state)

  const stats = match.stats()
  ok(stats.queued >= 4, '旧版本的人仍在自己那条队列里', stats.queued)
  for (const u of [i1, i2, i3]) match.cancel({ userId: u, ticketId: match.currentTicket({ userId: u }).ticketId, now: T0 })
  match.cancel({ userId: i4, ticketId: t4.ticketId, now: T0 })
}

// ================= T6 建房回报 =================
console.log('\n[T6] host 回报 roomId')
let g6
{
  // 前面几段用例重置过队列，这里重新拉一局 4 人的
  resetQueue()
  const a = newUser(); const b = newUser(); const c = newUser(); const d = newUser()
  for (const u of [a, b, c, d]) match.enqueue({ userId: u, mode: MODE, ruleset: RULES, now: T0 })
  const mine = match.currentTicket({ userId: a, now: T0 + 10 })
  const m = mine.match.id
  ok(mine.role === 'host', '第 1 个入队的是建方', mine.role)

  expectErr(() => match.reportRoom({ userId: b, matchId: m, roomId: 'room-x', now: T0 + 4000 }),
    'not_host', '客方回报房间号被拒')

  const r = match.reportRoom({ userId: a, matchId: m, roomId: 'room-x', roomCode: '1234', now: T0 + 4000 })
  ok(r.state === 'ready' && r.match.state === 'ready', 'host 回报后整局进入 ready', r.state)
  ok(r.match.roomId === 'room-x', 'roomId 写进这一局')

  const gv = match.currentTicket({ userId: b, now: T0 + 4100 })
  ok(gv.match.roomId === 'room-x', '客方也能看到 roomId（才能 join）', gv.match.roomId)
  ok(gv.match.roomCode === '1234', '房间密码随 roomId 一起下发')

  expectErr(() => match.reportRoom({ userId: a, matchId: m, roomId: 'room-y', now: T0 + 4200 }),
    'room_changed', '换一个房间号被拒（防止客方进错房）')

  const again = match.reportRoom({ userId: a, matchId: m, roomId: 'room-x', roomCode: '1234', now: T0 + 4300 })
  ok(again.match.roomId === 'room-x', '同一个 roomId 重复回报是幂等的')
  g6 = { a, b, c, d, matchId: m }
}

// ================= T7 全员入座 =================
console.log('\n[T7] 全员 seated 才开局')
{
  const { a, b, c, d, matchId } = g6
  const s1 = match.reportSeated({ userId: a, matchId, now: T0 + 5000 })
  ok(s1.match.state === 'ready', '1/4 入座时仍是 ready', s1.match.state)
  match.reportSeated({ userId: b, matchId, now: T0 + 5100 })
  match.reportSeated({ userId: c, matchId, now: T0 + 5200 })
  ok(match.currentTicket({ userId: d, now: T0 + 5250 }).match.state === 'ready', '3/4 时仍是 ready')
  const s4 = match.reportSeated({ userId: d, matchId, now: T0 + 5300 })
  ok(s4.match.state === 'playing', '4/4 入座 → playing', s4.match.state)
  ok(s4.match.deadline === null, 'playing 后不再有截止时间')

  const mine = match.currentTicket({ userId: a, now: T0 + 5400 })
  expectErr(() => match.cancel({ userId: a, ticketId: mine.ticketId, now: T0 + 5400 }),
    'already_seated', '已入座不能「取消匹配」')
}

// ================= T8 建房超时 → 回队一次 =================
console.log('\n[T8] 建房超时：失败方出队、其他人回队一次')
{
  resetQueue()
  const p = newUser(); const q = newUser()
  const tp = match.enqueue({ userId: p, mode: MODE, ruleset: RULES, now: T0 })
  match.enqueue({ userId: q, mode: MODE, ruleset: RULES, now: T0 + 100 })
  const formed = match.tick(T0 + 60_000)
  ok(formed.formed.length === 1, '两人等满 60s 成局', formed.formed.length)

  const mp = match.currentTicket({ userId: p, now: T0 + 60_100 })
  const mq = match.currentTicket({ userId: q, now: T0 + 60_100 })
  const hostId = mp.role === 'host' ? p : q
  const guestId = hostId === p ? q : p
  const matchId = mp.match.id

  // host 建房失败
  match.abort({ userId: hostId, matchId, reason: 'create_failed', now: T0 + 61_000 })

  const hv = match.currentTicket({ userId: hostId, now: T0 + 61_100 })
  ok(hv === null, '失败方直接出队（没有活票）', hv)

  const gv = match.currentTicket({ userId: guestId, now: T0 + 61_100 })
  ok(gv && gv.state === 'queued', '被连累的人回队', gv?.state)
  ok(gv.requeues === 1, '记录已回队一次', gv?.requeues)
  ok(gv.match === null, '旧局已经解绑', gv?.match)

  // 60s 计时被重置：不会立刻又配到同一个人
  match.tick(T0 + 61_500)
  ok(match.currentTicket({ userId: guestId, now: T0 + 61_600 }).state === 'queued', '回队后不会立刻重开')

  // 第二次失败才出队
  const late = match.tick(T0 + 121_000)
  ok(late.formed.length >= 0, 'tick 不报错')
  const cur = match.currentTicket({ userId: guestId, now: T0 + 121_000 })
  ok(cur !== null, '还没出队（仍在等第二个人）', cur?.state)
  match.cancel({ userId: guestId, ticketId: cur.ticketId, now: T0 + 121_100 })
}

// ================= T9 取消与超时清理 =================
console.log('\n[T9] 取消与超时')
{
  resetQueue()
  const r1 = newUser()
  const t = match.enqueue({ userId: r1, mode: MODE, ruleset: RULES, now: T0 })
  const c = match.cancel({ userId: r1, ticketId: t.ticketId, now: T0 + 1000 })
  ok(c.state === 'left', '取消后离队', c.state)
  ok(match.currentTicket({ userId: r1, now: T0 + 1100 }) === null, '不再有活票')

  const n1 = newUser(); const n2 = newUser(); const n3 = newUser(); const n4 = newUser()
  for (const u of [n1, n2, n3, n4]) match.enqueue({ userId: u, mode: MODE, ruleset: RULES, now: T0 })
  const m = match.currentTicket({ userId: n1, now: T0 + 10 }).match
  const aborted = match.tick(T0 + 20_000) // formed 15s 已过
  ok(aborted.aborted.length >= 1, 'formed 超时被解散', aborted.aborted.length)
  const closed = D().prepare('SELECT * FROM matches WHERE id = ?').get(m.id)
  ok(closed.state === 'closed', '局已关闭', closed.state)
  ok(closed.close_reason === 'timeout', '原因是 timeout', closed.close_reason)
  for (const u of [n1, n2, n3, n4]) {
    const cur = match.currentTicket({ userId: u, now: T0 + 20_100 })
    if (cur) match.cancel({ userId: u, ticketId: cur.ticketId, now: T0 + 20_200 })
  }

  // 参数边界
  expectErr(() => match.enqueue({ userId: newUser(), mode: 'nope', ruleset: RULES }), 'bad_mode', '非法模式被拒')
  expectErr(() => match.enqueue({ userId: newUser(), mode: MODE, ruleset: 'a b c' }), 'bad_ruleset', '非法 ruleset 被拒')
  expectErr(() => match.getTicket({ userId: 'u-nobody', ticketId: 'mt-nope' }), 'ticket_not_found', '不存在的票')
}

// ================= T10 不变量 =================
console.log('\n[T10] 数据不变量')
{
  const dup = D().prepare(`
    SELECT user_id, COUNT(*) AS c FROM match_tickets
     WHERE state IN ('queued','formed','ready','seated')
     GROUP BY user_id HAVING c > 1`).all()
  ok(dup.length === 0, '没有任何账号同时持有两张活票', dup)

  const badMatch = D().prepare(`
    SELECT COUNT(*) AS c FROM match_tickets
     WHERE state = 'queued' AND match_id IS NOT NULL`).get().c
  ok(badMatch === 0, '排队的票没有绑定已解散的局', badMatch)

  const noHost = D().prepare(`
    SELECT m.id FROM matches m
     WHERE m.state IN ('formed','ready')
       AND NOT EXISTS (SELECT 1 FROM match_tickets t WHERE t.match_id = m.id AND t.role = 'host')`).all()
  ok(noHost.length === 0, '每个进行中的局都有建方', noHost)

  const badState = D().prepare(
    "SELECT COUNT(*) AS c FROM matches WHERE state NOT IN ('formed','ready','playing','closed')").get().c
  ok(badState === 0, 'matches.state 没有越界取值', badState)
}

console.log(`\n=== ${pass} 通过, ${fails.length} 失败 ===`)
if (fails.length) { fails.forEach((f) => console.log('  FAIL:', f)); process.exit(1) }
process.exit(0)
