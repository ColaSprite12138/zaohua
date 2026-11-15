/**
 * Attack authoring contract — the single extension point for attack kinds,
 * their targeting mode, and their resource costs.
 *
 * 设计规则（与 owner 对齐）：
 *  - 当前武器槽决定 `AttackSpec`。没有单独的「开火模式」键：近战 / 远程 / 法术
 *    是武器的属性，不是输入的属性。
 *  - `fire()` 按 `spec.kind` 分派，**绝不按 owner 分派**。加一种新形态 = 加一个
 *    resolver，不碰输入 / 状态 / 绘制。
 *  - 资源消耗是独立注入的策略。怪物永远不付费。
 *  - 远程攻击有**指向性**（`targeting: 'locked'`，锁住点到的目标，飞行中追踪）与
 *    **非指向性**（`targeting: 'directional'`，朝起手角度直飞，可以打空）两种。
 *    这是两种形态，不是两个开关：指向性换「必中」，非指向性换「射程 / 溅射」。
 *
 * 数值全部来自 `tables/projectile.xlsx`（弹速 / 射程 / 碰撞半径）与
 * `tables/weapon.xlsx`（伤害 / 耐久），这里只做 join，不写数字。
 */

import { projectile as projectileRows } from '../resource/generated/projectile.ts';
import { weapon } from '../resource/generated/weapon.ts';

export type AttackKind = 'melee' | 'projectile' | 'spell';
export type CostKind = 'none' | 'durability' | 'ammo' | 'mana';
export type AttackOwner = 'player' | 'monster';
/**
 * 指向性 = 锁住一个目标，飞行中朝它转向（点谁打谁）；
 * 非指向性 = 只管起手角度，之后不再修正（可以打空）。
 */
export type TargetingMode = 'locked' | 'directional';

export interface AttackSpec {
  readonly id: string;
  readonly kind: AttackKind;
  readonly damage: number;
  readonly range: number;
  readonly cooldown: number;
  /** What the PLAYER would spend. Monsters always bypass this. */
  readonly costKind: CostKind;
  /** 飞行体原型（`projectile.xlsx` 的一行）；仅 `projectile` / `spell` 有意义。 */
  readonly projectileId?: string;
  /** 指向性 / 非指向性；缺省 `directional`（不追踪是最保守的默认）。 */
  readonly targeting?: TargetingMode;
  /** 每发消耗的弹药物品 id（`item.xlsx`）；仅 `costKind: 'ammo'` 有意义。 */
  readonly ammoId?: string;
  /** 远程武器的出手间隔另算：拉弓比挥刀慢，数值在 `weapon.xlsx` 之外由本表决定。 */
  readonly projectileSpeed?: number;
}

/** 箭矢（玩家远程）与骷髅箭（弓手）的原型 id，两处引用一次定义。 */
export const ARROW_ID = 'arrow';
export const MONSTER_ARROW_ID = 'monster_arrow';
export const FIREBALL_ID = 'fireball';

const ROW_BY_ID = new Map(projectileRows.map((row) => [String(row.id), row]));

/** 弹道原型的数值（**唯一读表的地方**，别的模块不要自己再 parse 一遍）。 */
export function projectileRow(id: string) {
  const row = ROW_BY_ID.get(id);
  if (row === undefined) {
    throw new Error(`projectile.xlsx 里没有 id=${id}（弹道没配数值就没法飞）`);
  }
  return row;
}

export interface AttackRequest {
  readonly owner: AttackOwner;
  readonly from: { x: number; y: number };
  readonly to: { x: number; y: number };
}

/** 拉弓间隔（秒）：远程比近战（0.4）慢，不然「贴脸砍 vs 远程点」没有取舍。 */
export const RANGED_ATTACK_CD = 0.55;

export const BARE_HANDS: AttackSpec = Object.freeze({
  id: 'bare_hands', kind: 'melee', damage: 22, range: 140,
  cooldown: 0.4, costKind: 'none',
});

