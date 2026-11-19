// 入口：node server.mjs
// 环境变量：PORT（默认 8790）、HOST（默认 127.0.0.1）、DB_PATH（默认 ./data/app.db）
// 只监听 127.0.0.1 —— 对外一律走 Caddy 的 443，不直接暴露端口。

import * as db from './src/db.mjs'
import * as auth from './src/auth.mjs'
import * as wallet from './src/wallet.mjs'
import * as market from './src/market.mjs'
import { createApp, start } from './src/http.mjs'

const PORT = Number(process.env.PORT || 8790)
const HOST = process.env.HOST || '127.0.0.1'

db.open()
console.log(`[boot] db opened, path=${process.env.DB_PATH || '(default ./data/app.db)'}`)

const handler = createApp({ db, auth, wallet, market })
const server = await start({ port: PORT, host: HOST, handler })
console.log(`[boot] trade-api listening on http://${HOST}:${PORT}`)

// 每小时清理过期 challenge / session，避免表无限增长
const timer = setInterval(() => {
  try {
    const n = db.sweep()
    if (n) console.log(`[sweep] removed ${n} expired rows`)
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
