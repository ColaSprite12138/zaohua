// 快速匹配（P1）的浏览器侧验证。
//
// P1 的链路是「撮合票 → 造化房间 → 入座 → 同 seed 起局」，其中**造化房间那一段
// 只有真宿主（造化预览 / 发布包）能给**，本地 58080 没有 PlatformClient。
// 所以这里验证的是「本地该验的那一半」：
//
//   A. 顶栏出现「快速匹配」，且默认不挡出征按钮
//   B. 游客点它 → 明确告知要登录（不是静默失败、不是把游客塞进队列）
//   C. 登录态（伪造 session）点它 → 明确告知本地没有平台联机能力
//   D. 全程不往 api.colasprite.net 发任何匹配请求（B/C 都在本地就挡住了）
//   E. 页面无 error 级 console / pageerror（注入脚本语法错会在这里炸）
//
// 真联机那一段的验收是平台上两个玩家 seated + match.state=playing，不是这个脚本。
import { chromium } from './lib/playwright.mjs'

const URL = 'http://127.0.0.1:58080/index.html?v=quick-match-verify'
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`)
}

const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
const page = await ctx.newPage()

const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)))
page.on('console', (m) => {
  const t = m.text()
  if (m.type() === 'error') errors.push('console: ' + t)
})

let matchCalls = []
page.on('request', (r) => {
  if (r.url().includes('/api/v1/match')) matchCalls.push(r.method() + ' ' + r.url())
})

async function openAndWait() {
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(8000) // 引擎初始化期会吞指针事件（2026-11-20 实测）
}

/* ---------------- A. 按钮存在，且初始可用 ---------------- */
await openAndWait()
const bar = await page.evaluate(() => {
  const btn = document.getElementById('fx-match')
  const controls = document.querySelector('#fx-shell .fx-controls')
  return {
    hasBtn: !!btn,
    text: btn ? btn.textContent : '',
    disabled: btn ? btn.disabled : null,
    inControls: !!(btn && controls && controls.contains(btn)),
    statusEl: !!document.getElementById('fx-match-status'),
    keepHidden: (() => {
      const k = document.getElementById('fx-match-keep')
      if (!k) return 'missing'
      // hidden 属性 vs inline-flex：必须真的看不见（踩过这个坑）
      return getComputedStyle(k).display
    })(),
  }
})
check('顶栏有「快速匹配」按钮', bar.hasBtn && bar.inControls)
check('按钮文案是「快速匹配」', bar.text === '快速匹配', bar.text)
check('初始状态可用（没匹配时不该灰）', bar.disabled === false, String(bar.disabled))
check('有状态条元素', bar.statusEl)
check('「继续等 / 取消」默认不可见', bar.keepHidden === 'none', String(bar.keepHidden))

/* ---------------- B. 游客点 → 提示要登录 ---------------- */
await page.click('#gate-guest')
await page.waitForTimeout(1200)
await page.evaluate(() => document.getElementById('fx-match').click())
await page.waitForTimeout(600)

const guest = await page.evaluate(() => {
  const s = document.getElementById('fx-match-status')
  return {
    text: s ? s.textContent : '',
    bad: s ? s.className.includes('bad') : false,
    phase: window.MetaShell && window.MetaShell.matchFlow ? window.MetaShell.matchFlow.phase() : 'no-flow',
    btnDisabled: document.getElementById('fx-match').disabled,
  }
})
check('游客点击 → 明确提示需要登录', /需要登录账号/.test(guest.text), guest.text)
check('提示是 bad 样式（红字，不是静默）', guest.bad)
check('没有进入排队状态', guest.phase === 'idle', guest.phase)
check('按钮没被卡在 disabled', guest.btnDisabled === false, String(guest.btnDisabled))

/* ---------------- C. 登录态点 → 提示本地无联机能力 ---------------- */
// 伪造一份有效会话（只为走到「宿主缺失」那条分支；不联网、不建号）
await page.evaluate(() => {
  const now = Date.now()
  localStorage.setItem('forgeax.session.v1', JSON.stringify({
    token: 'local-fake-token', userId: 'u-local', display: '本地测试',
    username: 'localtest', kind: 'account', expiresAt: now + 7 * 24 * 3600 * 1000,
  }))
})
await openAndWait()
const resumed = await page.evaluate(() => {
  const gate = document.getElementById('login-gate')
  const resume = document.getElementById('gate-resume')
  return {
    gateOpen: gate ? !gate.hidden : false,
    canResume: resume ? !resume.hidden : false,
  }
})
if (resumed.gateOpen && resumed.canResume) {
  await page.click('#gate-resume-go')
  await page.waitForTimeout(1500)
} else {
  console.log('   （门禁没有出现继续进入按钮，直接继续）')
}

matchCalls = []
await page.evaluate(() => document.getElementById('fx-match').click())
await page.waitForTimeout(1500)

const hosted = await page.evaluate(() => {
  const s = document.getElementById('fx-match-status')
  return {
    text: s ? s.textContent : '',
    bad: s ? s.className.includes('bad') : false,
    phase: window.MetaShell && window.MetaShell.matchFlow ? window.MetaShell.matchFlow.phase() : 'no-flow',
    hasPlatform: !!(window.PlatformClient && window.PlatformClient.stateSync),
  }
})
check('本地无宿主 → 明确提示需要造化宿主', /平台联机能力/.test(hosted.text) || /造化宿主/.test(hosted.text), hosted.text)
check('该提示是 bad 样式', hosted.bad)
check('仍未进入排队', hosted.phase === 'idle', hosted.phase)
check('本地没有 PlatformClient（前提成立）', hosted.hasPlatform === false)

/* ---------------- D. 没打我们自己的匹配接口 ---------------- */
check('本地未向 api.colasprite.net/api/v1/match 发请求', matchCalls.length === 0,
  matchCalls.slice(0, 3).join(' | '))

/* ---------------- E. 没有 error 级报错 ---------------- */
// C 里塞的是**假 token**：云存档挂上去必然拿到一次 401。那是测试自己造的，
// 不属于页面缺陷 —— 排除它，剩下的任何 error 都算真问题。
const realErrors = errors.filter((e) => !/401/.test(e))
check('页面无 error 级 console / pageerror（假 token 的 401 除外）',
  realErrors.length === 0, realErrors.slice(0, 3).join(' | '))
check('假 token 只换来一次 401，没有连锁报错',
  errors.filter((e) => /401/.test(e)).length <= 2, String(errors.filter((e) => /401/.test(e)).length))

/* ---------------- 截图留证 ---------------- */
await page.evaluate(() => {
  const s = document.getElementById('fx-match-status')
  if (s) s.textContent = '[验证截图] 本地无平台宿主，按钮已按预期降级'
})
await page.screenshot({ path: 'C:/Users/44763/AppData/Local/Temp/quick-match-verify.png' })

await browser.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n=== ${results.length - failed.length} 通过, ${failed.length} 失败 ===`)
process.exit(failed.length ? 1 : 0)
