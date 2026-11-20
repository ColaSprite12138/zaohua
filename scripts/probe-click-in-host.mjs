// 短探针：在造化平台预览（游戏在 iframe 里）中，哪种点击方式能真正驱动玩家？
//
// 用途：verify-two-player-net.mjs 里「A 走位」一直点不动。P3 真机日志给出
// 决定性线索：引擎 `netStat.localMouse === 0`、`localEdges === 0`，说明点击
// 边沿根本没进引擎，不是同步分叉；而 `clickInfo` 里出现 canvas/outer 字段，
// 说明首选的 `frame.click` 抛了异常、悄悄回落到了手算坐标。
//
// 这条脚本不开房间、不等匹配，用单机出征复现同一套壳层 DOM，一次给出：
//   1. iframe 内 window capture 计数器 —— CDP 事件到底有没有到达 iframe；
//   2. `elementFromPoint` —— 落点上盖着谁（canvas 还是 HUD 覆盖层）；
//   3. 所有 canvas 的 CSS rect / drawing buffer / iframe outerBox —— 缩放比例；
//   4. `frame.click` 的真实报错文本（旧版脚本把它吞了）；
//   5. 多种候选坐标 / 派发方式各点一次，读 `playerWorld` 看谁真的让玩家走了。
//
// 用法：MATCH_USER_A=.. MATCH_PASS_A=.. node scripts/probe-click-in-host.mjs <previewUrl>
import { chromium } from './lib/playwright.mjs'

const PREVIEW = process.argv[2]
const API = 'https://api.colasprite.net'
const CHANNEL = 'forgeax-arena-run'
if (!PREVIEW) {
  console.error('用法: MATCH_USER_A=.. MATCH_PASS_A=.. node scripts/probe-click-in-host.mjs <previewUrl>')
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

/** 出征/进房会让 iframe 重导航，旧 Frame 句柄必然 detached；按壳层元素自愈。 */
async function shellFrame (page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      try {
        if (await f.evaluate(() => Boolean(document.getElementById('fx-match')))) return f
      } catch { /* 正在导航，换下一帧再试 */ }
    }
    await page.waitForTimeout(400)
  }
  throw new Error('找不到带 #fx-match 的帧：' + page.frames().map((f) => f.url().slice(0, 70)).join(' | '))
}

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
// 无头 Chrome 前 3–7 秒 CDP 鼠标事件会被引擎吞掉（window capture 未就绪）。
await page.waitForTimeout(8000)
frame = await shellFrame(page)

// iframe 内装 capture 计数器。挂 window 上、capture=true，能收到所有落进
// iframe 的指针事件，即使被 HUD 覆盖层拦截也能计数。
await frame.evaluate(() => {
  const d = { pointerdown: 0, mousedown: 0, pointermove: 0, click: 0, targets: [] }
  window.__fxClickDiag = d
  for (const kind of ['pointerdown', 'mousedown', 'pointermove', 'click']) {
    window.addEventListener(kind, (e) => {
      d[kind] += 1
      if (d.targets.length < 24) {
        d.targets.push({
          kind,
          tag: e.target && e.target.tagName,
          id: e.target && e.target.id,
          x: Math.round(e.clientX || 0),
          y: Math.round(e.clientY || 0),
        })
      }
    }, true)
  }
})

