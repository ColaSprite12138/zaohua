// 造化预览里平台桥接是否真的注入：查 globalThis 上的 zaohua / Platform 全局，
// 并记录所有失败请求，避免把「404 导致没注入」误判成「平台不支持」。
import { chromium } from './lib/playwright.mjs'

const URL = process.argv[2]
const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })

const failed = []
page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`) })

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(12000)

const gameFrame = page.frames().find((f) => f.url().includes('serveVersion'))
if (!gameFrame) {
  console.log(JSON.stringify({ error: '找不到游戏 iframe', frames: page.frames().map((f) => f.url()) }, null, 2))
  await browser.close()
  process.exit(1)
}

const info = await gameFrame.evaluate(() => {
  const keys = Object.keys(globalThis).filter((k) => /zaohua|platform/i.test(k))
  const dump = {}
  for (const k of keys) {
    const v = globalThis[k]
    dump[k] = typeof v === 'function' ? 'function' : (v === null ? 'null' : typeof v)
  }
  return {
    keys: dump,
    initialized: globalThis.__zaohuaPlatformInitialized ?? null,
    hasPlatformClient: typeof globalThis.PlatformClient,
    platformClientKeys: globalThis.PlatformClient ? Object.keys(globalThis.PlatformClient) : [],
    stateSync: typeof globalThis.PlatformClient?.stateSync,
    storage: typeof globalThis.PlatformClient?.storage,
  }
})

console.log(JSON.stringify({ info, failed }, null, 2))
await browser.close()
