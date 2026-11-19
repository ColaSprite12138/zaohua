// 入口：node server.mjs
// 环境变量：PORT（默认 8790）、HOST（默认 127.0.0.1）、DB_PATH（默认 ./data/app.db）
// 只监听 127.0.0.1 —— 对外一律走 Caddy 的 443，不直接暴露端口。

import * as db from './src/db.mjs'
import * as auth from './src/auth.mjs'
import * as wallet from './src/wallet.mjs'
import * as market from './src/market.mjs'
import * as save from './src/save.mjs'
import * as match from './src/match.mjs'
import { createApp, start } from './src/http.mjs'

const PORT = Number(process.env.PORT || 8790)
const HOST = process.env.HOST || '127.0.0.1'

db.open()
console.log(`[boot] db opened, path=${process.env.DB_PATH || '(default ./data/app.db)'}`)

const handler = createApp({ db, auth, wallet, market, save, match })
const server = await start({ port: PORT, host: HOST, handler })
console.log(`[boot] trade-api listening on http://${HOST}:${PORT}`)

// 撮合的定时推进：4 人立即开局在入队时判定，但「等满 60s」和「超时解散」
// 都发生在没有请求的时候，必须有人在后台走时钟，否则队列最后两个人永远开不了局。
// 500ms 足够（用户感知的等待精度是秒），且一次 tick 只是几条索引查询。
const matchTimer = setInterval(() => {
  try {
    const r = match.tick()
    if (r.formed.length || r.aborted.length) {
      console.log(`[match] formed ${r.formed.length}, aborted ${r.aborted.length}`)
    }
  } catch (e) {
    console.error('[match] tick failed', e.message)
  }
}, 500)
matchTimer.unref()

// 每小时清理过期 challenge / session / 限流计数，避免表无限增长
const timer = setInterval(() => {
  try {
    const n = db.sweep()
    const r = auth.sweepLimiter()
    const m = match.sweep()
    if (n || r || m) console.log(`[sweep] removed ${n} expired rows, ${r} rate-limit entries, ${m} match rows`)
  } catch (e) {
    console.error('[sweep] failed', e.message)
  }
}, 3600_000)
timer.unref()

let closing = false
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (closing) return
    closing = true
    console.log(`[shutdown] ${sig}, closing server`)
    server.close(() => {
      try { db.get().close() } catch {}
      process.exit(0)
    })
    // 兜底：5 秒内没关完就强退，别让 systemd 一直等
    setTimeout(() => process.exit(0), 5000).unref()
  })
}
