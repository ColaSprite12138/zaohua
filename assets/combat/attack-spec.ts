/**
 * Attack authoring contract — the single extension point for attack kinds and
 * their resource costs.
 *
 * Design rules (agreed with the owner):
 *  - The ACTIVE WEAPON SLOT selects an AttackSpec. There is no separate
 *    "fire mode" key: melee / ranged / spell is a property of the weapon.
 *  - `fire()` dispatches on `spec.kind`, never on `owner`. Adding a new kind
 *    (e.g. spell) means adding one resolver, not touching input/state/render.
 *  - Cost is a separate injected policy. Monsters NEVER pay costs.
 *  - Only melee and projectile are implemented this round. `spell` exists as
 *    a type-level reservation so no interface has to be broken later.
 *
 * No engine / DOM imports: combat stays a pure logic module. The one import
 * below is an authored data constant, not runtime state.
 */

import { weapon } from '../resource/generated/weapon.ts';

export type AttackKind = 'melee' | 'projectile' | 'spell';
export type CostKind = 'none' | 'durability' | 'ammo' | 'mana';
export type AttackOwner = 'player' | 'monster';

export interface AttackSpec {
  readonly id: string;
  readonly kind: AttackKind;
  readonly damage: number;
  readonly range: number;
  readonly cooldown: number;
  /** What the PLAYER would spend. Monsters always bypass this. */
  readonly costKind: CostKind;
  /** Only meaningful for projectile specs. */
  readonly projectileSpeed?: number;
}

/** Written down in one place; will move to an authored table later. */
export const PROJECTILE_SPEED = 420;

export interface AttackRequest {
  readonly owner: AttackOwner;
  readonly from: { x: number; y: number };
  readonly to: { x: number; y: number };
}

export const BARE_HANDS: AttackSpec = Object.freeze({
  id: 'bare_hands', kind: 'melee', damage: 22, range: 140,
  cooldown: 0.4, costKind: 'none',
});

/** Melee weapon: costs weapon durability for the player, nothing else. */
export const MELEE_WEAPON: AttackSpec = Object.freeze({
  id: 'melee_weapon', kind: 'melee', damage: 46, range: 170,
  cooldown: 0.4, costKind: 'durability',
});

/** Ranged weapon: costs ammunition, not durability. */
export const RANGED_WEAPON: AttackSpec = Object.freeze({
  id: 'ranged_weapon', kind: 'projectile', damage: 22, range: Infinity,
  cooldown: 0.55, costKind: 'ammo', projectileSpeed: PROJECTILE_SPEED,
});

/**
 * Spell weapons are NOT implemented this round. Reserved so that a future
 * spec can be authored without changing AttackKind or the dispatch contract.
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
 * player's weapon slots. Values mirror the existing `enemies.ts` melee
 * (6 damage / 40px reach / 1.15s cadence) so the default arena stays intact.
 */
export function monsterSpec(monsterId: string): AttackSpec {
  if (monsterId === '200001') {
    return Object.freeze({
      id: 'monster_archer', kind: 'projectile' as const, damage: 6,
      range: Infinity, cooldown: 1.8, costKind: 'none' as const,
      projectileSpeed: PROJECTILE_SPEED,
    });
  }
  return Object.freeze({
    id: 'monster_melee', kind: 'melee' as const, damage: 6,
    range: 40, cooldown: 1.15, costKind: 'none' as const,
  });
}
