/**
 * Targeted melee. A click on an enemy queues exactly ONE swing; the swing
 * fires only in range and damages ONLY that locked enemy. No cone, no splash,
 * no soft lock onto a different monster.
 */

import { burst, say, setTarget } from './effects.ts';
import { rollLoot } from './loot.ts';
import { weaponDamage } from './run-inventory.ts';
import type { CombatModifiers } from './modifiers.ts';
import { applyStatus, clearStatus, damageTakenMultiplier, lockedFlags, statusOf } from './status.ts';
import { walkable, type World } from './world.ts';
import {
  activeWeapon, DROP_MODEL_RADIUS, dropLabelRect, MELEE_RANGE_ARMED,
  MELEE_RANGE_BARE, nextDropUid, PLAYER_ATTACK_CD, PLAYER_SWING_TIME,
  type Drop, type GameState,
} from './state.ts';

/** Clickable body box of a living skeleton (art spans about [-21,21] x [-57,0]). */
export const ENEMY_BODY_HALF_WIDTH = 30;
export const ENEMY_BODY_TOP = -70;
export const ENEMY_BODY_BOTTOM = 12;
/** Vertical centre of the torso, used as the distance anchor for targeting. */
export const ENEMY_TORSO_Y = -30;
/**
 * Generous radius around the torso for a click that just misses the box. A
 * chasing skeleton moves between press and release, so a strict silhouette
 * makes it feel unselectable; an in-box hit always beats a near miss, and the
 * nearest torso wins among candidates.
 */
export const ENEMY_NEAR_MISS_PX = 46;

/**
 * Which living skeleton is under this point -- the ONE authority shared by the
 * click and the hover feedback (sword cursor / ring), so the two can never
 * disagree.
 */
export function hitTestEnemy(s: GameState, x: number, y: number): number | null {
  let boxHit: number | null = null;
  let boxBest = Infinity;
  let nearHit: number | null = null;
  let nearBest = Infinity;
  for (let i = 0; i < s.skeletons.length; i += 1) {
    const sk = s.skeletons[i];
    if (sk === undefined || !sk.alive) continue;
    const dx = x - sk.x;
    const d = Math.hypot(dx, y - (sk.y + ENEMY_TORSO_Y));
    if (Math.abs(dx) <= ENEMY_BODY_HALF_WIDTH
      && y >= sk.y + ENEMY_BODY_TOP
      && y <= sk.y + ENEMY_BODY_BOTTOM) {
      if (d < boxBest) {
        boxBest = d;
        boxHit = i;
      }
    } else if (d <= ENEMY_NEAR_MISS_PX && d < nearBest) {
      nearBest = d;
      nearHit = i;
    }
  }
  return boxHit ?? nearHit;
}

/**
 * Which drop is under this point: its NAME PLATE box, or the small model.
 *
 * Loot used to win inside a 26px circle around the item, which meant that a
 * monster standing on a drop could not be attacked at all -- every click near
 * its feet walked over to loot instead. The plate is an explicit target the
 * player aims at, so loot only wins where the player actually pointed at its
 * name; the rest of the body stays an enemy click.
 *
 * Shared by the click and the hover feedback, like `hitTestEnemy`.
 */
export function dropAtPoint(s: GameState, x: number, y: number): Drop | null {
  let plateHit: Drop | null = null;
  let plateBest = Infinity;
  let modelHit: Drop | null = null;
  let modelBest = Infinity;
  for (const drop of s.drops) {
    const rect = dropLabelRect(drop);
    if (rect !== null
      && x >= rect.x && x <= rect.x + rect.w
      && y >= rect.y && y <= rect.y + rect.h) {
      // Overlapping plates: the one whose centre is nearest wins.
      const d = Math.hypot(x - drop.x, y - (rect.y + rect.h / 2));
      if (d < plateBest) {
        plateBest = d;
        plateHit = drop;
      }
      continue;
    }
    // No plate (hidden by the fan-out cap) still leaves the tiny model itself
    // clickable, so a capped drop is never unreachable.
    const d = Math.hypot(x - drop.x, y - drop.y);
    if (d <= DROP_MODEL_RADIUS && d < modelBest) {
      modelBest = d;
      modelHit = drop;
    }
  }
  return plateHit ?? modelHit;
}

export function hitTestDrop(s: GameState, x: number, y: number): boolean {
  return dropAtPoint(s, x, y) !== null;
}

/* ---------------------------------------------- 撞墙（设计 8.5 物理反应） */

/**
 * 只有「强击退」才可能撞墙眩晕：普攻的 1.0 倍击退只在原地推一下，
 * 每一刀贴墙就晕会让近战变成无限控。
 */
export const WALL_BOUNCE_KNOCKBACK = 1.2;
/** 撞墙的额外伤害（开发期取值：约等于普攻的四分之一）。 */
export const WALL_BOUNCE_DAMAGE = 12;

/** 怪物能站在这里吗（和 `enemies.ts` 同一套 8px 探针；这里独立实现避免方向反向）。 */
function monsterCanStand(w: World, x: number, y: number): boolean {
  return walkable(w, x, y)
    && walkable(w, x - 8, y)
    && walkable(w, x + 8, y);
}

export function clearAttackOrder(s: GameState): void {
  s.attackOrder = false;
  s.targetEnemy = null;
}

