import { createPlatformStateSyncRuntime } from '@vibegame/state-sync-runtime/server'
import { decodeBase64, encodeBase64 } from '../../../assets/net/base64.ts'
import { createFrameLog, advanceFrame, forgetPlayer, sliceHistory, submitIntent, FRAME_HZ, type FrameLog } from '../../../assets/net/frame-log.ts'
import { decodePacket, encodeInputFrame, type InputFrame } from '../../../assets/net/input-frame.ts'

/**
 * 搜打撤的房间服务 —— **帧钟 + 输入归属**（v2，2026-11-22）。
 *
 * ## 它做什么，不做什么
 *
 * 做四件事：
 * 1. **推进帧号**：`start()` 起一个独立的 60 Hz 定时器，帧号到点就 +1，**绝不
 *    等待任何客户端**。宿主自己的 `tick()`（42 ms）只负责让快照「看起来变了」
 *    从而触发广播，与逻辑帧率完全解耦。
 * 2. **贴输入**：客户端上行的是**意图**（不带帧号），按到达顺序进每个人的 FIFO；
 *    每推进一帧，就从每个队列取队首那条贴到这一帧。队列空 = 这一帧他没输入。
 * 3. **留全量历史**：`history` 从第 0 帧留到当前帧，不裁窗口。补帧、断线重连、
 *    换设备走的都是同一条 `replay` 通道，**不区分原因**。
 * 4. **记分叉**：两端报的状态 hash 同帧比对，不一致就写进 `diverged`（只留证，
 *    不裁决）。
 *
 * 明确**不做**：不跑模拟、不算伤害、不判定谁打死了谁。服务器一旦开始裁决，
 * 客户端就不再是唯一真相，帧同步的确定性也就没意义了。
 *
 * ## 帧号为什么必须由服务器定
 *
 * v1 的做法是「各端自己数帧 + 服务器只转发」。后果是 A 的 tick 600 对应 B 的
 * tick 560，谁都不知道对方说的 600 是哪个瞬间；一次丢包就永久分叉，而且没有
 * 任何一方有权否决客户端的本地副本（见 `docs/net-sync-v2.md` §0）。
 * 现在帧号只有一个来源，客户端推进的帧号**天然不可能超过服务器广播过的帧号**。
 *
 * ## 为什么走 JSON + base64 而不是裸二进制
 *
 * 平台文档的二进制通道（`RoomConnection.sendBinary` / `useRoomService.onBinaryMessage`）
 * 在 `createPlatformStateSyncRuntime` 这一层**没有暴露** —— 2026-11-20 真宿主探针实测：
 * `createOnlineClient()` 返回的会话上既无 `sendBinary` 也无 `onBinaryMessage`。
 * 所以用 `sendAction` 搬运定长二进制帧：帧本身仍是 12 字节定长，只在外面套一层
 * base64。服务器不解析帧内容，只按帧号归档。
 */

/**
 * 规则集版本闸：数值表 / 技能 / 怪物表 / 输入协议一变就要递增，否则新旧客户端
 * 会被配进同一局。
 *
 * v1 → v2：输入帧第一个字段从「客户端帧号」改成「意图序号」，语义不兼容。
 */
const RULESET = 'extract-v2'

/**
 * 广播里保留最近多少帧的输入。
 *
 * 这不是历史窗口（历史在 `frameLog.history` 里是全量的），只是**每轮广播都
 * 重发一遍**的那一小段：宿主 42 ms 广播一次、每轮带 12 帧 ≈ 200 ms，足够盖住
 * 一次丢包。更早的缺口由客户端发 `replay` 从全量历史里取，不靠广播碰运气。
 */
const RECENT_FRAMES = 12

/** 一次 replay 最多回多少帧（120 帧 ≈ 2 秒）。剩下的下一次再要。 */
const REPLAY_CHUNK = 120

/** 单个 base64 包的上限，防畸形包把内存吃光。 */
const MAX_PACKET_CHARS = 4096

/** 一次上行最多带多少条意图。客户端每 3 帧发一批，给突发留余量。 */
const MAX_INTENTS_PER_PACKET = 24