const geom = await frame.evaluate(() => ({
  url: location.href,
  // hidden 属性为真却仍被 elementFromPoint 命中 = 样式规则没生效（多半是
  // iframe 加载了旧壳层）。把 computed style 和规则是否可见一起报出来。
  gateState: (() => {
    const g = document.getElementById('login-gate')
    if (!g) return { exists: false }
    const r = g.getBoundingClientRect()
    const cs = getComputedStyle(g)
    let ruleFound = false
    for (const ss of document.styleSheets) {
      try {
        for (const rule of ss.cssRules) {
          if (String(rule.cssText).includes('#login-gate[hidden]')) ruleFound = true
        }
      } catch { /* 跨域样式表读不到 */ }
    }
    return {
      exists: true,
      hiddenAttr: g.hidden,
      display: cs.display,
      visibility: cs.visibility,
      pointerEvents: cs.pointerEvents,
      zIndex: cs.zIndex,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      ruleFound,
      styleSheets: [...document.styleSheets].map((ss) => ss.href || '(inline)'),
    }
  })(),
  canvases: [...document.querySelectorAll('canvas')].map((c) => {
    const r = c.getBoundingClientRect()
    return {
      id: c.id, cls: String(c.className).slice(0, 60),
      x: r.x, y: r.y, w: r.width, h: r.height,
      buffer: { w: c.width, h: c.height },
    }
  }),
  inner: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
  hits: [430, 478, 531, 600].map((y) => {
    const el = document.elementFromPoint(1010, y)
    return { y, tag: el && el.tagName, id: el && el.id, cls: el && String(el.className).slice(0, 60) }
  }),
  net: window.MetaShell && window.MetaShell.net ? window.MetaShell.net.status().engine : null,
}))
let outerBox = null
try {
  outerBox = await (await frame.frameElement()).boundingBox()
} catch (err) {
  outerBox = { error: String(err && err.message ? err.message : err).slice(0, 160) }
}
const outerHits = await page.evaluate(() => [430, 478, 531, 600].map((y) => {
  const el = document.elementFromPoint(1010, y)
  return { y, tag: el && el.tagName, id: el && el.id }
}))

const attempts = []
const snap = async (how) => {
  try { frame = await shellFrame(page) } catch { /* 保持上一帧句柄，让 probe 自己超时 */ }
  const p = await probe(frame)
  const d = await frame.evaluate(() => (window.__fxClickDiag ? { ...window.__fxClickDiag } : null)).catch(() => null)
  attempts.push({
    how,
    world: p && p.state ? p.state.playerWorld : null,
    diag: d ? {
      pointerdown: d.pointerdown, mousedown: d.mousedown,
      pointermove: d.pointermove, click: d.click,
    } : null,
    lastTargets: d ? d.targets.slice(-5) : [],
  })
}
await snap('start')

// 1) 验收脚本的首选：frame.click(canvas, position)。把报错记下来，别再吞。
let frameClickError = null
try {
  await frame.click('canvas', { position: { x: 1010, y: 478 }, timeout: 4000 })
} catch (err) {
  frameClickError = String(err && err.message ? err.message : err).slice(0, 1500)
}
await page.waitForTimeout(1200)
await snap('frame.click(canvas, 1010,478)')

// 2) 外层 page 的裸坐标 / 3) canvas 比例换算 / 4) 更靠下的地面点
for (const [label, x, y] of [
  ['page.mouse(1010,478)', 1010, 478],
  ['page.mouse(1010,531)', 1010, 531],
  ['page.mouse(1010,430)', 1010, 430],
  ['page.mouse(900,600)', 900, 600],
  ['page.mouse(1100,600)', 1100, 600],
]) {
  await page.mouse.move(x, y)
  await page.mouse.click(x, y)
  await page.waitForTimeout(1200)
  await snap(label)
}

// 5) iframe 内合成 DOM 事件（只派 canvas，验证事件本身能否被输入层消费）
await frame.evaluate(() => {
  const el = document.querySelector('canvas')
  if (!el) return
  const base = {
    bubbles: true, cancelable: true, clientX: 1010, clientY: 478,
    pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true,
  }
  el.dispatchEvent(new PointerEvent('pointermove', { ...base, buttons: 0 }))
  el.dispatchEvent(new MouseEvent('mousemove', { ...base, buttons: 0 }))
  el.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1 }))
  el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }))
  el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }))
  el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }))
  el.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }))
})
await page.waitForTimeout(1200)
await snap('synth:canvas(1010,478)')

console.log(JSON.stringify({
  gate, geom, outerBox, outerHits, frameClickError, attempts,
}, null, 2))
await browser.close()
