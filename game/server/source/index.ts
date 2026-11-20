import { createPlatformStateSyncRuntime } from '@vibegame/state-sync-runtime/server'

/**
 * 搜打撤的房间服务 —— 帧同步的 relay。
 *
 * ## 它做什么，不做什么
 *
 * 做三件事：
 * 1. **转发输入帧**：把每个玩家上传的输入包按 tick 收好，随下一次状态广播发给所有人。
 * 2. **记分叉**：两端各报每 60 tick 的状态 hash，不一致就写进 `diverged`（不裁决，只留证）。
 * 3. **宣布离场**：`removePlayer` 时打时间戳，客户端据此「从这一 tick 起不再等它」。
 *
 * 明确**不做**：不跑模拟、不算伤害、不判定谁打死了谁、不持有地图和怪物。
 * 服务器一旦开始裁决，客户端就不再是唯一真相，帧同步的确定性也就没意义了。
 *
 * ## 为什么走 JSON + base64 而不是裸二进制
 *
 * 平台文档的二进制通道（`RoomConnection.sendBinary` / `useRoomService.onBinaryMessage`）
 * 在 `createPlatformStateSyncRuntime` 这一层**没有暴露** —— 2026-11-20 真宿主探针实测：
 * `createOnlineClient()` 返回的会话上既无 `sendBinary` 也无 `onBinaryMessage`，
 * 只有 `room` 这个内部引用且未连接时为空。而 state-sync runtime 的座位、开局、
 * `game_init` 广播是 P1 已经验收过的链路，换掉它等于把已验证的东西推倒重来。
 *
 * 所以这里用 `sendAction` 搬运**定长二进制帧**：帧本身仍是 12 字节定长
 * （`assets/net/input-frame.ts`），只在外面套一层 base64 + tick 头。服务器不解析
 * 帧内容，只按 tick 归档转发 —— 「只转发」这条线没有破。
 */

/** 规则集版本闸：数值表 / 技能 / 怪物表一变就要递增，否则新旧客户端会被配进同一局。 */
const RULESET_EXTRACT = 'extract-v1'

/**
 * 保留最近多少个**输入包**的 tick 桶（key = 包的第一帧 tick）。
 *
 * 客户端每 3 帧（50ms）发一包，服务端 50ms tick 一次；主窗口的状态轮询是
 * 120ms，再叠加网络抖动，6 个桶（约 300ms）会被新包挤掉旧包 —— 客户端还没
 * 读到就被 prune，锁步就是「永远在等对方」。24 个桶 ≈ 1.2s，够覆盖一次
 * 轮询 + 一次广播重发。P4 做增量 ack 之后可以再收窄。
 */
const INPUT_WINDOW_TICKS = 24

/** 单个输入包最多多少帧（客户端按 20Hz 发，一批 3~4 帧；给突发留余量）。 */
const MAX_FRAMES_PER_PACKET = 16

/** 单个 base64 包的上限，防畸形包把内存吃光。 */
const MAX_PACKET_CHARS = 4096

type InputPacket = {
  /** 这个包里的第一帧 tick。 */
  readonly t: number
  /** 帧数。 */
  readonly n: number
  /** base64 的批量包（`assets/net/input-frame.ts` 的 PACKET_BATCH 格式）。 */
  readonly b: string
}

type HashReport = {
  readonly tick: number
  readonly hash: number
}

type RelayPlayer = { id: string; name: string }

type RelayState = {
  readonly ruleset: string
  players: RelayPlayer[]
  /** tick -> playerId -> 输入包。只保留最近 INPUT_WINDOW_TICKS 个 tick。 */
  inputs: Record<string, Record<string, InputPacket>>
  /** playerId -> 最近一次 hash 上报。 */
  hashes: Record<string, HashReport>
  /** 服务端观察到的第一处分叉（后续只计数）。 */
  diverged: { tick: number; a: string; b: string; hashA: number; hashB: number } | null
  /** 服务端自己宣布的离场：playerId -> 从哪个 tick 起不在场。 */
  departed: Record<string, number>
  /** 服务端 tick 计数（50ms 一格，只用于给离场打时间戳）。 */
  serverTick: number
  stats: {
    packets: number
    frames: number
    badPackets: number
    hashReports: number
    mismatches: number
    retired: number
  }
}

function emptyState(players: RelayPlayer[]): RelayState {
  return {
    ruleset: RULESET_EXTRACT,
    players: players.map((player) => ({ id: player.id, name: player.name })),
    inputs: {},
    hashes: {},
    diverged: null,
    departed: {},
    serverTick: 0,
    stats: {
      packets: 0,
      frames: 0,
      badPackets: 0,
      hashReports: 0,
      mismatches: 0,
      retired: 0,
    },
  }
}

/** 只保留最近 N 个 tick 的输入，不然 state 会一直长。 */
function pruneInputs(state: RelayState): void {
  const ticks = Object.keys(state.inputs).map(Number).sort((a, b) => a - b)
  while (ticks.length > INPUT_WINDOW_TICKS) {
    const oldest = ticks.shift()
    if (oldest === undefined) break
    delete state.inputs[String(oldest)]
  }
}