/**
 * THE single place a monster loses HP.
 *
 * Both a sword swing and every skill funnel through here, so "how damage lands"
 * (hit flash, knockback, death, kill counter, weighted loot roll) can never
 * drift between the two. A skill that kills must drop loot exactly like a
 * swing does -- otherwise the skill system silently becomes the worst way to
 * farm, and `lootLog` stops matching the kills.
 *
 * `dir` is the knockback direction in world units (defaults to "away from the
 * player", which is what a click-attack has always used).
 *
 * 伤害还要乘「易伤」（`damageTakenMultiplier`）：这是状态系统对伤害的唯一挂点，
 * 和 DOT / 引爆 / 撞墙共用同一条路径。
 */
export function damageSkeleton(
  s: GameState,
  index: number,
  amount: number,
  options: { dirX?: number; dirY?: number; knockback?: number; color?: string } = {},
): boolean {
  const sk = s.skeletons[index];
  if (sk === undefined || !sk.alive || amount <= 0) return false;
  const p = s.player;
  let dx = options.dirX ?? sk.x - p.x;
  let dy = options.dirY ?? sk.y - p.y;
  const d = Math.hypot(dx, dy) || 1;
  dx /= d;
  dy /= d;
  const push = options.knockback ?? 1;

  let scale = damageTakenMultiplier(sk);
  // 睡眠（设计 8.4）：受击即醒，且睡眠中的首次受伤 +50%。
  if (statusOf(sk, 'sleep') !== null) {
    clearStatus(sk, 'sleep');
    scale *= 1.5;
  }
  // 石化被击碎（设计 8.5）：高额伤害并终结石化。
  if (statusOf(sk, 'petrify') !== null) {
    clearStatus(sk, 'petrify');
    scale *= 1.8;
  }
  sk.hp -= amount * scale;
  sk.hit = 0.24;
  // 击退本身也是一条物理反应（设计 8.5）：撞上墙就换成「额外伤害 + 短暂眩晕」，
  // 不再把人推进墙里。撞墙伤害在**同一个函数里**结算，所以死亡 / 击杀 / 掉落
  // 仍然只有一套，不会出现「撞死了却不掉东西」。
  let bounced = false;
  if (push > 0) {
    const nx = sk.x + dx * 16 * push;
    const ny = sk.y + dy * 12 * push;
    if (push >= WALL_BOUNCE_KNOCKBACK && !monsterCanStand(s.world, nx, ny)) {
      applyStatus(sk, 'stun', { duration: 0.6 });
      sk.hp -= WALL_BOUNCE_DAMAGE;
      bounced = true;
    } else {
      sk.x = nx;
      sk.y = ny;
    }
  }
  burst(s, sk.x, sk.y - 26, options.color ?? '#ffd166', 9, 165);
  if (bounced) {
    burst(s, sk.x, sk.y - 18, '#cfdcea', 12, 150);
    say(s, '撞墙 · 眩晕');
  }
  if (sk.hp > 0) return false;

  sk.alive = false;
  // 尸体不能带着点燃继续烧：死亡即清空状态（DOT 不再结算）。
  sk.statuses.length = 0;
  s.kills += 1;
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
      uid: nextDropUid(),
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
  return true;
}

export function swingAtTarget(s: GameState, index: number, mods: CombatModifiers): void {
  const sk = s.skeletons[index];
  if (sk === undefined || !sk.alive) return;
  if (lockedFlags(s.player).noAttack) return;
  const p = s.player;
  const ddx = sk.x - p.x;
  const ddy = sk.y - p.y;
  const d = Math.hypot(ddx, ddy) || 1;
  const weaponId = activeWeapon(s);
  const armed = weaponId !== null;
  // `weapon.xlsx` owns the number. Unknown / demo ids fall back to the legacy
  // baseline rather than inventing a value; bare hands stay at 22.
  const baseline = weaponId === null ? 22 : (weaponDamage(weaponId) ?? 46);
  const aim = Math.atan2(ddy, ddx);

  p.attackCd = PLAYER_ATTACK_CD;
  p.attackFx = PLAYER_SWING_TIME;
  p.face = aim;
  s.attacks += 1;

  damageSkeleton(s, index, mods.damageMultiplier(baseline), {
    color: armed ? '#ffd166' : '#ffb454',
  });
  burst(s, p.x + Math.cos(aim) * 52, p.y + Math.sin(aim) * 52 - 22, '#cfe8ff', 5, 90);
}

/** Out of range -> approach; in range + ready -> one swing; cooling down -> wait. */
export function resolveAttackOrder(s: GameState, mods: CombatModifiers): void {
  if (s.player.dodge > 0 || !s.attackOrder || s.targetEnemy === null) return;
  // 缴械 / 硬控（晕眩、冻结、麻痹…）：普攻入口在这里一次性挡住。
  if (lockedFlags(s.player).noAttack) {
    clearAttackOrder(s);
    return;
  }
  const index = s.targetEnemy;
  const sk = s.skeletons[index];
  if (sk === undefined || !sk.alive) {
    clearAttackOrder(s);
    return;
  }
  const baseRange = activeWeapon(s) !== null ? MELEE_RANGE_ARMED : MELEE_RANGE_BARE;
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