type InputPacket = {
  /** 这个包对应的帧号（广播侧）/ 第一条意图的序号（上行侧已解包，仅诊断）。 */
  readonly t: number
  /** 帧数。v2 每帧一包，恒为 1。 */
  readonly n: number
  /** base64 的单帧 12 字节。 */
  readonly b: string
}

/** 分项状态指纹，用来定位第一次分叉出在哪项共享状态上。 */
export type HashParts = {
  readonly skeletons: number
  readonly drops: number
  readonly players: number
  readonly destructibles: number
  /** 其余共享世界（区域 / 弹道 / 事件 / 局内时钟）的全状态指纹。 */
  readonly shared: number
}

type HashReport = {
  readonly tick: number
  readonly hash: number
  readonly parts?: HashParts
}

/** 一段补帧回包：`data` 是 `[tick, [[playerId, base64(12B)], ...]]` 的紧凑列表。 */
type ReplayReply = {
  readonly seq: number
  /** 客户端请求的区间（原样回带，便于客户端确认这是不是它要的那段）。 */
  readonly from: number
  readonly to: number
  /** 这一次实际覆盖到的最后一帧；`more === true` 时从这里继续请求。 */
  readonly done: number
  readonly more: boolean
  readonly data: [number, [string, string][]][]
}

type RelayPlayer = { id: string; name: string; snapshot?: unknown }

type RelayState = {
  readonly ruleset: string
  players: RelayPlayer[]
  /** 广播窗口：tick -> playerId -> 单帧包。只保留最近 RECENT_FRAMES 帧。 */
  inputs: Record<string, Record<string, InputPacket>>
  /** playerId -> 最近一次 hash 上报。 */
  hashes: Record<string, HashReport>
  /** 服务端观察到的第一处分叉（后续只计数）。 */
  diverged: {
    tick: number; a: string; b: string; hashA: number; hashB: number;
    partsA: HashParts | null; partsB: HashParts | null
  } | null
  /** playerId -> 从哪个帧起不在场（只用于诊断与名单解释）。 */
  departed: Record<string, number>
  /** 宿主 tick 计数（42 ms 一格，只用于诊断）。**不是**逻辑帧号。 */
  serverTick: number
  /** 逻辑帧号：由 60 Hz 帧钟推进，客户端只能跟随。 */
  frame: number
  /** playerId -> 待取的补帧回包。取走并 ack 后清空。 */
  reply: Record<string, ReplayReply>
  stats: {
    packets: number
    intents: number
    badPackets: number
    hashReports: number
    mismatches: number
    retired: number
    replays: number
    /** 帧钟被事件循环阻塞、一次性补多帧的次数。 */
    catchup: number
  }
}

function emptyState(players: RelayPlayer[]): RelayState {
  return {
    ruleset: RULESET,
    players: players.map((player) => ({ id: player.id, name: player.name })),
    inputs: {},
    hashes: {},
    diverged: null,
    departed: {},
    serverTick: 0,
    frame: 0,
    reply: {},
    stats: {
      packets: 0, intents: 0, badPackets: 0, hashReports: 0,
      mismatches: 0, retired: 0, replays: 0, catchup: 0,
    },
  }
}

/** 广播窗口只留最近 RECENT_FRAMES 帧 —— 历史在 frameLog 里，这里不裁历史。 */
function pruneWindow(state: RelayState): void {
  const ticks = Object.keys(state.inputs).map(Number).sort((a, b) => a - b)
  while (ticks.length > RECENT_FRAMES) {
    const oldest = ticks.shift()
    if (oldest === undefined) break
    delete state.inputs[String(oldest)]
  }
}

/** 开局装备快照上行：客户端在 deploy 时发 `{ snapshot: {...} }`，relay 只转发。 */
function readPeerSnapshot(input: unknown): unknown | null {
  if (!input || typeof input !== 'object') return null
  const snap = (input as Record<string, unknown>).snapshot
  if (!snap || typeof snap !== 'object') return null
  return snap
}

