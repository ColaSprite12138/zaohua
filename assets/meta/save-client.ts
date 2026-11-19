/**
 * 云存档客户端（读写 `/api/v1/save`），零 import，可单测。
 *
 * 为什么需要它：`platform-store.js` 的 `persist()` 在 `queue` 为 null 时直接返回，
 * 而 `queue` 只能由 `mountPlatform()` 装上 —— 那个钩子原本留给造化平台 SDK 的 ESM 入口。
 * 结果是没有平台宿主时（58080 静态预览、未接入 SDK 的构建）存档一次都不写，
 * 刷新即回到空仓库。本模块就是补上这个 adapter：
 *
 *   读档  GET  /api/v1/save?slot=main   -> { payload, rev }
 *   写档  POST /api/v1/save             -> { rev }   （带 baseRev 做乐观锁）
 *
 * 与 `platform-store.js` 的对接点是 `SaveAdapter`（read 同步返回已读到的 payload，
 * write 收一个 envelope），所以调用方要先 await 读档、再构造 bridge。
 *
 * 三条刻意的设计：
 *   1. **rev 自增由这里维护**：写成功才推进，失败保持旧值，下次仍是同一次"基于旧版本"的写。
 *   2. **409 不吞**：别的设备先写了就拉最新 rev 重试一次（last-write-wins），
 *      仍失败才抛给上层。`createSaveQueue` 会 catch 掉所有拒绝，所以重试必须在这里做完。
 *   3. **节流**：`syncBadge` 每次 UI 重绘都会 persist，不节流会把请求打成每秒几十条。
 */

/** 与 `auth-client.ts::API_BASE` 保持一致的兜底值；调用方通常显式传 baseUrl。 */
export const DEFAULT_BASE = 'https://api.colasprite.net'
export const SAVE_SLOT = 'main'
/** 主存档位的写间隔。合并窗口比一次往返长得多，正常操作下不会丢最终状态。 */
export const MIN_WRITE_INTERVAL_MS = 400

export interface LoadedSave {
  payload: unknown | null
  rev: number
}

export interface SaveClientDeps {
  token: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  slot?: string
}

export interface PutResult {
  rev: number
  bytes: number
}

export interface SaveClient {
  readonly slot: string
  load(): Promise<LoadedSave>
  put(payload: unknown, baseRev?: number): Promise<PutResult>
  remove(): Promise<boolean>
}

export class SaveError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'SaveError'
    this.code = code
  }
}

async function request(
  deps: SaveClientDeps, method: string, path: string, body?: unknown,
): Promise<any> {
  const fetchImpl = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null)
  if (!fetchImpl) throw new SaveError('no_fetch', '当前环境不支持网络请求')
  if (!deps.token) throw new SaveError('no_token', '尚未登录，无法读写云存档')

  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: 'Bearer ' + deps.token,
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let res: Response
  try {
    res = await fetchImpl((deps.baseUrl || DEFAULT_BASE).replace(/\/+$/, '') + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new SaveError('network', '网络连接失败，存档没有上传')
  }

  let data: any = null
  try {
    data = await res.json()
  } catch {
    // 网关错误页等非 JSON 响应
  }
  if (!res.ok || !data || data.ok === false) {
    const code = (data && data.code) || 'http_' + res.status
    const message = (data && data.message) || ('存档请求失败（HTTP ' + res.status + '）')
    throw new SaveError(String(code), String(message))
  }
  return data
}

export function createSaveClient(deps: SaveClientDeps): SaveClient {
  const slot = deps.slot || SAVE_SLOT
  return {
    slot,
    async load(): Promise<LoadedSave> {
      const out = await request(deps, 'GET', '/api/v1/save?slot=' + encodeURIComponent(slot))
      return {
        payload: out.payload === undefined ? null : out.payload,
        rev: Number.isFinite(out.rev) ? Number(out.rev) : 0,
      }
    },
    async put(payload: unknown, baseRev?: number): Promise<PutResult> {
      const body: Record<string, unknown> = { slot, payload }
      if (Number.isFinite(baseRev)) body.baseRev = baseRev
      const out = await request(deps, 'POST', '/api/v1/save', body)
      return {
        rev: Number.isFinite(out.rev) ? Number(out.rev) : 0,
        bytes: Number.isFinite(out.bytes) ? Number(out.bytes) : 0,
      }
    },
    async remove(): Promise<boolean> {
      const out = await request(deps, 'DELETE', '/api/v1/save/' + encodeURIComponent(slot))
      return !!out.deleted
    },
  }
}

export interface RemoteBridge {
  initial: unknown | null
  read(): unknown | null
  write(envelope: unknown): Promise<void>
  /** 最近一次成功写入后的 rev；0 表示还没写成功过。 */
  rev(): number
  /** 写失败的次数（诊断用，UI 可据此提示"存档没存上"）。 */
  failures(): number
}

/**
 * 把云客户端包成 `mountPlatform` 要的 `{ initial, read, write }`。
 *
 * `initial` 必须是已经 await 过的读档结果 —— `platform-store.js` 是 classic script，
 * 装载时不能处理 Promise，所以读档由调用方先做完。
 */
export function remoteBridge(
  client: SaveClient, loaded: LoadedSave, now: () => number = Date.now,
): RemoteBridge {
  let rev = loaded.rev
  let payload = loaded.payload
  let lastWriteAt = 0
  let failureCount = 0

  async function attempt(envelope: unknown, baseRev: number): Promise<PutResult> {
    try {
      return await client.put(envelope, baseRev)
    } catch (err) {
      // 别的设备先写过：拉一次最新 rev 再覆盖，避免这一版存档直接丢掉。
      if (err instanceof SaveError && err.code === 'save_conflict') {
        const latest = await client.load()
        return await client.put(envelope, latest.rev)
      }
      throw err
    }
  }

  return {
    initial: loaded.payload,
    read: () => payload,
    async write(envelope: unknown): Promise<void> {
      const wait = MIN_WRITE_INTERVAL_MS - (now() - lastWriteAt)
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      lastWriteAt = now()
      try {
        const out = await attempt(envelope, rev)
        rev = out.rev
        payload = envelope
      } catch (err) {
        failureCount += 1
        // 不抛出：createSaveQueue 本来也会吞掉，这里吞是为了不让失败卡住后续写入。
        // 失败计数留给 UI / 诊断读取。
        console.warn('[save] 云端写入失败', err)
      }
    },
    rev: () => rev,
    failures: () => failureCount,
  }
}
