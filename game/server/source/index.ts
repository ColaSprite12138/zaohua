import { createPlatformStateSyncRuntime } from '@vibegame/state-sync-runtime/server'
import { decodeBase64, encodeBase64 } from '../../../assets/net/base64.ts'
import { createFrameLog, advanceFrame, forgetPlayer, sliceHistory, submitIntent, FRAME_HZ, FRAME_MS, type FrameLog } from '../../../assets/net/frame-log.ts'
import { decodePacket, encodeBatch, PROTOCOL_RULESET, type InputFrame } from '../../../assets/net/input-frame.ts'

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
 * v2 → v3：输入帧 12 → 16 字节，坐标 i16×4 → i32×4（大地图不再截断）。
 */
const RULESET = PROTOCOL_RULESET

/**
 * 广播里保留最近多少帧的输入。
 *
 * 这不是历史窗口（历史在 `frameLog.history` 里是全量的），只是**每轮广播都
 * 重发一遍**的那一小段。
 *
 * 怎么算这个数：**广播频率跟着逻辑帧率走**（`tickIntervalMs = FRAME_MS`），
 * 60 Hz 下每轮正好新增 1 帧。4 帧 = 67 ms，覆盖「本轮 + 上三轮」——
 * 丢 3 轮广播都还能从下一轮补齐，不必触发 replay。
 * 更早的缺口由客户端发 `replay` 从全量历史里取，不靠广播碰运气。
 *
 * 12 → 6 → 4 的收紧过程：42 ms 广播时每轮 2.5 帧，现在 16.7 ms 每轮 1 帧，
 * 同样的「抗丢包」能力需要的帧数少得多。窗口越小，每轮载荷越小。
 */
const RECENT_FRAMES = 4

/** 一次 replay 最多回多少帧（120 帧 ≈ 2 秒）。剩下的下一次再要。 */
const REPLAY_CHUNK = 120

/**
 * 补帧回包的存活时间（宿主 tick 数）。宿主 16.67 ms 一轮、60 轮 = 1 秒。
 *
 * 3 秒足够客户端 ack 往返十几次；超过就说明这份回包没人要了 —— 必须清掉，
 * 否则它会跟着每轮广播重发，一块 120 帧 ≈ 1 KB × 60 轮/秒 = 60 KB/s 的纯浪费。
 */
const REPLAY_TTL_TICKS = 180

/** 单个 base64 包的上限，防畸形包把内存吃光。 */
const MAX_PACKET_CHARS = 4096

/**
 * 开局装备快照在广播里保留多少帧（10 秒）。
 *
 * 快照是**开局一次性**数据：远端影子建好之后，每轮再带一遍纯属浪费。
 * 2026-11-24 实测（`scripts/probe-bandwidth.mjs`）：2 人局每轮 12.2 KB，
 * 其中 11.4 KB（92.9%）就是这两份装备快照；16 人局每轮 95 KB ⇒ 2.3 MB/s。
 * 所有输入帧加起来只占 3.7% —— 「帧同步只广播操作」这件事本身从来不贵。
 *
 * 10 秒足够覆盖开局握手（实测 1–2 秒）。超时之后如果还有客户端没拿到，
 * 它会发 `{ needSnapshot: true }` 把窗口重开（见 `SNAPSHOT_RESEND_FRAMES`），
 * 所以这不是「拿不到就永远拿不到」。
 */
const SNAPSHOT_GRACE_FRAMES = 240

/** 按需补发时窗口重开多少帧（5 秒）—— 够做完一次次重试的往返。 */
const SNAPSHOT_RESEND_FRAMES = 120

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
  /** 生成时的 serverTick。TTL 用 —— 客户端 ack 丢了也不能让它一直重发。 */
  readonly at: number
  /** 客户端请求的区间（原样回带，便于客户端确认这是不是它要的那段）。 */
  readonly from: number
  readonly to: number
  /** 这一次实际覆盖到的最后一帧；`more === true` 时从这里继续请求。 */
  readonly done: number
  readonly more: boolean
  readonly data: [number, [string, string][]][]
}

type RelayPlayer = {
  id: string
  name: string
  snapshot?: unknown
  /**
   * 到这个帧号之前，`snapshot` 才跟着每轮广播下发（见 `SNAPSHOT_GRACE_FRAMES`）。
   * 0 / 缺省 = 不再下发；客户端发 `{ needSnapshot: true }` 会把它推到当前帧 + 120。
   */
  snapshotUntil?: number
}

