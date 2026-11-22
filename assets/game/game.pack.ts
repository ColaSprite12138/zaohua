/**
 * Engine root: owns the World, reads InputSnapshot, and paints the 2.5D scene
 * into a CanvasTexture on a screen-filling quad. Engine pixels (not the HUD
 * overlay) are what `project play` samples, so this is the render authority.
 */

import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';
import type { Plugin } from '@forgeax/engine/plugin';
import type {} from '@forgeax/engine/app';
import { Time, Update } from '@forgeax/engine/ecs';
import {
  INPUT_SNAPSHOT_RESOURCE_KEY,
  type InputSnapshot,
} from '@forgeax/engine/input';
import { Transform } from '@forgeax/engine/scene';
import {
  Camera,
  CanvasTexture,
  Materials,
  MeshFilter,
  MeshRenderer,
  orthographic,
} from '@forgeax/engine/render';
import { createPrimitiveMesh } from '@forgeax/engine/geometry';

import {
  createModifiers, createState, deployRun, projection, reset, setArena, step,
  MINIMAP, VIEW_H, VIEW_W, screenToWorld, worldToScreen,
  syncWeaponSlots, applyRunCommand, snapshotRun, makeRunInventory,
  type Deployment, type RunLoadout, type RunCommand,
} from './simulation.ts';
import { leftoverDeathDrops, settleOnDeath, type LeftoverItem } from '../combat/death-drop.ts';
import type { AffixOnItem } from '../meta/inventory.ts';
import { paint } from './paint.ts';
import { HEAL_KEY, POTION_KEY, SKILL_KEYS } from '../shared/constants.ts';
import { arena } from '../resource/maps/arena.generated.ts';
import { testArena } from '../resource/maps/arena-test.ts';
// 帧同步：固定步长 + **服务器帧钟驱动的执行队列** + hash 对账。
// 这些模块刻意不 import 任何引擎类型 —— 它们只是算数和数据结构，能在 node 里单测。
import {
  FIXED_DT, addTime, createStepClock, seekClock, takeStep,
} from '../net/step-clock.ts';
import {
  NO_SKILL, NO_SWITCH, decodePacket, emptyInputFrame, encodeBatch,
  toStepInput, type InputFrame,
} from '../net/input-frame.ts';
import {
  capture as captureInput, createInputLatch, take as takeLatched,
  type RawInput,
} from '../net/input-latch.ts';
import { hasActivity } from '../net/intent-filter.ts';
import {
  DEFAULT_LOOKAHEAD, accept as acceptFrame, canStep, contiguous,
  createSyncDriver, pendingTicks, requestReplay, reset as resetSync,
  take as takeSync, type SyncDriver,
} from '../net/sync-driver.ts';
import { HASH_INTERVAL_TICKS, hashGameParts, hashGameState } from '../net/state-hash.ts';
import { createRemotePlayer, spawnOffset, type PeerSnapshot } from '../combat/players.ts';
import { decodeBase64, encodeBase64 } from '../net/base64.ts';

const PACKAGE_ID = definePackageId('019fb7ce-3d00-7000-8000-000000000001');

/**
 * Same-origin channel between the single-page meta shell (main window) and
 * this Engine Worker. BroadcastChannel is a Web standard available in both
 * realms, so no engine-private API or extra frontend root is required.
 */
export const RUN_CHANNEL = 'forgeax-arena-run';

// `type` (not `interface`) so it satisfies the JSON-shaped GameProjectionValue
// index signature required by registerRead.
export type RunResult = {
  /** `extracted` = 从传送门撤离；`cleared` = 主线清场；`gameOver` = 阵亡 / 超时。 */
  outcome: 'cleared' | 'extracted' | 'gameOver';
  /** 失败原因：阵亡 or 900 秒没撤离。壳层用它区分文案。 */
  reason?: 'dead' | 'timedOut';
  /**
   * 联机 PVP 的**按玩家**阵亡结算：死者当场爆装、5 秒后可以回大厅，但本局
   * 没结束、其他人照常玩。壳层收到它不能直接 `settle()` 回大厅，要先弹
   * 「撤离失败」面板，等死者点「返回大厅」才结算并真正离开房间。
   * （`s.gameOver` 全程没置过，所以这里必须带一个独立的标记。）
   */
  pvpDeath?: boolean;
  lootLog: { monsterId: string; itemId: string; name: string; quality: string }[];
  kills: number;
  /**
   * 本局获得的经验（设计 6.1：等级只来自击杀经验）。主窗口把它交给
   * `talent/` 结算升级与星图点；失败的一局**照样给经验** —— 死一次不该
   * 连成长都没有，那是搜打撤里最劝退的挫败感叠加。
   */
  xp: number;
  /** 本局地图 id：主线首通点数按它去重（同一关只给一次）。 */
  stage: string;
  /** The WHOLE run inventory; present only on a clear, null on a loss. */
  loadout: RunLoadout | null;
  /**
   * 失败时**仍然带回家**的部分（设计 4）：保险格里的背包物品；主线阵亡是整份。
   * 副本 / 搜打撤阵亡时它是 `{ 空背包 + 十个空槽 }` 或只有几瓶药。
   */
  kept?: RunLoadout | null;
  /**
   * 失败时**丢下**的部分。副本把它写进死亡掉落槽（下次进本捡回一次），
   * 搜打撤直接消失。主线阵亡为空数组。
   */
  lost?: { defId: string; durability?: number; affixes?: readonly AffixOnItem[]; damage?: number }[];
  /** 阵亡位置（世界像素）；副本用它决定遗物落在哪。 */
  deathAt?: { x: number; y: number } | null;
  /** 地上还没捡走的遗物（撤离时仍留在副本里，下次进来还在）。 */
  deathDropLeft?: LeftoverItem[];
};

/** A discarded / not-yet-deployed run owns nothing. */
const EMPTY_RUN: RunLoadout = {
  bag: [],
  equipped: Array.from({ length: 10 }, () => null),
  activeWeaponSlot: 0,
};

