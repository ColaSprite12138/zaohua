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
// 帧同步（P2）：固定步长 + 输入帧 + 等齐队列 + hash 对账。
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
import {
  DEFAULT_LOCAL_DELAY, createLockstep, noteWait, pendingPeers,
  pushLocal, pushRemote, retirePeer, runnableTick, take as takeLockstep,
} from '../net/lockstep.ts';
import { HASH_INTERVAL_TICKS, hashGameState } from '../net/state-hash.ts';
import { createRemoteActor, findRemote, stepRemoteActor } from '../net/remote-actor.ts';
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
    /** 联机中：input relay 已接上，tick 由 lockstep 决定。 */
    let netActive = false;
    /** 平台给的座号。服务端广播里的 playerId 与它必须一致。 */
    let netPlayerId = '';
    /** 锁步队列。单机时 localDelay = 0 且没有 peer，等价于不排队。 */
    let lockstep = createLockstep({ localId: '', localDelay: 0 });
    /** 在场 peer 与「服务端宣布过的离场」，两者重建 lockstep 的等待集合。 */
    let netPeers = new Set<string>();
    /** peer 的显示名（服务端 broadcast 里带过来），只用于头顶标签。 */
    const netPeerNames = new Map<string, string>();
    const netRetired = new Map<string, number>();
    /** 还没打包发走的本地帧。攒 3 帧（50ms）发一次，与平台 20Hz 广播同频。 */
    let netOutbox: InputFrame[] = [];
    /**
     * 参战名单是否已经确定。联机局在名单到达**之前不能推进**：否则会把它当
     * 单机跑（runnableTick 永远非空），等对方入座时我这边已经跑出几百 tick，
     * 两端帧号永远对不上。名单一旦见过一次就算 settled，之后有人离场仍继续。
     */
    let netSeatSettled = false;
    /** 联机诊断：主窗口的 `host.net.status()` 只读这些数，不重复计数。 */
    const netStat = {
      ticks: 0, framesOut: 0, framesIn: 0, lateIn: 0, droppedOut: 0,
      hashes: 0, flushes: 0, localEdges: 0, localMouse: 0,
      /** 因为触到单帧步数上限而被丢掉的时间（次）。持续增长 = 一直在追帧。 */
      melted: 0,
    };

    function rebuildPeers(): void {
      lockstep.peers = new Set([...netPeers].filter((id) => id !== netPlayerId));
      for (const [id, from] of netRetired) {
        if (lockstep.peers.has(id)) lockstep.retired.set(id, from);
      }
      syncRemotes();
    }

    /**
     * 让「看得见的影子角色」跟上参战名单：新来的人补一个，走了的人删掉。
     * 位置只在首次创建时定（出生点 + 按 id 的固定偏移），之后完全由输入驱动 ——
     * 两端算出来是同一个起点，所以不会出现「A 眼里 B 在左、B 眼里自己在右」。
     */
    function syncRemotes(): void {
      if (!netActive) {
        if (state.remotes.length > 0) state.remotes = [];
        return;
      }
      const spawn = state.map.spawn;
      const next: typeof state.remotes = [];
      for (const id of lockstep.peers) {
        if (lockstep.retired.has(id)) continue;
        const existing = findRemote(state.remotes, id);
        if (existing) {
          existing.name = netPeerNames.get(id) || existing.name;
          next.push(existing);
          continue;
        }
        next.push(createRemoteActor(id, netPeerNames.get(id) || id.slice(0, 6), spawn, lockstep.tick));
      }
      state.remotes = next;
    }

    /**
     * 座位/参战名单变化。开局（active=true 且之前不是联机）时重置整条时间轴：
     * 联机局的 tick 必须从 0 起，两端才对得上 —— 一局一清。
     */
    function applySeat(msg: {
      active?: boolean; playerId?: string; peers?: ({ id: string; name?: string } | string)[];
    }): void {
      if (msg.active !== true) {
        netActive = false;
        netSeatSettled = false;
        netPlayerId = '';
        netPeers.clear();
        netPeerNames.clear();
        netRetired.clear();
        netOutbox = [];
        lockstep = createLockstep({ localId: '', localDelay: 0 });
        state.remotes = [];
        return;
      }
      const starting = !netActive;
      netActive = true;
      netPlayerId = msg.playerId || netPlayerId;
      const list = Array.isArray(msg.peers) ? msg.peers : [];
      netPeers = new Set<string>();
      netPeerNames.clear();
      for (const entry of list) {
        const id = typeof entry === 'string' ? entry : entry?.id;
        if (!id) continue;
        netPeers.add(id);
        if (typeof entry !== 'string' && entry.name) netPeerNames.set(id, entry.name);
      }
      if (list.length > 0) netSeatSettled = true;
      if (starting) armTimeline();
      rebuildPeers();
      // 预热帧必须立刻发，不能等主循环推进：推进本身在等对方的帧，而对方也在
      // 等我的 tick 0。等 advanceLockstep 跑起来再 flush 就是典型的鸡生蛋死锁。
      flushOutbox();
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
    function armTimeline(): void {
      if (!netActive || !netPlayerId) return;
      seekClock(stepClock, 0);
      lockstep = createLockstep({ localId: netPlayerId, localDelay: DEFAULT_LOCAL_DELAY });
      // 预热：本地帧提前 delay 个 tick 提交，所以开局这几格先用「无输入」占位，
      // 否则第一个 tick 永远等不到自己的帧，整局卡死在 0。
      // **这几帧也必须发出去**：对方在等 tick 0，而它们是唯一会带上 tick 0
      // 的本地帧。只 pushLocal 不进 outbox 的话，双方都会永远等对方的第一帧。
      netOutbox = [];
      for (let i = 0; i < DEFAULT_LOCAL_DELAY; i += 1) {
        const warm = emptyInputFrame(lockstep.tick + i);
        pushLocal(lockstep, warm);
        netOutbox.push(warm);
      }
      netStat.ticks = 0;
      netStat.framesOut = 0;
      netStat.framesIn = 0;
      netStat.lateIn = 0;
      netStat.droppedOut = 0;
      netStat.hashes = 0;
      netStat.flushes = 0;
      netStat.localEdges = 0;
      netStat.localMouse = 0;
      netStat.melted = 0;
      flushOutbox();
    }

    /** 收到远端输入包：base64 → 批量帧 → 锁步队列。迟到/重复由队列自己记账。 */
    function applyRemotePackets(packets: { from: string; t: number; n: number; b: string }[]): void {
      let rosterChanged = false;
      for (const packet of packets) {
        // 收到对方的帧 = 对方确实在场。即便 netSeat 那条名单迟到/为空，
        // 这里也必须解锁，否则「等名单才推进 / 推进才发帧」会互相锁死。
        if (!netSeatSettled) netSeatSettled = true;
        if (!netPeers.has(packet.from)) {
          netPeers.add(packet.from);
          rosterChanged = true;
        }
        const decoded = decodePacket(decodeBase64(packet.b));
        if (decoded.kind !== 'batch') continue;
        for (const frame of decoded.frames) {
          const result = pushRemote(lockstep, packet.from, frame);
          if (result === 'accepted') netStat.framesIn += 1;
          else if (result === 'late') netStat.lateIn += 1;
        }
      }
      if (rosterChanged) rebuildPeers();
    }

    function applyRetired(peers: { peerId: string; fromTick: number }[]): void {
      for (const entry of peers) {
        netRetired.set(entry.peerId, entry.fromTick);
        retirePeer(lockstep, entry.peerId, entry.fromTick);
      }
    }

    /** 每 60 tick 一次对账。单机只算不发（用来验证「同一 seed 两遍跑出同一个 hash」）。 */
    function reportHash(tick: number): void {
      if (tick <= 0 || tick % HASH_INTERVAL_TICKS !== 0) return;
      const hash = hashGameState(state, tick);
      netStat.hashes += 1;
      channel?.postMessage({ type: 'netHash', tick, hash, active: netActive });
    }

    let netDiagAt = 0;
    function publishNetDiag(now: number): void {
      if (!netActive) return;
      if (now - netDiagAt < 1000) return;
      netDiagAt = now;
      channel?.postMessage({
        type: 'netStat',
        stat: {
          ...netStat,
          tick: lockstep.tick,
          waiting: noteWait(lockstep, now),
          pending: pendingPeers(lockstep),
          peers: [...lockstep.peers],
          lateFrames: lockstep.lateFrames,
          longestWaitMs: lockstep.longestWaitMs,
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
        if (frame.restart) {
          lastResult = null;
          resultSent = false;
        }
        reportHash(tick);
      }
    }

    /**
     * 联机推进：**等齐才走**。
     *
     * 三条不能动的顺序：
     * 1. 先确认 acc 够一步、且 `runnableTick` 非空 —— 两者都满足才真的推进；
     *    缺帧时既不推 tick 也不扣时间，否则恢复后永远追不回来，两端 tick 永久错位。
     * 2. `takeLockstep()` 取出的本地帧是**三个 tick 前**采的：本地输入和远端走
     *    同一条延迟队列，没有「我先动了再发」。
     * 3. 每推进一步才采样下一个待提交 tick，保证「每 tick 恰好一个本地帧」，
     *    与渲染帧率无关（144Hz 的机器也不会多发）。
     */
    /**
     * 一帧最多推进多少逻辑步。
     *
     * 等过对方帧之后，`acc` 里攒着的时间会在放行时一次性补上；不设上限的话一次
     * 能跑十几步（`step` + 影子 + 渲染都翻十几倍），玩家看到的就是一帧顿一下。
     * 这里宁可**丢掉**超出部分：帧同步的 tick 是逻辑时间，丢时间只会让整局慢
     * 一点，不会让两端分叉（双方都是按各自节奏推进同一个 tick 序列）。
     */
    const MAX_STEPS_PER_FRAME = 4;

    function advanceLockstep(delta: number): void {
      addTime(stepClock, delta);
      let stepsThisFrame = 0;
      for (;;) {
        if (stepClock.acc + 1e-9 < FIXED_DT) break;
        if (runnableTick(lockstep) === null) break;
        const inputs = takeLockstep(lockstep);
        if (!inputs) break;
        takeStep(stepClock);
        step(state, FIXED_DT, toStepInput(inputs.local), modifiers);
        if (inputs.local.restart) {
          lastResult = null;
          resultSent = false;
        }
        // 远端影子：用对方的输入在**我这边**推一遍。两边算的是同一个公式，
        // 所以 A 屏幕上 B 的走位 = B 自己屏幕上的走位（这也是 P3 的前置验证）。
        for (const [peerId, frame] of inputs.remote) {
          const actor = findRemote(state.remotes, peerId);
          if (actor) stepRemoteActor(actor, frame, FIXED_DT);
        }
        reportHash(inputs.tick);
        netStat.ticks += 1;
        stepsThisFrame += 1;
        // 采样下一个待提交的 tick：本地帧和远端走同一条 3 tick 延迟队列。
        // `submitTick` 每次只 +1 —— 让它一路领先、始终比 `tick` 大 3 格，
        // 中间不留空洞（留了就会被自己卡死，见 `lockstep.ts::take` 的注释）。
        const frame = takeLatched(latch, lockstep.submitTick);
        if (frame.pointerDown) netStat.localEdges += 1;
        if (frame.mouse) netStat.localMouse += 1;
        pushLocal(lockstep, frame);
        lockstep.submitTick += 1;
        netOutbox.push(frame);
        if (stepsThisFrame >= MAX_STEPS_PER_FRAME && stepClock.acc + 1e-9 >= FIXED_DT) {
          // 已经补到上限、还剩时间：直接丢掉，避免这一帧变成十几步的尖峰。
          stepClock.acc = 0;
          netStat.melted += 1;
          break;
        }
      }
      flushOutbox();
    }

    /** 攒够 3 帧（50ms）发一次：与平台 20Hz 的状态广播同频，多发只是浪费。 */
    function flushOutbox(): void {
      if (!netActive) {
        netOutbox.length = 0;
        return;
      }
      if (netOutbox.length < 3) return;
      const frames = netOutbox.splice(0, 16);
      netStat.framesOut += frames.length;
      netStat.flushes += 1;
      channel?.postMessage({
        type: 'netOut',
        t: frames[0]!.tick,
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
          /** netIn：远端输入包（base64 的定长批量帧）。 */
          packets?: { from: string; t: number; n: number; b: string }[];
          /** netRetire：服务端宣布的离场。 */
          gone?: { peerId: string; fromTick: number }[];
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
          // 新的一局 = 新的时间轴（tick 从 0 起，hash 的「每 60 tick」才有一致的锚点）。
          //
          // 联机时必须走 armTimeline：它会归零、重建锁步、并把前 delay 帧预热进
          // 发送队列。原来这里只是 `netOutbox = []`，依赖「netSeat 一定比 deploy
          // 先到且已预热」—— 实测这个假设不成立：netSeat 先到但 `starting` 为 false
          // 时并不预热，deploy 又把队列清空，于是双方都在等对方的 tick 0。
          if (netActive) armTimeline();
          else seekClock(stepClock, 0);
          lastResult = null;
          resultSent = false;
          publishRunState(true);
          channel?.postMessage({ type: 'deployed', loadout: snapshotRun(state.runInventory) });
        } else if (msg.type === 'runCommand') {
          // The in-run character panel is a read-only view. Every drag / equip
          // is validated and applied HERE, then the new snapshot goes back.
          if (msg.command !== undefined) {
            applyRunCommand(state.runInventory, msg.command);
            syncWeaponSlots(state);
            publishRunState(true);
          }
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
          if (Array.isArray(msg.packets)) applyRemotePackets(msg.packets);
        } else if (msg.type === 'netRetire') {
          if (Array.isArray(msg.gone)) applyRetired(msg.gone);
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
            state: projection(state),
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
     * a fresh snapshot whenever it actually changes (pickup, equip, restart).
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
      // 三种结束方式：主线清场（cleared）/ 撤离（extracted）/ 阵亡或超时（gameOver）。
      if (!state.cleared && !state.extracted && !state.timedOut && !state.gameOver) return;
      resultSent = true;
      const lost = state.gameOver || state.timedOut;
      // 死亡结算（设计 4）：主线整份带回；副本 / 搜打撤只带回保险格里的东西。
      // 分割规则是 `meta/inventory.ts::splitOnDeath()`，两个堆共用一份。
      const settlement = settleOnDeath(state, !lost);
      lastResult = {
        outcome: lost ? 'gameOver' : state.extracted ? 'extracted' : 'cleared',
        ...(lost ? { reason: state.timedOut ? 'timedOut' as const : 'dead' as const } : {}),
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
            // 大地图（M）铺满整个画布：指针落在它上面就等同于落在 HUD 上，
            // 点击不能穿透去移动 / 攻击（否则「看地图」会变成一次误操作）。
            const onHud = onMinimap || state.bigMap;
            const worldMouse = pointer
              ? screenToWorld(state.camera, screenX, screenY)
              : undefined;
            // press / held / release let the simulation classify a short click
            // (order: move to ground, or attack one enemy) vs. a long hold
            // (the only state with continuous cursor following). Hovering with
            // no button produces no order at all.
            const mouse = snapshot?.mouse;
            const restart = snapshot?.keyboard?.justPressedCode('KeyR') ?? false;
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
              restart,
              skill: skillSlot >= 0 ? skillSlot : NO_SKILL,
              switchWeapon: snapshot?.keyboard?.justPressedCode('Digit1') ?? false
                ? 0
                : (snapshot?.keyboard?.justPressedCode('Digit2') ?? false) ? 1 : NO_SWITCH,
              // Hover feedback must not light up while the pointer sits on
              // the read-only minimap / 大地图: those rectangles are not world space.
              pointerOnHud: onHud,
              // M = 大地图（设计 11）。
              bigMap: snapshot?.keyboard?.justPressedCode('KeyM') ?? false,
            });

            if (!locked && !paused) {
              if (netActive) {
                // 名单没到就冻结：既不推进、也不攒时间。攒了的话名单到达那一刻
                // 会一次吐出几百步，两端 tick 直接错开。
                if (netSeatSettled) advanceLockstep(raw);
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
            paint(painter, state, pointer ? { x: screenX, y: screenY } : undefined, renderDt);
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
        read: () => projection(state),
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
