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
  activeWeapon, createState, reset, type GameState, type StepInput,
} from './state.ts';
import { checkCleared, switchWeaponSlot, updateDrops } from './weapons.ts';

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
}

/**
 * Deploy a run from the meta layer. Called once per deployment by the engine
 * root when the single-page shell sends a `deploy` message.
 *
 * `loadout.weapons` is how many of the two weapon slots are armed (0..2); the
 * authored item identities stay in the meta inventory (borrowed), so combat
 * only needs the armed/bare category. Resets the run while preserving the
 * newly configured monster count and seed.
 */
export interface Deployment {
  readonly monsterCount?: number;
  readonly seed?: number;
  readonly armedWeapons?: 0 | 1 | 2;
  readonly activeWeaponSlot?: 0 | 1;
}

export function deployRun(s: GameState, config: Deployment = {}): void {
  s.monsterCount = Math.max(1, Math.floor(config.monsterCount ?? s.monsterCount));
  s.runSeed = config.seed ?? s.runSeed;
  s.rng = makeRng(s.runSeed);
  reset(s);
  const armed = Math.max(0, Math.min(2, config.armedWeapons ?? 0));
  s.weaponSlots = [armed >= 1 ? 'longsword' : null, armed >= 2 ? 'longsword' : null];
  s.activeWeaponSlot = config.activeWeaponSlot ?? 0;
  if (armed > 0) {
    say(s, `出征 · 携带 ${armed} 件武器 · ${s.monsterCount} 只怪物`);
  } else {
    say(s, `出征 · 徒手 · ${s.monsterCount} 只怪物`);
  }
}

/** Stable read projection consumed by the playthrough assertions. */
export function projection(s: GameState) {
  const first = s.drops[0];
  return {
    hp: s.hp,
    maxHp: s.maxHp,
    kills: s.kills,
    attacks: s.attacks,
    skeletonsAlive: s.skeletons.filter((sk) => sk.alive).length,
    skeletons: s.skeletons.map((sk) => ({
      x: sk.x / VIEW_W,
      y: sk.y / VIEW_H,
      hp: sk.hp,
      alive: sk.alive,
    })),
    attackTarget: s.targetEnemy,
    attackOrder: s.attackOrder,
    drops: s.drops.map((drop) => drop.kind),
    dropAt: first ? { x: first.x / VIEW_W, y: first.y / VIEW_H } : null,
    // Legacy field name kept for the existing 32-step playthrough: it now
    // reports the ACTIVE slot, i.e. the one weapon actually used in melee.
    equippedWeapon: activeWeapon(s),
    weaponSlots: [...s.weaponSlots],
    activeWeaponSlot: s.activeWeaponSlot,
    // Run / loot contract: consumed by the loot report and by the single-page
    // settlement bridge. All values are JSON-shaped (GameProjectionValue).
    monsterCount: s.monsterCount,
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
    player: { x: s.player.x / VIEW_W, y: s.player.y / VIEW_H },
    moveMode: s.moveMode,
    followingPointer: s.moveMode === 'follow',
    target: { x: s.target.x / VIEW_W, y: s.target.y / VIEW_H },
    dodging: s.player.dodge > 0,
    attackCooldown: s.player.attackCd,
    dodgeCooldown: s.player.dodgeCd,
    gameOver: s.gameOver,
    cleared: s.cleared,
  };
}

export { activeWeapon, createState, reset };
export type {
  Drop, GameState, MoveMode, Particle, Player, Skeleton, StepInput,
} from './state.ts';
export {
  CLICK_DRAG_PIXELS, CLICK_HOLD_SECONDS,
  MELEE_RANGE_ARMED, MELEE_RANGE_BARE,
} from './state.ts';
export type { CombatModifiers } from './modifiers.ts';
export { NO_MODIFIERS } from './modifiers.ts';