function readInput(input: unknown): InputPacket | null {
  if (!input || typeof input !== 'object') return null
  const packet = input as Partial<InputPacket>
  if (typeof packet.b !== 'string' || packet.b.length === 0) return null
  if (packet.b.length > MAX_PACKET_CHARS) return null
  const t = Number(packet.t)
  const n = Number(packet.n)
  if (!Number.isInteger(t) || t < 0) return null
  if (!Number.isInteger(n) || n <= 0 || n > MAX_FRAMES_PER_PACKET) return null
  return { t, n, b: packet.b }
}

function readHash(input: unknown): HashReport | null {
  if (!input || typeof input !== 'object') return null
  const report = input as Partial<HashReport>
  const tick = Number(report.tick)
  const hash = Number(report.hash)
  if (!Number.isInteger(tick) || tick < 0) return null
  if (!Number.isFinite(hash)) return null
  return { tick, hash: hash >>> 0 }
}

function createGame(players: RelayPlayer[], match?: { reportLoading?: () => void }) {
  const state = emptyState(players)

  /**
   * 每次都给一份**新对象**。返回同一个可变 `state` 引用时，runtime 若按
   * 引用/序列化结果判断「这轮有没有变化」，会永远认为没变、一次都不广播
   * （实测客户端只收到 game_init，之后静默）。serverTick 每轮递增，
   * 快照天然是新的。独立函数而不是 `this.getState()`：runtime 可能把方法
   * 解构出来单独调用，`this` 会丢。
   */
  function snapshot() {
    return {
      ...state,
      players: state.players.map((player) => ({ ...player })),
      inputs: { ...state.inputs },
      hashes: { ...state.hashes },
      departed: { ...state.departed },
      stats: { ...state.stats },
    };
  }

  return {
    start() {
      match?.reportLoading?.()
    },
    stop() {},
    /**
     * **返回 true = 本局结束**（platform runtime 会立刻广播 `game_over` 并停掉
     * tick 循环），不是「这轮有变化要广播」。2026-11-20 真宿主实测：把它改成
     * 恒 true 之后，事件序列变成 `game_init → game_update → game_over`，
     * 之后服务端不再推任何状态、客户端所有 sendAction 都落进已结束的房间。
     *
     * relay 自己永远不会判定对局结束（结算在客户端），所以恒 false。
     * 广播由 runtime 每轮取 `getDelta()` 完成 —— 让快照每轮都是新对象即可，
     * 与这里的返回值无关。
     */
    tick() {
      state.serverTick += 1
      return false
    },
    /**
     * 客户端上行入口（`session.sendAction(payload)`）。
     *
     * 两种消息，靠字段形状区分（不用 kind 字段，少一层解析）：
     * - 输入包：`{ t, n, b }`
     * - hash 上报：`{ tick, hash }`
     * 其余一律忽略并计数 —— 不认识的载荷不是错误，可能是别的版本发来的。
     */
    applyAction(playerId: string, input: unknown) {
      const packet = readInput(input)
      if (packet) {
        const key = String(packet.t)
        const bucket = state.inputs[key] ?? (state.inputs[key] = {})
        // 同一 tick 重复上传：后到的覆盖（客户端重发是正常的，不算错）。
        bucket[playerId] = packet
        state.stats.packets += 1
        state.stats.frames += packet.n
        pruneInputs(state)
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
            }
          }
        }
        return
      }

      if (input !== null && input !== undefined) state.stats.badPackets += 1
    },
    removePlayer(playerId: string) {
      state.players = state.players.filter((player) => player.id !== playerId)
      // 「从这一 tick 起不再等它」必须由服务端宣布，否则两端判断不一致：
      // 一端跳过它、另一端还在等，整局就永远卡住。
      //
      // 用**游戏 tick** 而不是服务端自己的 50ms 计数：客户端的时间轴是 60Hz、
      // 从开局 0 起，两边根本换算不了。`inputs` 的 key 就是客户端上传的 tick，
      // 所以「最近收到过的最大 tick + 1」是两端都能从同一份数据推出来的唯一一致值。
      const ticks = Object.keys(state.inputs).map(Number)
      const lastSeen = ticks.length > 0 ? Math.max(...ticks) : 0
      state.departed[playerId] = lastSeen + 1
      state.stats.retired += 1
      delete state.hashes[playerId]
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
      }
    },
  }
}

const platform = globalThis.PlatformServer
if (!platform) throw new Error('PlatformServer was not injected by the platform host')

createPlatformStateSyncRuntime({
  platform,
  // 只读准入策略：开局之后不再接受新人插队（P4 会在这里加真正的房间锁）。
  // onCheckJoin: ({ userId, isRejoin }) => ({ allowed: true }),
  roomPolicy: { maxPlayers: 16, minPlayersToStart: 2, tickIntervalMs: 42 },
  createGame,
})
