/**
 * Targeted melee. A click on an enemy queues exactly ONE swing; the swing
 * fires only in range and damages ONLY that locked enemy. No cone, no splash,
 * no soft lock onto a different monster.
 */

import { burst, say, setTarget } from './effects.ts';
import { rollLoot } from './loot.ts';
import type { CombatModifiers } from './modifiers.ts';
import {
  activeWeapon, MELEE_RANGE_ARMED, MELEE_RANGE_BARE, type GameState,
} from './state.ts';

/** Clickable body box of a living skeleton (art spans about [-21,21] x [-57,0]). */
export function hitTestEnemy(s: GameState, x: number, y: number): number | null {
  let hit: number | null = null;
  let best = Infinity;
  for (let i = 0; i < s.skeletons.length; i += 1) {
    const sk = s.skeletons[i];
    if (sk === undefined || !sk.alive) continue;
    if (Math.abs(x - sk.x) > 30 || y < sk.y - 70 || y > sk.y + 12) continue;
    const d = Math.hypot(x - sk.x, y - (sk.y - 30));
    if (d < best) {
      best = d;
      hit = i;
    }
  }
  return hit;
}

/** Drops win the click over enemies so a sword under a skeleton stays lootable. */
export function hitTestDrop(s: GameState, x: number, y: number): boolean {
  return s.drops.some((drop) => Math.hypot(x - drop.x, y - drop.y) <= 26);
}

export function clearAttackOrder(s: GameState): void {
  s.attackOrder = false;
  s.targetEnemy = null;
}

export function swingAtTarget(s: GameState, index: number, mods: CombatModifiers): void {
  const sk = s.skeletons[index];
  if (sk === undefined || !sk.alive) return;
  const p = s.player;
  const ddx = sk.x - p.x;
  const ddy = sk.y - p.y;
  const d = Math.hypot(ddx, ddy) || 1;
  const armed = activeWeapon(s) === 'longsword';
  const aim = Math.atan2(ddy, ddx);

  p.attackCd = 0.4;
  p.attackFx = 0.26;
  p.face = aim;
  p.attackAim = aim;
  s.attacks += 1;
  s.score += 5;

  sk.hp -= mods.damageMultiplier(armed ? 46 : 22);
  sk.hit = 0.24;
  sk.x += (ddx / d) * 16;
  sk.y += (ddy / d) * 12;
  burst(s, sk.x, sk.y - 26, armed ? '#ffd166' : '#ffb454', 9, 165);
  burst(s, p.x + Math.cos(aim) * 52, p.y + Math.sin(aim) * 52 - 22, '#cfe8ff', 5, 90);

  if (sk.hp <= 0) {
    sk.alive = false;
    s.kills += 1;
    s.score += 100;
    // Weighted roll from the authored loot table. `kind` stays 'longsword'
    // (visual category) so the existing drop art and playthrough assertions
    // remain valid; the authored identity rides in itemId/name/quality.
    const loot = rollLoot(sk.monsterId, s.rng);
    if (loot !== null) {
      s.lootLog.push({
        monsterId: sk.monsterId,
        itemId: loot.itemId,
        name: loot.name,
        quality: loot.quality,
        damageMin: loot.damageMin,
        damageMax: loot.damageMax,
        poolId: loot.poolId,
      });
      s.drops.push({
        x: sk.x, y: sk.y, kind: 'longsword', t: 0,
        itemId: loot.itemId, name: loot.name, quality: loot.quality,
        monsterId: sk.monsterId,
      });
      burst(s, sk.x, sk.y - 24, '#e8e4d8', 22, 210);
      say(s, `骷髅被击杀 · 掉落「${loot.name}」(${loot.quality})`);
    } else {
      // Authored data is inconsistent (unknown monster / empty pool). Do not
      // spawn an unlabelled drop; surface it as a toast instead.
      say(s, `骷髅被击杀 · 掉落表未配置 (monsterId=${sk.monsterId})`);
    }
  }
}

/** Out of range -> approach; in range + ready -> one swing; cooling down -> wait. */
export function resolveAttackOrder(s: GameState, mods: CombatModifiers): void {
  if (s.player.dodge > 0 || !s.attackOrder || s.targetEnemy === null) return;
  const index = s.targetEnemy;
  const sk = s.skeletons[index];
  if (sk === undefined || !sk.alive) {
    clearAttackOrder(s);
    return;
  }
  const baseRange = activeWeapon(s) === 'longsword' ? MELEE_RANGE_ARMED : MELEE_RANGE_BARE;
  const range = baseRange + mods.meleeRangeBonus();
  const d = Math.hypot(sk.x - s.player.x, sk.y - s.player.y);
  if (d > range - 8) {
    setTarget(s, sk.x, sk.y);
    s.moveMode = 'point';
  } else if (s.player.attackCd <= 0) {
    swingAtTarget(s, index, mods);
    clearAttackOrder(s);
    setTarget(s, s.player.x, s.player.y);
    s.moveMode = 'idle';
  } else {
    setTarget(s, s.player.x, s.player.y);
    s.moveMode = 'point';
  }
}
