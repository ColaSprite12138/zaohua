/**
 * Combat module facade: frame orchestration + the stable read projection.
 *
 * Everything here delegates to a subsystem. Keep `step()` free of gameplay
 * rules so a subsystem can be rewritten without touching the frame order.
 */

import { VIEW_H, VIEW_W } from '../shared/constants.ts';
import { resolveAttackOrder } from './attack.ts';
import { updateSkeletons } from './enemies.ts';
import { tickParticles, tickToast } from './effects.ts';
import { applyDodge, classifyPointer, walk } from './movement.ts';
import { NO_MODIFIERS, type CombatModifiers } from './modifiers.ts';
import { makeRng } from './loot.ts';
import { say } from './effects.ts';
import {
  activeWeapon, createState, reset, setArena, type GameState, type StepInput,
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
  if (s.gameOver) return;

  s.t += dt;
  tickTimers(s, dt);

  // 1 / 2 only changes which slot is in use; it never moves items or attacks.
  if (input.switchWeapon !== undefined && input.switchWeapon !== null) {
    switchWeaponSlot(s, input.switchWeapon);
  }
  classifyPointer(s, dt, input);
  applyDodge(s, input.dodge);
  walk(s, dt);
  resolveAttackOrder(s, modifiers);
  updateSkeletons(s, dt);
  updateDrops(s, dt);
  checkCleared(s);
  tickParticles(s, dt);
  // Camera is the single authority for input and painting. Updating it AFTER
  // movement keeps this frame's screen->world conversion (done by the engine
  // before step) consistent with what paint() will draw.
  s.camera = cameraFor(s.world, s.player.x, s.player.y);
}

/**
 * Deploy a run from the meta layer. Called once per deployment by the engine
 * root when the single-page shell sends a `deploy` message.
 *
 * Monster population is owned solely by the active map's LDtk entity layer.
 * The engine calls `setArena(state, arena)` before this to select the playable
 * LDtk map; there is NO count field anywhere in the deployment protocol.
 */
export interface Deployment {
  readonly seed?: number;
  readonly armedWeapons?: 0 | 1 | 2;
  readonly activeWeaponSlot?: 0 | 1;
}

export function deployRun(s: GameState, config: Deployment = {}): void {
  s.runSeed = config.seed ?? s.runSeed;
  s.rng = makeRng(s.runSeed);
  reset(s);
  const armed = Math.max(0, Math.min(2, config.armedWeapons ?? 0));
  s.weaponSlots = [armed >= 1 ? 'longsword' : null, armed >= 2 ? 'longsword' : null];
  s.activeWeaponSlot = config.activeWeaponSlot ?? 0;
  if (armed > 0) {
    say(s, `出征 · 携带 ${armed} 件武器`);
  } else {
    say(s, '出征 · 徒手');
  }
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
    drops: s.drops.map((drop) => drop.kind),
    dropAt: dropScreen ? { x: dropScreen.x / VIEW_W, y: dropScreen.y / VIEW_H } : null,
    // Legacy field name kept for the existing 35-step playthrough: it now
    // reports the ACTIVE slot, i.e. the one weapon actually used in melee.
    equippedWeapon: activeWeapon(s),
    weaponSlots: [...s.weaponSlots],
    activeWeaponSlot: s.activeWeaponSlot,
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
    pendingPickup: s.pendingPickup ? s.pendingPickup.uid : null,
    runBagUids: [...s.runBagUids],
    slotLootItemIds: [...s.slotLootItemIds],
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

export { activeWeapon, createState, reset, setArena };
export type {
  Drop, GameState, MoveMode, Particle, Player, Skeleton, StepInput,
} from './state.ts';
export {
  CLICK_DRAG_PIXELS, CLICK_HOLD_SECONDS,
  MELEE_RANGE_ARMED, MELEE_RANGE_BARE,
} from './state.ts';
export type { ArenaMap } from './world.ts';
export type { CombatModifiers } from './modifiers.ts';
export { NO_MODIFIERS } from './modifiers.ts';
