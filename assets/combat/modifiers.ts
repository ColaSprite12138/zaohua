/**
 * Talent-effect injection point — owned by COMBAT.
 *
 * `talent/` decides WHICH talents a player picked and emits effect ids.
 * It never computes damage or range. Combat interprets those ids here, so the
 * dependency is strictly one-way: talent -> (effect ids) -> combat.
 * No concrete talent effects are implemented yet; the default is a no-op.
 */

export interface CombatModifiers {
  /** Stable ids chosen outside the run, e.g. from `talent/`. */
  readonly effectIds: readonly string[];
  /** Applied to the final melee damage. 1 = unchanged. */
  damageMultiplier(base: number): number;
  /** Added to melee reach in logical pixels. 0 = unchanged. */
  meleeRangeBonus(): number;
}

export const NO_MODIFIERS: CombatModifiers = {
  effectIds: [],
  damageMultiplier: (base) => base,
  meleeRangeBonus: () => 0,
};
