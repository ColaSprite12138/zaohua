/**
 * Combat module facade: frame orchestration + the stable read projection.
 *
 * Everything here delegates to a subsystem. Keep `step()` free of gameplay
 * rules so a subsystem can be rewritten without touching the frame order.
 */

import { VIEW_H, VIEW_W } from '../shared/constants.ts';
import { dropAtPoint, hitTestEnemy, resolveAttackOrder } from './attack.ts';
import { updateSkeletons } from './enemies.ts';
import { tickParticles, tickToast } from './effects.ts';
import {
  applyDodge, classifyPointer, resolveBodyOverlap, walk,
} from './movement.ts';
import { NO_MODIFIERS, type CombatModifiers } from './modifiers.ts';
import { makeRng } from './loot.ts';
import { say } from './effects.ts';
import { makeRunInventory } from './run-inventory.ts';
import { updateExtraction, updateRunClock } from './extraction.ts';
import type { RunLoadout } from '../meta/inventory.ts';
import {
  activeWeapon, createState, dropLabelName, dropLabelRect, reset, setArena,
  syncWeaponSlots, type GameState, type RunKind, type StepInput,
} from './state.ts';
import { checkCleared, layoutDrops, switchWeaponSlot, updateDrops } from './weapons.ts';
import { cameraFor, worldToScreen, type ArenaMap } from './world.ts';

function tickTimers(s: GameState, dt: number): void {
  const p = s.player;
  p.invuln = Math.max(0, p.invuln - dt);
  p.dodge = Math.max(0, p.dodge - dt);
  p.dodgeCd = Math.max(0, p.dodgeCd - dt);
  p.attackCd = Math.max(0, p.attackCd - dt);
  p.attackFx = Math.max(0, p.attackFx - dt);
  p.hurt = Math.max(0, p.hurt - dt);
  tickToast(s, dt);
}

/** Advance one frame. `dt` is seconds, already clamped by the caller. */
export function step(
  s: GameState,
  dt: number,
  input: StepInput,
  modifiers: CombatModifiers = NO_MODIFIERS,
): void {
  if (input.restart) {
    reset(s);
    return;
  }
  // 已结算的一局完全冻结：撤离 / 超时和阵亡一样，不再走时间、不再挨打。
  if (s.gameOver || s.extracted || s.timedOut) {
    // Nothing below can be clicked any more: drop the sword cursor / hover ring.
    s.hoverEnemy = null;
    return;
  }

  s.t += dt;
  tickTimers(s, dt);
  // 单局骨架：倒计时 / 阶段推进。本帧之后的所有系统读的都是这一份时间。
  updateRunClock(s, dt);
  // 引导传送门时玩家被钉在门口：点击移动与攻击指令都不生效（updateExtraction
  // 负责开始、打断与结算；这里只负责「这一帧能不能动」）。
  const channeling = s.channel !== null;

  // 1 / 2 only changes which slot is in use; it never moves items or attacks.
  if (input.switchWeapon !== undefined && input.switchWeapon !== null) {
    switchWeaponSlot(s, input.switchWeapon);
  }
  if (!channeling) classifyPointer(s, input);
  applyDodge(s, input.dodge);
  if (!channeling) walk(s, dt);
  if (!channeling) resolveAttackOrder(s, modifiers);
  updateSkeletons(s, dt);
  // Nobody may stand inside anybody. Runs after both sides moved AND after
  // swing knockback, so a hit never leaves two bodies fused.
  resolveBodyOverlap(s);
  updateDrops(s, dt);
  // Piles fan out AFTER collection resolved, so every frame paints (and every
  // click tests) the same quality-ranked column.
  layoutDrops(s);
  checkCleared(s);
  // 撤离放在受击之后：同一帧挨打就立刻打断引导，不能靠「先抽完进度」蒙过去。
  updateExtraction(s, dt, input.extractChannel === true);
  tickParticles(s, dt);
  // Hover feedback LAST: it must describe the frame that is about to be
  // painted, using the very same hit test a click would use. Loot's name plate
  // wins the pointer over an enemy standing on the same spot -- that is what
  // turns the sword cursor back into the move cursor and promises a pickup.
  const noHover = s.cleared || input.pointerOnHud || input.mouse === undefined;
  const pointer = input.mouse;
  const hoveredDrop = pointer !== undefined && !noHover
    ? dropAtPoint(s, pointer.x, pointer.y)
    : null;
  s.hoverDrop = hoveredDrop ? hoveredDrop.uid : null;
  s.hoverEnemy = pointer === undefined || noHover || hoveredDrop !== null
    ? null
    : hitTestEnemy(s, pointer.x, pointer.y);
  // Camera is the single authority for input and painting. Updating it AFTER
  // movement keeps this frame's screen->world conversion (done by the engine
  // before step) consistent with what paint() will draw.
  s.camera = cameraFor(s.world, s.player.x, s.player.y);
}

