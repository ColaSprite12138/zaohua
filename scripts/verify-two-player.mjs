// 两个真玩家坐进同一间房（平台 `two_player_seat` 那一项）。
//
// 这是 P1 里**唯一从没跑过**的路径：撮合配对之后，host 真的要建房、guest 真的要
// join + 占座。之前只验到「进队列」，房间那一段是空白。
//
// 两个独立 browser context = 两个互不相干的玩家（不同 zaohuaSession）。
// 各自入队 → 等满 60s 兜底成局（2 人即可）→ host 建房 / guest 进房 → 双方报座。
//
// 用法：
//   MATCH_USER_A=xxx MATCH_PASS_A=yyy MATCH_USER_B=xxx MATCH_PASS_B=yyy \
//   node artifacts/verify-two-player.mjs <previewUrl>
import { chromium } from './lib/playwright.mjs'

const PREVIEW = process.argv[2]
const API = 'https://api.colasprite.net'
const A = { user: process.env.MATCH_USER_A, pass: process.env.MATCH_PASS_A }
const B = { user: process.env.MATCH_USER_B, pass: process.env.MATCH_PASS_B }
if (!PREVIEW || !A.user || !B.user) {
  console.error('用法: MATCH_USER_A=.. MATCH_PASS_A=.. MATCH_USER_B=.. MATCH_PASS_B=.. node artifacts/verify-two-player.mjs <previewUrl>')
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

/** 打开预览 → 写入会话 → 刷新 → 过门禁。返回 { page, frame }。 */
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

  // 门禁：有会话时停在「继续进入」
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

const readState = (frame) => frame.evaluate(() => ({
  label: document.getElementById('fx-match')?.textContent || '',
  status: document.getElementById('fx-match-status')?.textContent || '',
  cls: document.getElementById('fx-match-status')?.className || '',
  inBattle: !!document.getElementById('fx-back') && !document.getElementById('fx-back').disabled,
  gateHidden: !!document.getElementById('login-gate')?.hidden,
}))

const sa = await login(A)
const sb = await login(B)
console.log(`[准备] 两个账号就绪：${sa.display} / ${sb.display}`)

const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const pa = await enter(browser, sa)
const pb = await enter(browser, sb)
console.log(`[准备] 两个玩家都进了局外：gate hidden = ${await pa.frame.evaluate(() => !!document.getElementById('login-gate')?.hidden)}, ${await pb.frame.evaluate(() => !!document.getElementById('login-gate')?.hidden)}`)

/* 两边几乎同时入队，避免一个先等太久 */
await pa.frame.evaluate(() => document.getElementById('fx-match').click())
await pa.page.waitForTimeout(300)
await pb.frame.evaluate(() => document.getElementById('fx-match').click())
console.log('[入队] A / B 已点击「快速匹配」，等 60s 兜底成局…')

const timeline = []
let seated = false
const deadline = Date.now() + 120000
while (Date.now() < deadline) {
  await pa.page.waitForTimeout(3000)
  let sa2, sb2
  try {
    sa2 = await readState(pa.frame)
    sb2 = await readState(pb.frame)
  } catch {
    continue // iframe 可能在 reload
  }
  timeline.push({ t: Math.round((Date.now() - (deadline - 120000)) / 1000), A: sa2.status || sa2.label, B: sb2.status || sb2.label })
  if (sa2.inBattle && sb2.inBattle) { seated = true; break }
}

const fa = await readState(pa.frame).catch(() => null)
const fb = await readState(pb.frame).catch(() => null)

await pa.page.screenshot({ path: 'C:/Users/44763/AppData/Local/Temp/two-player-A.png' })
await pb.page.screenshot({ path: 'C:/Users/44763/AppData/Local/Temp/two-player-B.png' })
await browser.close()

console.log(JSON.stringify({ seated, A: fa, B: fb, timeline: timeline.slice(-12) }, null, 2))
console.log(seated ? '\n[ OK ] 两人都进入了同一局' : '\n[FAIL] 120 秒内没有两人同时开局')
process.exit(seated ? 0 : 1)
