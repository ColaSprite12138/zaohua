// P2 双人真机验收：输入帧真的在两个人之间流动，且对方在我屏幕上走动。
//
// 与 `verify-two-player.mjs` 的区别：那条验的是「撮合成局 + 同房开局」（P1），
// 这条验的是「开局之后输入有没有通」（P2）。判据全是可读的数字，不靠肉眼看截图：
//   1. 两边的 `host.net.status()` 都 active，且 playerId 不同、非空；
//   2. 两边 sends > 0（本地帧真的送上去了）与 packetsIn > 0（对方的包真的下来了）；
//   3. 两边引擎的锁步 tick 都在涨（没卡在等齐上）；
//   4. A 走位之后，**B 的 remotes 里 A 的坐标变了** —— 这是「看得见对方」的硬证据；
//   5. 服务端没记到分叉（`diverged` 为空）。
//
// 用法：
//   MATCH_USER_A=.. MATCH_PASS_A=.. MATCH_USER_B=.. MATCH_PASS_B=.. \
//   node scripts/verify-two-player-net.mjs <previewUrl>
import { chromium } from './lib/playwright.mjs'

const PREVIEW = process.argv[2]
const API = 'https://api.colasprite.net'
const CHANNEL = 'forgeax-arena-run'
const A = { user: process.env.MATCH_USER_A, pass: process.env.MATCH_PASS_A }
const B = { user: process.env.MATCH_USER_B, pass: process.env.MATCH_PASS_B }
if (!PREVIEW || !A.user || !A.pass || !B.user || !B.pass) {
  console.error('用法: MATCH_USER_A=.. MATCH_PASS_A=.. MATCH_USER_B=.. MATCH_PASS_B=.. node scripts/verify-two-player-net.mjs <previewUrl>')
  process.exit(1)
}

async function login (who) {
  const res = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: who.user, password: who.pass }),
  })
  const body = await res.json()
  if (!res.ok || !body.token) throw new Error(`登录失败 ${who.user}: ${JSON.stringify(body)}`)
  return body
}

