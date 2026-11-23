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
  stepAll, updateView, EMPTY_STEP_INPUT,
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
  CATCHUP_EXIT_TICKS, CATCHUP_TRIGGER_TICKS, MAX_CATCHUP_STEPS, NET_HZ, SOLO_HZ,
  addTime, clearDebt, createStepClock, forceStep, seekClock, setRate, takeStep,
} from '../net/step-clock.ts';
import {
  NO_SKILL, NO_SWITCH, decodePacket, encodeBatch,
  toStepInput, type InputFrame,
} from '../net/input-frame.ts';
import { assembleInputs } from '../net/assemble-inputs.ts';
import {
  capture as captureInput, createInputLatch, take as takeLatched,
  type RawInput,
} from '../net/input-latch.ts';
import { hasActivity } from '../net/intent-filter.ts';
import { renderAlpha } from './interp.ts';
// 渲染层移动追随器：逻辑执行给出「目标 + 这段逻辑的平均速度」，渲染帧自己走过去。
// 只影响画面位置（V 层），不进 S / 不进 hash / 不参与判定。
import {
  createActorCell, createVisualMotion, flushActorCell, noteActorStep,
  resetVisualMotion, stepActorCell, stepVisualMotion, syncVisualTarget,
  type ActorCell,
} from './visual-motion.ts';
import { cameraFor } from '../combat/world.ts';
import {
  DEFAULT_LOOKAHEAD, accept as acceptFrame, canStep, contiguous,
  createSyncDriver, pendingTicks, requestReplay, reset as resetSync,
  take as takeSync, type SyncDriver,
} from '../net/sync-driver.ts';
import { HASH_INTERVAL_TICKS, hashGameParts, hashGameState } from '../net/state-hash.ts';
import { createRemotePlayer, spawnPointFor, type PeerSnapshot } from '../combat/players.ts';
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
     *
     * ## 2026-11-22：默认 1x（**实测 2x 把呈现帧率打到 4 fps**）
     *
     * 用户录屏（1920×1350 窗口）逐帧算灰度差：**每 7~8 帧整幅跳一次
     * （diff 12~13），中间连续 7 帧只有 0.0x** —— 真实呈现 ≈ 4 fps。
     * 同一时刻角标自报 `间隔 6.9ms / 绘 1.4ms / 渲染 142/s`：`paint()` 确实
     * 每 7 ms 跑一次，只是**画完的东西上不了屏**。
     *
     * 原因就在这个倍数：`ceil(canvasW / 1280)` 只在窗口**大于** 1280 时给 2，
     * 而那正是最不该超采样的场景 —— 画面本来就要被放大显示。1920 宽的窗口
     * 渲染 2560×1440，每帧上传 14.7 MB，乘以 142 fps ≈ **2 GB/s** 的纹理上传，
     * 任何 GPU/合成链都顶不住，只能每 250 ms 吐一帧。
     *
     * 收益是什么？像素风 + 整数相机下，2x 只是把边缘锐度提高一档，在 1920 窗口
     * 上肉眼几乎看不出；代价却是 4 倍像素、4 倍上传。所以默认降到 1x。
     * 想要锐度可以把这里改回 2 —— 但先确认你的机器扛得住上传，否则就是拿
     * 60 fps 换一档看不出的锐度。
     */
    const RENDER_SCALE_MAX = 1;
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
    const readProjection = () => ({
      ...projection(state),
      viewBigMap: view.bigMap,
      // 只读诊断：验收脚本靠它区分「单机 60 Hz / 联机 24 Hz」，以及量实际推进速率。
      // 它不进 `step()`、不进 hash、不影响任何判定。
      tick: stepClock.tick,
      hz: stepClock.hz,
      /** 画面用的插值位置（与 `playerWorld` 不等即证明插值生效）。 */
      drawX: lastDrawPos.x,
      drawY: lastDrawPos.y,
      /** 渲染进度 0..1：0 = 画的是上一步，1 = 画的是当前步（怪仍按它插值）。 */
      alpha: renderAlpha(stepClock.acc, stepClock.dt),
      /**
       * 渲染层追随器的诊断（只读，不进 `S`）：
       * `drawSpeed` 是这一帧画出去的速度，稳态应 ≈ 玩家走速，补帧时才接近 1.3 倍；
       * `drawGap` 是画面位置与逻辑位置的距离，稳态 ≈ 一个逻辑步，不该持续变大。
       */
      drawSpeed: visual.lastSpeed,
      drawGap: (() => {
        const dx = state.player.x - lastDrawPos.x;
        const dy = state.player.y - lastDrawPos.y;
        return Math.sqrt(dx * dx + dy * dy);
      })(),
      /**
       * 被追随器接管的**非本机**实体数（远端玩家 + 怪），以及它们当中
       * 「画面位置 vs 逻辑位置」的最大距离。稳态应 ≈ 一个逻辑步，不该持续变大。
       */
      visualActors: actorCells.size,
      actorMaxGap: (() => {
        let worst = 0;
        for (const [ent, cell] of actorCells) {
          const dx = ent.x - cell.motion.x;
          const dy = ent.y - cell.motion.y;
          const gapPx = Math.sqrt(dx * dx + dy * dy);
          if (gapPx > worst) worst = gapPx;
        }
        return worst;
      })(),
      /**
       * 渲染帧间隔与绘制耗时（毫秒，均做过指数平滑）。
       *
       * 只读诊断：用来回答「画面为什么慢」—— 间隔大而绘制小说明引擎没给帧，
       * 绘制吃满间隔才是 `paint()` 的问题。不进 `S`、不进 hash、不参与判定。
       */
      frameGapMs: netStat.frameGapMs,
      paintMs: netStat.paintMs,
    });

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
    // 初始按**单机**帧率起：还没进联机局时跑的就是纯本地逻辑（PVE / 主线）。
    // 进联机局由 `armTimeline()` 用 `setRate(NET_HZ)` 切过去。
    const stepClock = createStepClock(SOLO_HZ);
    /** 一帧渲染采到的输入，按逻辑步分发（边沿只给第一个步）。 */
    const latch = createInputLatch();
    /**
     * 上一逻辑步之前的位置快照：**所有在场实体**（本机 / 远端玩家 / 怪），按对象引用索引。
     *
     * 用途只有一个 —— 算「这一步它走了多远」，作为那段逻辑的平均速度 `V`。
     * 不进 `S`、不进 hash、不进帧。
     */
    let prevActors = new Map<object, { x: number; y: number }>();
    /**
     * 最后一次**真正画出去**的玩家位置。它和 `state.player` 不相等就说明插值在起作用
     * （只读诊断：验收脚本靠它证明「画面不是每 41.7 ms 跳一次」，而不是只看「没崩」）。
     */
    let lastDrawPos = { x: 0, y: 0 };

    /**
     * **渲染层移动追随器**（`V` 层，不进 `S` / 不进 hash / 不参与判定）。
     *
     * 逻辑执行完只给出两个东西：玩家**最终位置**、以及这一段逻辑的**平均速度**。
     * 渲染帧从这里出发朝目标走：稳态按 `V` 匀速，补帧时用 `1.3V` 拉近，
     * 走到就贴住。规则与理由全在 `visual-motion.ts` 顶部。
     *
     * 为什么不是「插值」：插值的位置由 `acc` 推导，补帧时一次跑 6 步会表现为
     * 画面快进；这里用有限超速平滑拉近，画面不跳。
     */
    let visual = createVisualMotion(state.player.x, state.player.y);

    /**
     * 本渲染帧内执行过的逻辑步数 / 玩家走过的总路程（px）。
     *
     * `步数 > 0` 才把「目标 + 平均速度」同步给追随器：一帧跑 6 步时 `V` 仍是
     * 205，而不是 1224 —— 平均速度是「这段逻辑走过的路程 ÷ 这段逻辑的总时间」。
     */
    let frameSteps = 0;
    let frameTravel = 0;

    /**
     * **非本机实体**的视觉追踪单元（远端玩家 + 怪），按对象引用索引。
     *
     * 为什么按引用而不是 id：`Skeleton` 没有稳定 id，而对象引用在整个生命周期里
     * 唯一；远端玩家也有稳定 `id`，但统一用引用可以少一条分支。
     *
     * 本机玩家不在里面：它只有一份，用 `frameTravel / frameSteps` 直接算，且相机
     * 要单独跟它。三者共用同一套速度规则，所以画面表现一致。
     */
    const actorCells = new Map<{ x: number; y: number }, ActorCell>();

    /**
     * 追随器需要硬切的标记：新局 / 传送 / 换图 / 解锁重置时置位，绘制前消费。
     * 用标记而不是立刻 reset，是因为 `deploy` 改出生坐标发生在 `clearPrevPositions()`
     * **之后**，提前 reset 会切到旧坐标。
     */
    let visualNeedsSnap = true;

    /** 把本帧累计的逻辑位移交给追随器。没有执行过逻辑步就什么都不做（目标没变）。 */
    function flushVisualTarget(): void {
      if (frameSteps > 0) {
        const spanSeconds = frameSteps * stepClock.dt;
        syncVisualTarget(
          visual,
          state.player.x,
          state.player.y,
          spanSeconds > 0 ? frameTravel / spanSeconds : 0,
        );
        frameSteps = 0;
        frameTravel = 0;
      }
      // 远端玩家与怪：各自的目标与平均速度，同一个口径。
      for (const [ent, cell] of actorCells) {
        flushActorCell(cell, ent.x, ent.y, stepClock.dt);
      }
    }

    /** 每执行一步之前调一次：把「这一步之前」所有在场实体的位置记下来。 */
    function capturePrevPositions(): void {
      const snapshot = new Map<object, { x: number; y: number }>();
      for (const p of state.players) snapshot.set(p, { x: p.x, y: p.y });
      for (const sk of state.skeletons) snapshot.set(sk, { x: sk.x, y: sk.y });
      prevActors = snapshot;
    }

    /**
     * 每执行一步之后调一次：给**非本机**实体记账（这一步走了多远 + 几步）。
     * 本机玩家走 `frameTravel / frameSteps`，不在这里，因为它还要带相机。
     *
     * 首次见到的实体只建单元、不记位移：它的 `motion` 初值就是当前位置，
     * 不会从 (0,0) 飞过来。
     */
    function noteActorSteps(): void {
      for (const p of state.players) {
        if (p === state.player) continue;
        const cell = actorCells.get(p);
        if (cell === undefined) {
          actorCells.set(p, createActorCell(p.x, p.y));
          continue;
        }
        noteActorStep(cell, prevActors.get(p), p);
      }
      for (const sk of state.skeletons) {
        const cell = actorCells.get(sk);
        if (cell === undefined) {
          actorCells.set(sk, createActorCell(sk.x, sk.y));
          continue;
        }
        noteActorStep(cell, prevActors.get(sk), sk);
      }
    }

    /** 已经离场的实体（怪被打死移出数组 / 远端退局）要把追踪单元一起丢掉。 */
    function pruneActorCells(): void {
      if (actorCells.size === 0) return;
      const alive = new Set<{ x: number; y: number }>();
      for (const p of state.players) alive.add(p);
      for (const sk of state.skeletons) alive.add(sk);
      for (const key of actorCells.keys()) {
        if (!alive.has(key)) actorCells.delete(key);
      }
    }

    /**
     * 新一局 / 瞬移：丢掉上一帧位置，否则插值会把角色从旧局的位置拉过来。
     *
     * 追随器同样要硬切（`visualNeedsSnap`）：它有自己的持久状态，不清就会
     * 从上一局 / 上一个出生点滑过来。标记在 `paintWithInterp` 开头消费，
     * 因为 `deploy` 会在调用本函数**之后**才改出生坐标。
     */
    function clearPrevPositions(): void {
      prevActors = new Map();
      actorCells.clear();
      visualNeedsSnap = true;
    }

    /**
     * 带着**渲染层追随器**画一帧：把视觉位置临时写进实体，画完在 `finally` 里还原。
     *
     * 三类对象共用同一套速度规则（`visual-motion.ts`）：本机玩家走 `visual`，
     * 远端玩家与怪走 `actorCells` 里各自的单元。所以「自己的移动、队友的移动、
     * 怪的移动」在 60/144 fps 下都是连续位移，补帧时也都不跳。
     *
     * 安全性：`paint` 是同步的、主循环最后一步；期间没有别的代码读 `S`。
     * 判定永远用真实位置（`step()` 已经跑完），这里改的只是绘制用的那一瞬。
     */
    function paintWithInterp(dtRender: number, draw: () => void): void {
      if (visualNeedsSnap) {
        resetVisualMotion(visual, state.player.x, state.player.y);
        visualNeedsSnap = false;
        frameSteps = 0;
        frameTravel = 0;
      }
      pruneActorCells();
      const drawn = stepVisualMotion(visual, dtRender, stepClock.dt);
      const realPlayer = { x: state.player.x, y: state.player.y };
      const realCamera = { x: state.camera.x, y: state.camera.y };
      const realActors: { ent: { x: number; y: number }; x: number; y: number }[] = [];
      for (const [ent, cell] of actorCells) {
        const pose = stepActorCell(cell, dtRender, stepClock.dt);
        realActors.push({ ent, x: ent.x, y: ent.y });
        ent.x = pose.x;
        ent.y = pose.y;
      }
      lastDrawPos = { x: drawn.x, y: drawn.y };
      try {
        state.player.x = drawn.x;
        state.player.y = drawn.y;
        // 相机必须跟**画出去的位置**：跟逻辑位置的话，玩家会离开屏幕中心，
        // 而且偏移量逐帧变化 = 相机抽搐（2026-11-23 踩过）。
        const camera = cameraFor(state.world, drawn.x, drawn.y);
        state.camera.x = camera.x;
        state.camera.y = camera.y;
        draw();
      } finally {
        state.player.x = realPlayer.x;
        state.player.y = realPlayer.y;
        state.camera.x = realCamera.x;
        state.camera.y = realCamera.y;
        for (const entry of realActors) {
          entry.ent.x = entry.x;
          entry.ent.y = entry.y;
        }
      }
    }

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
      /**
       * 真正画出去的帧数（`paintWithInterp` 的调用次数，含插值分支）。
       * 与 `framesIn` 一起给主窗口算两个帧率：收包帧率 / 渲染帧率。
       */
      renderFrames: 0,
      /**
       * 采到 pointerUp 边沿的帧数。与 `localEdges`（按下）对照用：
       * 只有 down 没有 up = 点击永远不结算（`movement.ts` 的点击分支靠 up 触发），
       * 表现正是「点了完全不动」。
       */
      localUps: 0,
      /**
       * 执行时**没在广播帧里找到本机**的次数。持续增长说明服务器贴的 key 与
       * `netPlayerId` 对不上 —— 玩家会看到自己操作全部失效、对方却能动。
       */
      localMiss: 0,
      /**
       * 进入追帧模式的渲染帧数。持续增长说明一直追不上（积压不降），
       * 稳定不涨 = 只在开局的短暂积压里追了一次，正常。
       */
      catchUpFrames: 0,
      /**
       * 本渲染帧与上一渲染帧的墙钟间隔（指数平滑，毫秒）。**只用于诊断**。
       *
       * 为什么要它：`renderFrames` 算出来的渲染帧率只能说明「画得慢」，
       * 说不清是「引擎没给我帧」（rAF 被节流 / 标签页被遮挡 / 宿主 iframe
       * 不可见）还是「我画得慢」。两者的处理和结论完全不同：
       * - 间隔 ≈ 6.9ms（144Hz）~16.7ms（60Hz）而渲染帧率很低 → 是 `paintMs` 高
       * - 间隔本身就已经是 300~1000ms → 根本没拿到帧，别改绘制代码
       */
      frameGapMs: 0,
      /**
       * 实际渲染密度（1 = 1280×720 画布，2 = 2560×1440）。**只用于诊断**。
       *
       * 它决定了每帧要往 GPU 传多少像素：2x 是 4 倍上传量。2026-11-22 的
       * 「画面每 250ms 才跳一次」就是 2x 造成的，所以角标必须能看见这个数 ——
       * 否则改了 `RENDER_SCALE_MAX` 也没法确认到底生效没有。
       */
      surfaceScale: 1,
      /**
       * 当前渲染插值进度 0..1（`renderAlpha(acc, dt)`）。**只用于诊断**。
       *
       * 它是「画面到底平不平滑」的唯一直接证据：恒为 0 意味着一直在画上一步的
       * 位置，插值形同不存在 —— 画面会退化成 24 Hz 逐帧跳跃，而渲染/执行帧率
       * 全都显示正常。`acc` 曾长期为负，就是这个值恒 0 的成因。
       */
      alpha: 0,
      /**
       * 上一帧 `paint()` 的实际耗时（指数平滑，毫秒）。**只用于诊断**。
       *
       * 它和 `frameGapMs` 是一对：`paintMs / frameGapMs` 接近 1 就是「绘制把
       * 这一帧吃满了」，接近 0 就是「时间花在别处」。别用它做任何判定。
       */
      paintMs: 0,
    };
    /** 是否正在追帧（跨渲染帧的滞回状态，见 `CATCHUP_TRIGGER/EXIT_TICKS`）。 */
    let catchingUp = false;
    /** 上一渲染帧的墙钟时刻（`performance.now`）。帧间隔诊断用，不进 S。 */
    let lastFrameAt = 0;

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
        keep.push(createRemotePlayer(
          id,
          netPeerNames.get(id) || id.slice(0, 6),
          spawn,
          netPeerSnapshots.get(id),
          // 传 world 才会做可站性检查：`spawnOffset` 有一个方向正对着 arena
          // 出生点左边的墙，不检查会让玩家一出生就卡死。
          state.world,
        ));
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
        // 回到纯本地：帧率切回 60 Hz，帧号重新由墙钟推进。
        setRate(stepClock, SOLO_HZ);
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
      // 切到**联机**帧率（24 Hz）：帧号从此由服务器推进。
      setRate(stepClock, NET_HZ);
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
      netStat.localUps = 0;
      netStat.localMiss = 0;
      netStat.catchUpFrames = 0;
      catchingUp = false;
      lastFrameAt = 0;
      netStat.frameGapMs = 0;
      netStat.paintMs = 0;
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
        // **空桶必须照样 accept。** 服务器每帧都往窗口里写一条（见
        // `game/server/source/index.ts::onFrame` 的注释），全员没输入的帧就是
        // 空桶；客户端靠「收到第 N 帧」推进执行指针，跳过空帧 = 指针永远停在 0。
        // 2026-11-22 双人实测：进局后两人都不动 → 每帧空桶 → tick 卡在 0、
        // framesIn 0，而服务器侧已经跑到 tick 437 并在 47.5ms 稳定推进。
        const result = acceptFrame(driver, { tick: batch.tick, frames });
        // `framesIn` 数的是**帧**，不是帧里的意图条数：它是角标上「服务器
        // 帧率」的分子，一帧里有 1 个还是 2 个玩家都只算一帧。
        if (result === 'accepted') netStat.framesIn += 1;
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
        // 补帧块同理：空 entries 是「那个 tick 全员没输入」，不是「没补到」。
        // 跳过它，缺口就永远补不上，`missingRange` 会一直重请求同一段。
        const result = acceptFrame(driver, { tick, frames });
        if (result === 'accepted') netStat.framesIn += 1;
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
      netStat.surfaceScale = surfaceScale;
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
     * 单机推进：采一格走一格，**没有服务器**。`dt` 由 `stepClock` 给出
     * （`SOLO_HZ = NET_HZ = 24`，与联机共用一套行为基线），这让同一份操作在任何
     * 渲染帧率下跑出同一串位置，验收脚本才有意义。
     */
    function advanceSolo(delta: number): void {
      addTime(stepClock, delta);
      while (takeStep(stepClock)) {
        const tick = stepClock.tick - 1;
        const frame = takeLatched(latch, tick);
        capturePrevPositions();
        const beforeX = state.player.x;
        const beforeY = state.player.y;
        step(state, stepClock.dt, toStepInput(frame), modifiers);
        const movedX = state.player.x - beforeX;
        const movedY = state.player.y - beforeY;
        frameTravel += Math.sqrt(movedX * movedX + movedY * movedY);
        frameSteps += 1;
        noteActorSteps();
        reportHash(tick);
      }
      flushVisualTarget();
    }

    /**
     * 联机推进：**只执行服务器广播过的连续帧**。
     *
     * 三件互不干扰的事，顺序不能换：
     *
     * 1. **采意图**（墙钟节拍，60 Hz，和执行解耦）。执行会被服务器卡住，但采样
     *    不能停 —— 停了就等于「我一卡，我的操作也跟着停」。意图不带帧号，
     *    而且**这一帧没有操作就不发**（`intent-filter.ts`）。
     * 2. **执行**：`canStep` 要求手里从 `nextTick` 起连续 `lookahead` 帧都齐了。
     *    临时低延迟模式 `lookahead = 1`（只要这一帧到了），旧模式 2。
     *    不够就**一帧都不走**（画面停住、操作无响应），而且时间**不扣** ——
     *    恢复后一次性补算。
     *    **执行仍按墙钟 `takeStep`（`acc >= dt`）**，不要改成「收到帧就立刻跑」：
     *    那样会让一帧内的 `S`（画面到逻辑目标的距离）突增，渲染层追随器只能用
     *    `1.3V` 慢慢追，反而持续落后；按 `dt` 稳定执行，稳态 `S` 才恒定在一个
     *    逻辑步。（旧理由「相机插值要求 alpha=1」自 2026-11-23 追随器上线后已失效，
     *    但结论一样，见 `net/low-latency.ts` 与 `docs/net-sync-v2.md` §8.8。）
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
      while (intentAcc >= stepClock.dt && sampled < 8) {
        intentAcc -= stepClock.dt;
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
        if (intent.pointerUp) netStat.localUps += 1;
        if (intent.mouse) netStat.localMouse += 1;
        netOutbox.push(intent);
        netStat.intentsOut += 1;
      }
      // 标签页被切走很久之后回来：`intentAcc` 会堆成几秒，一次灌几百条意图
      // 只会让服务器把它们贴到未来几百帧上。直接丢掉，玩家不会希望「回来
      // 之后自动跑完离开的那段」。
      if (intentAcc > stepClock.dt * 8) intentAcc = 0;
      flushOutbox();

      // ---- 2) 执行：只跑服务器给过的帧 ----
      addTime(stepClock, delta);
      // 落后水位 = 手里已收到、但还没算的帧数。正常等于播放缓冲 + 网络抖动
      // （临时低延迟模式 `lookahead = 1`，稳态 0~1；旧模式 2，实测 2~6）。
      //
      // 明显超出就说明「看得见未来却算不过来」，必须**主动追**：`addTime` 把
      // 单帧时间截断到 6 步（0.25 s）并把超出部分丢掉，所以一次切后台 / 开
      // DevTools 造成的 2 秒停顿只补得回 0.25 秒，剩下的永久留在链路上 ——
      // 2026-11-22 实测「领先 52」（≈2.2 s），玩家的点击要好几秒才有反应。
      const backlog = Math.max(0, driver.highestSeen - driver.nextTick);
      // 滞回：>8 进追帧，追到 ≤3 才停。单边条件会让追帧跑一帧就退出、
      // 永远停在阈值下方（实测稳定 11 帧 = 458 ms 的点击迟滞）。
      if (backlog > CATCHUP_TRIGGER_TICKS) catchingUp = true;
      else if (backlog <= CATCHUP_EXIT_TICKS) catchingUp = false;
      const catchUp = catchingUp;
      if (catchUp) netStat.catchUpFrames += 1;
      let steps = 0;
      while (canStep(driver)) {
        if (steps >= MAX_CATCHUP_STEPS) break;
        // 非追赶时严格按墙钟；追赶时绕过 `acc`（`forceStep`），否则高刷下
        // 每帧只加 7 ms 永远攒不够一步，52 帧级的积压永远抹不平。
        // 单帧仍是 6 步上限：141 fps × 6 ≈ 850 步/秒，2.2 秒的积压几十毫秒
        // 就追平，表现为「画面快进一下」而不是「永久落后」。
        if (!catchUp && stepClock.acc + 1e-9 < stepClock.dt) break;
        const packet = takeSync(driver);
        if (!packet) break;
        if (catchUp) forceStep(stepClock);
        else takeStep(stepClock);
        // 服务器贴定的这一帧**原样**转成 `StepInput`，再按全体名单展开成完整
        // `I_all`。这里没有「本机 / 远端」之分：旧实现按 `netPlayerId` 拆成
        // `input` + `remoteInputs` 两张表，`step()` 里又只给本机垫空帧，两端各自
        // 只保证本机座位被模拟 —— 2026-11-22 PVP 分叉的根因。
        // **本机输入也来自这一帧广播**：没有预表现，玩家按下到生效要等一个回程，
        // 这是「不做预表现 + 不拥有自己的帧」的必然代价（`docs/net-sync-v2.md` §4）。
        const stamped = new Map<string, ReturnType<typeof toStepInput>>();
        for (const [peerId, frame] of packet.frames) stamped.set(peerId, toStepInput(frame));
        const inputs = assembleInputs(stamped, state.players, EMPTY_STEP_INPUT);
        if (!packet.frames.has(state.me)) netStat.localMiss += 1;
        capturePrevPositions();
        const beforeX = state.player.x;
        const beforeY = state.player.y;
        stepAll(state, stepClock.dt, inputs, modifiers);
        const movedX = state.player.x - beforeX;
        const movedY = state.player.y - beforeY;
        frameTravel += Math.sqrt(movedX * movedX + movedY * movedY);
        frameSteps += 1;
        noteActorSteps();
        // view-only: 本机鼠标只用于悬停环 / 相机，与死亡结算、UI 面板、血条一样
        // 属于 V 层，各随本机座位；不进帧、不进 hash、不参与世界演算。
        updateView(state, inputs.get(state.me) ?? EMPTY_STEP_INPUT);
        reportHash(packet.tick);
        netStat.ticks += 1;
        steps += 1;
      }

      /*
       * **`acc` 绝不能停在负数上。**
       *
       * `forceStep` 每步扣一个 `dt`（41.7ms），而 `addTime` 每渲染帧只加 6.9ms。
       * 只要 backlog 卡在「进追帧」与「退追帧」之间（实测稳定 8：`> 8` 才进，
       * `<= 3` 才出），而实时帧又是每帧只到 1 个 —— 每帧净欠约 35ms，几秒后
       * `acc` 就是大负数。
       *
       * 一旦为负，两个后果同时发生：
       * 1. 非追帧分支的 `acc + 1e-9 < dt` 永远成立 → **一步都走不了**，
       *    于是 backlog 涨过阈值又进追帧、跑几步又退出，来回振荡 = 走走停停；
       * 2. `renderAlpha(负数)` 恒等于 0 → 画面永远画「上一步」，**插值彻底失效**，
       *    从平滑移动退化成 24Hz 的逐帧跳跃。
       *
       * 而角标上「渲染 143/s、间隔 6.9ms、绘 1.4ms、领先 8」全都正常 ——
       * 因为引擎确实在画、时钟确实在走，**只是画出来的是同一个位置**。
       * 2026-11-22 用户实测「切后台回来走完补帧，之后一直卡且不恢复」就是它。
       *
       * 追帧的目的本来就是"多跑几步把积压吃掉"，多跑的那些步不该记成欠账。
       */
      clearDebt(stepClock);
      // 这一帧执行过的逻辑步 → 目标 + 平均速度，交给渲染层追随器。
      flushVisualTarget();
      netStat.alpha = renderAlpha(stepClock.acc, stepClock.dt);
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
          /**
           * netIn 附带：服务器**逻辑帧号**（`state.frame`）。
           *
           * 为什么必须传：广播窗口只有最近 4 帧。页面切后台 / 断线一会儿，
           * 窗口早就跳过去了，客户端靠 `batches` 完全看不出「已经落后几百帧」。
           * 有了这个数才能算出缺口并向服务器要 replay —— 否则就是永久卡死。
           */
          srv?: number;
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
          clearPrevPositions();
          modifiers = createModifiers(msg.deployment?.stars?.nodes ?? []);
          deployRun(state, msg.deployment ?? {});
          // 出生点偏移必须**对所有玩家**用同一套规则：`createRemotePlayer` 按 id
          // 给远端算了，本机如果还杵在裸 spawn 上，两端对同一个人的坐标认知就
          // 不同（A 看 A 在中心、B 看 A 在旁边），而坐标进 hash。
          if (netActive && netPlayerId) {
            // 和远端走**同一个** `spawnPointFor`：它会在四个候选方向里挑第一个
            // 站得下的。早先这里直接用 `spawnOffset` 的位移，而 arena 出生点左边
            // 两格是墙 —— 抽到 -x 的玩家一出生就卡在墙里（2026-11-22 实测）。
            const at = spawnPointFor(state.world, netPlayerId);
            state.player.x = at.x;
            state.player.y = at.y;
            state.player.intent.target = { x: at.x, y: at.y };
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
            // 单机（PVE 副本 / 主线）：纯本地逻辑，锁 60 Hz。
            setRate(stepClock, SOLO_HZ);
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
          clearPrevPositions();
          setRate(stepClock, SOLO_HZ);
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
          clearPrevPositions();
          setRate(stepClock, SOLO_HZ);
          seekClock(stepClock, 0);
          lastResult = null;
          resultSent = false;
          publishRunState(true);
        } else if (msg.type === 'hello') {
          channel?.postMessage({ type: 'ready' });
        } else if (msg.type === 'netSeat') {
          applySeat({ active: msg.active, playerId: msg.playerId, peers: msg.peers });
        } else if (msg.type === 'netIn') {
          // `srv` 即使在没有可投递帧时也会到（见 net-bridge 的注释）：它让
          // `driver.highestSeen` 跟上服务器的真实进度，`requestReplay` 才算得出
          // 「还差多少」，补帧通道才有起点。
          if (typeof msg.srv === 'number' && msg.srv > driver.highestSeen) {
            driver.highestSeen = msg.srv;
          }
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
            clearPrevPositions();
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
            // 渲染帧间隔（诊断）：引擎给没给帧，和「画得慢」是两件事。
            // determinism-ok: 纯渲染层诊断，只在 `netStat` 里，不进 S / 不进 hash / 不参与判定。
            const frameAt = performance.now();
            if (lastFrameAt > 0) {
              const gap = frameAt - lastFrameAt;
              netStat.frameGapMs = netStat.frameGapMs > 0
                ? netStat.frameGapMs * 0.9 + gap * 0.1
                : gap;
            }
            lastFrameAt = frameAt;
            // 渲染用的真实帧时长，只喂给绘制层的视觉插值。
            // 模拟层拿到的永远是当前模式的定长 dt —— 这是 P2 的第一条改动，也是帧同步的前提：
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
            // 「客户端渲染帧率」的唯一可信来源：真正走到绘制这一行的次数。
            // 挂在调用处而不是 `paintWithInterp` 内部，是因为它有两条返回分支
            // （alpha<=0 直接画），数在里面会漏掉那一半。
            netStat.renderFrames += 1;
            // 绘制耗时（诊断）：与 `frameGapMs` 对照就能分清「画得慢」和「没拿到帧」。
            // determinism-ok: 纯渲染层诊断，只在 `netStat` 里，不进 S / 不进 hash / 不参与判定。
            const paintAt = performance.now();
            paintWithInterp(renderDt, () => {
              paint(painter, state, pointer ? { x: screenX, y: screenY } : undefined, renderDt, view);
            });
            const paintTook = performance.now() - paintAt;
            netStat.paintMs = netStat.paintMs > 0
              ? netStat.paintMs * 0.9 + paintTook * 0.1
              : paintTook;
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
