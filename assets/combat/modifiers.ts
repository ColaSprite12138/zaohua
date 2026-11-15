/**
 * Talent-effect injection point — owned by COMBAT.
 *
 * `talent/` decides WHICH star nodes a player picked and emits node ids; it never
 * computes damage or range. Combat interprets those ids here against the SAME
 * authored table the star map UI renders (`resource/generated/starmap.ts`), so
 * the dependency stays one-way: talent -> node ids -> combat -> numbers.
 *
 * Adding a new effect = add rows in `starmap.xlsx` with a new `effect` value and
 * one case in `sum()` below. Never hardcode a number in this file.
 */

import { starmap } from '../resource/generated/starmap.ts';

export interface CombatModifiers {
  /** Star nodes picked outside the run (`talent/index.ts::effectsOf`). */
  readonly starNodes: readonly string[];
  /** Applied to the final melee damage. 1 = unchanged. */
  damageMultiplier(base: number): number;
  /** Added to melee reach in logical pixels. 0 = unchanged. */
  meleeRangeBonus(): number;
  /** Applied to the player's max HP at deploy. 1 = unchanged. */
  maxHpMultiplier(): number;
  /** Applied to the player's max mana at deploy. 1 = unchanged. */
  maxManaMultiplier(): number;
}

export const NO_MODIFIERS: CombatModifiers = {
  starNodes: [],
  damageMultiplier: (base) => base,
  meleeRangeBonus: () => 0,
  maxHpMultiplier: () => 1,
  maxManaMultiplier: () => 1,
};

const BY_ID = new Map(starmap.map((row) => [row.id as string, row]));

/** Sum one effect column over the picked nodes. Unknown ids are ignored. */
function sum(nodes: readonly string[], effect: string): number {
  let total = 0;
  for (const id of nodes) {
    const row = BY_ID.get(id);
    if (row === undefined || row.effect !== effect) continue;
    total += row.magnitude;
  }
  return total;
}

/**
 * Build the runtime modifiers from the picked node ids.
 *
 * `range_px` is a flat bonus (pixels), the three `_pct` columns are additive
 * percentages: 0.05 + 0.08 = +13% damage, not 1.05 * 1.08. Additive is the
 * design choice from 6.3 (「百分比乘区」), and it keeps small nodes readable.
 */
export function createModifiers(nodes: readonly string[]): CombatModifiers {
  if (nodes.length === 0) return NO_MODIFIERS;
  const damage = 1 + sum(nodes, 'dmg_pct');
  const range = sum(nodes, 'range_px');
  const hp = 1 + sum(nodes, 'hp_pct');
  const mana = 1 + sum(nodes, 'mana_pct');
  return {
    starNodes: [...nodes],
    damageMultiplier: (base) => base * damage,
    meleeRangeBonus: () => range,
    maxHpMultiplier: () => hp,
    maxManaMultiplier: () => mana,
  };
}
