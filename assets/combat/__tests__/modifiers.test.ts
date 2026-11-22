import { describe, expect, it } from 'vitest';
import {
  createModifiers, createState, deployRun, NO_MODIFIERS, reset, step, projection,
  type CombatModifiers, type StepInput,
} from '../simulation.ts';
import { damageSkeleton } from '../attack.ts';
import { MELEE_RANGE_BARE } from '../state.ts';
import { monsterXp } from '../loot.ts';
import { starmap } from '../../resource/generated/starmap.ts';

const idle: StepInput = {
  mouse: undefined,
  pointerDown: false,
  pointerHeld: false,
  pointerUp: false,
  dodge: false,
};

function queuedSwing(distance: number) {
  const s = createState();
  const sk = s.skeletons[0]!;
  sk.x = s.player.x + distance;
  sk.y = s.player.y;
  s.targetEnemy = 0;
  s.attackOrder = true;
  return { s, sk };
}

describe('talent-effect hook lives in combat', () => {
  it('NO_MODIFIERS reproduces the legacy bare-hand damage exactly', () => {
    const { s, sk } = queuedSwing(50);
    step(s, 0.016, idle, NO_MODIFIERS);
    expect(s.attacks).toBe(1);
    expect(sk.hp).toBe(66 - 22);
    expect(s.attackOrder).toBe(false);
  });

  it('a supplied modifier scales damage without touching combat code', () => {
    const double: CombatModifiers = {
      starNodes: ['test.damage-x2'],
      damageMultiplier: (base) => base * 2,
      meleeRangeBonus: () => 0,
      maxHpMultiplier: () => 1,
      maxManaMultiplier: () => 1,
    };
    const { s, sk } = queuedSwing(50);
    step(s, 0.016, idle, double);
    expect(sk.hp).toBe(66 - 44);
  });

  it('a range modifier lets a distant target be hit; default still approaches', () => {
    const reachMods: CombatModifiers = {
      starNodes: ['test.reach+100'],
      damageMultiplier: (base) => base,
      meleeRangeBonus: () => 100,
      maxHpMultiplier: () => 1,
      maxManaMultiplier: () => 1,
    };
    // 基础近战 58 +「长臂」100 = 158，减 RANGE_SLACK 8 之后仍有 150 的可达半径；
    // 取 128 留余量，且没词条的裸手（50）够不到 —— 一条用例同时验两件事。
    const dist = MELEE_RANGE_BARE + 100 - 30;
    const extended = queuedSwing(dist);
    step(extended.s, 0.016, idle, reachMods);
    expect(extended.s.attacks).toBe(1);

    const baseline = queuedSwing(dist);
    step(baseline.s, 0.016, idle, NO_MODIFIERS);
    expect(baseline.s.attacks).toBe(0);
    expect(baseline.s.attackOrder).toBe(true);
  });
});

describe('star nodes are interpreted from starmap.xlsx (design 6.3)', () => {
  const row = (id: string) => starmap.find((r) => r.id === id)!;

  it('sums additive percentages and flat range over the picked nodes', () => {
    const mods = createModifiers(['ember_dmg', 'venom_dmg', 'venom_range']);
    const dmg = 1 + row('ember_dmg').magnitude + row('venom_dmg').magnitude;
    expect(mods.damageMultiplier(100)).toBeCloseTo(100 * dmg, 6);
    expect(mods.meleeRangeBonus()).toBe(row('venom_range').magnitude);
    expect(mods.maxHpMultiplier()).toBe(1);
    expect(mods.maxManaMultiplier()).toBe(1);
  });

  it('ignores unknown node ids and skill nodes (magnitude 0)', () => {
    const mods = createModifiers(['ember_wall', 'ghost']);
    expect(mods.damageMultiplier(50)).toBe(50);
    expect(mods.maxHpMultiplier()).toBe(1);
    expect(createModifiers([])).toBe(NO_MODIFIERS);
  });

  it('deploy applies HP / mana multipliers and the star skill bar', () => {
    const s = createState();
    deployRun(s, {
      stars: { skills: ['cleave', 'thunder'], nodes: ['ember_hp', 'frost_mana'] },
    });
    const hp = 1 + row('ember_hp').magnitude;
    const mana = 1 + row('frost_mana').magnitude;
    expect(s.maxHp).toBe(Math.round(100 * hp));
    expect(s.hp).toBe(s.maxHp);
    expect(s.maxMana).toBe(Math.round(100 * mana));
    expect(s.mana).toBe(s.maxMana);
    expect(s.skillBar.map((slot) => slot.id)).toEqual([
      'cleave', 'thunder', null, null, null, null, null,
    ]);
  });

  it('a star map without skills deploys empty hands (no free pre-equipped kit)', () => {
    const s = createState();
    deployRun(s, { stars: { skills: [] } });
    expect(s.skillBar.every((slot) => slot.id === null)).toBe(true);
  });

  it('a fixture reset keeps the deployed star kit instead of the fixture default', () => {
    const s = createState();
    deployRun(s, { stars: { skills: ['ice_shard'] } });
    // R 重开已从帧协议删除；夹具重置是局外动作，不走 step()。
    reset(s);
    expect(s.skillBar[0]!.id).toBe('ice_shard');
  });
});

describe('kills are the only XP source (design 6.1)', () => {
  it('a killed monster grants its authored xp', () => {
    const s = createState();
    const sk = s.skeletons[0]!;
    expect(s.xp).toBe(0);
    const xp = monsterXp(sk.monsterId);
    expect(damageSkeleton(s, 0, 999)).toBe(true);
    expect(s.xp).toBe(xp);
    expect(projection(s).xp).toBe(xp);
  });

  it('a fresh run starts at zero xp', () => {
    const s = createState();
    damageSkeleton(s, 0, 999);
    expect(s.xp).toBeGreaterThan(0);
    reset(s);
    expect(s.xp).toBe(0);
  });
});
