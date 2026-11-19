// 探针：平台宿主到底给客户端开了哪条联机通道？
//
// P2 的 relay 需要「原样转发」的通道。平台文档里明确支持二进制
// （`RoomConnection.sendBinary` / `onBinaryMessage`），但 `stateSync.createOnlineClient()`
// 返回的会话对象在类型声明里只有 `sendAction()`。到底能不能拿到二进制收发，
// 只能问真宿主 —— 猜错的话整套 relay 都要重写。
//
// 用法：node scripts/probe-net-channel.mjs <previewUrl>
import { chromium } from './lib/playwright.mjs'

const PREVIEW = process.argv[2]
if (!PREVIEW) {
  console.error('用法: node scripts/probe-net-channel.mjs <previewUrl>')
  process.exit(1)
}

const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()
page.on('console', (m) => {
  const text = m.text()
  if (text.startsWith('[probe]')) console.log(text)
})
await page.goto(PREVIEW, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(6000)

let frame = page.frames().find((f) => f.url().includes('serveVersion'))
if (!frame) {
  console.log('[probe] 找不到游戏 iframe，现有 frames：', page.frames().map((f) => f.url()))
  await browser.close()
  process.exit(1)
}

const report = await frame.evaluate(() => {
  const p = window.PlatformClient
  const out = { url: location.href }
  if (!p) return { ...out, fatal: 'no PlatformClient' }
  out.platformKeys = Object.keys(p)
  out.stateSyncKeys = Object.keys(p.stateSync || {})
  out.roomsKeys = Object.keys(p.rooms || {})

  // 1) 会话对象上到底有什么
  try {
    const c = p.stateSync.createOnlineClient({ minPlayersToStart: 2 })
    out.clientOwn = Object.keys(c)
    out.clientProto = Object.getOwnPropertyNames(Object.getPrototypeOf(c))
    out.clientHasSendBinary = typeof c.sendBinary === 'function'
    out.clientHasOnBinary = typeof c.onBinaryMessage === 'function'
    out.clientHasSendAction = typeof c.sendAction === 'function'
    // 内部是否握着底层 roomClient（成员名在不同构建里可能是 roomClient / _room / client）
    out.clientInternals = Object.keys(c).filter((k) => {
      const v = c[k]
      return v && typeof v === 'object' && typeof v.sendBinary === 'function'
    })
  } catch (err) {
    out.clientErr = String(err)
  }

  // 2) OnlineRoomSession 构造器签名（参数里能不能塞 roomClient）
  try {
    const Ctor = p.stateSync.OnlineRoomSession
    out.sessionCtor = typeof Ctor === 'function' ? Ctor.length : null
    if (typeof Ctor === 'function') {
      const inst = new Ctor({ minPlayersToStart: 2 })
      out.sessionProto = Object.getOwnPropertyNames(Object.getPrototypeOf(inst))
      out.sessionHasSendBinary = typeof inst.sendBinary === 'function'
    }
  } catch (err) {
    out.sessionErr = String(err)
  }

  // 3) rooms 目录上的原始连接
  try {
    out.roomsIsAvailable = typeof p.rooms.isAvailable === 'function' ? p.rooms.isAvailable() : null
    out.roomsConnectArity = typeof p.rooms.connect === 'function' ? p.rooms.connect.length : null
  } catch (err) {
    out.roomsErr = String(err)
  }

  // 4) 宿主注入的运行时版本线索
  try {
    out.userAgent = navigator.userAgent
    out.iframeNested = window.parent !== window
  } catch {}

  return out
})

console.log('[probe] 探针结果：')
console.log(JSON.stringify(report, null, 2))
await browser.close()
