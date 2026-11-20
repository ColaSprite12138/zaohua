// 打开一个预览地址，把它**实际的界面**抓下来：截图 + 关键 DOM 是否存在。
// 用来判断「用户看到的是局外系统，还是裸游戏页面」——这两者截图差很多，
// 但代码层面只差「壳层脚本有没有跑起来」。
//
// 用法：node scripts/probe-preview-ui.mjs "<previewUrl>" [等待毫秒]
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from './lib/playwright.mjs'

const url = process.argv[2]
const waitMs = Number(process.argv[3] || 12000)
if (!url) {
  console.error('usage: node scripts/probe-preview-ui.mjs "<previewUrl>" [waitMs]')
  process.exit(2)
}

const profile = mkdtempSync(path.join(tmpdir(), 'fx-ui-'))
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1280, height: 800 },
})
const page = ctx.pages()[0] || (await ctx.newPage())
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(waitMs)

const report = []
for (const frame of page.frames()) {
  let info = { url: frame.url().slice(0, 90) }
  try {
    info = { ...info, ...(await frame.evaluate(() => ({
      hasMetaShell: typeof window.MetaShell !== 'undefined',
      hasMatchFlow: Boolean(window.MetaShell && window.MetaShell.matchFlow),
      hasLobbyBar: Boolean(document.getElementById('fx-deploy')),
      hasQuickMatch: Boolean(document.getElementById('fx-match')),
      hasLoginGate: Boolean(document.getElementById('login-gate')),
      loginGateHidden: (function () {
        const el = document.getElementById('login-gate')
        if (!el) return null
        return el.hasAttribute('hidden') || getComputedStyle(el).display === 'none'
      })(),
      bodyHead: ((document.body && document.body.innerText) || '')
        .replace(/\s+/g, ' ').slice(0, 180),
    }))) }
  } catch (err) {
    info.error = String((err && err.message) || err).slice(0, 120)
  }
  report.push(info)
}

const shot = path.join(profile, 'ui.png')
await page.screenshot({ path: shot })
console.log(JSON.stringify({ url, shot, frames: report }, null, 2))
await ctx.close()
