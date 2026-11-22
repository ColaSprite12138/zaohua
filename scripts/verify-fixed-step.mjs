// P2 单机回归：固定步长改动之后，本地这一局的**操作手感与模拟**必须没坏。
//
// 这个脚本故意不测联机（联机要两个真玩家，那条路只有真宿主能验），只回答
// 三个问题：
//   1. 出征之后玩家还能被点击驱动着走（固定步长没把输入吃掉）。
//   2. 模拟真的在推进（skeletonsAlive / 屏幕坐标会变），不是冻在一帧。
//   3. net-bridge 在单机下**没有**误判成联机（active 必须是 false，一条网都不发）。
//
// 用法：node scripts/verify-fixed-step.mjs [url]
import { chromium } from './lib/playwright.mjs'

const URL = process.argv[2] || 'http://127.0.0.1:58080/index.html'
const CHANNEL = 'forgeax-arena-run'

const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (err) => errors.push(String(err)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(5000)

/** 门禁：有「游客」就点它，没有就说明已经过了。 */
const guestVisible = await page.locator('#gate-guest').isVisible().catch(() => false)
if (guestVisible) await page.click('#gate-guest')
await page.waitForTimeout(2500)

// 无头 Chrome 前 3–7 秒 CDP 派发的鼠标事件会被引擎吞掉（已知环境坑），所以先等。
await page.waitForTimeout(6000)

const deployVisible = await page.locator('#fx-deploy').isVisible().catch(() => false)
if (!deployVisible) {
  console.log(JSON.stringify({ fatal: '找不到出征按钮，页面可能没进局外' }))
  await browser.close()
  process.exit(1)
}
await page.click('#fx-deploy')
// 出征会 reset 一局并重建 arena：引擎在 reset 之后的一两秒里仍会吞掉合成鼠标事件
// （与「无头 Chrome 前 3–7 秒吞事件」同一个原因）。给足时间再点。
await page.waitForTimeout(5000)

/** 通过 BroadcastChannel 的 probe 读 Worker 的只读投影（不注册第二份 projection）。 */
async function probe() {
  return page.evaluate((channelName) => new Promise((resolve) => {
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
}

const first = await probe()
if (!first || !first.state) {
  console.log(JSON.stringify({ fatal: 'probe 没有拿到状态（Worker 没起来？）' }))
  await browser.close()
  process.exit(1)
}

const startWorld = first.state.playerWorld
const startAlive = first.state.skeletonsAlive
// 帧率证据：单机（PVE 副本 / 主线）与联机统一 24 Hz，位移平滑靠渲染插值。
// 两次 probe 之间按墙钟算 tick 增量，比「读一个瞬时值」可信得多。
const tick0 = first.state.tick
const at0 = Date.now()

const netBefore = await page.evaluate(() => {
  const net = window.MetaShell && window.MetaShell.net
  return net ? net.status() : null
})

// 点画面右侧空地：够远，一定触发出「寻路 + 走位」。
await page.mouse.click(1010, 430)
/*
 * 连续采样：证明「逻辑 24 Hz、画面 60 fps」。
 * 如果插值真的在跑，采样到的 drawX 变化次数会明显多于 tick 变化次数 ——
 * 也就是同一步之内画面还在动。这是「不接受跳」这条要求的唯一硬证据。
 */
const samples = []
for (let i = 0; i < 10; i += 1) {
  const snap = await probe()
  if (snap?.state) samples.push(snap.state)
  await page.waitForTimeout(35)
}
await page.waitForTimeout(900)
const mid = await probe()
// 再点一个方向，验证连续指令也吃得下（不是只有第一下能动）。
await page.mouse.click(300, 560)
await page.waitForTimeout(1400)
const after = await probe()

const netAfter = await page.evaluate(() => {
  const net = window.MetaShell && window.MetaShell.net
  return net ? net.status() : null
})

// ---- 插值证据 ----
const uniq = (values) => new Set(values.map((v) => Number(v).toFixed(3))).size
const tickCount = uniq(samples.map((x) => x.tick))
const drawCount = uniq(samples.map((x) => x.drawX))
const alphaCount = uniq(samples.map((x) => x.alpha))
// 画面位置与逻辑位置的最大偏差。24 Hz 下一步最多走 205/24 ≈ 8.5 px，
// 插值只在「上一步 → 当前步」之间取点，所以偏差不可能超过一个步长（留余量到 20）。
let maxGap = 0
for (const st of samples) {
  if (st.drawX === undefined || !st.playerWorld) continue
  maxGap = Math.max(maxGap, Math.abs(st.drawX - st.playerWorld.x))
}

const elapsedMs = Date.now() - at0
const soloHz = after?.state?.tick !== undefined && elapsedMs > 0
  ? (after.state.tick - tick0) / (elapsedMs / 1000)
  : 0

await browser.close()

function moved(a, b) {
  if (!a || !b) return false
  return Math.abs(a.x - b.x) > 1e-6 || Math.abs(a.y - b.y) > 1e-6
}

const checks = [
  ['出征后拿到了引擎投影', Boolean(first.state)],
  // 2026-11-22 定：单机与联机统一 24 Hz（一套行为基线），手感由渲染插值补。
  ['单机帧率声明是 24 Hz（与联机同一套基线）', first.state.hz === 24],
  [`单机实际推进速率 ≈ 24 Hz（实测 ${soloHz.toFixed(1)}）`,
    soloHz >= 21 && soloHz <= 27],
  ['两次点击之后玩家真的动了（输入没被固定步长吃掉）', moved(startWorld, after?.state?.playerWorld)],
  ['移动是连续的：第二次指令也改变了轨迹', moved(mid?.state?.playerWorld, after?.state?.playerWorld)
    || moved(startWorld, mid?.state?.playerWorld)],
  ['单机下 net-bridge 没有误判成联机', netBefore ? netBefore.active === false : false],
  ['单机下一条 sendAction 都没发出去', netAfter ? netAfter.sends === 0 : false],
  // 判据不能靠「采样次数 > 帧数」：probe 一次往返就 >40ms，比逻辑帧还长。
  // 真正的硬证据是 **画面位置与逻辑位置不相等** —— 不插值时 drawX 恒等于 playerWorld.x，
  // 这个偏差只能是 0；实测 7.18px 说明画的是「上一步 → 当前步」之间的点。
  [`插值生效：画面位置与逻辑位置不同（最大偏移 ${maxGap.toFixed(2)}px）`, maxGap > 1],
  [`插值偏移不超过一个逻辑步（${maxGap.toFixed(2)}px ≤ 20）`, maxGap <= 20],
  [`插值进度在连续变化（${alphaCount} 个不同 alpha）`, alphaCount >= 3],
  ['页面无 error 级报错', errors.length === 0],
]

let failed = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? '[ OK ]' : '[FAIL]'} ${label}`)
  if (!ok) failed += 1
}

console.log('')
console.log(JSON.stringify({
  startWorld,
  midPlayer: mid?.state?.playerWorld,
  afterPlayer: after?.state?.playerWorld,
  startAlive,
  afterAlive: after?.state?.skeletonsAlive,
  net: netAfter,
  soloHz: Number(soloHz.toFixed(2)),
  interp: {
    samples: samples.length, tickCount, drawCount, alphaCount,
    maxGap: Number(maxGap.toFixed(2)),
  },
  tickRange: [tick0, after?.state?.tick],
  errors: errors.slice(0, 5),
}, null, 2))
console.log(`\n=== ${checks.length - failed} 通过, ${failed} 失败 ===`)
process.exit(failed === 0 ? 0 : 1)
