// 探针：点「快速匹配」之后，浏览器到底有没有往 api.colasprite.net 发请求。
//
// 用于区分两种「点了没反应」：
//   A. 请求发了但失败（CORS / 401 / 5xx）→ 网络面板能看到红色
//   B. 请求根本没发（前端提前 return）→ 一条都不出现
// 之前靠猜浪费了好几轮，这个脚本一次说清。
//
// 用法：node scripts/probe-match-click.mjs "<previewUrl>" <username> <password> [identity]
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from './lib/playwright.mjs'

const [url, user, pass] = process.argv.slice(2)
if (!url || !user || !pass) {
  console.error('usage: node scripts/probe-match-click.mjs "<previewUrl>" <user> <pass>')
  process.exit(2)
}
const API = 'https://api.colasprite.net'

const res = await fetch(`${API}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass }),
})
const session = await res.json()
if (!res.ok || !session.token) throw new Error('登录失败: ' + JSON.stringify(session))

const profile = mkdtempSync(path.join(tmpdir(), 'fx-click-'))
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chrome', headless: false, viewport: { width: 1280, height: 800 },
})
const page = ctx.pages()[0] || (await ctx.newPage())

const reqs = []
page.on('request', (r) => {
  if (r.url().includes('colasprite.net')) reqs.push({ m: r.method(), u: r.url().replace(API, ''), s: null })
})
page.on('response', async (r) => {
  if (!r.url().includes('colasprite.net')) return
  const hit = reqs.find((x) => x.u === r.url().replace(API, '') && x.s === null)
  if (hit) hit.s = r.status()
})
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(5000)
let frame = page.frames().find((f) => f.url().includes('serveVersion'))
if (!frame) throw new Error('找不到游戏 iframe')

// 走**真实表单登录**（和玩家操作完全一致）。注入 localStorage 的方式在
// 门禁这一段不可靠：登录态没被识别时 gate 仍然盖在上面，点击会被它吃掉。
await frame.fill('#acct-user', user)
await frame.fill('#acct-pass', pass)
await frame.click('#acct-submit')
await page.waitForTimeout(5000)
frame = page.frames().find((f) => f.url().includes('serveVersion'))

const gateVisible = await frame.evaluate(() => {
  const g = document.getElementById('login-gate')
  if (!g) return 'no-gate'
  const cs = getComputedStyle(g)
  return {
    hidden: g.hasAttribute('hidden'),
    display: cs.display,
    pointerEvents: cs.pointerEvents,
    zIndex: cs.zIndex,
  }
})

const before = reqs.length
await frame.click('#fx-match')
await page.waitForTimeout(8000)

const statusText = await frame.evaluate(() => {
  const el = document.querySelector('#fx-match-status') || document.querySelector('.fx-status')
  return el ? el.textContent.trim().slice(0, 160) : '(找不到状态元素)'
})
const phase = await frame.evaluate(() => (window.MetaShell && window.MetaShell.matchFlow
  ? window.MetaShell.matchFlow.phase() : 'no matchFlow'))

const shot = path.join(profile, 'click.png')
await page.screenshot({ path: shot })

console.log(JSON.stringify({
  url, user,
  phase,
  gateVisible,
  statusText,
  requestsAfterClick: reqs.slice(before),
  requestsTotal: reqs.length,
  errors,
  shot,
}, null, 2))
await ctx.close()
