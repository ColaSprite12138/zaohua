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
    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(RUN_CHANNEL);
      channel.onmessage = (event: MessageEvent) => {
        const msg = event.data as {
          type?: string;
          deployment?: Deployment;
          command?: RunCommand;
          requestId?: number;
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
          lastResult = null;
          resultSent = false;
          publishRunState(true);
        } else if (msg.type === 'hello') {
          channel?.postMessage({ type: 'ready' });
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
            const dt = Math.min(Math.max(raw, 0), 0.05);
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
            if (!locked && !paused) {
              step(state, dt, {
                mouse: worldMouse,
                pointerDown: !onHud && (mouse?.justPressed(0) ?? false),
                pointerHeld: !onHud && (mouse?.button(0) ?? false),
                pointerUp: !onHud && (mouse?.justReleased(0) ?? false),
                switchWeapon: snapshot?.keyboard?.justPressedCode('Digit1') ?? false
                  ? 0
                  : (snapshot?.keyboard?.justPressedCode('Digit2') ?? false) ? 1 : null,
                dodge: snapshot?.keyboard?.justPressedCode('Space') ?? false,
                // 主动技能（1..7 格）与蓝药：justPressed 才算，按住不会连发。
                skill: skillSlot >= 0 ? skillSlot : null,
                potion: snapshot?.keyboard?.justPressedCode(POTION_KEY) ?? false,
                healPotion: snapshot?.keyboard?.justPressedCode(HEAL_KEY) ?? false,
                // E = 起手 / 取消传送门引导（搜打撤的「撤」）。
                extractChannel: snapshot?.keyboard?.justPressedCode('KeyE') ?? false,
                restart,
                // Hover feedback must not light up while the pointer sits on
                // the read-only minimap / 大地图: those rectangles are not world space.
                pointerOnHud: onHud,
                // M = 大地图（设计 11）。
                bigMap: snapshot?.keyboard?.justPressedCode('KeyM') ?? false,
              }, modifiers);
              // An in-run restart (R) starts a fresh settlement window.
              if (restart) {
                lastResult = null;
                resultSent = false;
              }
              // Pickups / weapon switches happen INSIDE this Worker now. Only
              // a changed snapshot is sent to the read-only character panel.
              publishRunState();
              settleIfFinished();
            }
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
            paint(painter, state, pointer ? { x: screenX, y: screenY } : undefined);
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