type RelayState = {
  readonly ruleset: string
  /**
   * 本局的全局种子与关卡类型，**从 CVM 拉来之后由 relay 广播**。
   *
   * 为什么不能让客户端通过 deployment 带：`runSeed` / `runKind` 都在
   * `state-hash.ts::SHARED_KEYS` 里。种子不同 ⇒ 掉落序列与刷怪全不同；
   * kind 不同 ⇒ 结束条件不同。两者都是「世界参数」，只能有服务端一个来源。
   * `null` = 还没拉到，客户端不许开局（门禁会等）。
   */
  seed: number | null
  kind: string | null
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
    /** 因为停摆超过半秒而**放弃补算**的帧数（逻辑时间比墙钟短了这么多）。 */
    skipped: number
    /** 客户端请求补发开局快照的次数（正常应为 0）。 */
    snapshotResends: number
    /**
     * CVM（我们自己后端）出网探测结果（2026-11-24）。
     *
     * 房间进程跑在造化云端，**它的日志我们看不到** —— 所以把答案写进 stats，
     * 随每轮广播带回客户端角标。取值：
     *   `pending`        还在探测
     *   `ok:200:1234ms`  通了
     *   `bad:503`        通了但响应异常
     *   `fail:TimeoutError` / `fail:TypeError`  没通（DNS / 出网被拦 / 证书）
     *   `no-fetch`       这个 Node 没有 global fetch（太老）
     *
     * 它是「loadout 由 CVM 下发给 relay」这条路的前置条件：不 ok 就不能走。
     */
    cvmProbe: string
    /**
     * 从 CVM 拉开局装备快照的结果（2026-11-24）。取值：
     *   `skipped`           没走这条路（开关关掉 / 没人报 matchId）
     *   `pending`           正在拉
     *   `ok:2/2`            拉到 2 份，名单也是 2 人
     *   `ok:1/2`            只匹配上 1 人（另一个只能靠客户端上报或门禁兜底）
     *   `bad:404` / `fail:timeout` / `no-fetch`
     */
    cvmLoadouts: string
    /**
     * 旧客户端还会发的 `{snapshot}` 上行次数（单一数据源之后一律不采用）。
     * 只为排障：> 0 说明还有旧版本在跑，而它们的装备不会被当成权威数据。
     */
    clientSnapshots: number
  }
}