function readReplay(input: unknown): { from: number; to: number } | null {
  if (!input || typeof input !== 'object') return null
  const raw = (input as Record<string, unknown>).replay
  if (!raw || typeof raw !== 'object') return null
  const req = raw as { from?: unknown; to?: unknown }
  const from = Number(req.from)
  const to = Number(req.to)
  if (!Number.isInteger(from) || from < 0) return null
  if (!Number.isInteger(to) || to < from) return null
  return { from, to }
}

function readReplayAck(input: unknown): number | null {
  if (!input || typeof input !== 'object') return null
  const seq = Number((input as Record<string, unknown>).replayAck)
  if (!Number.isInteger(seq) || seq <= 0) return null
  return seq
}

/** 上行意图包：`{ s: 第一条意图的序号, b: base64(PACKET_BATCH) }`。 */
function readIntentPacket(input: unknown): { s: number; b: string } | null {
  if (!input || typeof input !== 'object') return null
  const packet = input as { s?: unknown; b?: unknown }
  if (typeof packet.b !== 'string' || packet.b.length === 0) return null
  if (packet.b.length > MAX_PACKET_CHARS) return null
  const s = Number(packet.s)
  if (!Number.isFinite(s) || s < 0) return null
  return { s, b: packet.b }
}

function readParts(value: unknown): HashParts | undefined {
  if (!value || typeof value !== 'object') return undefined
  const p = value as Partial<Record<keyof HashParts, unknown>>
  const s = Number(p.skeletons)
  const d = Number(p.drops)
  const pl = Number(p.players)
  const de = Number(p.destructibles)
  const sh = p.shared === undefined ? 0 : Number(p.shared)
  if (![s, d, pl, de, sh].every((n) => Number.isFinite(n))) return undefined
  return {
    skeletons: s >>> 0, drops: d >>> 0,
    players: pl >>> 0, destructibles: de >>> 0, shared: sh >>> 0,
  }
}

function readHash(input: unknown): HashReport | null {
  if (!input || typeof input !== 'object') return null
  const report = input as Partial<HashReport>
  const tick = Number(report.tick)
  const hash = Number(report.hash)
  if (!Number.isInteger(tick) || tick < 0) return null
  if (!Number.isFinite(hash)) return null
  return { tick, hash: hash >>> 0, parts: readParts(report.parts) }
}

function encodeOne(intent: InputFrame): string {
  return encodeBase64(new Uint8Array(encodeInputFrame(intent).buffer))
}

