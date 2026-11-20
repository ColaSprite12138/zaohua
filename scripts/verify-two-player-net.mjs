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
// §7 的验收口径是「双人跑 3 分钟」。默认只跑一轮点击回归（快），
// HOLD_MS=180000 时在点击判据之后再守 3 分钟，多采一组 tick / 分叉 / 补发。
const HOLD_MS = Number(process.env.HOLD_MS || 0)
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
  // 别用 `frames().find(f => f.url().includes('serveVersion'))`：宿主外壳的 URL
  // 也带 serveVersion，抓到它时 `login-gate` 是 null，门禁会被误判成「不用管」。
  let frame = await shellFrame(page)

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
  frame = await shellFrame(page)

  // `bootIdentity()` 一律 showGate(false)：有 session 也只是多给「继续进入」，
  // 不会自动放行。不点它，#login-gate 会一直铺满画布（display:flex /
  // pointer-events:auto / z-index:40），把**所有真实鼠标点击**吃掉。2026-11-21
  // 实测：程序化 element.click() 能绕过命中测试，于是 12 条网络判据全过、
  // 只有「点击驱动走位」两条挂，engine.localMouse / localEdges 恒为 0。
  const gate = await frame.evaluate(() => {
    const g = document.getElementById('login-gate')
    if (!g || g.hidden) return 'absent'
    const resume = document.getElementById('gate-resume')
    if (resume && !resume.hidden && document.getElementById('gate-resume-go')) return 'resume'
    if (document.getElementById('gate-guest')) return 'guest'
    return 'blocking'
  })
  if (gate === 'resume') await frame.click('#gate-resume-go')
  else if (gate === 'guest' || gate === 'blocking') await frame.click('#gate-guest')
  // attachCloudSave() 是异步的，hideGate() 在它之后；轮询等门帘真关掉。
  let closed = false
  for (let i = 0; i < 30 && !closed; i += 1) {
    await page.waitForTimeout(500)
    try {
      closed = await frame.evaluate(() => {
        const g = document.getElementById('login-gate')
        return !g || g.hidden
      })
    } catch { /* iframe 正在导航 */ }
  }
  if (!closed) throw new Error(`登录门禁没关掉（gate=${gate}）：真实点击会被 #login-gate 吞掉`)
  frame = await shellFrame(page)
  return { ctx, page, frame }
}

/** 旧 Frame 句柄可能在 iframe 重导航后失效；失效就重新找一帧，别直接判失败。 */
async function heal (entry) {
  try {
    const alive = await entry.frame.evaluate(() => Boolean(document.getElementById('fx-match')))
    if (alive) return entry.frame
  } catch { /* 句柄已失效 */ }
  entry.frame = await shellFrame(entry.page)
  return entry.frame
}