function emptyState(players: RelayPlayer[]): RelayState {
  return {
    ruleset: RULESET,
    /** 还没从 CVM 拉到就是 null；客户端据此继续等（不许用本地 seed 开局）。 */
    seed: null,
    kind: null,
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
      mismatches: 0, retired: 0, replays: 0, catchup: 0, skipped: 0,
      snapshotResends: 0,
      cvmProbe: 'skipped',
      cvmLoadouts: 'skipped',
      clientSnapshots: 0,
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

/**
 * 补发请求：`{ needSnapshot: true }`。
 *
 * 触发条件很窄 —— 客户端发现名单里有人**从来没拿到过**快照（不是「这轮没有」）。
 * 正常对局 1–2 秒内全员就位，这条路径不该出现；它存在只是为了不让
 * `SNAPSHOT_GRACE_FRAMES` 变成「慢一步就永远拿不到」。
 */
function readNeedSnapshot(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false
  return (input as Record<string, unknown>).needSnapshot === true
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

/**
 * 单帧下行编码。
 *
 * **必须带包 tag**：客户端统一用 `decodePacket` 解，它靠首字节区分
 * `PACKET_FRAME` / `PACKET_BATCH`。以前这里直接 `encodeInputFrame().buffer`，
 * 那是**裸帧**（首字节是 `seq` 的低 8 位），客户端一律判成 `unknown` →
 * `decodeOneFrame` 返回 null → 广播里每一帧的意图表都是空的。
 *
 * 后果极具迷惑性（2026-11-22 双人实测）：服务器照常 tick、`submitted/applied`
 * 都有数、客户端 `framesIn` 也在涨、`scores` 全绿，但**两个玩家一动不动**，
 * 自己的点击也永远不生效 —— 因为本机输入同样要经服务器贴帧广播回来。
 */
function encodeOne(intent: InputFrame): string {
  return encodeBase64(encodeBatch([intent]))
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

  /* --------------------------- CVM 出网探测 --------------------------- */

  /** 我们自己的后端。只探这一个，够回答「relay 这个 Node 进程能不能出网」。 */
  const CVM_HEALTH_URL = 'https://api.colasprite.net/api/v1/health'
  /** 探测超时。DNS + TLS 冷启动本机实测 1.0 s，给 5 s 余量。 */
  const CVM_PROBE_TIMEOUT_MS = 5000

  /**
   * 探一次 CVM 可达性，结果写进 `state.stats.cvmProbe`，随每轮广播带回客户端。
   *
   * 为什么必须把答案带回客户端：relay 跑在造化云端的房间进程里，**它的 stdout
   * 我们看不到**，只有 `state` 这条通道是我们能读的。
   *
   * 为什么不用 `AbortSignal.timeout`：平台 Node 版本未知（`fetch` 本身要 18+）。
   * 用 `AbortController` + `setTimeout` 更兼容，而且**无论 fetch 是否真被中断**，
   * 定时器都会把状态从 `pending` 挪走 —— 不能让它永远挂在「探测中」。
   *
   * fire-and-forget：不阻塞开局，失败也不影响出帧。
   */
  function probeCvm(): void {
    const fetchFn = (globalThis as unknown as { fetch?: typeof fetch }).fetch
    if (typeof fetchFn !== 'function') {
      state.stats.cvmProbe = 'no-fetch'
      return
    }
    state.stats.cvmProbe = 'pending'
    const started = Date.now()
    let settled = false
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const finish = (value: string): void => {
      if (settled) return
      settled = true
      state.stats.cvmProbe = value
      clearTimeout(timer)
    }
    const timer = setTimeout(() => {
      try { controller?.abort() } catch { /* 忽略 */ }
      finish('fail:timeout')
    }, CVM_PROBE_TIMEOUT_MS)
    // 别让它把进程钉住（只有 5 秒，但 Node 会因为有活定时器而延迟退出）。
    ;(timer as unknown as { unref?: () => void }).unref?.()
    fetchFn(CVM_HEALTH_URL, controller ? { signal: controller.signal } : undefined)
      .then(async (res) => {
        if (!res.ok) { finish(`bad:${res.status}`); return }
        // 读完 body 才算真的通了：有些代理先给响应头、body 才挂住。
        await res.text()
        finish(`ok:${res.status}:${Date.now() - started}ms`)
      })
      .catch((err: unknown) => {
        const name = err && typeof err === 'object' && 'name' in err
          ? String((err as { name?: unknown }).name)
          : 'error'
        finish(`fail:${name}`)
      })
  }

  /* ----------------------- CVM 开局快照拉取 ----------------------- */

  /** 我们自己的后端。env 可覆盖（换环境 / 本地联调）。 */
  const CVM_BASE = String(process.env.CVM_BASE || 'https://api.colasprite.net').replace(/\/+$/, '')
  /** `LOADOUT_FROM_CVM=0` 一键回到「只靠客户端上报」。 */
  const LOADOUT_FROM_CVM = process.env.LOADOUT_FROM_CVM !== '0'
  /** 拉取超时。客户端门禁等 300 帧（12.5 秒），1.5 秒足够。 */
  const CVM_LOADOUT_TIMEOUT_MS = 1500
  /** 一局只拉一次：matchId 由任一客户端上报，谁先报都一样。 */
  let loadoutsRequested = false

  /**
   * 按 matchId 从 CVM 拉本局全员的开局装备快照。
   *
   * **为什么需要它**：入座（`reportSeated`）只证明"报过到"，不证明连接还活着。
   * 先入座的人在最后一个人入座前关掉页面，撮合服照样判定全员到齐、局照开，
   * 而他的客户端永远不会再发 loadout —— 那一端只能用默认属性建影子，
   * 两端玩家 hp 立刻不同 ⇒ 分叉。CVM 在点匹配那一刻就把数据存住了，与
   * 当事人是否还在线无关。
   *
   * fire-and-forget：拉不到就退回「只靠客户端上报」，不影响出帧。
   */
  function fetchCvmLoadouts(matchId: string): void {
    if (!LOADOUT_FROM_CVM || loadoutsRequested) return
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(matchId)) return
    loadoutsRequested = true
    const fetchFn = (globalThis as unknown as { fetch?: typeof fetch }).fetch
    if (typeof fetchFn !== 'function') {
      state.stats.cvmLoadouts = 'no-fetch'
      return
    }
    state.stats.cvmLoadouts = 'pending'
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    let settled = false
    const finish = (value: string): void => {
      if (settled) return
      settled = true
      state.stats.cvmLoadouts = value
      clearTimeout(timer)
    }
    const timer = setTimeout(() => {
      try { controller?.abort() } catch { /* 忽略 */ }
      finish('fail:timeout')
    }, CVM_LOADOUT_TIMEOUT_MS)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    fetchFn(
      `${CVM_BASE}/api/v1/match/${encodeURIComponent(matchId)}/loadouts`,
      controller ? { signal: controller.signal } : undefined,
    )
      .then(async (res) => {
        if (!res.ok) { finish(`bad:${res.status}`); return }
        finish(applyCvmLoadouts(await res.json()))
      })
      .catch((err: unknown) => {
        const name = err && typeof err === 'object' && 'name' in err
          ? String((err as { name?: unknown }).name) : 'error'
        finish(`fail:${name}`)
      })
  }

  /**
   * 把 CVM 的快照填进名单。
   *
   * **只在「这个人还没有快照」时填**：客户端 deploy 后上报的那份更准
   * （带真 hpMax，且反映他实际带进局的装备），必须能覆盖这里。反过来不行 ——
   * 覆盖顺序错一次，两端对同一个人的属性认知就不同。
   *
   * 对齐方式：先按造化 `playerId === platformId`，再按显示名。都对不上就不填，
   * 那个人会走「客户端上报」或门禁兜底。
   */
  function applyCvmLoadouts(data: unknown): string {
    const payload = (data ?? {}) as { seed?: unknown; mode?: unknown; members?: unknown }
    /*
     * 世界参数只认这里：种子与关卡类型都进 hash（`SHARED_KEYS`），
     * 客户端通过 deployment 带一份就等于"每台机器自己算自己的世界"。
     */
    if (Number.isFinite(payload.seed)) state.seed = Number(payload.seed)
    state.kind = payload.mode === 'extract' ? 'pvpve' : null
    const list = Array.isArray(payload.members) ? payload.members : []
    const byId = new Map<string, string>()
    const byName = new Map<string, string>()
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue
      const m = raw as { platformId?: unknown; displayName?: unknown; loadout?: unknown }
      if (typeof m.loadout !== 'string') continue
      if (typeof m.platformId === 'string' && m.platformId) byId.set(m.platformId, m.loadout)
      if (typeof m.displayName === 'string' && m.displayName) byName.set(m.displayName, m.loadout)
    }
    let filled = 0
    for (const player of state.players) {
      if (player.snapshot !== undefined) continue
      const payload = byId.get(player.id) ?? byName.get(player.name)
      if (payload === undefined) continue
      try {
        player.snapshot = JSON.parse(payload)
        // 和客户端上报走同一条广播窗口规则：不设这个，`snapshot()` 会认为
        // 「窗口早就关了」，拉到的数据永远发不出去（本地探针抓到的就是这个）。
        player.snapshotUntil = state.frame + SNAPSHOT_GRACE_FRAMES
        filled += 1
      } catch { /* 坏 JSON 当作没拉到 */ }
    }
    return `ok:${filled}/${state.players.length}`
  }

  /**
   * 每次都给一份**新对象**。返回同一个可变 `state` 引用时，runtime 若按
   * 引用/序列化结果判断「这轮有没有变化」，会永远认为没变、一次都不广播
   * （实测客户端只收到 game_init，之后静默）。serverTick 每轮递增，
   * 快照天然是新的。
   */
  function snapshot() {
    /*
     * 字段**逐个列出，不用 `...state`**。两个理由：
     * 1. `snapshotUntil` 之类的内部调度字段不该跟着广播出门；
     * 2. 以后往 `RelayState` 里加字段时，默认是「不广播」，而不是悄悄泄漏。
     */
    return {
      ruleset: state.ruleset,
      /**
       * 全局种子与关卡类型由 relay 下发（来源：CVM 的 `matches.seed` / `mode`）。
       * 客户端**不许**用本地 deployment 里的 seed —— `runSeed` 进 hash。
       */
      seed: state.seed,
      kind: state.kind,
      /*
       * `players[]` 必须**显式**逐字段列出，不能 `{ ...player }`：
       * `snapshotUntil` 是服务器的内部调度字段，spread 会把它一起广播出去。
       *
       * `snapshot` 只在开局窗口内带（见 `SNAPSHOT_GRACE_FRAMES`）。
       * `undefined` 会被 JSON.stringify 直接省掉，客户端读到的就是「没有」。
       */
      players: state.players.map((player) => ({
        id: player.id,
        name: player.name,
        snapshot: state.frame <= (player.snapshotUntil ?? 0) ? player.snapshot : undefined,
      })),
      inputs: { ...state.inputs },
      /*
       * **`hashes` 不进广播**：它是服务器自己用来对账的（同 tick 比两端指纹），
       * 客户端一个字段都不读。每轮带着 N 份 `parts` 等于白花带宽；分叉证据
       * 只经 `diverged` 下发一次即可。
       */
      diverged: state.diverged,
      departed: { ...state.departed },
      serverTick: state.serverTick,
      frame: state.frame,
      reply: { ...state.reply },
      stats: {
        ...state.stats,
        tickMs: tickQuantiles(),
        /** 还有积压的玩家数（队列里攒着没贴的意图）。 */
        pending: [...log.pending.entries()].filter(([, q]) => q.length > 0).length,
        /** 收到 / 贴出 / 丢弃的意图条数。`submitted - applied` 就是还没贴的。 */
        submitted: log.stats.submitted,
        applied: log.stats.applied,
        dropped: log.stats.dropped,
      },
    };
  }

  return {
    start() {
      match?.reportLoading?.()
      // 开局时探一次自己的后端能不能出网。结果随 stats 广播，客户端角标可读。
      probeCvm()
      // 帧钟：**独立**于宿主 42 ms 的 tick()。半周期轮询 + 累加补偿比
      // setInterval(16.67) 稳（后者在 Node 上会慢慢漂到 17~18 ms）。
      const period = FRAME_MS
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
        //
        // 这里丢掉的是**帧数**，不是帧号连续性 —— 帧号是自增整数，永远 +1，
        // 客户端不会看到空洞。代价只是「这一局的逻辑时间比墙钟短了半秒」。
        // 反过来硬补几百帧，会让所有人都跟着卡更久，而且那些帧本来就没输入。
        // 计数放出来是为了让面板能解释「游戏内时间比真实时间慢」。
        if (now - nextAt > 500) {
          state.stats.skipped += Math.round((now - nextAt) / period)
          nextAt = now + period
        }
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
      // 补帧回包有 TTL：客户端 ack 丢了、或者它根本没实现 ack，都不能让这一块
      // 每轮广播都重发一遍（一块 120 帧 ≈ 1 KB，60 Hz 下发就是 60 KB/s 的纯浪费）。
      // 主路径仍是 ack 立即删；这里只兜底。
      for (const pid of Object.keys(state.reply)) {
        const reply = state.reply[pid]
        if (reply && state.serverTick - reply.at > REPLAY_TTL_TICKS) delete state.reply[pid]
      }
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
          at: state.serverTick,
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

      /*
       * 客户端报 matchId：relay 据此向 CVM 拉全员开局快照。
       *
       * 为什么让客户端报、而不是 relay 自己查：`createGame(players, match?)`
       * 只给了 `reportLoading`，拿不到自己的 roomId / matchId。只要还有**一个**
       * 活着的客户端报一次就行 —— 这正是「当事人可以不在线」的关键：
       * 需要的是局号，不是那个人的连接。
       */
      const declared = input && typeof input === 'object'
        ? (input as Record<string, unknown>).matchId
        : null
      if (typeof declared === 'string' && declared) {
        fetchCvmLoadouts(declared)
        return
      }

      const snap = readPeerSnapshot(input)
      if (snap !== null) {
        /*
         * **开局快照只有一个来源：CVM**（用户 2026-11-24 拍板）。
         *
         * 以前这里会把客户端 deploy 后上报的那份写进名单，于是「谁先到用谁」——
         * 而覆盖顺序只要和别的端不一致，同一局里两个人对同一个玩家的装备认知
         * 就不同 ⇒ hash 分叉。既然 CVM 在点匹配时就把数据存住了（当事人离线也
         * 拿得到），客户端这条路就没有存在价值，只需要它别再影响世界。
         *
         * 这里只计数，供排障确认「旧客户端还在发」。
         */
        state.stats.clientSnapshots += 1
        return
      }

      // 客户端说「我名单里有人一直没拿到快照」：把所有窗口重开 5 秒。
      // 这是异常兜底（正常局面 1–2 秒就都拿到了），不是常态流量。
      if (readNeedSnapshot(input)) {
        for (const entry of state.players) {
          if (entry.snapshot !== undefined) entry.snapshotUntil = state.frame + SNAPSHOT_RESEND_FRAMES
        }
        state.stats.snapshotResends += 1
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
  // **广播频率跟着逻辑帧率走**（用户 2026-11-22 定）：60 Hz 逻辑 → 16.67 ms 一轮。
  // 以前写死 42 ms，导致每轮攒 2.5 帧、窗口要 12 帧才够抗丢包。
  roomPolicy: { maxPlayers: 16, minPlayersToStart: 2, tickIntervalMs: FRAME_MS },
  createGame,
})