/**
 * Deploy a run. The main window hands over its ENTIRE bag + equipment as a
 * structured-cloned `RunLoadout`; the Worker builds its own InventoryState
 * from it. Nothing is "borrowed" and nothing is shared by reference.
 *
 * Monster population is owned solely by the active map's LDtk entity layer.
 * The engine calls `setArena(state, arena)` before this to select the playable
 * LDtk map; there is NO count field anywhere in the deployment protocol.
 */
export interface Deployment {
  readonly seed?: number;
  readonly loadout?: RunLoadout;
  /**
   * 关卡类型。缺省 `story`：自动验收夹具与旧链路都是「清怪即通关」。
   * 正式出征（壳层）发 `pvpve` —— 必须从传送门撤离才算带走战利品。
   */
  readonly kind?: RunKind;
}

const EMPTY_LOADOUT: RunLoadout = {
  bag: [],
  equipped: [null, null, null, null, null, null, null, null, null, null],
  activeWeaponSlot: 0,
};

export function deployRun(s: GameState, config: Deployment = {}): void {
  s.runSeed = config.seed ?? s.runSeed;
  s.rng = makeRng(s.runSeed);
  s.runKind = config.kind ?? 'story';
  s.runInventory = makeRunInventory(config.loadout ?? EMPTY_LOADOUT);
  reset(s);
  const armed = s.weaponSlots.filter((w) => w !== null).length;
  const carried = s.runInventory.bag.length
    + s.runInventory.equipped.filter((it) => it !== null).length;
  const mode = s.runKind === 'pvpve' ? '搜打撤' : s.runKind === 'dungeon' ? '副本' : '主线';
  say(s, armed > 0
    ? `${mode} · 带入 ${carried} 件物品（${armed} 件武器）· 找传送门撤离`
    : `${mode} · 徒手，带入 ${carried} 件物品 · 找传送门撤离`);
}

/**
 * Stable read projection consumed by the playthrough assertions.
 *
 * `player` / `skeletons` / `dropAt` / `target` stay SCREEN-normalised
 * (world - camera, then / VIEW_W, / VIEW_H). The acceptance fixture is exactly
 * one viewport big, so its camera is (0,0) and those numbers are unchanged
 * from the legacy one-screen arena. World-space facts are exposed separately
 * in `worldPlayer` / `camera` / `map` for the new map-runtime assertions.
 */