export const game: Plugin = {
  name: 'game/arena',
  inject: ['world', 'assets', 'gameHost'],
  apply(ctx) {
    const world = ctx.world;
    const assets = ctx.assets;
    const host = ctx.gameHost;
    if (assets === undefined) throw new Error('game/arena requires the Assets service');

    // Mouse-driven games need a free cursor, not pointer lock.
    host?.setPointerLockAllowed?.(false);

    /**
     * Render density, in whole multiples of the 1280x720 layout.
     *
     * The canvas is the ONLY surface the engine samples, and it used to be
     * locked at 1280x720 and stretched to whatever the window happened to be
     * (1.25x at 1600x900, 1.5x at 1080p). A non-integer bilinear upscale smears
     * every voxel edge and every Chinese glyph, and the bigger the monitor the
     * worse it gets -- that is the "resolution looks low" half of the problem.
     * Painting at an integer multiple and letting the GPU scale DOWN instead
     * keeps lines hard: 1280x720 stays the sole layout authority (all gameplay,
     * HUD and input code is untouched), only the sampling density moves.
     *
     * 2x is the ceiling on purpose: 2560x1440 is 3.7M pixels to upload per
     * frame, which is the most this 2D painter should push. Raising it further
     * belongs with finer art (a smaller voxel unit), not with this one change.
     */
    const RENDER_SCALE_MAX = 2;
    const surface = new OffscreenCanvas(VIEW_W, VIEW_H);
    let surfaceScale = 1;
    const resizeSurface = (scale: number): void => {
      if (scale === surfaceScale) return;
      surfaceScale = scale;
      // Assigning width/height resets the 2D state (transform, smoothing); both
      // are re-established every frame right before `paint`, so nothing is lost.
      surface.width = VIEW_W * scale;
      surface.height = VIEW_H * scale;
    };
    const context = surface.getContext('2d');
    if (context === null) throw new Error('game/arena requires a Canvas 2D context');
    const painter = context as unknown as CanvasRenderingContext2D;
    // The small flat fixture keeps automated acceptance runs alive; the real
    // playable LDtk arena is selected by `deploy` below.
    const state = createState({ map: testArena });

    /**
     * **纯本地视图状态 `V`**（不属于 `GameState` / `S`）。
     *
     * 大地图只是「本机正在看哪一层」的模态覆盖层：按 M 只切本机画面，
     * 不写进世界状态、不进输入帧、不进 hash。联机时 A 开着地图、B 没开，
     * 两端各自渲染，世界状态仍逐位一致。这是 docs/net-sync-design.md §1.1
     * 的 `S` / `V` 分层，别把它放回 `state`。
     */
    const view = { bigMap: false };

    /**
     * 验收脚本的**只读观察投影**：`S` 的世界状态 + `V` 的本地视图位。
     * `viewBigMap` 只给自动化断言看，不来自 `GameState`、不进输入帧、不进 hash、
     * 不参与 `step()`；`projection()` 本身仍然只序列化 `S`。
     */
    const readProjection = () => ({ ...projection(state), viewBigMap: view.bigMap });

    // Last pointer position seen in the input snapshot. The snapshot carries a
    // position only on frames where the browser delivered a pointer event; a
    // frame that reports justPressed/justReleased WITHOUT one would otherwise
    // drop the click entirely (no press to resolve, no hover to report).
    let lastPointer: { x: number; y: number } | null = null;

    // Last hover index announced to the presentation realm. The pointer style
    // itself lives in the page (an Engine Worker has no `document` and no
    // canvas), so a change is the only thing worth broadcasting.
    let lastHover: number | null = null;

    // Meta <-> run bridge. `lastResult` is posted to the shell exactly once
    // per run (on cleared / gameOver) and read back by playthrough assertions.
    let lastResult: RunResult | null = null;
    let resultSent = false;
    // While the mandatory login overlay is up the arena must not advance:
    // otherwise the skeletons would quietly kill an unattended player before
    // anyone has logged in. `unlock` resets to a clean run on successful auth.
    let locked = false;
    // Platform lifecycle pause (publishing validation). Kept INDEPENDENT of
    // `locked`: `unlock` resets to a fresh run, which a resume must never do.
    let paused = false;
    let lastRunSignature = '';
    // 星图乘区：只在 deploy 时换一次（设计 6.4「局内不能换 build」）。
    let modifiers = createModifiers([]);
    /* ---------------------- 帧同步状态（P2） ---------------------- */

    /**
     * 固定步长时钟。单机也用它 —— 这是「同一份输入 → 同一份结果」的地基，
     * 而单机同样需要它：可变 dt 会让重放、回放、验收脚本全部不可复现。
     */
    const stepClock = createStepClock();
    /** 一帧渲染采到的输入，按逻辑步分发（边沿只给第一个步）。 */
    const latch = createInputLatch();
    /** 联机中：服务器帧钟已经接上，帧号由服务器广播决定。 */
    let netActive = false;
    /** 平台给的座号。服务端广播里的 playerId 与它必须一致。 */
    let netPlayerId = '';
    /**
     * 执行指针。**只因为「执行了服务器广播的一帧」而前进**，所以它永远不可能
     * 超过服务器已经广播过的最大帧号 —— 这不是靠检查保证的，是结构上做不到。
     */
    let driver: SyncDriver = createSyncDriver(0, DEFAULT_LOOKAHEAD);
    /** 在场 peer（座位名单）。 */
    let netPeers = new Set<string>();
    /** peer 的显示名（服务端 broadcast 里带过来），只用于头顶标签。 */
    const netPeerNames = new Map<string, string>();
    /**
     * 还没打包发走的**意图**。注意它不带帧号：服务器贴到哪一帧就是哪一帧，
     * 客户端没有资格决定（`docs/net-sync-v2.md` §2.2）。
     *
     * **没有操作的帧不进这里，也不发空帧**：服务器那一帧里没有我 = 空输入，
     * 语义等价；而队列是 FIFO 的，前面堆空意图会让我真正按下的那一下晚几十帧。
     */
    let netOutbox: InputFrame[] = [];
    /** 上一次真的发出去的意图；`hasActivity` 拿它做基准判断「有没有变化」。 */
    let lastIntent: InputFrame | null = null;
    /**
     * 意图采样累加器。**与执行节拍解耦**：执行会被服务器卡住，但采样不能停 ——
     * 停了就等于「我一卡，我的操作也跟着停」，恢复后那段时间是彻底的空白。
     */
    let intentAcc = 0;
    /** 下一条意图的序号。只用于服务端去重与诊断，不参与任何判定。 */
    let nextIntentSeq = 0;
    /**
     * 参战名单是否已经确定。联机局在名单到达**之前不能推进**：否则会把它当
     * 单机跑，等对方入座时我这边已经跑出几百帧，两端帧号永远对不上。
     */
    let netSeatSettled = false;
    /** 对端上报的开局装备快照（id -> 快照）。收齐之前不许开时间轴。 */
    const netPeerSnapshots = new Map<string, PeerSnapshot>();
    /** deploy 已执行、正在等全员快照；这段时间冻结推进。 */
    let awaitingLoadouts = false;
    let loadoutWaitFrames = 0;
    /** 联机诊断：主窗口的 `host.net.status()` 只读这些数，不重复计数。 */
    const netStat = {
      /** 真正执行的帧数。只可能是服务器给过的帧。 */
      ticks: 0,
      /** 采到并发出的意图条数（**只有有操作的帧才算**）。 */
      intentsOut: 0,
      /** 采到但「没有任何操作」因此没发的帧数。远大于 intentsOut = 玩家在挂机。 */
      idleFrames: 0,
      framesOut: 0, framesIn: 0,
      /** 服务器帧号领先执行指针多少（= 播放缓冲 + 网络延迟）。 */
      lead: 0,
      /** 收到过的最大服务器帧号。 */
      highest: 0,
      /** 已经执行过、又被重发过来的帧（replay 与实时流重叠时正常出现）。 */
      stale: 0,
      duplicates: 0,
      hashes: 0, flushes: 0, localEdges: 0, localMouse: 0,
      /** 补帧请求次数。持续增长 = 一直在丢包。 */
      replays: 0,
      /** 当前缺口大小（已经看到更高帧号但中间有洞的帧数）。 */
      gap: 0,
      /** 兼容旧诊断面板的字段：v2 不再「丢时间」，恒为 0。 */
      melted: 0,
      /** 兼容旧面板：迟到帧在 v2 里由补帧通道处理，这里的值等于 `stale`。 */
      lateFrames: 0,
    };

    function rebuildPeers(): void {
      syncRemotes();
    }

    /**
     * 让「看得见的影子角色」跟上参战名单：新来的人补一个，走了的人删掉。
     * 位置只在首次创建时定（出生点 + 按 id 的固定偏移），之后完全由输入驱动 ——
     * 两端算出来是同一个起点，所以不会出现「A 眼里 B 在左、B 眼里自己在右」。
     */
    function syncRemotes(): void {
      // 远端玩家现在是 `state.players` 里的**真玩家**，不再是独立的影子数组。
      // 这里只负责「名单 → 实体」：缺的补上，走了的删掉，位置一个都不动
      // （位置只能由 step() 算出来，谁都不许在这里写坐标）。
      if (!netActive) {
        if (state.players.length > 1) {
          state.players = state.players.filter((p) => p.id === state.me);
        }
        return;
      }
      const spawn = state.map.spawn;
      const keep: typeof state.players = [state.player];
      for (const id of [...netPeers].sort()) {
        if (id === netPlayerId || id === state.me) continue;
        const existing = state.players.find((p) => p.id === id);
        if (existing) {
          existing.name = netPeerNames.get(id) || existing.name;
          keep.push(existing);
          continue;
        }
        keep.push(createRemotePlayer(id, netPeerNames.get(id) || id.slice(0, 6), spawn, netPeerSnapshots.get(id)));
      }
      state.players = keep;
    }

    /**
     * 座位/参战名单变化。开局（active=true 且之前不是联机）时重置整条时间轴：
     * 联机局的 tick 必须从 0 起，两端才对得上 —— 一局一清。
     */
    function applySeat(msg: {
      active?: boolean; playerId?: string;
      peers?: ({ id: string; name?: string; snapshot?: PeerSnapshot } | string)[];
    }): void {
      if (msg.active !== true) {
        netActive = false;
        state.online = false;
        netSeatSettled = false;
        netPlayerId = '';
        // 回到单机：身份也还原成 'p0'，别把上一局的座位 id 带进本地局。
        state.player.id = 'p0';
        state.me = 'p0';
        netPeers.clear();
        netPeerNames.clear();
        netPeerSnapshots.clear();
        awaitingLoadouts = false;
        netOutbox = [];
        intentAcc = 0;
        lastIntent = null;
        driver = createSyncDriver(0, DEFAULT_LOOKAHEAD);
        state.players = state.players.filter((p) => p.id === state.me);
        return;
      }
      const starting = !netActive;
      netActive = true;
      state.online = true;
      netPlayerId = msg.playerId || netPlayerId;
      // **本机玩家也必须用座位 id**。以前本机恒为 'p0'、远端用真实座位 id，
      // 于是 A 的 players 是 {p0, B_id}、B 的是 {p0, A_id} —— 按 id 排序的
      // `hashGameState` 必然报分叉（玩家进 hash 之前看不出来）。
      if (netPlayerId && state.player.id !== netPlayerId) {
        state.player.id = netPlayerId;
        state.me = netPlayerId;
      }
      const list = Array.isArray(msg.peers) ? msg.peers : [];
      netPeers = new Set<string>();
      netPeerNames.clear();
      for (const entry of list) {
        const id = typeof entry === 'string' ? entry : entry?.id;
        if (!id) continue;
        netPeers.add(id);
        if (typeof entry !== 'string') {
          if (entry.name) netPeerNames.set(id, entry.name);
          if (entry.snapshot) netPeerSnapshots.set(id, entry.snapshot);
        }
      }
      if (list.length > 0) netSeatSettled = true;
      if (starting) armTimeline();
      rebuildPeers();
      // 有意不发任何「预热帧」：v2 里本机输入要等服务器贴帧再广播回来，本地
      // 没有需要预热的东西。硬发只会往服务器队列里灌几条开局空意图。
      // 名单没变、但这一轮带回了装备快照，也要试着放行门禁。
      tryArmAfterLoadouts();
    }

    /**
     * 为「这一局」把时间轴归零，并预发前 delay 帧。
     *
     * **两个入口都必须调用它**：第一条带名单的 `netSeat`，以及 `deploy`（新局开始）。
     *
     * 只挂在 `netSeat` 上会死锁 —— 如果上一局结束时 `netActive` 还是 true，
     * 新局到来时 `starting` 为 false，预热就再也不会执行；同时 `deploy` 分支
     * 又把 `netOutbox` 清空，结果双方都在等对方的 tick 0，而谁都没有 tick 0
     * 的帧可发。2026-11-20 实测：角标停在 `tick 0 等 41612ms`，画面完全冻住。
     *
     * 重复调用是安全的：每次都会重建一条从 0 开始的时间轴并重发同样的预热帧。
     */
    /**
     * 开局门禁：**收齐所有人的装备快照才 armTimeline**。
     *
     * 装备加成会改 maxHp / maxMana / 伤害 / 射程，而玩家 hp 与怪的血量都进
     * hash —— 若 A 在 tick 0 就带着 B 的真实装备、B 却要晚几帧才拿到 A 的，
     * 这几帧算出来的状态两端必然不同，之后永远追不回来。
     */
    function loadoutsReady(): boolean {
      // 没有对手也算「齐」：单人房间不该卡在门禁上。名单还没到由
      // `netSeatSettled` 冻结主循环，这里不用重复管。
      for (const id of netPeers) {
        if (id === netPlayerId) continue;
        if (!netPeerSnapshots.has(id)) return false;
      }
      return true;
    }

    function tryArmAfterLoadouts(): void {
      if (!netActive || !awaitingLoadouts || !loadoutsReady()) return;
      awaitingLoadouts = false;
      // armTimeline 末尾 rebuildPeers() → syncRemotes()，那时快照已齐，
      // 远端玩家会带着**真实装备**被创建（而不是空背包占位）。
      armTimeline();
    }

    /** 兜底：对方没上报（旧客户端 / 消息丢了）也不能永久冻结，用空快照开局。 */
    function forceStartWithoutLoadouts(): void {
      for (const id of netPeers) {
        if (id === netPlayerId || netPeerSnapshots.has(id)) continue;
        netPeerSnapshots.set(id, {
          loadout: null,
          hpMax: state.maxHp,
          manaMax: state.maxMana,
          starSkills: [...state.starSkills],
        });
      }
      tryArmAfterLoadouts();
    }

    function armTimeline(): void {
      if (!netActive || !netPlayerId) return;
      seekClock(stepClock, 0);
      // 执行指针归零：服务器的帧号也从 0 起，两边同一条时间轴。
      driver = createSyncDriver(0, DEFAULT_LOOKAHEAD);
      intentAcc = 0;
      nextIntentSeq = 0;
      // 旧影子还停在上一局的位置，要清掉。不清的后果不是「卡住」，而是更隐蔽的错：
      // 名单还在但角色是上一局的，两端算出来的状态从第一帧就不同。
      state.players = state.players.filter((p) => p.id === state.me);
      netOutbox = [];
      netStat.ticks = 0;
      netStat.intentsOut = 0;
      netStat.idleFrames = 0;
      lastIntent = null;
      netStat.framesOut = 0;
      netStat.framesIn = 0;
      netStat.hashes = 0;
      netStat.flushes = 0;
      netStat.localEdges = 0;
      netStat.localMouse = 0;
      netStat.replays = 0;
      netStat.stale = 0;
      netStat.duplicates = 0;
      // 必须放在最后：用（已经填好的）netPeers 把名单和新影子补回来。
      rebuildPeers();
      // 时间轴重建 = 执行指针归零。让主窗口把「已投递水位」也清掉，否则窗口里
      // 还留着的旧帧会被当成「已经给过了」而永远不再投递。
      channel?.postMessage({ type: 'netResync' });
    }

    /**
     * 收到一批服务器广播的帧。**一个 tick 一个包**，包里是这个 tick 里每个
     * 玩家的意图（缺席者不在表里 = 空输入）。
     *
     * 这里刻意不区分「自己的」和「别人的」帧 —— v2 里它们是同一种东西，
     * 本机玩家的操作也要等服务器贴帧后广播回来才生效。
     */
    function applyFrames(batches: { tick: number; frames: { from: string; b: string }[] }[]): void {
      let rosterChanged = false;
      for (const batch of batches) {
        // 收到帧 = 名单确实存在。即便 netSeat 迟到/为空也要解锁，否则
        // 「等名单才推进 / 推进才有帧可收」会互相锁死。
        if (!netSeatSettled) netSeatSettled = true;
        const frames = new Map<string, InputFrame>();
        for (const entry of batch.frames) {
          if (entry.from !== netPlayerId && !netPeers.has(entry.from)) {
            netPeers.add(entry.from);
            rosterChanged = true;
          }
          const frame = decodeOneFrame(entry.b);
          if (frame) frames.set(entry.from, frame);
        }
        if (frames.size === 0) continue;
        const result = acceptFrame(driver, { tick: batch.tick, frames });
        if (result === 'accepted') netStat.framesIn += frames.size;
        else if (result === 'stale') netStat.stale += 1;
        else netStat.duplicates += 1;
      }
      if (rosterChanged) rebuildPeers();
    }

    /** 补帧回包：`data` 是 `[[tick, [[playerId, base64], ...]], ...]`。 */
    function applyReplay(reply: { seq: number; data: [number, [string, string][]][] }): void {
      for (const [tick, entries] of reply.data) {
        const frames = new Map<string, InputFrame>();
        for (const [playerId, encoded] of entries) {
          const frame = decodeOneFrame(encoded);
          if (frame) frames.set(playerId, frame);
        }
        if (frames.size === 0) continue;
        const result = acceptFrame(driver, { tick, frames });
        if (result === 'accepted') netStat.framesIn += frames.size;
        else if (result === 'stale') netStat.stale += 1;
      }
      // 确认收到：服务端删掉这份回包，否则每轮广播都会重带一次。
      channel?.postMessage({ type: 'netReplayAck', seq: reply.seq });
    }

    /** 一个 base64 包 → 一帧。批量包里只有第一帧（服务器每帧一包）。 */
    function decodeOneFrame(encoded: string): InputFrame | null {
      const decoded = decodePacket(decodeBase64(encoded));
      if (decoded.kind === 'frame') return decoded.frame;
      if (decoded.kind === 'batch') return decoded.frames[0] ?? null;
      return null;
    }

    /** 每 60 tick 一次对账。单机只算不发（用来验证「同一 seed 两遍跑出同一个 hash」）。 */
    function reportHash(tick: number): void {
      if (tick <= 0 || tick % HASH_INTERVAL_TICKS !== 0) return;
      const hash = hashGameState(state, tick);
      netStat.hashes += 1;
      // 全状态分项指纹随总 hash 一起上报：服务端第一次记到分叉时就能回答
      // 「是怪 / 掉落 / 玩家 / 破坏物 / 其余共享世界哪一项先不同」，不用靠猜。
      channel?.postMessage({
        type: 'netHash', tick, hash, parts: hashGameParts(state), active: netActive,
      });
    }

    let netDiagAt = 0;
    function publishNetDiag(now: number): void {
      if (!netActive) return;
      if (now - netDiagAt < 1000) return;
      netDiagAt = now;
      const have = contiguous(driver);
      const lead = Math.max(0, driver.highestSeen - driver.nextTick);
      netStat.lead = lead;
      netStat.highest = driver.highestSeen;
      netStat.gap = Math.max(0, lead - have);
      netStat.lateFrames = netStat.stale;
      channel?.postMessage({
        type: 'netStat',
        stat: {
          ...netStat,
          /** 下一个要执行的帧号。永远 ≤ `highest`。 */
          tick: driver.nextTick,
          /** 1 = 现在没有可执行帧（在等服务器 / 在补帧）。 */
          waiting: canStep(driver) ? 0 : 1,
          /** 已看到更高帧号、但手里还缺的帧（最多列 16 个）。 */
          pending: pendingTicks(driver),
          peers: [...netPeers],
          /** 已经建出来的影子数量。与 peers 数量对照能区分「名单没到」和「影子没建」。 */
          remotes: Math.max(0, state.players.length - 1),
          /** 诊断：卡在 0 时用来一眼分辨「名单没到 / 主循环被锁 / 帧没发出去」。 */
          settled: netSeatSettled,
          outbox: netOutbox.length,
          flushes: netStat.flushes,
          locked,
          paused,
        },
      });
    }

    /**
     * 单机推进：采一格走一格。与改造前的行为等价，唯一的差别是 `dt` 固定成
     * 1/60 —— 这让同一份操作在任何帧率下跑出同一串位置，验收脚本才有意义。
     */
    function advanceSolo(delta: number): void {
      addTime(stepClock, delta);
      while (takeStep(stepClock)) {
        const tick = stepClock.tick - 1;
        const frame = takeLatched(latch, tick);
        step(state, FIXED_DT, toStepInput(frame), modifiers);
        reportHash(tick);
      }
    }

    /**
     * 卡住 5 秒后恢复时，`acc` 里攒着 5 秒的量（300 步）。一口气跑完会让这一
     * 渲染帧占用几十毫秒，玩家看到的是「卡完再卡一下」。
     *
     * 所以每渲染帧最多补这么多步，**剩下的留在 `acc` 里下一帧继续** —— 这是
     * 「不丢时间」和「不卡死」之间唯一正确的取法。
     *
     * 取值 = `MAX_FRAME_DELTA (0.25s) × FIXED_HZ` = 6 步 @24 Hz。
     * 追帧速率 360 步/秒，卡 12 秒（300 帧）能在 0.8 秒内追平，观感是快进。
     */
    const MAX_CATCHUP_STEPS = 6;

    /**
     * 联机推进：**只执行服务器广播过的连续帧**。
     *
     * 三件互不干扰的事，顺序不能换：
     *
     * 1. **采意图**（墙钟节拍，60 Hz，和执行解耦）。执行会被服务器卡住，但采样
     *    不能停 —— 停了就等于「我一卡，我的操作也跟着停」。意图不带帧号，
     *    而且**这一帧没有操作就不发**（`intent-filter.ts`）。
     * 2. **执行**：`canStep` 要求手里从 `nextTick` 起连续 `lookahead` 帧都齐了。
     *    不够就**一帧都不走**（画面停住、操作无响应），而且时间**不扣** ——
     *    恢复后一次性补算。这是「固定延迟换画面不抖」的全部实现。
     * 3. **补帧**：看到更高的帧号但中间有洞，立刻向服务器要。同一缺口有节流。
     *
     * 这里**没有**「等某个玩家」的语义。谁没交意图，那一帧他就是空输入，
     * 绝不让最慢的客户端决定全场帧率。
     */
    function advanceNet(delta: number): void {
      const now = Date.now();
      // ---- 1) 采意图：按墙钟走，不受执行卡顿影响 ----
      intentAcc += delta;
      let sampled = 0;
      while (intentAcc >= FIXED_DT && sampled < 8) {
        intentAcc -= FIXED_DT;
        sampled += 1;
        // 先取出这一帧（顺带清掉边沿），再判断值不值得发。
        const intent = takeLatched(latch, nextIntentSeq);
        if (!hasActivity(intent, lastIntent)) {
          netStat.idleFrames += 1;
          continue;
        }
        nextIntentSeq += 1;
        lastIntent = intent;
        if (intent.pointerDown) netStat.localEdges += 1;
        if (intent.mouse) netStat.localMouse += 1;
        netOutbox.push(intent);
        netStat.intentsOut += 1;
      }
      // 标签页被切走很久之后回来：`intentAcc` 会堆成几秒，一次灌几百条意图
      // 只会让服务器把它们贴到未来几百帧上。直接丢掉，玩家不会希望「回来
      // 之后自动跑完离开的那段」。
      if (intentAcc > FIXED_DT * 8) intentAcc = 0;
      flushOutbox();

      // ---- 2) 执行：只跑服务器给过的帧 ----
      addTime(stepClock, delta);
      let steps = 0;
      while (stepClock.acc + 1e-9 >= FIXED_DT && canStep(driver)) {
        if (steps >= MAX_CATCHUP_STEPS) break;
        const packet = takeSync(driver);
        if (!packet) break;
        takeStep(stepClock);
        const remoteInputs = new Map<string, ReturnType<typeof toStepInput>>();
        for (const [peerId, frame] of packet.frames) {
          if (peerId === netPlayerId) continue;
          remoteInputs.set(peerId, toStepInput(frame));
        }
        // **本机输入也来自这一帧广播**：没有预表现，玩家按下到生效要等一个回程。
        // 这是「不做预表现 + 不拥有自己的帧」的必然代价（`docs/net-sync-v2.md` §4）。
        const localFrame = packet.frames.get(netPlayerId);
        step(
          state,
          FIXED_DT,
          localFrame ? toStepInput(localFrame) : toStepInput(emptyInputFrame(packet.tick)),
          modifiers,
          remoteInputs,
        );
        reportHash(packet.tick);
        netStat.ticks += 1;
        steps += 1;
      }

      // ---- 3) 补帧：有洞就立刻要 ----
      const gap = requestReplay(driver, now);
      if (gap) {
        netStat.replays += 1;
        channel?.postMessage({ type: 'netReplay', from: gap.from, to: gap.to });
      }
    }

    /**
     * 有意图就立刻发。
     *
     * 以前是「攒够 3 条（50 ms）再发」，那是为了让包数跟 20 Hz 广播对齐。现在
     * 只在有操作时才产意图，攒批就等于让「点一下」白等两帧 —— 而一次操作一个包
     * 本来就不费什么（40 字节级），所以直接发。
     */
    function flushOutbox(): void {
      if (!netActive) {
        netOutbox.length = 0;
        return;
      }
      if (netOutbox.length === 0) return;
      const frames = netOutbox.splice(0, 16);
      netStat.framesOut += frames.length;
      netStat.flushes += 1;
      channel?.postMessage({
        type: 'netOut',
        // 第一条意图的序号。**不是帧号** —— 落在哪一帧由服务器决定。
        s: frames[0]!.seq,
        n: frames.length,
        b: encodeBase64(encodeBatch(frames)),
      });
    }

    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(RUN_CHANNEL);
      channel.onmessage = (event: MessageEvent) => {
        const msg = event.data as {
          type?: string;
          deployment?: Deployment;
          command?: RunCommand;
          requestId?: number;
          /** netSeat：联机座位/参战名单。 */
          active?: boolean;
          playerId?: string;
          peers?: ({ id: string; name?: string } | string)[];
          /** netIn：服务器广播的帧批次（一个 tick 一个包，含每个玩家的意图）。 */
          batches?: { tick: number; frames: { from: string; b: string }[] }[];
          /** netReplayData：补帧回包。 */
          replay?: { seq: number; data: [number, [string, string][]][] };
        } | null;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'deploy') {
          // Real play always comes through the meta shell's deploy step, so
          // this is the single switch from the acceptance fixture to arena.ldtk.
          // The shell has ALREADY emptied its own bag + equipment; `loadout`
          // is the structured-cloned copy this Worker now owns exclusively.
          setArena(state, arena);
          modifiers = createModifiers(msg.deployment?.stars?.nodes ?? []);
          deployRun(state, msg.deployment ?? {});
          // 出生点偏移必须**对所有玩家**用同一套规则：`createRemotePlayer` 按 id
          // 给远端算了，本机如果还杵在裸 spawn 上，两端对同一个人的坐标认知就
          // 不同（A 看 A 在中心、B 看 A 在旁边），而坐标进 hash。
          if (netActive && netPlayerId) {
            const off = spawnOffset(netPlayerId);
            const sx = state.map.spawn.x + off.dx;
            const sy = state.map.spawn.y + off.dy;
            state.player.x = sx;
            state.player.y = sy;
            state.player.intent.target = { x: sx, y: sy };
          }
          lastResult = null;
          resultSent = false;
          publishRunState(true);
          channel?.postMessage({ type: 'deployed', loadout: snapshotRun(state.runInventory) });

          if (netActive) {
            // 上报自己的开局快照：装备 + **算好的**属性 + 星图技能。
            // 属性必须等 deployRun() 跑完才有（装备/星图乘区在那里结算）。
            awaitingLoadouts = true;
            loadoutWaitFrames = 0;
            channel?.postMessage({
              type: 'netLoadout',
              snapshot: {
                loadout: msg.deployment?.loadout ?? null,
                hpMax: state.maxHp,
                manaMax: state.maxMana,
                starSkills: [...state.starSkills],
              },
            });
            // 收齐之后由 applySeat 触发 tryArmAfterLoadouts() → armTimeline()。
            tryArmAfterLoadouts();
          } else {
            seekClock(stepClock, 0);
          }
        } else if (msg.type === 'runCommand') {
          // The in-run character panel is a read-only view. Every drag / equip
          // is validated and applied HERE, then the new snapshot goes back.
          if (msg.command !== undefined) {
            applyRunCommand(state.runInventory, msg.command);
            syncWeaponSlots(state);
            publishRunState(true);
          }
        } else if (msg.type === 'fixtureReset') {
          /**
           * **仅供自动化验收夹具**：`playthrough*.mjs` 每一步都要从干净状态
           * 出发（怪回到出生点、计数器归零、技能冷却清空）。
           *
           * 这不是玩家功能：玩家按 R 已被彻底删除，`reset` 永远不进输入帧，
           * 也不出现在 `step()` 里。它只由验收脚本通过 BroadcastChannel
           * 显式调用，属于**局外管理动作**，与帧同步的 `F` 无关。
           * 生产宿主不会收到这条消息（只有验收脚本会发）。
           */
          reset(state);
          seekClock(stepClock, 0);
          lastResult = null;
          resultSent = false;
          publishRunState(true);
        } else if (msg.type === 'abort') {
          // Returning to the lobby, refreshing or closing the preview is a
          // LOSS: the whole run state is discarded. The lobby is already empty.
          state.runInventory = makeRunInventory(EMPTY_RUN);
          modifiers = createModifiers([]);
          reset(state);
          seekClock(stepClock, 0);
          lastResult = null;
          resultSent = false;
          publishRunState(true);
        } else if (msg.type === 'hello') {
          channel?.postMessage({ type: 'ready' });
        } else if (msg.type === 'netSeat') {
          applySeat({ active: msg.active, playerId: msg.playerId, peers: msg.peers });
        } else if (msg.type === 'netIn') {
          if (Array.isArray(msg.batches)) applyFrames(msg.batches);
        } else if (msg.type === 'netReplayData') {
          if (msg.replay && typeof msg.replay === 'object') applyReplay(msg.replay);
        } else if (msg.type === 'netSeatRequest') {
          // 主窗口刚起来 / 刚刷新时不知道 Worker 在不在等座位信息。
          channel?.postMessage({
            type: 'netSeat',
            active: netActive,
            playerId: netPlayerId,
            peers: [...netPeers],
          });
        } else if (msg.type === 'lock') {
          locked = true;
        } else if (msg.type === 'unlock') {
          // One-shot: never reset a live run just because another `hello`
          // handshake arrived. Only a real auth transition sends `unlock`.
          if (locked) {
            locked = false;
            reset(state);
            lastResult = null;
            resultSent = false;
          }
        } else if (msg.type === 'pause') {
          paused = true;
        } else if (msg.type === 'resume') {
          paused = false;
        } else if (msg.type === 'probe') {
          // Read-only observability seam for REAL 4174 acceptance runs. The
          // projection registry lives in this Worker's module scope, so an
          // external harness cannot call `game.state` directly. This branch
          // only serialises the current state; it never mutates gameplay and
          // deliberately does NOT register another read projection, which
          // would break `project play`'s "single projection" resolution.
          const extent = host?.drawingBufferSize?.() ?? null;
          channel?.postMessage({
            type: 'state',
            requestId: msg.requestId,
            state: readProjection(),
            // `projection()` exposes only the first drop (a legacy playthrough
            // field). A real multi-monster run needs every drop location to
            // walk over and pick the loot up.
            drops: state.drops.map((d) => {
              const v = worldToScreen(state.camera, d.x, d.y);
              return {
                x: v.x / VIEW_W,
                y: v.y / VIEW_H,
                itemId: d.itemId ?? null,
                name: d.name ?? null,
                quality: d.quality ?? null,
              };
            }),
            extent,
            // Read-only proof of the render density, so acceptance can assert
            // the canvas is actually supersampling instead of trusting a reply.
            renderScale: surfaceScale,
          });
        }
      };
      // Main-window scripts (including the login overlay) run BEFORE this
      // Worker boots. A `hello` sent at DOMContentLoaded is therefore lost,
      // and so is the overlay's initial `lock`. Proactively announce readiness
      // so the overlay can reassert the lock as soon as this channel exists.
      channel?.postMessage({ type: 'ready' });
    }

    /**
     * The main-window panel renders a COPY of the Worker's run state. Publish
     * a fresh snapshot whenever it actually changes (pickup, equip, fixture reset).
     */
    const publishRunState = (force = false): void => {
      const loadout = snapshotRun(state.runInventory);
      const signature = JSON.stringify(loadout);
      if (!force && signature === lastRunSignature) return;
      lastRunSignature = signature;
      channel?.postMessage({ type: 'runState', loadout });
    };

    const settleIfFinished = (): void => {
      if (resultSent) return;
      // 联机 PVP 阵亡是**按玩家**的：本机实体 hp<=0 且独立结算时钟归零才发
      // result。不置 `s.gameOver`，所以帧循环照样推进、其他玩家照常行动。
      // `state.player` 在联机里就是本机实体（`applySeat` 把 id 改成了座位 id，
      // `syncRemotes()` 永远把它放在 players[0]），读它不算「判定层读本机」——
      // 这里是 `step()` 之外的只读观察 / V 层结算。
      const pvpDead = state.online && state.runKind === 'pvpve'
        && state.player.hp <= 0 && state.player.deathTimer === 0;
      // 三种结束方式：主线清场（cleared）/ 撤离（extracted）/ 阵亡或超时（gameOver）；
      // 第四种是联机 PVP 的个人阵亡，只结算死者自己。
      if (!state.cleared && !state.extracted && !state.timedOut
        && !state.gameOver && !pvpDead) return;
      resultSent = true;
      const lost = state.gameOver || state.timedOut || pvpDead;
      // 死亡结算（设计 4）：主线整份带回；副本 / 搜打撤只带回保险格里的东西。
      // 分割规则是 `meta/inventory.ts::splitOnDeath()`，两个堆共用一份。
      const settlement = settleOnDeath(state, !lost);
      lastResult = {
        outcome: lost ? 'gameOver' : state.extracted ? 'extracted' : 'cleared',
        ...(lost ? { reason: state.timedOut ? 'timedOut' as const : 'dead' as const } : {}),
        ...(pvpDead ? { pvpDeath: true } : {}),
        lootLog: state.lootLog.map((r) => ({
          monsterId: r.monsterId, itemId: r.itemId, name: r.name, quality: r.quality,
        })),
        kills: state.kills,
        xp: state.xp,
        stage: state.map.id,
        // A clear / extraction brings the WHOLE run home; a loss discards it.
        // There is no per-uid reconciliation, no findFirstFit banking, no overflow.
        loadout: lost ? null : snapshotRun(state.runInventory),
        kept: lost ? settlement.kept : null,
        lost: lost ? settlement.lost.map((it) => ({
          defId: it.defId,
          ...(it.durability === undefined ? {} : { durability: it.durability }),
          ...(it.affixes === undefined ? {} : { affixes: it.affixes }),
          ...(it.damage === undefined ? {} : { damage: it.damage }),
        })) : [],
        // 阵亡点：副本遗物落在这里。玩家被冻结后不再移动，所以结算时读到的就是死点。
        deathAt: lost ? { x: state.player.x, y: state.player.y } : null,
        deathDropLeft: leftoverDeathDrops(state),
      };
      channel?.postMessage({ type: 'result', result: lastResult });
    };

    ctx.effect(function* () {
      yield () => { channel?.close(); channel = null; };
      const texture = new CanvasTexture(surface, { flipY: false });
      yield () => texture.dispose();

      const materialHandle = assets
        .create(Materials.unlit('#ffffff', { baseColorTexture: { source: texture.source } }))
        .unwrap();
      const meshHandle = assets.create(createPrimitiveMesh('quad').unwrap()).unwrap();

      const quad = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0], scale: [2, 2, 1] } },
          { component: MeshFilter, data: { assetHandle: meshHandle } },
          { component: MeshRenderer, data: { materials: [materialHandle] } },
        )
        .unwrap();
      // The spawned components hold their own references.
      assets.release(materialHandle).unwrap();
      assets.release(meshHandle).unwrap();
      yield () => world.despawn(quad).unwrap();

      const camera = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 5] } },
          {
            component: Camera,
            data: {
              ...orthographic({ left: -1, right: 1, bottom: -1, top: 1, near: 0.1, far: 20 }),
              clearColor: [0.03, 0.06, 0.1, 1],
              tonemap: 0,
            },
          },
        )
        .unwrap();
      yield () => world.despawn(camera).unwrap();

      world
        .addSystem(Update, {
          name: 'game/arena-frame',
          queries: [],
          fn: () => {
            const snapshot = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
            const raw = world.getResource(Time).delta;
            // 渲染用的真实帧时长，只喂给绘制层的视觉插值。
            // 模拟层拿到的永远是 FIXED_DT —— 这是 P2 的第一条改动，也是帧同步的前提：
            // 60Hz 与 144Hz 的机器跑同一份输入，必须走出同一串位置。
            const renderDt = Math.min(Math.max(raw, 0), 0.05);
            const reported = snapshot?.mouse?.position;
            if (reported) lastPointer = { x: reported.x, y: reported.y };
            // Sticky: reuse the last known position on frames that omit it.
            const pointer = lastPointer ?? undefined;
            // InputSnapshot.mouse.position is in canvas *physical* pixels: the
            // browser backend scales client coords by canvas.width / rect.width.
            // This Engine realm is a Worker: it has neither `document` nor
            // `gameHost.canvas`, so the authoritative extent is the Host's
            // drawingBufferSize() -- documented as "current input-coordinate
            // extent, including source realms without a canvas". Read it every
            // frame so resize / DPR changes stay aligned. Dividing by a fixed
            // 1280x720 instead scales the pointer away from the visual cursor
            // and makes the player walk in the wrong direction on any window
            // whose drawing buffer is not exactly 1280x720.
            const extent = host?.drawingBufferSize?.();
            const canvasW = extent?.width || VIEW_W;
            const canvasH = extent?.height || VIEW_H;
            const screenX = pointer ? (pointer.x / canvasW) * VIEW_W : 0;
            const screenY = pointer ? (pointer.y / canvasH) * VIEW_H : 0;
            // The minimap is READ ONLY: pointer orders inside it are dropped,
            // so it can never be clicked to move or to follow the cursor.
            const onMinimap = screenX >= MINIMAP.x
              && screenX <= MINIMAP.x + MINIMAP.w
              && screenY >= MINIMAP.y
              && screenY <= MINIMAP.y + MINIMAP.h;
            // M 只切**本机**视图状态，不进输入帧（更不进世界状态）。
            // 打开时大地图铺满画布，指针等同于落在 HUD 上：点击不会穿透
            // 去移动 / 攻击。这个判定也只影响本机的输入采集。
            if (snapshot?.keyboard?.justPressedCode('KeyM') ?? false) {
              view.bigMap = !view.bigMap;
            }
            const onHud = onMinimap || view.bigMap;
            const worldMouse = pointer
              ? screenToWorld(state.camera, screenX, screenY)
              : undefined;
            // press / held / release let the simulation classify a short click
            // (order: move to ground, or attack one enemy) vs. a long hold
            // (the only state with continuous cursor following). Hovering with
            // no button produces no order at all.
            const mouse = snapshot?.mouse;
            // 技能键 / 喝药键只在输入层出现一次映射（SKILL_KEYS 是唯一权威，HUD 读同一份）。
            const skillSlot = SKILL_KEYS.findIndex(
              (code) => snapshot?.keyboard?.justPressedCode(code) ?? false,
            );
            // Login overlay AND platform lifecycle pause: freeze simulation and
            // settlement, but keep painting so the canvas shows a live frame.
            //
            // 一帧渲染只**采集**一次输入，由锁存按逻辑步分发：边沿（按下/松手/
            // 按键）只给这一帧的第一个步，持续态（指针位置、按住）保留给后续步。
            // 不分发的话，一帧跑 3 步会把一次点击变成三连击。
            captureInput(latch, {
              mouse: worldMouse ? { x: worldMouse.x, y: worldMouse.y } : null,
              pointerDown: !onHud && (mouse?.justPressed(0) ?? false),
              pointerHeld: !onHud && (mouse?.button(0) ?? false),
              pointerUp: !onHud && (mouse?.justReleased(0) ?? false),
              dodge: snapshot?.keyboard?.justPressedCode('Space') ?? false,
              // 主动技能（1..7 格）与蓝药：justPressed 才算，按住不会连发。
              potion: snapshot?.keyboard?.justPressedCode(POTION_KEY) ?? false,
              healPotion: snapshot?.keyboard?.justPressedCode(HEAL_KEY) ?? false,
              // E = 起手 / 取消传送门引导（搜打撤的「撤」）。
              extractChannel: snapshot?.keyboard?.justPressedCode('KeyE') ?? false,
              skill: skillSlot >= 0 ? skillSlot : NO_SKILL,
              switchWeapon: snapshot?.keyboard?.justPressedCode('Digit1') ?? false
                ? 0
                : (snapshot?.keyboard?.justPressedCode('Digit2') ?? false) ? 1 : NO_SWITCH,
              // Hover feedback must not light up while the pointer sits on
              // the read-only minimap / 大地图: those rectangles are not world space.
              pointerOnHud: onHud,
            });

            if (!locked && !paused) {
              if (netActive) {
                // 装备快照没收齐就冻结：既不推进、也不攒时间（理由同上，
                // 名单/快照到达那一刻一次吐出几百步会让两端 tick 错开）。
                if (awaitingLoadouts) {
                  loadoutWaitFrames += 1;
                  if (loadoutWaitFrames > 300) forceStartWithoutLoadouts();
                }
                if (netSeatSettled && !awaitingLoadouts) advanceNet(raw);
              } else advanceSolo(raw);
              // Pickups / weapon switches happen INSIDE this Worker now. Only
              // a changed snapshot is sent to the read-only character panel.
              publishRunState();
              settleIfFinished();
            }
            publishNetDiag(Date.now());
            // Whole multiples only. A fractional ratio would make the 2D
            // rasteriser antialias the block edges -- exactly the softness this
            // change exists to remove. `ceil` (not `round`) because a 1.25x
            // window has nothing to gain from rendering at 1x and being
            // stretched, while 2x still supersamples it.
            resizeSurface(Math.max(
              1,
              Math.min(
                RENDER_SCALE_MAX,
                Math.ceil(Math.max(canvasW / VIEW_W, canvasH / VIEW_H)),
              ),
            ));
            painter.setTransform(surfaceScale, 0, 0, surfaceScale, 0, 0);
            // 状态图标的悬停提示要指针位置：传视图坐标（不是物理像素），
            // 否则 2x 渲染下会指到左上角去。
            paint(painter, state, pointer ? { x: screenX, y: screenY } : undefined, renderDt, view);
            texture.update();
            // Pointer feedback: the source realm cannot touch CSS, so tell the
            // main window which enemy (if any) is under the free cursor. Sent
            // only on change -- this is not a per-frame state stream.
            if (state.hoverEnemy !== lastHover) {
              lastHover = state.hoverEnemy;
              channel?.postMessage({ type: 'hoverEnemy', index: lastHover });
            }
          },
        })
        .unwrap();
      yield () => world.removeSystem(Update, 'game/arena-frame').unwrap();

      const unregister = host?.gameProjection?.registerRead({
        id: 'game.state',
        title: '2.5D arena state',
        description:
          'Player position, health, kills, living skeletons, drops, equipped main weapon, cooldowns and loot log.',
        read: () => readProjection(),
      });
      if (unregister !== undefined) yield unregister;

      // `game.state` MUST stay the ONLY read projection. ForgeAX `project play`
      // resolves an unqualified read by "the single registered projection"; a
      // second one makes every playthrough step fail with state-unavailable,
      // even though the scripts pass 'game.state' explicitly. Run results and
      // deployments travel over BroadcastChannel (see the bridge above), so
      // they need no projection seam here.
    }, 'game/arena');
  },
};

export default definePack({
  schemaVersion: '2.0.0',
  plugins: true,
  packageId: PACKAGE_ID,
  build: () =>
    ok({
      'plugin/engine': {
        kind: 'plugin',
        module: { specifier: './game.pack.ts', export: 'game' },
      },
    }),
});
