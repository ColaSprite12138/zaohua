// 短探针：在造化平台预览（游戏在 iframe 里）中，哪种点击方式能真正驱动玩家？
//
// 用途：verify-two-player-net.mjs 里「A 走位」一直点不动，而 58080 单页
// 的 verify-fixed-step.mjs 用 page.mouse.click 一点就动。差别只可能是
// 「外层 page / iframe / canvas 坐标」或「引擎输入层监听挂在哪个 realm」。
// 这条脚本不开房间、不等匹配，20 秒内给出结论。
//
// 用法：MATCH_USER_A=.. MATCH_PASS_A=.. node scripts/probe-click-in-host.mjs <previewUrl>
import { chromium } from './lib/playwright.mjs'

const PREVIEW = process.argv[2]
const API = 'https://api.colasprite.net'
const CHANNEL = 'forgeax-arena-run'
if (!PREVIEW) {
  console.error('用法: node scripts/probe-click-in-host.mjs <previewUrl>')
  process.exit(1)
}

const probe = (frame) => frame.evaluate((name) => new Promise((resolve) => {
  const ch = new BroadcastChannel(name)
  const id = Math.floor(Math.random() * 1e9)
  const done = (v) => { ch.removeEventListener('message', onMsg); ch.close(); resolve(v) }
  const onMsg = (e) => {
    if (e.data && e.data.type === 'state' && e.data.requestId === id) done(e.data)
  }
  ch.addEventListener('message', onMsg)
  ch.postMessage({ type: 'probe', requestId: id })
  setTimeout(() => done(null), 2500)
}), CHANNEL)

const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()
await page.goto(PREVIEW, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(5000)
let frame = page.frames().find((f) => f.url().includes('serveVersion'))
if (!frame) throw new Error('找不到游戏 iframe')

// 有账号就注入登录态，否则用游客入口。
if (process.env.MATCH_USER_A) {
  const res = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.MATCH_USER_A,
      password: process.env.MATCH_PASS_A,
    }),
  })
  const s = await res.json()
  await frame.evaluate((v) => localStorage.setItem('forgeax.session.v1', JSON.stringify(v)), {
    token: s.token, userId: s.userId, display: s.display || s.username,
    username: s.username, kind: 'account', expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
  })
  await frame.goto(frame.url(), { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(7000)
  frame = page.frames().find((f) => f.url().includes('serveVersion'))
}
const gate = await frame.evaluate(() => {
  const g = document.getElementById('login-gate')
  if (!g || g.hidden) return 'absent'
  if (document.getElementById('gate-resume-go')) return 'resume'
  if (document.getElementById('gate-guest')) return 'guest'
  return 'blocking'
})
if (gate === 'resume') await frame.click('#gate-resume-go')
else if (gate === 'guest') await frame.click('#gate-guest')
await page.waitForTimeout(2500)

// 出征，进一局单机。
await frame.evaluate(() => {
  const k = document.getElementById('fx-kind')
  if (k && k.value !== 'pvpve') { k.value = 'pvpve'; k.dispatchEvent(new Event('change')) }
  const d = document.getElementById('fx-deploy')
  if (d) d.click()
})
await page.waitForTimeout(6000)

const geom = await frame.evaluate(() => {
  const c = document.querySelector('canvas')
  const r = c ? c.getBoundingClientRect() : null
  return {
    canvas: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
    inner: { w: innerWidth, h: innerHeight },
    elementAtCenter: (document.elementFromPoint(1010, 430) || {}).tagName || null,
  }
})
const outerBox = await (await frame.frameElement()).boundingBox()
const outerHit = await page.evaluate(({ x, y }) => {
  const el = document.elementFromPoint(x, y)
  return el ? { tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 60) } : null
}, { x: 1010, y: 430 })

const attempts = []
const read = async () => (await probe(frame))?.state?.playerWorld || null

const start = await read()
attempts.push({ how: 'start', world: start })

// 1) 外层 page 的裸坐标
await page.mouse.click(1010, 430)
await page.waitForTimeout(1200)
attempts.push({ how: 'page.mouse(1010,430)', world: await read() })

// 2) 外层 page + canvas 比例换算
if (geom.canvas) {
  const sx = outerBox.x + geom.canvas.x + 1010 * (geom.canvas.w / 1280)
  const sy = outerBox.y + geom.canvas.y + 430 * (geom.canvas.h / 720)
  await page.mouse.click(sx, sy)
  await page.waitForTimeout(1200)
  attempts.push({ how: `page.mouse(${sx.toFixed(0)},${sy.toFixed(0)})`, world: await read() })
}

// 3) iframe 内合成 DOM 事件（canvas / window 各派一遍）
for (const target of ['canvas', 'window']) {
  await frame.evaluate(({ t }) => {
    const el = t === 'canvas' ? document.querySelector('canvas') : window
    if (!el) return
    const base = {
      bubbles: true, cancelable: true, clientX: 1010, clientY: 430,
      pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true,
    }
    el.dispatchEvent(new PointerEvent('pointermove', { ...base, buttons: 0 }))
    el.dispatchEvent(new MouseEvent('mousemove', { ...base, buttons: 0 }))
    el.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1 }))
    el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }))
    el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }))
    el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }))
    el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }))
  }, { t: target })
  await page.waitForTimeout(1200)
  attempts.push({ how: `synth:${target}`, world: await read() })
}

// 4) 外层 page 合成事件
await page.evaluate(() => {
  const base = {
    bubbles: true, cancelable: true, clientX: 1010, clientY: 430,
    pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true,
  }
  window.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1 }))
  window.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }))
  window.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }))
  window.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }))
  window.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }))
})
await page.waitForTimeout(1200)
attempts.push({ how: 'synth:outer-window', world: await read() })

console.log(JSON.stringify({ gate, geom, outerBox, outerHit, attempts }, null, 2))
await browser.close()
