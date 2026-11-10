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
import {
  createState, reset, type GameState, type StepInput,
} from './state.ts';
import { checkCleared, updateDrops } from './weapons.ts';

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

  classifyPointer(s, dt, input);
  applyDodge(s, input.dodge);
  walk(s, dt);
  resolveAttackOrder(s, modifiers);
  updateSkeletons(s, dt);
  updateDrops(s, dt);
  checkCleared(s);
  tickParticles(s, dt);
}

/** Stable read projection consumed by the playthrough assertions. */
export function projection(s: GameState) {
  const first = s.drops[0];
  return {
    hp: s.hp,
    maxHp: s.maxHp,
    score: s.score,
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
    equippedWeapon: s.equipped,
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

export { createState, reset };
export type {
  Drop, GameState, MoveMode, Particle, Player, Skeleton, StepInput,
} from './state.ts';
export {
  CLICK_DRAG_PIXELS, CLICK_HOLD_SECONDS,
  MELEE_RANGE_ARMED, MELEE_RANGE_BARE,
} from './state.ts';
export type { CombatModifiers } from './modifiers.ts';
export { NO_MODIFIERS } from './modifiers.ts';
