// 「快速匹配」在**真造化宿主**里的端到端验证。
//
// 与 verify-quick-match.mjs 互补：那个跑本地 58080（无 PlatformClient，只验降级提示），
// 这个跑 127.0.0.1:<port>/__zaohua/preview（真宿主，PlatformClient 已注入）。
//
// 验证顺序（任一失败即终止，失败信息带实际值）：
//   A. 宿主里 PlatformClient.stateSync.createOnlineClient 可用
//   B. 注入真实账号会话后，点「快速匹配」能打到线上撮合接口（/api/v1/match/queue 200）
//   C. 按钮进入「匹配中…」、状态条出现排队文案（说明票真的进了队列）
//   D. 收尾取消这张票（不留残票在线上队列里）
//
// 用法：node artifacts/verify-match-in-host.mjs <previewUrl>
import { chromium } from './lib/playwright.mjs'

const PREVIEW = process.argv[2]
const API = 'https://api.colasprite.net'
const USER = process.env.MATCH_USER
const PASS = process.env.MATCH_PASS
if (!PREVIEW || !USER || !PASS) {
  console.error('用法: MATCH_USER=xxx MATCH_PASS=yyy node artifacts/verify-match-in-host.mjs <previewUrl>')
  process.exit(1)
}

const results = []
function check (name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? '[ OK ]' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`)
}

/* 1. 先用真实账号换 token（和浏览器里是同一套接口） */
const loginRes = await fetch(`${API}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
})
const login = await loginRes.json()
check('拿得到账号会话', loginRes.ok && !!login.token, `status=${loginRes.status} ${login.error || ''}`)
if (!login.token) process.exit(1)

const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })

const apiCalls = []
page.on('response', async (res) => {
  if (res.url().includes('/api/v1/match')) apiCalls.push({ url: res.url(), status: res.status() })
})

await page.goto(PREVIEW, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(6000)

const frame = page.frames().find((f) => f.url().includes('serveVersion'))
check('找到游戏 iframe', !!frame, frame?.url() || '')
if (!frame) { await browser.close(); process.exit(1) }

/* 2. 把会话写进 localStorage 再刷新（等价于用户登录过一次） */
const session = {
  token: login.token,
  userId: login.user?.userId || login.userId,
  display: login.user?.display || USER,
  username: USER,
  kind: 'account',
  expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
}
await frame.evaluate((s) => localStorage.setItem('forgeax.session.v1', JSON.stringify(s)), session)
await frame.goto(frame.url(), { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(8000)

/* 门禁拦在前面：有会话时它显示「继续进入」，必须点一下才进大厅。
   这一步是真实用户也会走的路径，不是测试绕过。 */
const gate = await frame.evaluate(() => {
  const g = document.getElementById('login-gate')
  if (!g || g.hidden) return 'absent'
  const resume = document.getElementById('gate-resume-go')
  if (resume && !resume.closest('[hidden]')) return 'resume'
  const close = document.getElementById('gate-close')
  if (close && !close.hidden) return 'close'
  return 'blocking'
})
if (gate === 'resume') {
  await frame.click('#gate-resume-go')
  await page.waitForTimeout(4000)
} else if (gate === 'close') {
  await frame.click('#gate-close')
  await page.waitForTimeout(2000)
}
check('过了身份门禁（点「继续进入」）', gate === 'absent' || gate === 'resume' || gate === 'close', gate)
check('门禁已收起', await frame.evaluate(() => !!document.getElementById('login-gate')?.hidden))

const platformOk = await frame.evaluate(() => {
  const p = globalThis.PlatformClient
  return !!(p && p.stateSync && typeof p.stateSync.createOnlineClient === 'function')
})
check('宿主提供 PlatformClient.stateSync.createOnlineClient', platformOk)

/* 3. 点按钮 */
const btn = frame.locator('#fx-match')
check('顶栏存在「快速匹配」按钮', await btn.count() === 1)
const ready = await frame.evaluate(() => !document.getElementById('fx-match')?.disabled)
check('按钮可用（未被禁用）', ready)

await btn.click()
await page.waitForTimeout(5000)

const state = await frame.evaluate(() => ({
  label: document.getElementById('fx-match')?.textContent || '',
  status: document.getElementById('fx-match-status')?.textContent || '',
  gateVisible: !document.getElementById('login-gate')?.hidden,
}))
// 排队中按钮的正确文案是「取消匹配」（点它 = 取消），不是「匹配中…」——
// 「匹配中…」只在请求发出到返回之间出现。
check('排队中按钮变成「取消匹配」', /取消匹配/.test(state.label), state.label)
check('状态条显示已进队列', /排队|匹配|等待|人/.test(state.status), state.status || '(空)')

const queued = apiCalls.find((c) => c.url.includes('/match/queue'))
check('确实调用了线上入队接口且成功', queued && queued.status < 400,
  queued ? `${queued.status} ${queued.url.replace(API, '')}` : '没抓到请求')

/* 4. 取消这张票，别留在线上的队列里 */
const cancelRes = await fetch(`${API}/api/v1/match/ticket`, {
  headers: { Authorization: `Bearer ${login.token}` },
}).then((r) => r.json()).catch(() => null)
const ticketId = cancelRes?.ticket?.ticketId
if (ticketId) {
  const r = await fetch(`${API}/api/v1/match/tickets/${ticketId}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${login.token}` },
  })
  check('收尾：取消测试票', r.ok, `status=${r.status} ticket=${ticketId.slice(0, 8)}`)
} else {
  check('收尾：取消测试票', true, '没有活跃票（可能已被服务端清理）')
}

await page.screenshot({ path: 'C:/Users/44763/AppData/Local/Temp/zaohua-match-host.png' })
await browser.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