export function projection(s: GameState) {
  const first = s.drops[0];
  const cam = s.camera;
  const scr = (x: number, y: number) => worldToScreen(cam, x, y);
  const dropScreen = first ? scr(first.x, first.y) : null;
  // Centre of the first VISIBLE name plate. A drop hidden by the fan-out cap
  // has no plate, so the acceptance script must click one that exists.
  const labelled = s.drops.find((drop) => dropLabelRect(drop) !== null);
  const labelRect = labelled ? dropLabelRect(labelled) : null;
  const labelScreen = labelRect ? scr(labelRect.x + labelRect.w / 2, labelRect.y + labelRect.h / 2) : null;
  const playerScreen = scr(s.player.x, s.player.y);
  const targetScreen = scr(s.target.x, s.target.y);
  return {
    hp: s.hp,
    maxHp: s.maxHp,
    kills: s.kills,
    attacks: s.attacks,
    skeletonsAlive: s.skeletons.filter((sk) => sk.alive).length,
    skeletons: s.skeletons.map((sk) => {
      const v = scr(sk.x, sk.y);
      return { x: v.x / VIEW_W, y: v.y / VIEW_H, hp: sk.hp, alive: sk.alive };
    }),
    attackTarget: s.targetEnemy,
    attackOrder: s.attackOrder,
    /** Enemy under the free cursor; drives the sword cursor and the hover ring. */
    hoverEnemy: s.hoverEnemy,
    /** Drop uid under the free cursor (name plate wins over the enemy). */
    hoverDrop: s.hoverDrop,
    drops: s.drops.map((drop) => drop.kind),
    dropAt: dropScreen ? { x: dropScreen.x / VIEW_W, y: dropScreen.y / VIEW_H } : null,
    dropLabel: labelScreen ? { x: labelScreen.x / VIEW_W, y: labelScreen.y / VIEW_H } : null,
    /**
     * Every plate, including the fan-out bookkeeping: `x/y/w/h` are the box a
     * click must land in, `index` is the row (0 = top = best quality),
     * `hidden` counts what the cap suppressed. Null box = no plate at all.
     */
    dropPlates: s.drops.map((drop) => {
      const r = dropLabelRect(drop);
      return {
        uid: drop.uid,
        name: dropLabelName(drop),
        quality: drop.quality ?? null,
        x: r ? r.x / VIEW_W : null,
        y: r ? r.y / VIEW_H : null,
        w: r ? r.w / VIEW_W : 0,
        h: r ? r.h / VIEW_H : 0,
        index: r ? r.index : -1,
        count: r ? r.count : 0,
        hidden: r ? r.hidden : 0,
      };
    }),
    // Legacy field names kept for the 35-step playthrough: they report the
    // visual 'longsword' CATEGORY. The authored ids live in `weaponDefIds`.
    equippedWeapon: activeWeapon(s) !== null ? 'longsword' : null,
    weaponSlots: s.weaponSlots.map((w) => (w !== null ? 'longsword' : null)),
    weaponDefIds: [...s.weaponSlots],
    activeWeaponSlot: s.activeWeaponSlot,
    // The Worker-owned in-run inventory, exposed as a plain JSON object so
    // the main-window character panel can render it (read only). A named
    // interface has no index signature and would not satisfy the projection
    // value type, so build the literal here.
    runInventory: {
      bag: s.runInventory.bag.map((i) => ({
        uid: i.uid, defId: i.defId, container: i.container, col: i.col, row: i.row,
      })),
      equipped: s.runInventory.equipped.map((i) => (
        i === null ? null : { uid: i.uid, defId: i.defId }
      )),
      activeWeaponSlot: s.runInventory.activeWeaponSlot,
    },
    // Run / loot contract: consumed by the loot report and by the single-page
    // settlement bridge. All values are JSON-shaped (GameProjectionValue).
    runSeed: s.runSeed,
    lootLog: s.lootLog.map((r) => ({
      monsterId: r.monsterId,
      itemId: r.itemId,
      name: r.name,
      quality: r.quality,
      damageMin: r.damageMin,
      damageMax: r.damageMax,
      poolId: r.poolId,
    })),
    carriedItems: [...s.carriedItems],
    pickupTarget: s.pickupTarget,
    dropItems: s.drops.map((d) => d.itemId ?? null),
    player: { x: playerScreen.x / VIEW_W, y: playerScreen.y / VIEW_H },
    moveMode: s.moveMode,
    followingPointer: s.moveMode === 'follow',
    target: { x: targetScreen.x / VIEW_W, y: targetScreen.y / VIEW_H },
    dodging: s.player.dodge > 0,
    attackCooldown: s.player.attackCd,
    dodgeCooldown: s.player.dodgeCd,
    gameOver: s.gameOver,
    cleared: s.cleared,
    // World-space map runtime facts (new; existing fields above are untouched).
    camera: { x: cam.x, y: cam.y },
    worldPlayer: { x: s.player.x, y: s.player.y },
    map: { id: s.map.id, w: s.map.pxWid, h: s.map.pxHei },
    pathLength: s.path.length,
    // 单局骨架（搜打撤）：剩余时间 / 阶段 / 传送门。坐标同样屏幕归一化，
    // 所以 playthrough 可以直接点门的屏幕位置走过去。
    runKind: s.runKind,
    runSeconds: s.runSeconds,
    phase: s.phase,
    extracted: s.extracted,
    timedOut: s.timedOut,
    channel: s.channel,
    portals: s.portals.map((portal) => {
      const v = scr(portal.x, portal.y);
      return {
        id: portal.id,
        x: v.x / VIEW_W,
        y: v.y / VIEW_H,
        progress: portal.progress,
        uses: portal.uses,
        state: portal.state,
        inRange: portal.inRange,
      };
    }),
  };
}

export { activeWeapon, createState, reset, setArena, syncWeaponSlots };
export type {
  Drop, GameState, MoveMode, Particle, Player, Skeleton, StepInput,
} from './state.ts';
export {
  CLICK_DRAG_PIXELS, DROP_LABEL_GAP, DROP_LABEL_H, DROP_LABEL_MAX,
  DROP_LABEL_STEP, DROP_MODEL_RADIUS, DROP_MODEL_TOP, DROP_PILE_GAP,
  dropLabelAnchor, dropLabelName, dropLabelRect, dropQualityRank,
  MELEE_RANGE_ARMED, MELEE_RANGE_BARE,
  MONSTER_SWING_TIME, PLAYER_SWING_TIME, STRIDE_PIXELS,
  PHASE_EXTRACT_AT, PHASE_FIGHT_AT, PORTAL_COUNT, PORTAL_GUIDE_SECONDS,
  PORTAL_RADIUS, PORTAL_STAGE_COUNT, PORTAL_USES, RUN_SECONDS,
  createPortals,
} from './state.ts';
export type { Portal, RunKind, RunPhase } from './state.ts';
export { phaseAt, runFinished } from './extraction.ts';
export type { ArenaMap } from './world.ts';
export type { CombatModifiers } from './modifiers.ts';
export { NO_MODIFIERS } from './modifiers.ts';
