// 探针：造化正式环境在「完全未登录」的浏览器里，到底给不给平台身份？
//
// 为什么需要它：关于「游客能不能联机」有两条互相矛盾的线索 ——
//   文档说 MCP Preview 的身份是 parent tab 的 localStorage / ?identity=（可伪造），
//   而 platform container 里是「profile nickname = account identity」（看起来要登录）。
// 这两条都不能直接推出「未登录的正式用户能不能建房」，只能实测。
//
// 做法：用**全新的 Chrome user-data-dir**（零 cookie、零 localStorage）打开发布链接，
// 遍历所有 frame 检查 window.PlatformClient / user.getCurrent() / rooms.create。
//
// 用法：node scripts/probe-guest-identity.mjs "<publish_url>"
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from './lib/playwright.mjs'

const url = process.argv[2]
if (!url) {
  console.error('usage: node scripts/probe-guest-identity.mjs "<publish_url>"')
  process.exit(2)
}

const profile = mkdtempSync(path.join(tmpdir(), 'fx-guest-'))
console.log('[probe] fresh profile:', profile)

const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1400, height: 900 },
  args: ['--disable-blink-features=AutomationControlled'],
})

const page = ctx.pages()[0] || (await ctx.newPage())
const consoleLines = []
page.on('console', (m) => {
  if (consoleLines.length < 80) consoleLines.push(m.type() + ': ' + m.text().slice(0, 300))
})

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(18000)

const results = []
for (const frame of page.frames()) {
  let entry = { url: frame.url(), ok: false }
  try {
    const data = await frame.evaluate(async () => {
      const P = window.PlatformClient
      const out = {
        hasPlatformClient: Boolean(P),
        hasStateSync: Boolean(P && P.stateSync),
        hasCreateOnlineClient: Boolean(
          P && P.stateSync && typeof P.stateSync.createOnlineClient === 'function'),
        hasRoomsCreate: Boolean(P && P.rooms && typeof P.rooms.create === 'function'),
        hasRoomsLeave: Boolean(P && P.rooms && typeof P.rooms.leave === 'function'),
        hasUser: Boolean(P && P.user && typeof P.user.getCurrent === 'function'),
        title: document.title,
        textHead: ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').slice(0, 160),
      }
      try {
        out.storageKeys = Object.keys(localStorage).slice(0, 30)
      } catch (err) {
        out.storageError = String(err)
      }
      if (out.hasUser) {
        try {
          out.user = await P.user.getCurrent()
        } catch (err) {
          out.userError = String((err && err.message) || err)
        }
      }
      return out
    })
    entry = { url: frame.url(), ok: true, ...data }
  } catch (err) {
    entry.error = String((err && err.message) || err)
  }
  results.push(entry)
}

const shot = path.join(profile, 'guest-shot.png')
try {
  await page.screenshot({ path: shot })
} catch { /* 截图失败不影响结论 */ }

console.log(JSON.stringify({ url, profile, shot, results, consoleLines }, null, 2))
await ctx.close()
