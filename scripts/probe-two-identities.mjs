// 探针：本地造化宿主的「伪身份」能不能在同一浏览器里同时开两个？
//
// 背景：`?identity=alice` / `?identity=bob` 是平台文档写明的 debug 座位，
// 身份存在 parent tab 的 localStorage（`__zaohua_preview_player_id__`）。
// 同一 profile 的两个标签页共用 localStorage，所以必须实测：
// 后开的那个会不会把先开的覆盖成同一个 playerId（那样就配不上对）。
//
// 用法：node scripts/probe-two-identities.mjs "http://127.0.0.1:PORT/__zaohua/preview"
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from './lib/playwright.mjs'

const base = process.argv[2]
if (!base) {
  console.error('usage: node scripts/probe-two-identities.mjs "<previewUrl>"')
  process.exit(2)
}

const profile = mkdtempSync(path.join(tmpdir(), 'fx-two-'))
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1100, height: 760 },
})

async function openAs (identity) {
  const page = await ctx.newPage()
  await page.goto(base + '?identity=' + identity, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(14000)
  const out = { identity, frames: [] }
  let gameFrame = null
  for (const frame of page.frames()) {
    try {
      const data = await frame.evaluate(async () => {
        const P = window.PlatformClient
        const r = {
          url: location.href.slice(0, 80),
          hasPlatformClient: Boolean(P),
          name: null,
          id: null,
          roomKey: null,
        }
        if (P && P.user && typeof P.user.getCurrent === 'function') {
          try {
            const u = await P.user.getCurrent()
            r.id = u && u.id
            r.name = u && u.name
          } catch (err) { r.userError = String((err && err.message) || err) }
        }
        try { r.roomKey = localStorage.getItem('__game_builder_room_key__') } catch { /* sandboxed */ }
        return r
      })
      if (data.hasPlatformClient) {
        out.frames.push(data)
        if (!gameFrame) gameFrame = frame
      }
    } catch { /* 跨域/沙箱 frame 跳过 */ }
  }
  return { page, frame: gameFrame, out }
}

const a = await openAs('alice')
const b = await openAs('bob')

// 再回头问一次 alice 的身份：如果被 bob 覆盖，这里会变成 bob。
const recheck = a.frame
  ? await a.frame.evaluate(async () => {
      const P = window.PlatformClient
      if (!P || !P.user) return null
      try { return await P.user.getCurrent() } catch { return null }
    })
  : null

console.log(JSON.stringify({
  base,
  alice: a.out,
  bob: b.out,
  aliceAfterBobOpened: recheck,
  sameSeat: Boolean(
    a.out.frames[0] && b.out.frames[0] &&
    a.out.frames[0].id && a.out.frames[0].id === b.out.frames[0].id,
  ),
}, null, 2))

await ctx.close()
