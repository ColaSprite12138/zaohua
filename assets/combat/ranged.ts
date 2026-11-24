/**
 * 出手分派：**一个点击指令，按当前武器槽决定是走近战还是放箭**。
 *
 * 以前这里只有近战一条路（`MELEE_RANGE` + `swingAtTarget`），于是弓箭在代码里
 * 是一把「射程 170 的剑」：点一下怪就贴脸砍。远程武器的形态其实早就写在
 * `attack-spec.ts` 里了（`weapon_subtype` 决定），只是没人读它。本文件就是那个读者。
 *
 * 三条规则：
 * 1. **范围从 spec 来**：近战读 `weapon.xlsx::range`（空手读 `combat_rule.xlsx::melee_range_bare`），
 *    远程读 `projectile.xlsx` 的射程；星图 / 词条的 `range_px` 再叠一层。
 * 2. **远程扣弹药，不扣「出手耐久」**：箭是消耗品（`costKind: 'ammo'`），
 *    武器耐久在**命中**时按伤害扣（`projectile-runtime.ts`）—— 打空只丢一支箭。
 * 3. **没箭就是打不出去**：拒绝要说话（toast），并且**不进冷却、不扣耐久**，
 *    否则玩家会以为「卡住了」。
 */

import { atan2 } from '../net/trig.ts';
import { ARROW_ID, weaponSpec, type AttackSpec } from './attack-spec.ts';
import { gearAffixTotal } from '../meta/affix.ts';
import { clearAttackOrder, swingAtPlayer, swingAtTarget } from './attack.ts';
import { activeWeaponBroken } from './durability.ts';
import { say, setTarget } from './effects.ts';
import { ammoCount, fireProjectile, takeAmmo } from './projectile-runtime.ts';
import type { CombatModifiers } from './modifiers.ts';
import { playerById } from './players.ts';
import { weaponDamage } from './run-inventory.ts';
import { lockedFlags } from './status.ts';
import {
  activeWeapon, PLAYER_SWING_TIME,
  type GameState, type Player,
} from './state.ts';

/** 走到点再放箭：`range - 8` 与近战同一条「差一点就算够到」的宽容。 */
const RANGE_SLACK = 8;

/**
 * 一次点击攻击指令的解析。顺序：够不着就靠近 → 冷却好了就出手 → 否则原地等。
 * 近战 / 远程的唯一差别在 `spec`；**打怪还是打人**由 `intent` 里互斥的两个
 * 目标字段决定，走同一份射程 / 冷却 / 星图乘区，不存在「本机特供」分支。
 */
export function resolveAttackOrder(s: GameState, mods: CombatModifiers): void {
  const p = s.player;
  if (p.dodge > 0 || !s.attackOrder) return;
  // 缴械 / 硬控（晕眩、冻结、麻痹…）：普攻入口在这里一次性挡住。
  // **必须说一句话**：静默吞掉会让「点了没反应」看起来像卡了 —— 这一句也是
  // 玩家第一次知道「打我的是缴械，不是我的鼠标」（2026-11-18 怪物技能批次）。
  if (lockedFlags(p).noAttack) {
    say(s, '被缴械 · 这一下打不出去');
    clearAttackOrder(s);
    return;
  }
  const foe = s.targetPlayerId !== null ? playerById(s, s.targetPlayerId) : null;
  const index = s.targetEnemy;
  const sk = index !== null ? s.skeletons[index] : undefined;
  const target = foe !== null && foe.hp > 0
    ? foe
    : (sk !== undefined && sk.alive ? sk : null);
  // 目标死了 / 离场就撤销指令，绝不改打别的身体。
  if (target === null) {
    clearAttackOrder(s);
    return;
  }
  const tx = target.x;
  const ty = target.y;
  const weaponId = activeWeapon(s);
  const armed = weaponId !== null && !activeWeaponBroken(s);
  const spec = weaponSpec(armed ? weaponId : null);
  // 射程词条（设计 7.1）只对**拿着的那把它**生效：损坏 / 空手不加。
  const gearRange = armed ? gearAffixTotal(s.runInventory, 'range_px') : 0;
  // 距离的真源就是 `spec`：近战 = 这把武器在 `weapon.xlsx::range` 里的值，
  // 空手 / 拿坏了的武器 = `BARE_HANDS`，远程 = `projectile.xlsx` 的射程。
  const range = spec.kind === 'melee'
    ? spec.range + mods.meleeRangeBonus() + gearRange
    : spec.range + gearRange;
  const d = Math.sqrt((tx - p.x) * (tx - p.x) + (ty - p.y) * (ty - p.y));
  if (d > range - RANGE_SLACK) {
    setTarget(s, tx, ty);
    s.moveMode = 'point';
    return;
  }
  if (p.attackCd > 0) {
    setTarget(s, p.x, p.y);
    s.moveMode = 'point';
    return;
  }
  if (spec.kind === 'melee') {
    if (foe !== null && target === foe) swingAtPlayer(s, p, foe, mods);
    else swingAtTarget(s, index as number, mods);
  } else if (foe !== null && target === foe) {
    fireRangedAtPlayer(s, p, foe, spec, mods);
  } else {
    fireRangedAt(s, index as number, spec, mods);
  }
  clearAttackOrder(s);
  setTarget(s, p.x, p.y);
  s.moveMode = 'idle';
}