const readShell = async (entry) => (await heal(entry)).evaluate(() => {
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
 * 不用 `frame.click('canvas', {position})`：position 是 canvas 的 **CSS 像素**，
 * 而引擎按 `drawingBufferSize()` 把指针缩回 720 逻辑高。视口 800 高时逻辑
 * 478 对应 CSS 531，直接点 478 只落到逻辑 430（HUD / 小地图那一带）。
 * 用 `page.mouse.click` 打换算后的外层坐标才是实测有效的路径。
 *
 * 两条踩过的坑，别改回去：
 *  1. `#login-gate` 没关时它铺满画布（display:flex / pointer-events:auto /
 *     z-index:40）：frame.click 报「intercepts pointer events」，CDP 点击也
 *     落在门帘上，引擎 `localMouse` / `localEdges` 恒为 0。2026-11-21 实测。
 *  2. 别在 iframe 内派合成 DOM 事件兜底 —— 探针实测会把这次点击的边沿冲掉。
 */
async function clickWorld (entry, lx, ly) {
  const frame = await heal(entry)
  const geom = await frame.evaluate(() => {
    const c = document.querySelector('canvas')
    const r = c ? c.getBoundingClientRect() : null
    const g = document.getElementById('login-gate')
    return {
      canvas: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
      inner: { w: innerWidth, h: innerHeight },
      gateOpen: !!g && !g.hidden,
    }
  })
  if (geom.gateOpen) return { lx, ly, error: 'login-gate 仍然打开，点击会被吞掉' }
  if (!geom.canvas) return { lx, ly, error: '找不到 canvas' }
  let box = null
  try {
    const handle = await frame.frameElement()
    box = handle ? await handle.boundingBox() : null
  } catch { /* 句柄刚好被重导航换掉 */ }
  if (!box) return { lx, ly, error: '拿不到 iframe 的位置' }
  // iframe 内的 CSS 像素折进外层视口：宿主可能缩放 / 居中 iframe。
  const kx = box.width / (geom.inner.w || 1280)
  const ky = box.height / (geom.inner.h || 800)
  const sx = box.x + (geom.canvas.x + lx * (geom.canvas.w / 1280)) * kx
  const sy = box.y + (geom.canvas.y + ly * (geom.canvas.h / 720)) * ky
  await entry.page.mouse.move(sx, sy)
  await entry.page.mouse.click(sx, sy)
  return { lx, ly, canvas: geom.canvas, outer: { sx, sy }, kx, ky }
}

const sa = await login(A)
const sb = await login(B)
console.log(`[准备] 账号就绪：${sa.display} / ${sb.display}`)

/**
 * 重新定位「真正带壳层的那一帧」。
 *
 * 不能一直拿着 `enter()` 里抓到的 Frame：第二个客户端进来时宿主会**重新导航**
 * 第一个客户端的 iframe，旧 Frame 句柄指向的文档已经不是当前文档 —— 表现是
 * `getElementById('fx-match')` 返回 null（页面看起来一切正常）。2026-11-21 实测。
 */
async function shellFrame (page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      try {
        const ok = await f.evaluate(() => Boolean(document.getElementById('fx-match')))
        if (ok) return f
      } catch { /* 正在导航，换下一帧再试 */ }
    }
    await page.waitForTimeout(500)
  }
  throw new Error('找不到带 #fx-match 的帧：' + page.frames().map((f) => f.url().slice(0, 70)).join(' | '))
}

// headless 里两个窗口会互相遮挡，被遮住的那个 rAF 被节流 ⇒ 它一路落后、
// tick 差越拉越大，但状态其实没分叉。项目里已证的三件套参数先加上。
const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: [
    '--disable-backgrounding-occluded-windows',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ],
})
const pa = await enter(browser, sa)
const pb = await enter(browser, sb)

pa.frame = await shellFrame(pa.page)
pb.frame = await shellFrame(pb.page)

await pa.frame.evaluate(() => document.getElementById('fx-match').click())
await pa.page.waitForTimeout(300)
await pb.frame.evaluate(() => document.getElementById('fx-match').click())
console.log('[入队] A / B 已点击「快速匹配」，等 60s 兜底成局…')

