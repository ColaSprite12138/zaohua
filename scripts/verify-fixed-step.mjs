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

const netBefore = await page.evaluate(() => {
  const net = window.MetaShell && window.MetaShell.net
  return net ? net.status() : null
})

// 点画面右侧空地：够远，一定触发出「寻路 + 走位」。
await page.mouse.click(1010, 430)
await page.waitForTimeout(1400)
const mid = await probe()
// 再点一个方向，验证连续指令也吃得下（不是只有第一下能动）。
await page.mouse.click(300, 560)
await page.waitForTimeout(1400)
const after = await probe()

const netAfter = await page.evaluate(() => {
  const net = window.MetaShell && window.MetaShell.net
  return net ? net.status() : null
})

await browser.close()

function moved(a, b) {
  if (!a || !b) return false
  return Math.abs(a.x - b.x) > 1e-6 || Math.abs(a.y - b.y) > 1e-6
}

const checks = [
  ['出征后拿到了引擎投影', Boolean(first.state)],
  ['两次点击之后玩家真的动了（输入没被固定步长吃掉）', moved(startWorld, after?.state?.playerWorld)],
  ['移动是连续的：第二次指令也改变了轨迹', moved(mid?.state?.playerWorld, after?.state?.playerWorld)
    || moved(startWorld, mid?.state?.playerWorld)],
  ['单机下 net-bridge 没有误判成联机', netBefore ? netBefore.active === false : false],
  ['单机下一条 sendAction 都没发出去', netAfter ? netAfter.sends === 0 : false],
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
  errors: errors.slice(0, 5),
}, null, 2))
console.log(`\n=== ${checks.length - failed} 通过, ${failed} 失败 ===`)
process.exit(failed === 0 ? 0 : 1)
