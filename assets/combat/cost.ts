/**
 * Resource-cost extension point.
 *
 * Planned player-side costs (owner's spec):
 *   melee      -> weapon durability
 *   projectile -> ammunition (arrows etc.)
 *   spell      -> mana
 * Monsters never consume any of these.
 *
 * Only the POLICY INTERFACE and the monster bypass are implemented this
 * round. Durability / ammo / mana have no authoritative data source yet, so
 * `NO_COST` is a deliberate "nothing is deducted" policy, not a placeholder
 * to be filled in later. When a resource system lands, supply a player
 * CostPolicy through `costPolicyFor` — attack logic does not change.
 */

import type { AttackOwner, AttackSpec, CostKind } from './attack-spec.ts';

export interface ResourceWallet {
  readonly durability: number;
  readonly ammo: number;
  readonly mana: number;
}

export interface CostPolicy {
  canPay(spec: AttackSpec, owner: AttackOwner): boolean;
  pay(spec: AttackSpec, owner: AttackOwner): void;
}

export const NO_COST: CostPolicy = Object.freeze({
  canPay: () => true,
  pay: () => {},
});

/** Monsters never pay, even if a player policy is supplied. */
export function costPolicyFor(owner: AttackOwner, playerPolicy?: CostPolicy): CostPolicy {
  if (owner === 'monster') return NO_COST;
  return playerPolicy ?? NO_COST;
}

/** Describes which resource a spec WOULD draw from; never deducts. */
export function costKindOf(spec: AttackSpec, owner: AttackOwner): CostKind {
  return owner === 'monster' ? 'none' : spec.costKind;
}