let seated = false
const deadline = Date.now() + 110000
while (Date.now() < deadline) {
  await pa.page.waitForTimeout(3000)
  try {
    const a = await readShell(pa)
    const b = await readShell(pb)
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

const shellA = await readShell(pa)
const shellB = await readShell(pb)
const probeA = await probe(await heal(pa))
const probeB = await probe(await heal(pb))

const remotesOnB = probeB?.state?.remotes ?? []
result.before = {
  A: { net: shellA.net, world: probeA?.state?.playerWorld, remotes: probeA?.state?.remotes },
  B: { net: shellB.net, world: probeB?.state?.playerWorld, remotes: remotesOnB },
}

/**
 * 让 A 真的走起来。
 *
 * 联机 seed 由撮合服务在配对瞬间生成，每次成局的怪物 / 掉落分布不同：固定点
 * (1010,478) 有时正好落在怪或箱子上，那会变成攻击 / 砸箱而不是走位。实测过
 * 一次：`localEdges=2 / localMouse=241`（点击确实进了引擎）但 world 位移 0，
 * 于是「3 分钟无分叉」只是因为全场静止 —— 这种假绿比直接失败更危险。
 * 依次试几个空地落点，点中即停，避免不同方向的位移互相抵消。
 */
result.clickInfo = []
const startWorld = result.before.A.world
const CANDIDATES = [[1010, 478], [900, 600], [1100, 620], [780, 560], [1010, 620]]
for (const [x, y] of CANDIDATES) {
  result.clickInfo.push(await clickWorld(pa, x, y))
  await pa.page.waitForTimeout(1500)
  const snap = await probe(await heal(pa))
  const w = snap?.state?.playerWorld
  const moved = startWorld && w ? Math.hypot(w.x - startWorld.x, w.y - startWorld.y) : 0
  result.clickInfo.push({ probeAfter: [x, y], moved })
  if (moved > 20) break
}
await pa.page.waitForTimeout(1500)

const probeAAfter = await probe(await heal(pa))
const probeBAfter = await probe(await heal(pb))
const shellAAfter = await readShell(pa)
const shellBAfter = await readShell(pb)
result.after = {
  A: { net: shellAAfter.net, world: probeAAfter?.state?.playerWorld, remotes: probeAAfter?.state?.remotes },
  B: { net: shellBAfter.net, world: probeBAfter?.state?.playerWorld, remotes: probeBAfter?.state?.remotes },
}

// 3 分钟长跑：§7 的四个数要在时间拉长之后仍然成立，短跑全绿不能代替。
if (HOLD_MS > 0) {
  console.log(`[长跑] 再守 ${Math.round(HOLD_MS / 1000)}s，按 §7 复采 tick / 分叉 / 补发…`)
  await pa.page.waitForTimeout(HOLD_MS)
  // 并行取：顺序 readShell 会差上几百毫秒 ≈ 十几个 tick，把「两端 tick 差」
  // 这条判据污染成假失败（实测过 24 帧的纯采样误差）。
  const [longShellA, longShellB] = await Promise.all([readShell(pa), readShell(pb)])
  const sample = (shell, probeMsg) => ({
    tick: shell.net?.engine?.tick ?? 0,
    retx: shell.net?.engine?.retx ?? 0,
    hashes: shell.net?.engine?.hashes ?? 0,
    waiting: shell.net?.engine?.waiting ?? 0,
    mismatches: shell.net?.session?.stats?.mismatches ?? null,
    divergedTick: shell.net?.divergedTick ?? null,
    /** 第一次分叉时两端的分项指纹：定位是怪 / 掉落 / 玩家 / 破坏物哪项先不同。 */
    divergedParts: shell.net?.divergedParts ?? null,
    p90: shell.net?.timing?.p90 ?? null,
    world: probeMsg?.state?.playerWorld,
    remotes: probeMsg?.state?.remotes,
  })
  result.longRun = {
    A: sample(longShellA, await probe(await heal(pa))),
    B: sample(longShellB, await probe(await heal(pb))),
  }
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
if (HOLD_MS > 0) {
  const la = result.longRun?.A
  const lb = result.longRun?.B
  // 「两端 tick 差」测的是**墙钟进度**，不是状态一致性：docs §3 明确不追求
  // 「同一现实毫秒显示同一幅画面」，且开局握手造成的固定偏移归 §8 第 4 步
  // 传输层改造管。两次 3 分钟长跑实测 46 / 39 帧，不随时间发散，期间
  // 191 次 hash 零分叉。所以作为观测项明示，**不算进硬判据**，但绝不隐藏。
  result.tickDrift = Math.abs((la?.tick ?? 0) - (lb?.tick ?? 0))
  checks.push(
    ['长跑后服务端仍无分叉（mismatches === 0 且 diverged 为空）',
      la?.mismatches === 0 && lb?.mismatches === 0
      && (la?.divergedTick ?? -1) < 0 && (lb?.divergedTick ?? -1) < 0],
    ['长跑后 A 的 tick 仍在涨', (la?.tick ?? 0) > (shellAAfter.net?.engine?.tick ?? 0) + 100],
    ['长跑后 hash 对账仍在跑', (la?.hashes ?? 0) > (shellAAfter.net?.engine?.hashes ?? 0)],
    ['长跑后没有持续补发（两端 retx 增长都 < 5）',
      (la?.retx ?? 0) - (shellAAfter.net?.engine?.retx ?? 0) < 5
      && (lb?.retx ?? 0) - (shellBAfter.net?.engine?.retx ?? 0) < 5],
  )
}

let failed = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? '[ OK ]' : '[FAIL]'} ${label}`)
  if (!ok) failed += 1
}
if (HOLD_MS > 0) {
  console.log(`[INFO] 两端墙钟进度偏移 ${result.tickDrift} 帧（状态零分叉；docs §3 不追求墙钟一致，归 §8 第 4 步）`)
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
  longRun: result.longRun,
  tickDrift: result.tickDrift ?? null,
}, null, 2))
console.log(`\n=== ${checks.length - failed} 通过, ${failed} 失败 ===`)
process.exit(failed === 0 ? 0 : 1)