/** Melee weapon: costs weapon durability for the player, nothing else. */
export const MELEE_WEAPON: AttackSpec = Object.freeze({
  id: 'melee_weapon', kind: 'melee', damage: 46, range: 170,
  cooldown: 0.4, costKind: 'durability',
});

/**
 * 远程武器：**指向性**。点中的那一只就是锁定目标，箭会朝它转向 —— 与近战
 * 「只打点中的那一只」保持同一条交互契约，只是把距离换成了飞行时间。
 * 箭矢消耗一件弹药（`item.xlsx::30001`），耐久照样磨（设计 7.4 三类武器都有耐久）。
 */
export const RANGED_WEAPON: AttackSpec = Object.freeze({
  id: 'ranged_weapon', kind: 'projectile',
  // 基础伤害只是回退值：真正的伤害是 `weapon.xlsx::damage_min/max` 的中值。
  damage: 22,
  range: projectileRow(ARROW_ID).range,
  cooldown: RANGED_ATTACK_CD, costKind: 'ammo',
  projectileId: ARROW_ID, targeting: 'locked',
  ammoId: '30001',
  projectileSpeed: projectileRow(ARROW_ID).speed,
});

/**
 * Spell weapons are NOT implemented as weapons: 弹道法术走技能栏（`skills.ts`
 * 的 `missile` 形态），因为它要读蓝耗、冷却与读条，这些都属于技能而不是武器。
 * 这个常量保留，是为了让 `AttackKind` 里的 `'spell'` 有一个明确的落点。
 */
export const SPELL_RESERVED_COST: CostKind = 'mana';

/**
 * `tables/weapon.xlsx::weapon_subtype` is the ONLY authority for an item's
 * attack kind. Id prefixes are a legacy naming convention, NOT a rule:
 * `30001` is ammunition (`子弹`) and must never be mistaken for a bow.
 *
 * Extending the game means adding ONE row here (e.g. a future `法术` subtype
 * maps to a spell spec), never changing the id-prefix logic in every consumer.
 * Non-weapon subtypes, unknown ids and empty slots all fall back to bare hands.
 */
const SUBTYPE_SPEC: Readonly<Record<string, AttackSpec>> = Object.freeze({
  '近战': MELEE_WEAPON,
  '远程': RANGED_WEAPON,
});

const WEAPON_BY_ID = new Map(weapon.map((row) => [row.id as string, row]));

export function weaponSpec(itemId: string | null | undefined): AttackSpec {
  if (!itemId) return BARE_HANDS;
  const row = WEAPON_BY_ID.get(itemId);
  if (row === undefined) return BARE_HANDS;
  return SUBTYPE_SPEC[row.weapon_subtype] ?? BARE_HANDS;
}

/**
 * Monster attack behaviour is keyed by the authored monsterId, not by the
 * player's weapon slots. 伤害 / 间隔仍来自 `monster.xlsx`（见 `enemies.ts`），
 * 这里只决定「用哪种形态出手」与弹道原型。
 *
 * 弓手是**非指向性**：朝你此刻站的地方射，走位能躲。这是设计上「不能只靠站着
 * 对轰」的那一半 —— 如果弓手也锁定，玩家挨箭就变成纯数值比大小。
 */
export function monsterSpec(monsterId: string): AttackSpec {
  if (monsterId === '200001') {
    const arrow = projectileRow(MONSTER_ARROW_ID);
    return Object.freeze({
      id: 'monster_archer', kind: 'projectile' as const, damage: 6,
      range: arrow.range, cooldown: 1.8, costKind: 'none' as const,
      projectileId: MONSTER_ARROW_ID, targeting: 'directional' as const,
      projectileSpeed: arrow.speed,
    });
  }
  return Object.freeze({
    id: 'monster_melee', kind: 'melee' as const, damage: 6,
    range: 40, cooldown: 1.15, costKind: 'none' as const,
  });
}
