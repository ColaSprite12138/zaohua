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
 * 数值全部来自表，这里只做 join，不写数字：
 *  - `weapon.xlsx`：`weapon_subtype`（形态权威）、`damage_min/max`、`durability`、
 *    **`range`（这把武器能锁到多远；远程填 0 = 交给弹道）**；
 *  - `projectile.xlsx`：弹速 / 射程 / 碰撞半径（远程武器的真实飞行距离）；
 *  - `combat_rule.xlsx`：`melee_range_bare`（空手距离，没有武器行可挂）。
 */

import { combat_rule } from '../resource/generated/combat_rule.ts';
import { monster as monsterRows } from '../resource/generated/monster.ts';
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

/**
 * 近战武器的**模板**距离：`weapon.xlsx` 里第一把近战武器的 `range`。
 * 具体武器走 `weaponSpec()` 的行值（每把可以不同）；这里只是没有行时的模板。
 */
const MELEE_TEMPLATE_RANGE = weapon.find((row) => row.weapon_subtype === '近战')?.range ?? 0;

/**
 * 空手：没有武器行，距离来自 `combat_rule.xlsx::melee_range_bare`（2026-11-17 数值表化）。
 * 尺度见 `state.ts::MELEE_RANGE_BARE` 的注释（一个身位多一点）。
 */
export const BARE_HANDS: AttackSpec = Object.freeze({
  id: 'bare_hands', kind: 'melee', damage: 22,
  range: combat_rule[0].melee_range_bare,
  cooldown: 0.4, costKind: 'none',
});

/** Melee weapon: costs weapon durability for the player, nothing else. */
export const MELEE_WEAPON: AttackSpec = Object.freeze({
  id: 'melee_weapon', kind: 'melee', damage: 46, range: MELEE_TEMPLATE_RANGE,
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

/**
 * 按武器行派生出的 spec 缓存。
 * 距离进了表之后，同一个 `kind` 的两把剑可能有一长一短 —— 不能共用一个 spec，
 * 但也不该每次调用都 new 一个（调用方会拿 `spec` 做身份比较 / 当 Map 键）。
 * 每把武器解析一次，之后返回同一个冻结对象。
 */
const SPEC_BY_ID = new Map<string, AttackSpec>();

/**
 * 当前武器（或空手）的出手规格。
 *
 * `range` 的口径（2026-11-17，用户要求「攻击距离能在 excel 里配」）：
 *  - **近战**：读 `weapon.xlsx::range`（这把剑自己的距离）→ 每把可不同；
 *  - **远程**：行的 `range` 约定为 `0`，表示「交给弹道」→ 用 `projectile.xlsx` 的射程。
 *    （箭能飞多远由弹道决定，玩家看得见；在两处各写一份必然漂移。）
 *  - **空手 / 未知 id / 非武器 subtype**：`BARE_HANDS`（`combat_rule.xlsx`）。
 */
export function weaponSpec(itemId: string | null | undefined): AttackSpec {
  if (!itemId) return BARE_HANDS;
  const cached = SPEC_BY_ID.get(itemId);
  if (cached !== undefined) return cached;
  const row = WEAPON_BY_ID.get(itemId);
  const base = row === undefined ? undefined : SUBTYPE_SPEC[row.weapon_subtype];
  if (row === undefined || base === undefined) {
    SPEC_BY_ID.set(itemId, BARE_HANDS);
    return BARE_HANDS;
  }
  const range = row.range > 0 ? row.range : base.range;
  const spec = range === base.range ? base : Object.freeze({ ...base, range });
  SPEC_BY_ID.set(itemId, spec);
  return spec;
}

/**
 * 怪物普攻的形态，**按 `monster.xlsx` 的行派生**，不再按 id 写 if
 * （2026-11-18 怪物技能批次）。
 *
 * 表里两列决定它：
 * - `attack_kind`：`melee` / `projectile`；
 * - `projectile`：远程的弹道原型（`projectile.xlsx`）；近战留空。
 *
 * 伤害 / 间隔**不在这里**：`enemies.ts` 直接读同一行的 `attack_damage` /
 * `attack_interval`。以前这个函数里写死过一份 `damage: 6` / `cooldown: 1.15`，
 * 改表根本不生效 —— 那种「看着像配置的死值」比没有更坏。
 *
 * 远程一律 `directional`：弓手与法师都朝你**此刻**站的位置出手，走位能躲。
 * 会追踪的远程会让「贴脸换血」变成唯一解，那是设计明确否决的。
 *
 * 表里没有这只怪（地图写了没配表的 id）时退回近战模板 —— 一只站着不动的怪
 * 比一只打法粗暴的怪更难查。
 */
const MONSTER_SPEC = new Map<string, AttackSpec>();
const MONSTER_BY_ID = new Map(monsterRows.map((row) => [String(row.id), row]));

export function monsterSpec(monsterId: string): AttackSpec {
  const cached = MONSTER_SPEC.get(monsterId);
  if (cached !== undefined) return cached;
  const row = MONSTER_BY_ID.get(monsterId);
  // 显式放宽成 string：generated 是 `as const`，判别式收窄会把「melee 行的
  // projectile 必为空」推成字面量联合，`!== ''` 反而报"不可能成立"。
  const kind: string = row?.attack_kind ?? 'melee';
  const projectileId: string = row?.projectile ?? '';
  let spec: AttackSpec;
  if (row !== undefined && kind === 'projectile' && projectileId !== '') {
    const shot = projectileRow(projectileId);
    spec = Object.freeze({
      id: `monster:${monsterId}`, kind: 'projectile' as const,
      damage: row.attack_damage, range: shot.range, cooldown: row.attack_interval,
      costKind: 'none' as const,
      projectileId, targeting: 'directional' as const,
      projectileSpeed: shot.speed,
    });
  } else {
    spec = Object.freeze({
      id: `monster:${monsterId}`, kind: 'melee' as const,
      damage: row?.attack_damage ?? 0,
      range: combat_rule[0].monster_strike_range,
      cooldown: row?.attack_interval ?? 0,
      costKind: 'none' as const,
    });
  }
  MONSTER_SPEC.set(monsterId, spec);
  return spec;
}
