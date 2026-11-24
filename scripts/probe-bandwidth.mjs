#!/usr/bin/env node
/**
 * 广播流量探针：量**每轮 game_update 的真实字节数**，并拆开看钱花在哪。
 *
 * 背景（2026-11-24）：用户问「帧同步不是只广播玩家操作吗，为什么流量这么大」。
 * 答案不在输入帧（16 字节/帧/人，base64 后 22 字符），而在宿主每轮广播的
 * **整份世界快照**里 —— 其中 `players[].snapshot`（开局装备快照）是最刺眼的
 * 一项：它只在开局需要一次，却跟着每轮广播重复 24 次/秒。
 *
 * 这个探针不猜：它拉起 `game/server/dist/index.js` 的真实 relay，塞进典型
 * 规模的装备，量 `JSON.stringify(getState())` 的 UTF-8 字节，并给出各字段
 * 的占比与 24 Hz 下的折算带宽。
 *
 * 跑法：pnpm build:server && node scripts/probe-bandwidth.mjs
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/* ---------------------------- 典型规模的装备 ---------------------------- */

/**
 * 一件典型装备。字段抄的是 `ItemInstance` / `PlacedItem` 的真实形状：
 * 实例属性（uid / 耐久 / 词条 / 掷好的伤害）+ 悬停卡展示副本（品质 / 类型）
 * + 背包位置。一件约 250–320 字节，和真实存档一个量级。
 */
function item(i, container) {
  return {
    uid: `i-17-${(i * 7919).toString(16)}`,
    defId: String(10000 + i),
    durability: 88 - (i % 30),
    damage: 41 + i,
    quality: ['白', '绿', '蓝', '紫', '橙'][i % 5],
    itemType: 'weapon',
    weaponSubtype: ['巨剑', '长弓', '箭'][i % 3],
    damageMin: 38,
    damageMax: 62,
    affixes: [
      { id: 'sharp', value: 0.06 },
      { id: 'sturdy', value: 18 },
    ],
    container,
    col: i % 8,
    row: Math.floor(i / 8),
  }
}

/** 一局「带满装备」的典型 loadout：背包 12 件 + 身上 9 格 + 保险格 2 件。 */
function loadout() {
  return {
    bag: Array.from({ length: 12 }, (_, i) => item(i, 'bag')),
    stash: [],
    equipped: [
      item(20, 'equipped'),
      item(21, 'equipped'),
      item(22, 'equipped'),
      null,
      item(23, 'equipped'),
      item(24, 'equipped'),
      item(25, 'equipped'),
      item(26, 'equipped'),
      item(27, 'equipped'),
    ],
    activeWeaponSlot: 0,
    safe: [item(30, 'safe'), item(31, 'safe')],
  }
}

function peerSnapshot() {
  return {
    loadout: loadout(),
    hpMax: 132,
    manaMax: 80,
    starSkills: ['fireball', 'dash-cd', 'lifesteal', 'crit'],
  }
}

/* ------------------------------ 拉起 relay ------------------------------ */

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
  console.error('FAIL: dist/index.js 没有调用 createRuntime（先 pnpm build:server）')
  process.exit(1)
}

const HZ = 24
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const bytes = (value) => (value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value), 'utf8'))

/** 一次 16 字节定长帧的批量包（和 `input-frame.ts` 的布局一致）。 */
function batchBytes(count) {
  const out = new Uint8Array(3 + count * 16)
  out[0] = 0x02
  new DataView(out.buffer).setUint16(1, count, true)
  return Buffer.from(out).toString('base64')
}