async function enter (browser, session) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  await page.goto(PREVIEW, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(5000)
  let frame = page.frames().find((f) => f.url().includes('serveVersion'))
  if (!frame) throw new Error('找不到游戏 iframe')

  await frame.evaluate((s) => localStorage.setItem('forgeax.session.v1', JSON.stringify(s)), {
    token: session.token,
    userId: session.userId,
    display: session.display || session.username,
    username: session.username,
    kind: 'account',
    expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
  })
  await frame.goto(frame.url(), { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(7000)
  frame = page.frames().find((f) => f.url().includes('serveVersion'))

  const gate = await frame.evaluate(() => {
    const g = document.getElementById('login-gate')
    if (!g || g.hidden) return 'absent'
    return document.getElementById('gate-resume-go') ? 'resume' : 'blocking'
  })
  if (gate === 'resume') {
    await frame.click('#gate-resume-go')
    await page.waitForTimeout(3500)
  }
  return { ctx, page, frame }
}

const readShell = (frame) => frame.evaluate(() => {
  const net = window.MetaShell && window.MetaShell.net
  return {
    label: document.getElementById('fx-match')?.textContent || '',
    status: document.getElementById('fx-match-status')?.textContent || '',
    inBattle: !!document.getElementById('fx-back') && !document.getElementById('fx-back').disabled,
    net: net ? net.status() : null,
  }
})

/** 通过 BroadcastChannel 读 Worker 的只读投影（remotes 在里面）。 */
const probe = (frame) => frame.evaluate((channelName) => new Promise((resolve) => {
  const ch = new BroadcastChannel(channelName)
  const requestId = Math.floor(Math.random() * 1e9)
  const done = (value) => {
    ch.removeEventListener('message', onMessage)
    ch.close()
    resolve(value)
  }
  const onMessage = (event) => {
    const msg = event.data
    if (!msg || msg.type !== 'state' || msg.requestId !== requestId) return
    done(msg)
  }
  ch.addEventListener('message', onMessage)
  ch.postMessage({ type: 'probe', requestId })
  setTimeout(() => done(null), 3000)
}), CHANNEL)

/**
 * 在平台预览的 iframe 里点一个「1280×720 逻辑坐标」。
 *
 * 不能直接 `page.mouse.click(1010, 430)`：外层 page 是造化宿主，游戏在 iframe
 * 里，iframe 与 canvas 都有各自的偏移/缩放。实测过一次，点击完全落空 ——
 * 两端 world 都停在出生点，看起来像「远端影子不同步」，其实是脚本没点中。
 * 这里只走换算后的真实 CDP 点击。曾经加过 iframe 内合成 DOM 事件兜底，
 * 结果反而把这次点击的边沿冲掉 —— 探针（scripts/probe-click-in-host.mjs）
 * 实测：CDP 点 (1010,478) 有效，紧接着派合成事件后玩家原地不动。
 */
async function clickWorld (entry, lx, ly) {
  const canvas = await entry.frame.evaluate(() => {
    const c = document.querySelector('canvas')
    if (!c) return null
    const r = c.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  let outer = null
  if (canvas) {
    const handle = await entry.frame.frameElement()
    const box = handle ? await handle.boundingBox() : null
    if (box) {
      const sx = box.x + canvas.x + lx * (canvas.w / 1280)
      const sy = box.y + canvas.y + ly * (canvas.h / 720)
      await entry.page.mouse.click(sx, sy)
      outer = { sx, sy }
    }
  }
  return { lx, ly, canvas, outer }
}

const sa = await login(A)
const sb = await login(B)
console.log(`[准备] 账号就绪：${sa.display} / ${sb.display}`)

const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const pa = await enter(browser, sa)
const pb = await enter(browser, sb)

await pa.frame.evaluate(() => document.getElementById('fx-match').click())
await pa.page.waitForTimeout(300)
await pb.frame.evaluate(() => document.getElementById('fx-match').click())
console.log('[入队] A / B 已点击「快速匹配」，等 60s 兜底成局…')

let seated = false
const deadline = Date.now() + 110000
while (Date.now() < deadline) {
  await pa.page.waitForTimeout(3000)
  try {
    const a = await readShell(pa.frame)
    const b = await readShell(pb.frame)
    if (a.inBattle && b.inBattle) { seated = true; break }
  } catch { /* iframe 可能在 reload */ }
}

const result = { seated, checks: [], before: null, after: null }
if (!seated) {
  await browser.close()
  console.log(JSON.stringify(result, null, 2))
  console.log('\n[FAIL] 110 秒内没有两人同时开局，P2 无从验起')
  process.exit(1)
}

// 开局之后给锁步几秒：本地帧要提前 3 tick 提交，服务端按 50ms 打包广播。
await pa.page.waitForTimeout(6000)

const shellA = await readShell(pa.frame)
const shellB = await readShell(pb.frame)
const probeA = await probe(pa.frame)
const probeB = await probe(pb.frame)

const remotesOnB = probeB?.state?.remotes ?? []
result.before = {
  A: { net: shellA.net, world: probeA?.state?.playerWorld, remotes: probeA?.state?.remotes },
  B: { net: shellB.net, world: probeB?.state?.playerWorld, remotes: remotesOnB },
}

// A 走两步（同一个已验证的空地落点，方向一致，净位移不会被抵消）。
// B 那边应该看到 A 的影子跟着动。
result.clickInfo = [
  await clickWorld(pa, 1010, 430),
]
await pa.page.waitForTimeout(1500)
result.clickInfo.push(await clickWorld(pa, 1010, 430))
await pa.page.waitForTimeout(2500)

const probeAAfter = await probe(pa.frame)
const probeBAfter = await probe(pb.frame)
const shellAAfter = await readShell(pa.frame)
const shellBAfter = await readShell(pb.frame)
result.after = {
  A: { net: shellAAfter.net, world: probeAAfter?.state?.playerWorld, remotes: probeAAfter?.state?.remotes },
  B: { net: shellBAfter.net, world: probeBAfter?.state?.playerWorld, remotes: probeBAfter?.state?.remotes },
}

await browser.close()

const idA = shellA.net?.playerId || 'A'
const idB = shellB.net?.playerId || 'B'
const findRemoteOf = (remotes, id) => (remotes || []).find((r) => r.id === id)
const movedBy = (from, to) => {
  if (!from || !to) return 0
  return Math.hypot(to.x - from.x, to.y - from.y)
}

const remoteAOnB0 = findRemoteOf(result.before?.B?.remotes, idA)
const remoteAOnB1 = findRemoteOf(result.after?.B?.remotes, idA)
const remoteBOnA0 = findRemoteOf(result.before?.A?.remotes, idB)
const remoteBOnA1 = findRemoteOf(result.after?.A?.remotes, idB)

const checks = [
  ['A 侧 relay 已接通（active 且拿到座号）', shellA.net?.active === true && Boolean(shellA.net?.playerId)],
  ['B 侧 relay 已接通（active 且拿到座号）', shellB.net?.active === true && Boolean(shellB.net?.playerId)],
  ['两边座号不同（不是自己在跟自己同步）', Boolean(idA) && Boolean(idB) && idA !== idB],
  ['A 真的把输入送出去了（sends > 0）', (shellAAfter.net?.sends || 0) > 0],
  ['B 真的把输入送出去了（sends > 0）', (shellBAfter.net?.sends || 0) > 0],
  ['A 收到了 B 的输入包（packetsIn > 0）', (shellAAfter.net?.packetsIn || 0) > 0],
  ['B 收到了 A 的输入包（packetsIn > 0）', (shellBAfter.net?.packetsIn || 0) > 0],
  ['A 的锁步 tick 在涨（没卡在等齐上）', (shellAAfter.net?.engine?.tick || 0) > 60],
  ['B 的锁步 tick 在涨（没卡在等齐上）', (shellBAfter.net?.engine?.tick || 0) > 60],
  ['B 的屏幕上出现了 A（remotes 里有 A 的座号）', Boolean(remoteAOnB0) || Boolean(remoteAOnB1)],
  ['点击真的驱动了 A 本人（排除脚本没点中）',
    movedBy(result.before?.A?.world, result.after?.A?.world) > 20],
  ['A 走位之后，B 看到的 A 坐标变了', movedBy(remoteAOnB0, remoteAOnB1) > 20],
  ['A 的屏幕上出现了 B（反向也通）', Boolean(remoteBOnA0) || Boolean(remoteBOnA1)],
  ['服务端没记到分叉', (shellBAfter.net?.divergedTick ?? -1) < 0],
]

let failed = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? '[ OK ]' : '[FAIL]'} ${label}`)
  if (!ok) failed += 1
}

console.log('')
console.log(JSON.stringify({
  ids: { A: idA, B: idB },
  A: result.after?.A,
  B: {
    net: result.after?.B?.net,
    world: result.after?.B?.world,
    remotes: result.after?.B?.remotes,
  },
  movedOfAOnB: movedBy(remoteAOnB0, remoteAOnB1),
  movedOfALocal: movedBy(result.before?.A?.world, result.after?.A?.world),
  clickInfo: result.clickInfo,
}, null, 2))
console.log(`\n=== ${checks.length - failed} 通过, ${failed} 失败 ===`)
process.exit(failed === 0 ? 0 : 1)
