// 造化预览（真宿主）的截图 + 关键存在性检查。
// 用途：证明「局外大厅 + 快速匹配」在造化宿主里真的渲染出来了，且平台桥接可用。
// 与 verify-quick-match.mjs 的区别：那个验本地 58080（无宿主），这个验 127.0.0.1:<port>/__zaohua/preview。
import { chromium } from './lib/playwright.mjs'

const URL = process.argv[2]
const OUT = process.argv[3] || 'C:/Users/44763/AppData/Local/Temp/zaohua-preview.png'
if (!URL) {
  console.error('用法: node artifacts/shot-preview.mjs <previewUrl> [outPng]')
  process.exit(1)
}

const errors = []
// 用系统 Chrome：Playwright 自带的 chromium 没下载过（npx playwright install 要联网）
const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
// 引擎初始化会吞掉前 3–7 秒的事件，这里只需要渲染，等 9 秒足够。
await page.waitForTimeout(9000)

/* 页面结构：包装页 + 里面 iframe 才是游戏。两层都查一遍。 */
const frames = page.frames()
const probe = async (frame) => {
  try {
    return await frame.evaluate(() => ({
      url: location.href,
      hasFxShell: !!document.getElementById('fx-shell'),
      hasMatchBtn: !!Array.from(document.querySelectorAll('button'))
        .find((b) => (b.textContent || '').includes('快速匹配')),
      hasGate: !!document.getElementById('login-gate'),
      hasPlatform: typeof window.PlatformClient === 'function',
      title: document.title,
      bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
    }))
  } catch (err) {
    return { url: frame.url(), error: String(err).slice(0, 120) }
  }
}

const report = []
for (const frame of frames) report.push(await probe(frame))

await page.screenshot({ path: OUT, fullPage: false })
await browser.close()

console.log(JSON.stringify({ url: URL, screenshot: OUT, frames: report, errors: errors.slice(0, 5) }, null, 2))
