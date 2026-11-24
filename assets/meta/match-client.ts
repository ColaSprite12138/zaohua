/**
 * 撮合客户端（读写 `/api/v1/match/*`），零 import，可单测。
 *
 * 服务端只当**导演**：它决定「谁建房、谁加入、什么时候开」，但房间本身归造化平台。
 * 所以这里的形状是「一张票 + 一个配对状态机」，客户端拿票自己走：
 *
 *   入队 POST /match/queue            -> TicketView（state=queued）
 *   轮询 GET  /match/tickets/:id      -> TicketView（1s 一次，配对延迟预算本来就是秒级）
 *   继续等 POST /match/tickets/:id/keep-waiting   （独狼等满 60s 后的待遇）
 *   取消   POST /match/tickets/:id/cancel
 *   报房   POST /match/:id/room       （仅 host：把造化的 roomId 回报给服务端）
 *   报座   POST /match/:id/seated     （全员报完 → match.state=playing）
 *   失败   POST /match/:id/abort      （建房/加入失败，按服务端规则回队）
 *
 * **为什么把状态机单独抽成 `decideNext()`**：轮询循环里最容易写错的两件事是
 * 「host 在 formed 该建房、guest 在 formed 只能等」和「ready 之后到底该 join 还是
 * 只报座」。这两条是纯函数，能单测；写成散在回调里的 if 就只能靠真机联调碰出来。
 *
 * **不动随机数**：一局的 `seed` 由服务端在配对瞬间生成并随票下发（`match.seed`），
 * 两端拿到的是同一个值 —— 帧同步的第一前提。客户端绝不自己抽 seed。
 */

/** 与 `auth-client.ts::API_BASE` 一致；调用方通常显式传 baseUrl。 */
export const DEFAULT_BASE = 'https://api.colasprite.net'

/**
 * 规则集版本闸。`ruleset` 不同的人进不同队列 —— 否则两端各跑一套数值，
 * 帧同步第一帧就分叉。
 *
 * 现在用常量：造化上传的是同一个包，跨版本同时在线的情况还没出现。
 * **改了数值表 / 技能 / 怪物表就要递增这个值**（例如 `extract-v2`），
 * 否则新旧客户端会被配到一起。
 */
export const RULESET_EXTRACT = 'extract-v1'

/** 唯一支持联机的模式。主线 / 副本仍跑本地单机。 */
export const MODE_EXTRACT = 'extract'

/** 轮询间隔：排队阶段的延迟预算就是秒级，不值得上 WebSocket。 */
export const POLL_INTERVAL_MS = 1000

export interface TicketMember {
  userId: string
  role: string
  state: string
}

export interface MatchInfo {
  id: string
  state: string
  /** 一局的随机种子，由服务端配对时生成。帧同步靠它对齐。 */
  seed: number
  roomId: string | null
  roomCode: string | null
  /** 状态截止时间（毫秒时间戳）；`playing` 之后为 null。 */
  deadline: number | null
  createdAt: number
  closeReason: string | null
  members: TicketMember[]
}

export type TicketState = 'queued' | 'formed' | 'ready' | 'seated' | 'left' | 'done'

export interface TicketView {
  ticketId: string
  state: TicketState
  mode: string
  ruleset: string
  role: 'host' | 'guest' | null
  waitedMs: number
  /** 等满 60s 还没成局：客户端据此弹「继续等 / 取消」。 */
  canKeepWaiting: boolean
  requeues: number
  match: MatchInfo | null
}

export interface MatchStats {
  queued: number
  playing: number
}

export interface MatchClientDeps {
  token: string
  baseUrl?: string
  fetchImpl?: typeof fetch
}

