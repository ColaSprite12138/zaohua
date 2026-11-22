#!/usr/bin/env node
/**
 * 服务器帧钟探针 —— 直接跑 `game/server/dist/index.js` 的真实产物，验证七条原理里
 * 最关键的几条**在产物上**成立，而不只是纯逻辑单测成立：
 *
 * 1. 帧号按墙钟自己推进，**不等任何客户端**（只让 A 交意图，B 一条都不交）。
 * 2. 客户端交的是意图、不带帧号；落在哪一帧由服务器决定。
 * 3. 缺席者的那些帧里没有他（读不到 = 空输入），不影响帧号推进。
 * 4. replay 能从全量历史里取回任意区间，且按 120 帧分块。
 *
 * 不需要平台宿主：mock 掉 `PlatformServer.stateSync.createRuntime` 拿到
 * `createGame`，然后自己像 runtime 那样调 start / applyAction / getState。
 *
 * 跑法：node scripts/probe-frame-clock.mjs
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/* ---------------------------- 手工构造输入帧 ---------------------------- */

const INPUT_FRAME_BYTES = 12

/** 12 字节定长帧：seq(u32) flags(u8) skill(u8) switch(u8) aux(u8) mouseX(i16) mouseY(i16)。 */
function encodeFrame(seq, flags = 0) {
  const buf = new Uint8Array(INPUT_FRAME_BYTES)
  const view = new DataView(buf.buffer)
  view.setUint32(0, seq >>> 0, true)
  view.setUint8(4, flags)
  view.setUint8(5, 255) // NO_SKILL
  view.setUint8(6, 255) // NO_SWITCH
  view.setUint8(7, 0)   // 没有鼠标
  return buf
}

/** PACKET_BATCH 批量包：`[0x02][u16 count][12B × count]`。 */
function encodeBatchBytes(frames) {
  const out = new Uint8Array(3 + frames.length * INPUT_FRAME_BYTES)
  out[0] = 0x02
  new DataView(out.buffer).setUint16(1, frames.length, true)
  frames.forEach((frame, i) => out.set(frame, 3 + i * INPUT_FRAME_BYTES))
  return out
}

function b64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------- 探针主体 ------------------------------- */

let captured = null
globalThis.PlatformServer = {
  stateSync: {
    createRuntime(options) {
      captured = options
    },
  },
}

await import(pathToFileURL(path.join(ROOT, 'game/server/dist/index.js')).href)
if (!captured) {
  console.error('FAIL: dist/index.js 没有调用 createRuntime')
  process.exit(1)
}

/** 与 game/server/source/index.ts::RECENT_FRAMES 保持一致。 */
const RECENT = 6

