/**
 * Combat module facade: frame orchestration + the stable read projection.
 *
 * Everything here delegates to a subsystem. Keep `step()` free of gameplay
 * rules so a subsystem can be rewritten without touching the frame order.
 */

import { VIEW_H, VIEW_W } from '../shared/constants.ts';
import { hitTestEnemy, resolveAttackOrder } from './attack.ts';
import { updateSkeletons } from './enemies.ts';
import { tickParticles, tickToast } from './effects.ts';
import {
  applyDodge, classifyPointer, resolveBodyOverlap, walk,
} from './movement.ts';
import { NO_MODIFIERS, type CombatModifiers } from './modifiers.ts';
import { makeRng } from './loot.ts';
import { say } from './effects.ts';
import { makeRunInventory } from './run-inventory.ts';
import type { RunLoadout } from '../meta/inventory.ts';
import {
  activeWeapon, createState, reset, setArena, syncWeaponSlots,
  type GameState, type StepInput,
} from './state.ts';
import { checkCleared, switchWeaponSlot, updateDrops } from './weapons.ts';
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
  if (s.gameOver) {
    // Nothing below can be clicked any more: drop the sword cursor / hover ring.
    s.hoverEnemy = null;
    return;
  }

  s.t += dt;
  tickTimers(s, dt);

  // 1 / 2 only changes which slot is in use; it never moves items or attacks.
  if (input.switchWeapon !== undefined && input.switchWeapon !== null) {
    switchWeaponSlot(s, input.switchWeapon);
  }
  classifyPointer(s, input);
  applyDodge(s, input.dodge);
  walk(s, dt);
  resolveAttackOrder(s, modifiers);
  updateSkeletons(s, dt);
  // Nobody may stand inside anybody. Runs after both sides moved AND after
  // swing knockback, so a hit never leaves two bodies fused.
  resolveBodyOverlap(s);
  updateDrops(s, dt);
  checkCleared(s);
  tickParticles(s, dt);
  // Hover feedback LAST: it must describe the frame that is about to be
  // painted, using the very same hit test a click would use.
  s.hoverEnemy = s.cleared || input.pointerOnHud || input.mouse === undefined
    ? null
    : hitTestEnemy(s, input.mouse.x, input.mouse.y);
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
}

const EMPTY_LOADOUT: RunLoadout = {
  bag: [],
  equipped: [null, null, null, null, null, null, null, null, null, null],
  activeWeaponSlot: 0,
};

export function deployRun(s: GameState, config: Deployment = {}): void {
  s.runSeed = config.seed ?? s.runSeed;
  s.rng = makeRng(s.runSeed);
  s.runInventory = makeRunInventory(config.loadout ?? EMPTY_LOADOUT);
  reset(s);
  const armed = s.weaponSlots.filter((w) => w !== null).length;
  const carried = s.runInventory.bag.length
    + s.runInventory.equipped.filter((it) => it !== null).length;
  say(s, armed > 0
    ? `出征 · 带入 ${carried} 件物品（${armed} 件武器）`
    : `出征 · 徒手，带入 ${carried} 件物品`);
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
    drops: s.drops.map((drop) => drop.kind),
    dropAt: dropScreen ? { x: dropScreen.x / VIEW_W, y: dropScreen.y / VIEW_H } : null,
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
  };
}

export { activeWeapon, createState, reset, setArena, syncWeaponSlots };
export type {
  Drop, GameState, MoveMode, Particle, Player, Skeleton, StepInput,
} from './state.ts';
export { CLICK_DRAG_PIXELS, MELEE_RANGE_ARMED, MELEE_RANGE_BARE } from './state.ts';
export type { ArenaMap } from './world.ts';
export type { CombatModifiers } from './modifiers.ts';
export { NO_MODIFIERS } from './modifiers.ts';