/**
 * 放一发远程普攻。`targeting: 'locked'` 把目标下标交给弹道运行时，箭会朝它转向；
 * 非指向性的武器（目前没有，留给「法术武器」那一批）只认出手角度。
 *
 * 返回是否真的打出去了 —— 没箭时返回 false，**冷却与耐久都不动**。
 */
export function fireRangedAt(
  s: GameState,
  index: number,
  spec: AttackSpec,
  mods: CombatModifiers,
): boolean {
  const p = s.player;
  const sk = s.skeletons[index];
  if (sk === undefined || !sk.alive) return false;
  if (spec.ammoId !== undefined) {
    if (ammoCount(s, spec.ammoId) <= 0) {
      say(s, '没有箭了 · 去搜刮箭矢，或者换近战（1 / 2 切槽）');
      return false;
    }
    takeAmmo(s, spec.ammoId);
  }
  const weaponId = activeWeapon(s);
  // 伤害以 `weapon.xlsx` 的中值为准；spec 里的数字只是没有武器时的回退。
  const baseline = weaponId === null ? spec.damage : (weaponDamage(weaponId, s.runInventory) ?? spec.damage);
  const damage = mods.damageMultiplier(baseline);
  p.attackCd = spec.cooldown;
  // 拉弓也是一次「出手动作」：绘制层据此抬手，玩家看得出这一发真的放出去了。
  p.attackFx = PLAYER_SWING_TIME;
  p.face = atan2(sk.y - p.y, sk.x - p.x);
  s.attacks += 1;
  fireProjectile(s, {
    owner: 'player',
    ownerId: p.id,
    projectileId: spec.projectileId ?? ARROW_ID,
    damage,
    from: { x: p.x, y: p.y },
    targetIndex: spec.targeting === 'locked' ? index : null,
    aim: { x: sk.x, y: sk.y },
    angle: p.face,
    sourceId: weaponId ?? spec.id,
  });
  return true;
}

/**
 * 远程普攻**打另一个玩家**（PVP 互砍的弹道出口）。
 *
 * 与 `fireRangedAt` 共用弹药 / 冷却 / 伤害 / 射程规则，只有目标形态不同：
 * `targetIndex` 只认 `skeletons` 下标，所以对玩家改成「起手角度直飞 + 非追踪」，
 * 走位能躲 —— 和技能火球同一条规则，不额外造一套锁定逻辑。
 * `ownerId` 必须是发射者，弹道命中时的伤害来源才认得出「这支箭是谁的」。
 */
export function fireRangedAtPlayer(
  s: GameState,
  attacker: Player,
  target: Player,
  spec: AttackSpec,
  mods: CombatModifiers,
): boolean {
  if (spec.ammoId !== undefined) {
    if (ammoCount(s, spec.ammoId) <= 0) {
      say(s, '没有箭了 · 去搜刮箭矢，或者换近战（1 / 2 切槽）');
      return false;
    }
    takeAmmo(s, spec.ammoId);
  }
  const weaponId = activeWeapon(s);
  const baseline = weaponId === null ? spec.damage : (weaponDamage(weaponId, s.runInventory) ?? spec.damage);
  const damage = mods.damageMultiplier(baseline);
  attacker.attackCd = spec.cooldown;
  attacker.attackFx = PLAYER_SWING_TIME;
  attacker.face = atan2(target.y - attacker.y, target.x - attacker.x);
  s.attacks += 1;
  fireProjectile(s, {
    owner: 'player',
    ownerId: attacker.id,
    projectileId: spec.projectileId ?? ARROW_ID,
    damage,
    from: { x: attacker.x, y: attacker.y },
    targetIndex: null,
    aim: { x: target.x, y: target.y },
    angle: attacker.face,
    sourceId: weaponId ?? spec.id,
  });
  return true;
}
