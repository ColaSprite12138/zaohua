import { describe, expect, it } from 'vitest';
import { attribute } from '../../resource/generated/attribute.ts';
import { combat_rule } from '../../resource/generated/combat_rule.ts';
import { consumable } from '../../resource/generated/consumable.ts';
import { baseAttributePoints, deriveAttributes, mitigatedDamage } from '../attributes.ts';
import { POTION_HP_HEAL, POTION_HP_SECONDS } from '../consumables.ts';
import { PLAYER_HP_MAX, PLAYER_MANA_MAX } from '../state.ts';

/** 只改表改出来的期望值：代码里不许再抄一份数字。 */
const hpRow = consumable.find((r) => String(r.id) === '30002')!;

describe('base values come from the authored tables', () => {
  it('life / mana caps are 500 / 200 and read from combat_rule.xlsx', () => {
    expect(combat_rule[0].player_hp_max).toBe(500);
    expect(combat_rule[0].player_mana_max).toBe(200);
    expect(PLAYER_HP_MAX).toBe(combat_rule[0].player_hp_max);
    expect(PLAYER_MANA_MAX).toBe(combat_rule[0].player_mana_max);
  });

  it('the red potion restores 150 over 10 seconds, read from consumable.xlsx', () => {
    expect(hpRow.hp_restore).toBe(150);
    expect(hpRow.hp_seconds).toBe(10);
    expect(POTION_HP_HEAL).toBe(hpRow.hp_restore);
    expect(POTION_HP_SECONDS).toBe(hpRow.hp_seconds);
  });
});

describe('the five base attributes', () => {
  it('has exactly five unique attributes, each with an absolute per-point effect', () => {
    expect(attribute).toHaveLength(5);
    expect(new Set(attribute.map((r) => r.id)).size).toBe(5);
    for (const row of attribute) {
      const sum = row.hp_per_point + row.mana_per_point + row.physical_per_point
        + row.spell_per_point + row.healing_per_point + row.reduction_per_point;
      expect(sum).toBeGreaterThan(0);
      expect(row.points).toBe(0);
    }
  });

  it('base points are all zero and produce no bonus', () => {
    const points = baseAttributePoints();
    expect(Object.values(points)).toEqual([0, 0, 0, 0, 0]);
    expect(deriveAttributes(points)).toEqual({
      hpBonus: 0, manaBonus: 0, physicalDamage: 0,
      spellDamage: 0, healing: 0, damageReduction: 0,
    });
  });

  it('every point adds the table value, never a percentage', () => {
    const points = baseAttributePoints();
    for (const id of Object.keys(points) as (keyof typeof points)[]) points[id] = 3;
    const rows = new Map(attribute.map((r) => [r.id as string, r]));
    const got = deriveAttributes(points);
    expect(got.hpBonus).toBe(3 * rows.get('stamina')!.hp_per_point);
    expect(got.manaBonus).toBe(3 * rows.get('intellect')!.mana_per_point);
    expect(got.physicalDamage).toBe(3 * rows.get('strength')!.physical_per_point);
    expect(got.spellDamage).toBe(3 * rows.get('intellect')!.spell_per_point);
    expect(got.healing).toBe(3 * rows.get('faith')!.healing_per_point);
    expect(got.damageReduction).toBe(3 * rows.get('will')!.reduction_per_point);
  });
});

describe('will reduction multiplies with status reduction', () => {
  it('two independent multipliers never reach full immunity', () => {
    expect(mitigatedDamage(100, 0.5, 0.5)).toBe(25);
    expect(mitigatedDamage(100, 0.3, 0.8)).toBeCloseTo(56);
    expect(mitigatedDamage(100, 0.9, 0.9)).toBeCloseTo(9);
  });

  it('an over-stacked reduction is clamped so damage never goes negative', () => {
    expect(mitigatedDamage(100, 5, 1)).toBe(0);
  });
});
