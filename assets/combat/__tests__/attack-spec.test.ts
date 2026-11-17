import { describe, expect, it } from 'vitest';
import { projectile as projectileRows } from '../../resource/generated/projectile.ts';
import { weapon as weaponRows } from '../../resource/generated/weapon.ts';
import {
  ARROW_ID, BARE_HANDS, MELEE_WEAPON, MONSTER_ARROW_ID, RANGED_WEAPON,
  SPELL_RESERVED_COST, monsterSpec, projectileRow, weaponSpec,
} from '../attack-spec.ts';
import { NO_COST, costKindOf, costPolicyFor, type CostPolicy } from '../cost.ts';
import { MELEE_RANGE_ARMED, MELEE_RANGE_BARE } from '../state.ts';

const SWORD_IDS = ['10001', '10002', '10003', '10004', '10005', '10006'];
const BOW_IDS = ['20001', '20002', '20003', '20004', '20005', '20006'];

const ARROW = projectileRows.find((row) => row.id === ARROW_ID)!;
const MONSTER_ARROW = projectileRows.find((row) => row.id === MONSTER_ARROW_ID)!;

describe('the active weapon slot decides the attack kind and its cost', () => {
  it('an empty slot is bare-handed melee and costs nothing', () => {
    expect(weaponSpec(null)).toBe(BARE_HANDS);
    expect(BARE_HANDS.kind).toBe('melee');
    expect(BARE_HANDS.costKind).toBe('none');
    expect(BARE_HANDS.damage).toBe(22);
    // 绝对值钉死（用户 2026-11-17 定的尺度：一个身位多一点），
    // 第二行保证它和战斗判定读的常量没有分叉。
    expect(BARE_HANDS.range).toBe(58);
    expect(BARE_HANDS.range).toBe(MELEE_RANGE_BARE);
  });

  it('every 近战 subtype sword is melee and would consume durability', () => {
    for (const id of SWORD_IDS) {
      const spec = weaponSpec(id);
      expect(spec).toBe(MELEE_WEAPON);
      expect(spec.kind).toBe('melee');
      expect(spec.costKind).toBe('durability');
      expect(spec.damage).toBe(46);
      expect(spec.range).toBe(88);
      expect(spec.range).toBe(MELEE_RANGE_ARMED);
      // 近战没有弹道，也不该被误挂上弹药。
      expect(spec.projectileId).toBeUndefined();
      expect(spec.ammoId).toBeUndefined();
    }
  });

  it('近战距离必须还是一个身位，不许再调回「半个屏幕」', () => {
    // 回归（2026-11-17 用户：「都快成远程武器了」）：曾经是 170 = 弓的 19%。
    // 现在钉上限，顺带钉住「持械比空手长、但仍是同一个量级」。
    expect(MELEE_RANGE_ARMED).toBeLessThanOrEqual(120);
    expect(MELEE_RANGE_ARMED).toBeLessThan(RANGED_WEAPON.range / 8);
    expect(MELEE_RANGE_ARMED).toBeGreaterThan(MELEE_RANGE_BARE);
  });

  it('every 远程 subtype bow is a LOCKED projectile paying ammunition', () => {
    for (const id of BOW_IDS) {
      const spec = weaponSpec(id);
      expect(spec).toBe(RANGED_WEAPON);
      expect(spec.kind).toBe('projectile');
      expect(spec.costKind).toBe('ammo');
      // 指向性：点中的那一只就是锁定目标。
      expect(spec.targeting).toBe('locked');
      expect(spec.projectileId).toBe(ARROW_ID);
      expect(spec.ammoId).toBe('30001');
      // 射程与弹速来自 `projectile.xlsx`，不是代码里的数字。
      expect(spec.range).toBe(ARROW.range);
      expect(spec.projectileSpeed).toBe(ARROW.speed);
    }
  });

  it('the bow is a ranged weapon in the table, not a sword with a long reach', () => {
    // 回归：远程武器曾经被当成「射程 170 的剑」——点一下怪就贴脸砍。
    expect(weaponSpec('20003').kind).toBe('projectile');
    expect(weaponSpec('20003').range).toBeGreaterThan(400);
  });

  it('the subtype, not the id prefix, decides: 30001 is ammunition', () => {
    // 30001 sits in weapon.xlsx with subtype 子弹. It must not become a melee
    // weapon (old prefix rule) and must not fire like a bow either.
    expect(weaponSpec('30001')).toBe(BARE_HANDS);
    expect(weaponSpec('30001')).not.toBe(MELEE_WEAPON);
    expect(weaponSpec('30001')).not.toBe(RANGED_WEAPON);
    // Unknown / empty slots stay bare-handed rather than guessing from an id.
    expect(weaponSpec('99999')).toBe(BARE_HANDS);
    expect(weaponSpec('')).toBe(BARE_HANDS);
  });

  it('every authored weapon row resolves without throwing', () => {
    for (const row of weaponRows) {
      expect(() => weaponSpec(String(row.id))).not.toThrow();
    }
  });

  it('spell costs are reserved at the type level without a weapon implementation', () => {
    expect(SPELL_RESERVED_COST).toBe('mana');
    // 弹道法术走技能栏（`skills.ts::missile`），不是武器 —— 所以武器里没有 spell。
    expect([BARE_HANDS, MELEE_WEAPON, RANGED_WEAPON].map((s) => s.kind))
      .not.toContain('spell');
  });
});

describe('projectile rows are the single authority for flight numbers', () => {
  it('throws for an id that has no row instead of inventing numbers', () => {
    expect(() => projectileRow('no_such_shot')).toThrow(/projectile\.xlsx/);
  });

  it('bow and archer use different rows, so their arrows are not the same arrow', () => {
    expect(ARROW_ID).not.toBe(MONSTER_ARROW_ID);
    expect(ARROW.speed).toBeGreaterThan(MONSTER_ARROW.speed);
    expect(ARROW.homing).toBeGreaterThan(0);          // 玩家箭锁定
    expect(MONSTER_ARROW.homing).toBe(0);             // 怪箭不锁定
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

  it('200001 archer fires a NON-LOCKED arrow and pays nothing', () => {
    const spec = monsterSpec('200001');
    expect(spec.kind).toBe('projectile');
    expect(spec.targeting).toBe('directional');
    expect(spec.projectileId).toBe(MONSTER_ARROW_ID);
    expect(spec.range).toBe(MONSTER_ARROW.range);
    expect(spec.projectileSpeed).toBe(MONSTER_ARROW.speed);
    expect(spec.costKind).toBe('none');
  });
});