function createGame(players: RelayPlayer[], match?: { reportLoading?: () => void }) {
  const state = emptyState(players)
  let log: FrameLog = createFrameLog()
  let replySeq = 0
  /** 帧钟定时器（`start()` 起，`stop()` 清）。 */
  let timer: ReturnType<typeof setInterval> | null = null

  /**
   * 服务器 tick 的真实周期（毫秒）。只在这里记，不进 `state`：
   * 240 个数字每个快照都带一遍是浪费，对外只给分位数。
   *
   * 为什么需要它：客户端看到的「广播间隔」里混了投递延迟，回答不了
   * 「42ms 配出来为什么是 46.7ms」这种问题 —— 那是服务器侧的周期问题。
   */
  let tickAt = 0
  const tickGaps: number[] = []

  function tickQuantiles() {
    if (tickGaps.length === 0) return { n: 0, p50: 0, p90: 0, p99: 0, max: 0 };
    const sorted = tickGaps.slice().sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * q))]!;
    return {
      n: sorted.length,
      p50: at(0.5),
      p90: at(0.9),
      p99: at(0.99),
      max: sorted[sorted.length - 1]!,
    };
  }

  /**
   * 推一帧：帧号 +1，把这一帧的意图塞进广播窗口。
   *
   * 这里**没有**「还差谁的输入」这种判断 —— 差谁就不贴谁，那一帧他就是空输入。
   * 让最慢的客户端决定全场帧率正是 v1 卡死的根因。
   *
   * 全员都没输入的帧也**必须**写进窗口（哪怕是空对象）：客户端是靠「收到第 N
   * 帧」来推进执行指针的，跳过空帧它就以为那些 tick 还缺，于是画面停住、
   * 然后去补帧 —— 明明只是没人按键。
   */
  function onFrame(): void {
    const tick = advanceFrame(log)
    state.frame = tick
    const row = log.history.get(tick)
    const bucket: Record<string, InputPacket> = {}
    if (row) {
      for (const [playerId, intent] of row) {
        bucket[playerId] = { t: tick, n: 1, b: encodeOne(intent) }
      }
    }
    state.inputs[String(tick)] = bucket
    pruneWindow(state)
  }

  /**
   * 每次都给一份**新对象**。返回同一个可变 `state` 引用时，runtime 若按
   * 引用/序列化结果判断「这轮有没有变化」，会永远认为没变、一次都不广播
   * （实测客户端只收到 game_init，之后静默）。serverTick 每轮递增，
   * 快照天然是新的。
   */
  function snapshot() {
    return {
      ...state,
      players: state.players.map((player) => ({ ...player })),
      inputs: { ...state.inputs },
      hashes: { ...state.hashes },
      departed: { ...state.departed },
      reply: { ...state.reply },
      stats: {
        ...state.stats,
        tickMs: tickQuantiles(),
        pending: [...log.pending.entries()].filter(([, q]) => q.length > 0).length,
      },
    };
  }

  return {
    start() {
      match?.reportLoading?.()
      // 帧钟：**独立**于宿主 42 ms 的 tick()。半周期轮询 + 累加补偿比
      // setInterval(16.67) 稳（后者在 Node 上会慢慢漂到 17~18 ms）。
      const period = 1000 / FRAME_HZ
      let nextAt = Date.now() + period
      timer = setInterval(() => {
        const now = Date.now()
        let guard = 0
        while (now >= nextAt && guard < 5) {
          onFrame()
          nextAt += period
          guard += 1
        }
        if (guard > 1) state.stats.catchup += 1
        // 落后超过半秒（进程被挂起 / 长 GC）：不再补，直接对齐到现在。
        // 补几百帧只会让所有人一起卡更久，而且那些帧本来就没有输入。
        if (now - nextAt > 500) nextAt = now + period
      }, Math.max(1, Math.floor(period / 2)))
      if (typeof timer === 'object' && timer && 'unref' in timer) {
        // 宿主进程常驻，但别让一个空房间的定时器拖住进程退出。
        ;(timer as { unref?: () => void }).unref?.()
      }
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    /**
     * 宿主每 42 ms 调一次。**返回 true = 本局结束**（runtime 会立刻广播
     * `game_over` 并停掉 tick 循环），不是「这轮有变化要广播」。
     * 2026-11-20 真宿主实测：把它改成恒 true 之后，事件序列变成
     * `game_init → game_update → game_over`，之后服务端不再推任何状态。
     * relay 永远不会判定对局结束（结算在客户端），所以恒 false。
     */
    tick() {
      const now = Date.now()
      if (tickAt > 0) {
        tickGaps.push(now - tickAt)
        if (tickGaps.length > 240) tickGaps.shift()
      }
      tickAt = now
      state.serverTick += 1
      return false
    },
    /**
     * 客户端上行入口（`session.sendAction(payload)`）。
     *
     * 四种消息，靠字段形状区分（不用 kind 字段，少一层解析）：
     * - 意图包：`{ s, b }`（b = base64 的批量帧）
     * - 补帧请求：`{ replay: { from, to } }`
     * - 补帧确认：`{ replayAck: seq }`
     * - hash 上报：`{ tick, hash, parts }`
     * 其余一律忽略并计数 —— 不认识的载荷不是错误，可能是别的版本发来的。
     */
    applyAction(playerId: string, input: unknown) {
      const packet = readIntentPacket(input)
      if (packet) {
        const decoded = decodePacket(decodeBase64(packet.b))
        const frames = decoded.kind === 'batch' ? decoded.frames
          : decoded.kind === 'frame' ? [decoded.frame] : []
        if (frames.length === 0) {
          state.stats.badPackets += 1
          return
        }
        const accepted = frames.slice(0, MAX_INTENTS_PER_PACKET)
        for (const intent of accepted) submitIntent(log, playerId, intent)
        state.stats.packets += 1
        state.stats.intents += accepted.length
        return
      }

      const replayRequest = readReplay(input)
      if (replayRequest) {
        // `done` 必须是**实际覆盖到的最后一帧**，不能是「理论上这一块的末尾」：
        // 客户端请求的 `to` 可能超过当前帧号（刚连上就报了个大数），报大了它
        // 会以为那段已经补齐，于是既不重试也不等待，永久停在那里。
        const chunkEnd = Math.min(replayRequest.to, replayRequest.from + REPLAY_CHUNK - 1)
        const done = Math.min(chunkEnd, log.frame)
        const frames = sliceHistory(log, replayRequest.from, done)
        const data: [number, [string, string][]][] = frames.map((entry) => [
          entry.tick,
          [...entry.players].map(([pid, intent]) => [pid, encodeOne(intent)] as [string, string]),
        ])
        replySeq += 1
        state.reply[playerId] = {
          seq: replySeq,
          from: replayRequest.from,
          to: replayRequest.to,
          done,
          // 还有下一块 = 「被 120 帧上限截断」，不是「历史还没走到那里」。
          more: done === chunkEnd && chunkEnd < replayRequest.to,
          data,
        }
        state.stats.replays += 1
        return
      }

      const ack = readReplayAck(input)
      if (ack !== null) {
        const current = state.reply[playerId]
        if (current && current.seq <= ack) delete state.reply[playerId]
        return
      }

      const hash = readHash(input)
      if (hash) {
        state.hashes[playerId] = hash
        state.stats.hashReports += 1
        // 分叉判定：同一 tick 上两个人都报了，hash 不同就是分叉。
        for (const [otherId, other] of Object.entries(state.hashes)) {
          if (otherId === playerId) continue
          if (other.tick !== hash.tick) continue
          if (other.hash === hash.hash) continue
          state.stats.mismatches += 1
          if (!state.diverged) {
            state.diverged = {
              tick: hash.tick,
              a: otherId,
              b: playerId,
              hashA: other.hash,
              hashB: hash.hash,
              partsA: other.parts ?? null,
              partsB: hash.parts ?? null,
            }
          }
        }
        return
      }

      const snap = readPeerSnapshot(input)
      if (snap !== null) {
        const entry = state.players.find((p) => p.id === playerId)
        if (entry) entry.snapshot = snap
        return
      }

      if (input !== null && input !== undefined) state.stats.badPackets += 1
    },
    removePlayer(playerId: string) {
      state.players = state.players.filter((player) => player.id !== playerId)
      // 「从这一帧起不再等它」这件事在 v2 里不需要宣布了：缺席本来就是空输入。
      // 这里只留一个诊断时间点，以及丢掉他攒着没贴的意图（那个人已经不在场了）。
      state.departed[playerId] = state.frame
      forgetPlayer(log, playerId)
      delete state.hashes[playerId]
      delete state.reply[playerId]
      state.stats.retired += 1
    },
    addPlayer(player: RelayPlayer) {
      if (state.players.some((entry) => entry.id === player.id)) return
      state.players.push({ id: player.id, name: player.name })
      delete state.departed[player.id]
    },
    getPlayerCount() {
      return state.players.length
    },
    /**
     * 每轮递增的 serverTick 让快照天然是「新的」，runtime 无论按引用还是按
     * 序列化结果比较，都会认为有变化并广播 game_update。
     */
    getState() {
      return snapshot();
    },
    getDelta() {
      return snapshot();
    },
    getResult() {
      return {
        players: state.players,
        stats: state.stats,
        diverged: state.diverged,
        frame: state.frame,
      }
    },
  }
}

const platform = globalThis.PlatformServer
if (!platform) throw new Error('PlatformServer was not injected by the platform host')

createPlatformStateSyncRuntime({
  platform,
  roomPolicy: { maxPlayers: 16, minPlayersToStart: 2, tickIntervalMs: 42 },
  createGame,
})
