/**
 * 近战命中 / 受击 / 掉落 / 玩家掉血 —— 战斗的**两个伤害出口**都在这个文件里。
 *
 * 普攻与技能的「打怪」走 `damageSkeleton()`（唯一入口）；怪物出刀、弹道命中、
 * DOT 的「打人」走 `damagePlayer()`（唯一入口）。近战的出手判定本身在
 * `ranged.ts::resolveAttackOrder()` —— 那里按当前武器槽分派近战 / 远程。
 */

import { atan2, cos, sin } from '../net/trig.ts';
import { combat_rule } from '../resource/generated/combat_rule.ts';
import { affix } from '../resource/generated/affix.ts';
import { affix_slot } from '../resource/generated/affix_slot.ts';
import { rollAffixes, type AffixEquipKind } from '../meta/affix.ts';
import { activeWeaponBroken, weaponUsable, wearWeapon } from './durability.ts';
import type { Player } from './state.ts';
import { burstEquipmentOnDeath } from './death-drop.ts';
import { burst, say } from './effects.ts';
import { authoredItem, monsterXp, rollLoot, rollWeaponDamage } from './loot.ts';
import { weaponDamage } from './run-inventory.ts';
import type { CombatModifiers } from './modifiers.ts';
import { hurts, type DamageSource } from './source.ts';
import { applyStatus, clearStatus, damageTakenMultiplier, lockedFlags, statusOf } from './status.ts';
import { walkable, type World } from './world.ts';
import {
  activeWeapon, DROP_MODEL_RADIUS, dropLabelRect, dropLanded, makeDropFlight, nextDropUid,
  PLAYER_ATTACK_CD, PLAYER_SWING_TIME, PVP_DEATH_SECONDS, type Drop, type GameState,
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
    const d = Math.sqrt((dx) * (dx) + (y - (sk.y + ENEMY_TORSO_Y)) * (y - (sk.y + ENEMY_TORSO_Y)));
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
    // 还在空中：点不到。用户 2026-11-17「要掉到地上才能拾取」——
    // 名字牌本来就不画了（`dropLabelRect`），模型自己也不能当隐形靶子。
    if (!dropLanded(drop)) continue;
    const rect = dropLabelRect(drop);
    if (rect !== null
      && x >= rect.x && x <= rect.x + rect.w
      && y >= rect.y && y <= rect.y + rect.h) {
      // Overlapping plates: the one whose centre is nearest wins.
      const d = Math.sqrt((x - drop.x) * (x - drop.x) + (y - (rect.y + rect.h / 2)) * (y - (rect.y + rect.h / 2)));
      if (d < plateBest) {
        plateBest = d;
        plateHit = drop;
      }
      continue;
    }
    // No plate (hidden by the fan-out cap) still leaves the tiny model itself
    // clickable, so a capped drop is never unreachable.
    const d = Math.sqrt((x - drop.x) * (x - drop.x) + (y - drop.y) * (y - drop.y));
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
export const WALL_BOUNCE_KNOCKBACK = combat_rule[0].wall_bounce_knockback;
/** 撞墙的额外伤害（约等于普攻的四分之一）；数值在 `tables/combat_rule.xlsx`。 */
export const WALL_BOUNCE_DAMAGE = combat_rule[0].wall_bounce_damage;

/**
 * 掉落物会用哪个部位的词条池（设计 7.2 的锁部位）。
 * 只有武器有池子；药 / 箭返回 null —— 它们品质为白 / 空，`affix_slot` 给 0 条，
 * 这里的 null 只是不替它们猜一个部位。
 */
function affixEquipKind(itemId: string): AffixEquipKind | null {
  return authoredItem(itemId)?.item_type === '武器' ? 'weapon' : null;
}

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
/** 「打怪」这一路的可选项。`source` 必填于新代码：没有来源就判不了阵营。 */
export interface SkeletonDamageOptions {
  dirX?: number; dirY?: number; knockback?: number; color?: string;
  /**
   * 谁造成的（技能 / 武器 / 怪物 / 弹道 / 区域 / DOT）。
   * 省略 = 环境伤害（伤所有阵营）；同阵营一律打不到 —— 见 `source.ts::hurts()`。
   */
  source?: DamageSource;
}

export function damageSkeleton(
  s: GameState,
  index: number,
  amount: number,
  options: SkeletonDamageOptions = {},
): boolean {
  const sk = s.skeletons[index];
  if (sk === undefined || !sk.alive || amount <= 0) return false;
  // **阵营判定在扣血之前**：打不到就什么都不该发生 —— 不给击退、不惊醒、
  // 不撞墙、不计击杀、不滚掉落。放在后面判会留下「自伤把怪推走」这种鬼故事。
  if (!hurts(options.source, 'monster')) return false;
  const p = s.player;
  let dx = options.dirX ?? sk.x - p.x;
  let dy = options.dirY ?? sk.y - p.y;
  const d = Math.sqrt((dx) * (dx) + (dy) * (dy)) || 1;
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
  // 挨打即醒（设计 10.5 的另一半）：沉睡的怪被远程 / AOE 蹭到不会继续站着发呆。
  sk.awake = true;
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
  // 击杀是经验的唯一来源（设计 6.1）。数值在 monster.xlsx 的 `xp` 列，
  // 结算时整份交给主窗口，由 `talent/` 结算升级 —— Worker 不认识等级。
  s.xp += monsterXp(sk.monsterId);
  // Weighted roll from the authored loot table. `kind` stays 'longsword'
  // (visual category) so the existing drop art and playthrough assertions
  // remain valid; the authored identity rides in itemId/name/quality.
  const loot = rollLoot(sk.monsterId, s.rng);
  if (loot !== null) {
    // 恒定伤害与词条都在**掉落这一刻**掷一次（2026-11-17 / 设计 7.1），
    // 结果落在实例上：同一把剑每一下都一样，不同实例各有各的固定值。
    // 用 `s.rng` 而不是 Math.random：同 seed 的整条序列必须可复现。
    const affixes = rollAffixes(
      affix, affix_slot, loot.quality, affixEquipKind(loot.itemId), s.rng,
    );
    const damage = rollWeaponDamage(loot.itemId, s.rng);
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
      uid: nextDropUid(s),
      x: sk.x, y: sk.y, kind: 'longsword', t: 0,
      itemId: loot.itemId, name: loot.name, quality: loot.quality,
      monsterId: sk.monsterId,
      ...(affixes.length === 0 ? {} : { affixes }),
      ...(damage === null ? {} : { damage }),
      // 从怪物倒下的位置抛起，落到脚边（同一坐标），表现层画弧线。
      flight: makeDropFlight(sk.x, sk.y, 0),
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
  const d = Math.sqrt((ddx) * (ddx) + (ddy) * (ddy)) || 1;
  const weaponId = activeWeapon(s);
  // 损坏的武器按空手算（设计 5.2：耐久归零 = 这件装备没了），所以 `armed` 也要看它。
  const broken = activeWeaponBroken(s);
  const armed = weaponId !== null && !broken;
  // `weapon.xlsx` owns the number. Unknown / demo ids fall back to the legacy
  // baseline rather than inventing a value; bare hands stay at 22.
  const baseline = !armed ? 22 : (weaponDamage(weaponId, s.runInventory) ?? 46);
  const aim = atan2(ddy, ddx);

  p.attackCd = PLAYER_ATTACK_CD;
  p.attackFx = PLAYER_SWING_TIME;
  p.face = aim;
  s.attacks += 1;

  const dealt = mods.damageMultiplier(baseline);
  damageSkeleton(s, index, dealt, {
    color: armed ? '#ffd166' : '#ffb454',
  });
  // 造成伤害扣耐久（5.2 / 7.4）。损坏后的那一下不再磨损（已经到底了）。
  if (armed) wearWeapon(s, dealt, 0, p);
  burst(s, p.x + cos(aim) * 52, p.y + sin(aim) * 52 - 22, '#cfe8ff', 5, 90);
}

/* ------------------------------------------------- 玩家掉血（唯一入口） */

export interface PlayerDamageOptions {
  readonly color?: string;
  /**
   * 谁造成的。**同阵营打不到玩家**（`hurts()`）：自己火墙的 DOT、自己铺的毒池、
   * 自己技能的溅射都不会扣自己的血。省略 = 环境，照常生效。
   */
  readonly source?: DamageSource;
  /**
   * 是否吃无敌帧。**攻击类伤害吃**（闪避 / 受击硬直期间不再掉血），
   * **DOT / 区域伤害不吃** —— 站在火里翻滚不该免疫灼烧。
   */
  readonly invuln?: boolean;
  /** 是否算「承受伤害」扣耐久（设计 7.4 的 7:3）。DOT 也算。 */
  readonly wear?: boolean;
  /** 阵亡文案。 */
  readonly deathText?: string;
}

/**
 * 玩家掉血的**唯一出口**：怪物出刀、弹道命中、DOT / 地面区域三条路都走这里。
 *
 * 为什么必须收成一个入口：无敌帧、受伤闪红、掉耐久、阵亡结算这四件事各自散在
 * 三处时，「翻滚到底有没有用」会变成三个不同的答案。收口之后只需要读一个函数。
 */
export function damagePlayer(
  s: GameState,
  amount: number,
  options: PlayerDamageOptions = {},
  /**
   * 打的是谁。缺省 = 我。
   *
   * 多玩家之后这条不能省：怪物按 `nearestPlayer` 选目标，伤害若仍落在
   * `s.player`，就会出现「怪在打 B、掉血的是 A」—— 两端都会看到这件错事，
   * 而且和谁挨打无关。
   */
  target?: Player,
): boolean {
  if (s.gameOver || s.extracted || s.timedOut || s.cleared) return false;
  if (amount <= 0) return false;
  // **自己的东西打不到自己**：在无敌帧、耐久、闪红之前就返回，
  // 所以自伤连"看起来挨了一下"的效果都不会有（用户 2026-11-16 报的问题）。
  if (!hurts(options.source, 'player')) return false;
  const p = target ?? s.player;
  if (p.hp <= 0) return false;
  if ((options.invuln ?? true) && p.invuln > 0) return false;
  // 易伤（软控）对**所有**打向玩家的伤害生效：和怪物打怪走同一条倍率表。
  const taken = amount * damageTakenMultiplier(p);
  p.hp = Math.max(0, p.hp - taken);
  if (options.wear ?? true) wearWeapon(s, 0, taken, p);
  p.hurt = Math.max(p.hurt, options.invuln === false ? 0.18 : 0.35);
  if (options.invuln ?? true) p.invuln = 0.7;
  burst(s, p.x, p.y - 26, options.color ?? '#ff6b6b', 8, 120);
  if (p.hp > 0) return false;
  // 联机 PVP 阵亡：当场爆装，别人可以捡。**PVE 一行都不动** —— 那边是局末
  // settleOnDeath 写存档、下一局摆回地图，两条链路混起来会改坏「二次机会」。
  if (s.online && s.runKind === 'pvpve') {
    burstEquipmentOnDeath(s, p);
    // 独立结算时钟从这一帧起按帧递减：5 秒后本机的 V 层才提示「撤离失败」。
    // 它挂在玩家实体上并进 hash，A、B 两端算出的归零帧号完全相同。
    p.deathTimer = PVP_DEATH_SECONDS;
    // 「谁倒下了」是每个玩家实体上的 `hp`，不是全局结局：死者会在 step 的
    // `if (p.hp <= 0) continue` 里停止行动，其余人继续抢装备。若这里只在
    // 本机死亡时置 `s.gameOver`，A 端冻结全场、B 端继续跑，同一帧立刻分叉。
    say(s, options.deathText ?? `${p.name ?? '玩家'} 被击倒了 · 装备散落一地`);
    return true;
  }
  // 单机 / PVE：本机倒下才结束这一局。用实体 id 比较而不是 `s.me`，
  // 判定层不需要知道「我」是谁。R 重开功能已按产品决定删除，别再提示。
  if (p.id === s.player.id) {
    s.gameOver = true;
    say(s, options.deathText ?? '你被击倒了');
  }
  // 远端玩家倒下：不结束本局，尸体留在原地由绘制层表现。
  return true;
}