export interface MatchClient {
  /**
   * 入队。幂等：同一账号重复调用返回同一张票。
   *
   * `loadout` 是**点匹配这一刻**的装备快照（`{ loadout, stars }`）：
   * 帧同步需要全员属性一致，而"入座"并不要求连接还活着 —— 先入座的人可能
   * 在最后一个人入座前关掉页面。数据只有在他人还在的时候交出来才存得住。
   * 见 `docs/net-sync-v2.md` §7.1 与服务端 `match_loadouts`。
   */
  queue(options?: {
    mode?: string
    ruleset?: string
    loadout?: unknown
    platformId?: string | null
    displayName?: string | null
  }): Promise<TicketView>
  /** 当前活票（刷新页面后恢复现场）。没有票返回 null。 */
  current(): Promise<TicketView | null>
  get(ticketId: string): Promise<TicketView>
  keepWaiting(ticketId: string): Promise<TicketView>
  cancel(ticketId: string): Promise<TicketView>
  reportRoom(matchId: string, room: { roomId: string; roomCode?: string | null }): Promise<TicketView>
  reportSeated(matchId: string): Promise<TicketView>
  abort(matchId: string, reason: string): Promise<TicketView>
  stats(): Promise<MatchStats>
}

export class MatchError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 0) {
    super(message)
    this.name = 'MatchError'
    this.code = code
    this.status = status
  }
}

async function request(
  deps: MatchClientDeps, method: string, path: string, body?: unknown,
): Promise<any> {
  const fetchImpl = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null)
  if (!fetchImpl) throw new MatchError('no_fetch', '当前环境不支持网络请求')
  if (!deps.token) throw new MatchError('no_token', '尚未登录，无法匹配')

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
    throw new MatchError('network', '连不上匹配服务器')
  }

  let data: any = null
  try {
    data = await res.json()
  } catch {
    // 网关错误页等非 JSON 响应
  }
  if (!res.ok || !data || data.ok === false) {
    const code = (data && data.code) || 'http_' + res.status
    const message = (data && data.message) || ('匹配请求失败（HTTP ' + res.status + '）')
    throw new MatchError(String(code), String(message), res.status)
  }
  return data
}

/** 服务端所有接口都返回 `{ ok, ticket }` 或 `{ ok, ticketId, ... }`，统一收成 TicketView。 */
function toTicket(data: any): TicketView {
  const t = (data && (data.ticket || data)) || {}
  const m = t.match || null
  return {
    ticketId: String(t.ticketId || ''),
    state: String(t.state || 'queued') as TicketState,
    mode: String(t.mode || ''),
    ruleset: String(t.ruleset || ''),
    role: t.role === 'host' || t.role === 'guest' ? t.role : null,
    waitedMs: Number.isFinite(t.waitedMs) ? Number(t.waitedMs) : 0,
    canKeepWaiting: !!t.canKeepWaiting,
    requeues: Number.isFinite(t.requeues) ? Number(t.requeues) : 0,
    match: m
      ? {
          id: String(m.id || ''),
          state: String(m.state || ''),
          seed: Number(m.seed) || 0,
          roomId: m.roomId ? String(m.roomId) : null,
          roomCode: m.roomCode ? String(m.roomCode) : null,
          deadline: Number.isFinite(m.deadline) ? Number(m.deadline) : null,
          createdAt: Number(m.createdAt) || 0,
          closeReason: m.closeReason ? String(m.closeReason) : null,
          members: Array.isArray(m.members) ? m.members : [],
        }
      : null,
  }
}

