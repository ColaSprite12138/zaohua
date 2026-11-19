/**
 * CSP / CORS / WebSocket 放行探针 —— 服务端（零依赖，Node 18+）
 *
 * 目的只有一个：让我们能区分「平台沙箱 CSP 拦了」和「我们自己的 CORS 配错了」。
 * 所以 CORS 这里故意回 `*`（不带 credentials），把 CORS 这个变量先摁死 ——
 * 如果探针页仍然报 `Refused to connect ... Content-Security-Policy`，
 * 那就是宿主 CSP 的锅，不是配置问题。
 *
 * 用法：
 *   node server.mjs                 # 默认 8787
 *   PORT=443 node server.mjs        # 也可以让 nginx 在前面反代，见回复
 *
 * 端点：
 *   GET  /health   → 简单请求（不触发 preflight）
 *   POST /echo     → 带自定义头的 POST（必然触发 preflight）
 *   WS   /ws       → 回显（测 wss 是否放行）
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '0.0.0.0'
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 宽松 CORS：探针的目的不是安全，是排除变量。 */
function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-probe')
  res.setHeader('Access-Control-Max-Age', '600')
  res.setHeader('Cache-Control', 'no-store')
  // 把收到的 Origin 原样回显在响应头里，方便看是哪个域来问的
  const origin = req.headers.origin
  if (origin) res.setHeader('X-Probe-Seen-Origin', origin)
}

function sendJson(req, res, status, payload) {
  applyCors(req, res)
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) return req.destroy()
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const path = url.pathname
  const startedAt = Date.now()

  if (req.method === 'OPTIONS') {
    applyCors(req, res)
    res.writeHead(204)
    res.end()
    return
  }

  if (path === '/health' && req.method === 'GET') {
    sendJson(req, res, 200, {
      ok: true,
      server: 'csp-probe',
      now: new Date().toISOString(),
      origin: req.headers.origin ?? null,
      host: req.headers.host ?? null,
      proto: req.headers['x-forwarded-proto'] ?? 'direct',
      ms: Date.now() - startedAt,
    })
    return
  }

  if (path === '/echo' && req.method === 'POST') {
    const body = await readBody(req)
    console.log(`[echo] from=${req.headers.origin ?? 'none'} body=${body.slice(0, 4000)}`)
    sendJson(req, res, 200, {
      ok: true,
      method: req.method,
      sawCustomHeader: req.headers['x-probe'] ?? null,
      contentType: req.headers['content-type'] ?? null,
      origin: req.headers.origin ?? null,
      body: body.slice(0, 512),
      ms: Date.now() - startedAt,
    })
    return
  }

  sendJson(req, res, 404, { ok: false, error: 'not found', path })
})

/* ---------- 最小 WebSocket 实现（RFC 6455，只做 text 回显） ---------- */

function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeUInt32BE(0, 2)
    header.writeUInt32BE(len, 6)
  }
  header[0] = 0x81 // FIN + text
  return Buffer.concat([header, payload])
}

function decodeFrames(buf) {
  const frames = []
  let offset = 0
  while (offset + 2 <= buf.length) {
    const b0 = buf[offset]
    const b1 = buf[offset + 1]
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let cursor = offset + 2
    if (len === 126) {
      if (cursor + 2 > buf.length) break
      len = buf.readUInt16BE(cursor)
      cursor += 2
    } else if (len === 127) {
      if (cursor + 8 > buf.length) break
      len = Number(buf.readBigUInt64BE(cursor))
      cursor += 8
    }
    const maskKey = masked ? buf.subarray(cursor, cursor + 4) : null
    if (masked) cursor += 4
    if (cursor + len > buf.length) break
    const raw = Buffer.from(buf.subarray(cursor, cursor + len))
    if (maskKey) for (let i = 0; i < raw.length; i++) raw[i] ^= maskKey[i % 4]
    frames.push({ opcode, payload: raw })
    offset = cursor + len
  }
  return { frames, rest: buf.subarray(offset) }
}

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  console.log(
    `[ws] upgrade path=${url.pathname} origin=${req.headers.origin ?? 'none'} key=${req.headers['sec-websocket-key'] ? 'yes' : 'MISSING'}`,
  )
  if (url.pathname !== '/ws') {
    console.log('[ws] reject: wrong path')
    socket.destroy()
    return
  }
  const key = req.headers['sec-websocket-key']
  if (!key) {
    socket.destroy()
    return
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64')
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'),
  )
  socket.write(
    encodeFrame(
      JSON.stringify({
        ok: true,
        server: 'csp-probe-ws',
        origin: req.headers.origin ?? null,
        note: 'wss 已放行',
      }),
    ),
  )

  let pending = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk])
    const { frames, rest } = decodeFrames(pending)
    pending = rest
    for (const frame of frames) {
      if (frame.opcode === 0x8) {
        socket.end()
        return
      }
      if (frame.opcode === 0x9) continue // ping：忽略，浏览器不发起
      if (frame.opcode === 0x1) {
        socket.write(
          encodeFrame(
            JSON.stringify({ ok: true, echo: frame.payload.toString('utf8'), ms: Date.now() }),
          ),
        )
      }
    }
  })
  socket.on('error', () => socket.destroy())
})

server.listen(PORT, HOST, () => {
  console.log(`[csp-probe] listening on http://${HOST}:${PORT}`)
  console.log(`  GET  /health`)
  console.log(`  POST /echo   (needs x-probe header)`)
  console.log(`  WS   /ws`)
})
