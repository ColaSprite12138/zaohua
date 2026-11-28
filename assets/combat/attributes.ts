/**
 * 人物基础属性 → 派生战斗数值。
 *
 * 数值唯一来源是 `tables/attribute.xlsx`（经 `generated/attribute.ts`）。
 * 这里只做「点数 × 每点收益」的**绝对值加算**：不设计任何百分比属性，
 * 不在代码里写死数字，也不碰技能（技能会按这套属性重新设计）。
 *
 * 表里的 `points` 是人物自带点数的初值；装备词条与星图小节点给的点数，
 * 由调用方叠加成 `AttributePoints` 再传进来。
 */

import { attribute } from '../resource/generated/attribute.ts';

export type AttributeId = typeof attribute[number]['id'];
export type AttributePoints = Record<AttributeId, number>;

export interface DerivedAttributes {
  /** 生命上限的绝对值加成：基础值 + 这个值。 */
  readonly hpBonus: number;
  /** 法力上限的绝对值加成：基础值 + 这个值。 */
  readonly manaBonus: number;
  /** 普通攻击伤害的绝对值加成。 */
  readonly physicalDamage: number;
  /** 法术伤害的绝对值加成。 */
  readonly spellDamage: number;
  /** 治疗技能回复量的绝对值加成；红药不受影响。 */
  readonly healing: number;
  /** 意志提供的减伤比例（0~1），与状态减伤**乘算**。 */
  readonly damageReduction: number;
}

/** 表里配的人物自带点数初值。 */
export function baseAttributePoints(): AttributePoints {
  const out = {} as AttributePoints;
  for (const row of attribute) out[row.id as AttributeId] = row.points;
  return out;
}

/** 全部按绝对值加算；同一属性的多个来源直接相加，不互相乘。 */
export function deriveAttributes(points: AttributePoints): DerivedAttributes {
  let hpBonus = 0;
  let manaBonus = 0;
  let physicalDamage = 0;
  let spellDamage = 0;
  let healing = 0;
  let damageReduction = 0;
  for (const row of attribute) {
    const p = points[row.id as AttributeId] ?? 0;
    hpBonus += p * row.hp_per_point;
    manaBonus += p * row.mana_per_point;
    physicalDamage += p * row.physical_per_point;
    spellDamage += p * row.spell_per_point;
    healing += p * row.healing_per_point;
    damageReduction += p * row.reduction_per_point;
  }
  return { hpBonus, manaBonus, physicalDamage, spellDamage, healing, damageReduction };
}

/**
 * 意志减伤与状态减伤**乘算**，不是相加：
 * 加法会把两个独立乘区堆到 100% 免伤，乘算永远留有余量。
 * 减伤比例先夹到 [0,1]，避免点数过量时出现负伤害（回血）。
 */
export function mitigatedDamage(amount: number, reduction: number, statusMultiplier: number): number {
  const kept = 1 - Math.min(1, Math.max(0, reduction));
  return amount * kept * statusMultiplier;
}