export function createMatchClient(deps: MatchClientDeps): MatchClient {
  return {
    async queue(options): Promise<TicketView> {
      const data = await request(deps, 'POST', '/api/v1/match/queue', {
        mode: (options && options.mode) || MODE_EXTRACT,
        ruleset: (options && options.ruleset) || RULESET_EXTRACT,
        // 三个都可选：旧客户端不带也能排队，只是那一局要退回「进房后各自上报」。
        loadout: (options && options.loadout) || undefined,
        platformId: (options && options.platformId) || undefined,
        displayName: (options && options.displayName) || undefined,
      })
      return toTicket(data)
    },
    async current(): Promise<TicketView | null> {
      const data = await request(deps, 'GET', '/api/v1/match/ticket')
      return data && data.ticket ? toTicket(data) : null
    },
    async get(ticketId: string): Promise<TicketView> {
      return toTicket(await request(deps, 'GET', '/api/v1/match/tickets/' + encodeURIComponent(ticketId)))
    },
    async keepWaiting(ticketId: string): Promise<TicketView> {
      return toTicket(await request(
        deps, 'POST', '/api/v1/match/tickets/' + encodeURIComponent(ticketId) + '/keep-waiting'))
    },
    async cancel(ticketId: string): Promise<TicketView> {
      return toTicket(await request(
        deps, 'POST', '/api/v1/match/tickets/' + encodeURIComponent(ticketId) + '/cancel'))
    },
    async reportRoom(matchId, room): Promise<TicketView> {
      const body: Record<string, unknown> = { roomId: room.roomId }
      if (room.roomCode) body.roomCode = room.roomCode
      return toTicket(await request(
        deps, 'POST', '/api/v1/match/' + encodeURIComponent(matchId) + '/room', body))
    },
    async reportSeated(matchId: string): Promise<TicketView> {
      return toTicket(await request(
        deps, 'POST', '/api/v1/match/' + encodeURIComponent(matchId) + '/seated'))
    },
    async abort(matchId: string, reason: string): Promise<TicketView> {
      return toTicket(await request(
        deps, 'POST', '/api/v1/match/' + encodeURIComponent(matchId) + '/abort', { reason }))
    },
    async stats(): Promise<MatchStats> {
      const data = await request(deps, 'GET', '/api/v1/match/stats')
      return {
        queued: Number(data.queued) || 0,
        playing: Number(data.playing) || 0,
      }
    },
  }
}

/* --------------------------- 配对状态机（纯函数） --------------------------- */

export type MatchStep =
  /** 没票：什么都不用做。 */
  | { kind: 'idle' }
  /** 排队中，或者已经 formed 但还在等对方建房 / 分配 roomId。 */
  | { kind: 'wait' }
  /** host 在 `formed` 阶段的唯一动作：建房（房号由造化给，服务端不知道）。 */
  | { kind: 'create_room'; matchId: string }
  /** 已经拿到 roomId，但本地还没连进那个房间。 */
  | { kind: 'join_room'; matchId: string; roomId: string }
  /** 已经连上座位，但服务端还没记我 seated（或者报座失败要重报）。 */
  | { kind: 'report_seated'; matchId: string }
  /** 全员入座，可以起局。`seed` 两端一致。 */
  | { kind: 'start'; matchId: string; seed: number }
  /** 票已结束（left / done）。 */
  | { kind: 'done'; state: string }

export interface LocalSeat {
  /** 本地已经连上的 roomId；没有则 null。 */
  roomId: string | null
  /** 本地已经成功报过 seated（只是本地记性，真理在服务端）。 */
  reportedSeated: boolean
}

/**
 * 「现在该做什么」—— 轮询拿到的票 + 本地座位状态 → 下一步。
 *
 * 三条规矩：
 * 1. `formed` 阶段**只有 host 能建房**；guest 在这里必须老实等着拿 roomId。
 * 2. `ready` 阶段谁没进房谁 join；进房之后才报座。**报座必须在连接之后**，
 *    否则服务端会以为人到了、而其实房间里没这个人。
 * 3. `seated` 之后才看 `match.state === 'playing'` 起局 —— 提前起局会让
 *    先进去的人跑在别人前面。
 */
export function decideNext(view: TicketView | null, local: LocalSeat): MatchStep {
  if (!view) return { kind: 'idle' }
  const match = view.match

  if (view.state === 'left' || view.state === 'done') {
    return { kind: 'done', state: view.state }
  }
  if (view.state === 'queued') return { kind: 'wait' }
  if (!match) return { kind: 'wait' }

  if (view.state === 'formed') {
    return view.role === 'host' ? { kind: 'create_room', matchId: match.id } : { kind: 'wait' }
  }

  if (view.state === 'ready') {
    if (!match.roomId) return { kind: 'wait' }
    if (local.roomId !== match.roomId) {
      return { kind: 'join_room', matchId: match.id, roomId: match.roomId }
    }
    if (!local.reportedSeated) return { kind: 'report_seated', matchId: match.id }
    return { kind: 'wait' }
  }

  // state === 'seated'
  if (match.state === 'playing') return { kind: 'start', matchId: match.id, seed: match.seed }
  return { kind: 'wait' }
}