const players = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
const game = captured.createGame(players)
const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}${detail === undefined ? '' : `  ${detail}`}`)
}

game.start()

// ---- 1) 只让 A 交意图，B 完全不交，帧号必须照样走 ----
// 先给 A 五条意图（模拟客户端每 3 帧发一批）。
game.applyAction('a', { s: 0, b: b64(encodeBatchBytes([0, 1, 2, 3, 4].map((seq) => encodeFrame(seq, 1)))) })

// 先趁意图还在窗口里（窗口只有 12 帧 ≈ 200ms）看它们有没有被贴上。
await sleep(100)
const sEarly = game.getState()
const earlyTicks = Object.keys(sEarly.inputs).map(Number).sort((x, y) => x - y)
const earlyA = earlyTicks.filter((t) => sEarly.inputs[String(t)].a)
check('A 的意图确实被贴进广播窗口', earlyA.length > 0, `A 命中 ${earlyA.length} 帧`)

await sleep(300)
const s1 = game.getState()
check('帧号按墙钟自行推进（400ms 应 ≈ 20~32 帧）', s1.frame >= 15 && s1.frame <= 40, `frame=${s1.frame}`)

// ---- 2) A 的意图被贴到了具体帧上，B 一帧都没有 ----
const ticks = Object.keys(s1.inputs).map(Number).sort((x, y) => x - y)
const aTicks = ticks.filter((t) => s1.inputs[String(t)].a)
const bTicks = ticks.filter((t) => s1.inputs[String(t)].b)
check('B 没有意图就不出现在那些帧里（= 空输入）', bTicks.length === 0, `B 命中 ${bTicks.length} 帧`)
check('窗口覆盖每一帧（含全员空帧），客户端才推得动',
  ticks.length === Math.min(RECENT, s1.frame + 1), `窗口 ${ticks.length} 帧 / frame=${s1.frame}`)
check('广播窗口只保留最近一段（<= RECENT_FRAMES）', ticks.length <= RECENT, `窗口 ${ticks.length} 帧`)
check('广播里有当前帧号字段且与窗口一致', typeof s1.frame === 'number' && s1.frame >= Math.max(...ticks),
  `frame=${s1.frame} maxTick=${Math.max(...ticks)}`)

// ---- 3) 顺序：A 的 5 条意图按 seq 递增贴在连续帧上 ----
const seqOrder = earlyA.map((t) => {
  const packet = sEarly.inputs[String(t)].a
  const bytes = Buffer.from(packet.b, 'base64')
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)
})
const monotonic = seqOrder.every((value, i) => i === 0 || value > seqOrder[i - 1])
check('同一玩家的意图按到达顺序贴帧（seq 单调递增）', monotonic, JSON.stringify(seqOrder))

// ---- 4) replay：从全量历史取任意区间，分块 120 帧 ----
game.applyAction('a', { replay: { from: 0, to: 9999 } })
const s2 = game.getState()
const reply = s2.reply && s2.reply.a
check('replay 请求得到回包', Boolean(reply), reply ? `seq=${reply.seq}` : 'no reply')
if (reply) {
  // 当前帧号远小于 120，所以这一块被「历史还没到」截断，more 必须是 false，
  // done 必须等于当前帧号 —— 报大了客户端会以为补齐而不重试。
  check('回包按 120 帧分块，done 不超过当前帧号', reply.data.length <= 120 && reply.done <= s2.frame,
    `data=${reply.data.length} more=${reply.more} done=${reply.done} frame=${s2.frame}`)
  check('历史还没走到请求终点时 more=false（客户端据此等广播而不是死循环重试）',
    reply.more === false, `more=${reply.more}`)
  // 第二块从 120 起。
  game.applyAction('a', { replayAck: reply.seq })
  const s3 = game.getState()
  check('ack 之后回包被删掉（不然每轮广播都重带）', !s3.reply.a)
  // 分块语义：先攒够历史，再请求一个跨块的区间。
  await sleep(2500)
  const grown = game.getState().frame
  game.applyAction('a', { replay: { from: 0, to: grown } })
  const s4 = game.getState()
  const second = s4.reply && s4.reply.a
  check('一块最多 120 帧（每帧都有一条，空帧也算），超出用 more=true 续取',
    Boolean(second) && second.data.length === 120 && second.more === true && second.done === 119,
    second ? `data=${second.data.length} more=${second.more} done=${second.done} frame=${grown}` : 'no chunk')
}

// ---- 5) 不认的载荷只计数，不炸 ----
game.applyAction('a', { nonsense: true })
const s5 = game.getState()
check('畸形载荷只记 badPackets，不抛异常', s5.stats.badPackets >= 1, `badPackets=${s5.stats.badPackets}`)

// ---- 6) 帧钟频率：去掉 400ms 那段的误差，再量 600ms ----
const before = game.getState().frame
await sleep(600)
const after = game.getState().frame
const hz = (after - before) / 0.6
check('帧钟约 60 Hz（误差 ±15%）', hz > 51 && hz < 69, `${hz.toFixed(1)} Hz`)

// ---- 7) 最纯粹的一条：**零输入**下也必须严格 60 Hz、帧号连续 ----
// 这一组刻意不调任何 applyAction —— 一个客户端都没交东西，甚至一个都没连上。
// 只要它还在这里按 60 Hz 推进，「绝不等待客户端」就成了结构事实而不是口号。
const solo = captured.createGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])
solo.start()
await sleep(300)
const zeroFrom = solo.getState().frame
const zeroAt = Date.now()
await sleep(3000)
const zeroTo = solo.getState().frame
const zeroElapsed = (Date.now() - zeroAt) / 1000
const zeroHz = (zeroTo - zeroFrom) / zeroElapsed
check('零输入 3 秒仍严格 ~60 Hz（没有任何客户端在喂它）',
  zeroHz >= 56 && zeroHz <= 64, `${zeroHz.toFixed(1)} Hz, frame ${zeroFrom}→${zeroTo}`)

const zeroTicks = Object.keys(solo.getState().inputs).map(Number).sort((x, y) => x - y)
const gapless = zeroTicks.every((t, i) => i === 0 || t === zeroTicks[i - 1] + 1)
check('帧号连续无空洞（帧号是自增整数，不按墙钟算）', gapless, `窗口 ${zeroTicks.length} 帧`)
check('广播窗口仍覆盖满 RECENT_FRAMES 帧（空帧也算条目）', zeroTicks.length === RECENT, `窗口 ${zeroTicks.length} 帧`)
check('窗口最大值 = 当前帧号', Math.max(...zeroTicks) === solo.getState().frame,
  `max=${Math.max(...zeroTicks)} frame=${solo.getState().frame}`)
// 全员空帧：每条 bucket 都必须是空对象，而不是缺 key。
const allEmpty = zeroTicks.every((t) => Object.keys(solo.getState().inputs[String(t)]).length === 0)
check('全员空帧时条目在、但里面没有玩家（= 空输入，不是「缺帧」）', allEmpty)
solo.stop()

// ---- 8) 反向证明：客户端**多交**意图也不能让帧钟变快 ----
// 帧号只由服务器的时间决定。堆输入既不能插队也不能加速 —— 它们只在后续帧里
// 一帧一条地被贴出去，多出来的就排队等着。
const spam = captured.createGame([{ id: 'a', name: 'A' }])
spam.start()
await sleep(120)
const spamFrom = spam.getState().frame
const spamAt = Date.now()
// 36 条，低于 MAX_PENDING_PER_PLAYER(40)，所以一条都不会被丢。
for (let sent = 0; sent < 36; sent += 12) {
  const frames = []
  for (let j = 0; j < 12; j += 1) frames.push(encodeFrame(sent + j, 0))
  spam.applyAction('a', { s: sent, b: b64(encodeBatchBytes(frames)) })
}
await sleep(200)
const spamMid = spam.getState()
check('灌 36 条意图不能让帧钟变快（帧号只由时间决定）',
  spamMid.frame - spamFrom <= 20, `200ms 只走了 ${spamMid.frame - spamFrom} 帧`)
check('多余的意图排队等后续帧，不插队也不丢',
  spamMid.stats.submitted === 36 && spamMid.stats.dropped === 0 && spamMid.stats.applied < 36,
  `submitted=${spamMid.stats.submitted} applied=${spamMid.stats.applied} dropped=${spamMid.stats.dropped}`)
await sleep(600)
const spamDone = spam.getState()
const spamHz = (spamDone.frame - spamFrom) / ((Date.now() - spamAt) / 1000)
check('灌包之后整体速率仍回到 ~60 Hz', spamHz >= 52 && spamHz <= 68, `${spamHz.toFixed(1)} Hz`)
check('积压按帧消化完（applied 追上 submitted）', spamDone.stats.applied === 36,
  `applied=${spamDone.stats.applied}`)
spam.stop()

// ---- 9) 带宽实测：一次广播的 JSON 有多大 ----
// 这决定了「降帧率」到底省多少。注意大头往往不是帧数，而是每个 playerId
// 在每一帧里都要重复一遍（UUID 36 字符 × 人数 × 帧数）。
const wire = JSON.stringify(game.getState())
const perBroadcast = wire.length
const broadcastHz = 1000 / 42
console.log(`\n[带宽] 一次广播 JSON = ${perBroadcast} 字符`)
console.log(`[带宽] 2 人局 ≈ ${(perBroadcast * broadcastHz / 1024).toFixed(1)} KB/s`
  + `（16 人按人数线性放大 ≈ ${(perBroadcast * 8 * broadcastHz / 1024).toFixed(0)} KB/s）`)

game.stop()
const failed = results.filter((r) => !r.pass)
console.log(`\n${failed.length === 0 ? '全部通过' : `${failed.length} 项失败`}（${results.length} 项）`)
process.exit(failed.length === 0 ? 0 : 1)
