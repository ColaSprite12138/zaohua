import { describe, expect, it } from 'vitest';
import {
  BARE_HANDS, MELEE_WEAPON, PROJECTILE_SPEED, RANGED_WEAPON,
  SPELL_RESERVED_COST, monsterSpec, weaponSpec,
} from '../attack-spec.ts';
import { NO_COST, costKindOf, costPolicyFor, type CostPolicy } from '../cost.ts';

const SWORD_IDS = ['10001', '10002', '10003', '10004', '10005', '10006'];
const BOW_IDS = ['20001', '20002', '20003', '20004', '20005', '20006'];

describe('the active weapon slot decides the attack kind and its cost', () => {
  it('an empty slot is bare-handed melee and costs nothing', () => {
    expect(weaponSpec(null)).toBe(BARE_HANDS);
    expect(BARE_HANDS.kind).toBe('melee');
    expect(BARE_HANDS.costKind).toBe('none');
    expect(BARE_HANDS.damage).toBe(22);
    expect(BARE_HANDS.range).toBe(140);
  });

  it('every 1xxxx sword is melee and would consume durability', () => {
    for (const id of SWORD_IDS) {
      const spec = weaponSpec(id);
      expect(spec).toBe(MELEE_WEAPON);
      expect(spec.kind).toBe('melee');
      expect(spec.costKind).toBe('durability');
      expect(spec.damage).toBe(46);
      expect(spec.range).toBe(170);
    }
  });

  it('every 2xxxx bow is projectile and would consume ammunition', () => {
    for (const id of BOW_IDS) {
      const spec = weaponSpec(id);
      expect(spec).toBe(RANGED_WEAPON);
      expect(spec.kind).toBe('projectile');
      expect(spec.costKind).toBe('ammo');
      expect(spec.range).toBe(Infinity);
      expect(spec.projectileSpeed).toBe(PROJECTILE_SPEED);
    }
  });

  it('spell costs are reserved at the type level without an implementation', () => {
    expect(SPELL_RESERVED_COST).toBe('mana');
    expect([BARE_HANDS, MELEE_WEAPON, RANGED_WEAPON].map((s) => s.kind))
      .not.toContain('spell');
  });
});

describe('resource cost policy', () => {
  it('monsters never consume anything, even when a player policy is supplied', () => {
    let charged = 0;
    const playerPolicy: CostPolicy = {
      canPay: () => true,
      pay: () => { charged += 1; },
    };
    const policy = costPolicyFor('monster', playerPolicy);
    expect(policy).toBe(NO_COST);
    policy.pay(RANGED_WEAPON, 'monster');
    expect(charged).toBe(0);
    expect(costKindOf(RANGED_WEAPON, 'monster')).toBe('none');
  });

  it('a player policy is used for the player and describes the resource', () => {
    let charged = 0;
    const playerPolicy: CostPolicy = {
      canPay: (spec) => spec.costKind !== 'durability',
      pay: () => { charged += 1; },
    };
    const policy = costPolicyFor('player', playerPolicy);
    expect(policy.canPay(MELEE_WEAPON, 'player')).toBe(false);
    expect(policy.canPay(RANGED_WEAPON, 'player')).toBe(true);
    policy.pay(RANGED_WEAPON, 'player');
    expect(charged).toBe(1);
    expect(costKindOf(MELEE_WEAPON, 'player')).toBe('durability');
    expect(costKindOf(RANGED_WEAPON, 'player')).toBe('ammo');
  });

  it('without a resource system no deduction happens by design', () => {
    expect(costPolicyFor('player')).toBe(NO_COST);
    expect(NO_COST.canPay(RANGED_WEAPON, 'player')).toBe(true);
  });
});

describe('monster specs are keyed by monsterId, not by player weapon slots', () => {
  it('100001 keeps the legacy melee numbers', () => {
    const spec = monsterSpec('100001');
    expect(spec.kind).toBe('melee');
    expect(spec.damage).toBe(6);
    expect(spec.range).toBe(40);
    expect(spec.cooldown).toBe(1.15);
    expect(spec.costKind).toBe('none');
  });

  it('200001 archer fires projectiles and pays nothing', () => {
    const spec = monsterSpec('200001');
    expect(spec.kind).toBe('projectile');
    expect(spec.range).toBe(Infinity);
    expect(spec.projectileSpeed).toBe(PROJECTILE_SPEED);
    expect(spec.costKind).toBe('none');
  });
});