async function measure(playerCount, settleMs = 450) {
  const players = Array.from({ length: playerCount }, (_, i) => ({
    id: `p${i}`,
    name: `玩家${i}`,
  }))
  const game = captured.createGame(players)
  game.start()
  // 每个人都上报一次开局快照（真实路径：`{ snapshot }` 上行，relay 存进名单）。
  for (const p of players) game.applyAction(p.id, { snapshot: peerSnapshot() })
  // 让帧钟跑几帧，窗口里有输入（这才是稳定态，不是刚开局的空窗口）。
  await sleep(250)
  for (const p of players) game.applyAction(p.id, { s: 0, b: batchBytes(6) })
  await sleep(settleMs)

  const snap = game.getState()
  const total = bytes(snap)
  const playerBytes = bytes(snap.players)
  const snapshotBytes = bytes(snap.players.map((p) => p.snapshot ?? null))
  const inputBytes = bytes(snap.inputs)
  // `hashes` 已不进广播（服务器内部对账用），所以这里量到 0 是预期结果。
  const hashBytes = bytes(snap.hashes)
  const statsBytes = bytes(snap.stats)
  const rest = total - playerBytes - inputBytes - hashBytes - statsBytes
  game.stop?.()
  return { playerCount, total, playerBytes, snapshotBytes, inputBytes, hashBytes, statsBytes, rest }
}

const rows = []
// 开局窗口内（frame < 240，快照跟着广播走）
rows.push(await measure(2))
// 开局窗口关闭之后（10.5 s ≈ 252 帧）：这才是稳态，也是用户感知到的「流量」
rows.push(await measure(2, 10500))
rows.push(await measure(16, 10500))

const kb = (b) => (b / 1024).toFixed(1)
const pct = (part, total) => `${((part / total) * 100).toFixed(1)}%`

console.log('\n每轮 game_update 的真实大小（JSON + UTF-8，和宿主序列化一致）\n')
console.log('人数   每轮      折 24 Hz   其中 players[]  其中 .snapshot   其中 inputs  其中 hashes  其中 stats')
for (const r of rows) {
  console.log(
    `${String(r.playerCount).padEnd(5)}${(kb(r.total) + 'KB').padEnd(11)}` +
    `${(kb(r.total * HZ) + 'KB/s').padEnd(11)}` +
    `${(kb(r.playerBytes) + 'KB').padEnd(16)}` +
    `${(kb(r.snapshotBytes) + 'KB').padEnd(17)}` +
    `${(kb(r.inputBytes) + 'KB').padEnd(12)}` +
    `${(kb(r.hashBytes) + 'KB').padEnd(12)}` +
    `${kb(r.statsBytes)}KB`,
  )
}

console.log('\n占比（2 人局）：')
const two = rows[0]
console.log(`  开局装备快照 players[].snapshot  ${kb(two.snapshotBytes)}KB  ${pct(two.snapshotBytes, two.total)}`)
console.log(`  输入帧窗口 inputs               ${kb(two.inputBytes)}KB  ${pct(two.inputBytes, two.total)}`)
console.log(`  对账指纹 hashes                 ${kb(two.hashBytes)}KB  ${pct(two.hashBytes, two.total)}`)
console.log(`  统计 stats                      ${kb(two.statsBytes)}KB  ${pct(two.statsBytes, two.total)}`)
console.log(`  其余（名单 / 帧号 / departed）    ${kb(two.rest)}KB  ${pct(two.rest, two.total)}`)

console.log('\n结论：')
console.log('  · 输入帧（定长 16B/帧/人）本来就不是大头：2 人局满窗也只占几个百分点。')
console.log('  · 「流量这么大」的真正来源是宿主每轮重发的**整份世界快照**里的开局装备快照，')
console.log('    它只在建远端影子时用一次，却跟着 24 Hz 广播重复了整局。')
console.log('  · 2026-11-24 起：快照只在开局 10 秒窗口内下发（之后按 `needSnapshot` 补发），')
console.log('    `hashes` 移出广播。回归判据就是上表的「稳态」两行 —— 2 人 ≤ 1KB/轮、16 人 ≤ 2KB/轮。')
console.log('  · 稳态 `inputs` 为 0 是因为探针最后没再发意图；真实对局里每个有操作的帧')
console.log('    每人约 22 字符（16B base64），满窗 4 帧 × 16 人 ≈ 1.4KB/轮。')
