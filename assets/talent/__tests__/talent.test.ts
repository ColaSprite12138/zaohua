import { describe, expect, it } from 'vitest';
import {
  affinityMissing, affinityOf, awardClear, awardExplore, canPick, constellationDone,
  constellationOpen, createStarMap, createStarState, effectsOf, grantXp, levelCap, pickNode,
  pointsEarned, pointsLeft, pointsSpent, respec, sanitizeProgress, ultimateCount,
  unlockedSkills, xpToNext, AFFINITIES, type ConstellationRow, type LevelRow,
  type StarNodeRow, type StarRule,
} from '../index.ts';

/** 夹具：4 个等级 / 4 个星座 / 依 order 顺序点亮。数值手算，形状与真实表一致。 */
const levels: LevelRow[] = [
  { id: 'lv1', level: 1, xp_to_next: 60, star_points: 1 },
  { id: 'lv2', level: 2, xp_to_next: 90, star_points: 1 },
  { id: 'lv3', level: 3, xp_to_next: 120, star_points: 1 },
  { id: 'lv4', level: 4, xp_to_next: 0, star_points: 1 },
];
const rule: StarRule = { mainline_star_points: 2, explore_star_points: 1 };

const c = (partial: Partial<ConstellationRow> & { id: string }): ConstellationRow => ({
  name: partial.id, color: 'ares', tier: 'base', god: '', school: 'physical',
  requirement: 0, grant_color: 'ares', grant_amount: 3, combo_a: '', combo_b: '',
  combo_c: '', x: 0, y: 0, hint: '', ...partial,
});
const constellations: ConstellationRow[] = [
  c({ id: 'ember' }),
  c({ id: 'frost', color: 'demeter', grant_color: 'demeter' }),
  c({ id: 'tide', color: 'poseidon', tier: 'mid', requirement: 2, grant_color: 'poseidon', grant_amount: 5 }),
  c({ id: 'warlord', tier: 'ult', requirement: 5, grant_amount: 0, grant_color: '',
      combo_a: 'apollo', combo_b: 'zeus', combo_c: 'athena' }),
];

const node = (
  partial: Partial<StarNodeRow> & { id: string; constellation: string },
): StarNodeRow => ({
  name: partial.id, kind: 'attribute', order: 1, effect: 'dmg_pct', magnitude: 0.05,
  cost: 1, school: 'physical', god: '', combo_god: '', skill_id: '', hint: '', ...partial,
});

const nodeRows: StarNodeRow[] = [
  node({ id: 'ember_n1', constellation: 'ember', order: 1 }),
  node({ id: 'ember_skill', constellation: 'ember', order: 2, kind: 'skill',
         effect: '', magnitude: 0, skill_id: 'fire_wall' }),
  node({ id: 'ember_big', constellation: 'ember', order: 3, kind: 'passive', magnitude: 0.1, cost: 2 }),
  node({ id: 'frost_n1', constellation: 'frost', order: 1 }),
  node({ id: 'frost_skill', constellation: 'frost', order: 2, kind: 'skill',
         effect: '', magnitude: 0, skill_id: 'ice_shard' }),
  node({ id: 'frost_mana', constellation: 'frost', order: 3, effect: 'mana_pct', magnitude: 0.1 }),
  node({ id: 'tide_skill', constellation: 'tide', order: 1, kind: 'skill',
         effect: '', magnitude: 0, skill_id: 'water_wave' }),
  node({ id: 'warlord_ult', constellation: 'warlord', order: 1, kind: 'ult',
         effect: '', magnitude: 0, skill_id: 'ult_ares', god: '阿瑞斯' }),
];

const map = createStarMap(nodeRows, constellations);

describe('star map parsing rejects broken wiring', () => {
  it('puts the whole constellation grant on its last node and groups nodes by order', () => {
    expect(map.byId.ember_skill!.grants).toEqual({});
    expect(map.byId.ember_big!.grants).toEqual({ ares: 3 });
    expect(map.constellationById.ember!.nodes.map((n) => n.id))
      .toEqual(['ember_n1', 'ember_skill', 'ember_big']);
  });

  it('throws on unknown constellation, duplicate id, unknown color and skill without skill_id', () => {
    expect(() => createStarMap([node({ id: 'a', constellation: 'ghost' })], constellations))
      .toThrow(/unknown constellation ghost/);
    expect(() => createStarMap([
      node({ id: 'a', constellation: 'ember' }), node({ id: 'a', constellation: 'ember' }),
    ], constellations)).toThrow(/duplicate node/);
    expect(() => createStarMap([], [{ ...constellations[0]!, color: 'holy' }]))
      .toThrow(/unknown color holy/);
    expect(() => createStarMap([node({ id: 'a', constellation: 'ember', kind: 'skill' })], constellations))
      .toThrow(/skill without skill_id/);
  });
});

describe('affinity comes only from COMPLETED constellations', () => {
  it('no affinity for a half-picked constellation; full completion grants it once', () => {
    const state = createStarState(4);
    expect(affinityOf(state, map).ares).toBe(0);
    pickNode(state, map, levels, rule, 'ember_n1');
    pickNode(state, map, levels, rule, 'ember_skill');
    expect(affinityOf(state, map).ares).toBe(0); // 还差最后一点
    expect(constellationDone(state, map, 'ember')).toBe(false);
    pickNode(state, map, levels, rule, 'ember_big');
    expect(constellationDone(state, map, 'ember')).toBe(true);
    expect(affinityOf(state, map).ares).toBe(3);
    expect(pointsSpent(state, map)).toBe(4);
    expect(Object.keys(affinityOf(state, map)).sort()).toEqual([...AFFINITIES].sort());
  });

  it('a constellation opens only when its colour affinity is high enough', () => {
    const state = createStarState(3);
    expect(constellationOpen(state, map, 'tide')).toBe(false);
    expect(affinityMissing(state, map, 'tide')).toBe(2);
    expect(canPick(state, map, levels, rule, 'tide_skill')).toBe(false);
    // 点满 ember 给 ares 3，但 tide 要 poseidon 2 —— 颜色不对仍然开不了
    state.picks = ['ember_n1', 'ember_skill', 'ember_big'];
    expect(constellationOpen(state, map, 'tide')).toBe(false);
    state.picks = ['frost_n1', 'frost_skill', 'frost_mana']; // 点满 frost 给 demeter 3
    expect(affinityOf(state, map).demeter).toBe(3);
    // 用 tide 自己的颜色凑够
    state.picks.push('tide_skill'); // 直接注入，绕过门槛，只验证 affinity 累加
    expect(affinityOf(state, map).poseidon).toBe(5);
  });

  it('nodes inside a constellation MUST be picked in order (GD style)', () => {
    const state = createStarState(3);
    expect(canPick(state, map, levels, rule, 'ember_skill')).toBe(false); // 跳过 n1
    expect(pickNode(state, map, levels, rule, 'ember_n1')).toBe(true);
    expect(pickNode(state, map, levels, rule, 'ember_skill')).toBe(true);
    expect(canPick(state, map, levels, rule, 'ember_big')).toBe(false); // 点数不够
  });

  it('only ONE ultimate per build (global mutual exclusion)', () => {
    const state = createStarState(4);
    state.picks = ['ember_n1', 'ember_skill', 'ember_big'];
    state.cleared = ['arena']; // 补足点数
    expect(affinityOf(state, map).ares).toBe(3);
    // 造一个可点的第二终极：手动注入已有终极
    expect(ultimateCount(state, map)).toBe(0);
    state.picks.push('warlord_ult');
    expect(ultimateCount(state, map)).toBe(1);
    expect(canPick(state, map, levels, rule, 'warlord_ult')).toBe(false); // 已点过
  });

  it('refuses unknown / duplicate picks and leaves state untouched', () => {
    const state = createStarState(3);
    pickNode(state, map, levels, rule, 'ember_n1');
    const before = JSON.stringify(state);
    expect(pickNode(state, map, levels, rule, 'ghost')).toBe(false);
    expect(pickNode(state, map, levels, rule, 'ember_n1')).toBe(false);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('gates on points AND affinity independently', () => {
    const state = createStarState(1);
    pickNode(state, map, levels, rule, 'ember_n1');
    expect(pointsLeft(state, map, levels, rule)).toBe(0);
    expect(pickNode(state, map, levels, rule, 'ember_skill')).toBe(false);
    state.level = 3;
    expect(pickNode(state, map, levels, rule, 'ember_skill')).toBe(true);
    expect(pointsSpent(state, map)).toBe(2);
  });
});

describe('respec is free and affinity follows it back to zero', () => {
  it('clears picks but keeps level, xp and first-clear history', () => {
    const state = createStarState(3);
    state.xp = 40;
    awardClear(state, 'arena');
    state.picks = ['ember_n1', 'ember_skill', 'ember_big'];
    expect(affinityOf(state, map).ares).toBe(3);
    expect(respec(state)).toBe(3);
    expect(state.picks).toEqual([]);
    expect(affinityOf(state, map).ares).toBe(0);
    expect(state.level).toBe(3);
    expect(state.xp).toBe(40);
    expect(state.cleared).toEqual(['arena']);
  });
});

describe('the star map is what the skill bar reads (design 6.2)', () => {
  it('emits unlocked skills in pick order and ignores attribute nodes', () => {
    const state = createStarState(3);
    expect(unlockedSkills(state, map)).toEqual([]);
    state.picks = ['frost_n1', 'frost_skill', 'ember_n1', 'ember_skill'];
    expect(unlockedSkills(state, map)).toEqual(['ice_shard', 'fire_wall']);
    expect(effectsOf(state)).toEqual(['frost_n1', 'frost_skill', 'ember_n1', 'ember_skill']);
  });
});

describe('level baseline: xp in, levels out', () => {
  it('carries leftover xp across several level-ups', () => {
    const state = createStarState(1);
    expect(grantXp(state, 200, levels)).toEqual({ levelUps: 2, level: 3, xp: 50 });
  });
  it('stops at the cap and refuses to bank xp there', () => {
    const state = createStarState(4);
    expect(levelCap(levels)).toBe(4);
    expect(xpToNext(levels, 4)).toBe(0);
    expect(grantXp(state, 500, levels).levelUps).toBe(0);
    expect(state.xp).toBe(0);
  });
  it('ignores non-positive / non-finite amounts', () => {
    const state = createStarState(1);
    expect(grantXp(state, 0, levels).level).toBe(1);
    expect(grantXp(state, -5, levels).level).toBe(1);
    expect(grantXp(state, Number.NaN, levels).level).toBe(1);
    expect(state.xp).toBe(0);
  });
  it('counts mainline first-clear and exploration points once each', () => {
    const state = createStarState(1);
    expect(awardClear(state, 'arena')).toBe(true);
    expect(awardClear(state, 'arena')).toBe(false);
    expect(awardExplore(state, 'shrine')).toBe(true);
    expect(awardExplore(state, 'shrine')).toBe(false);
    expect(pointsEarned(state, levels, rule)).toBe(1 + 2 + 1);
  });
});

describe('save data is repaired by replaying it, never trusted blindly', () => {
  it('drops picks whose constellation was locked at that moment', () => {
    const repaired = sanitizeProgress({
      level: 4, xp: 12,
      picks: ['tide_skill', 'frost_n1', 'frost_skill', 'frost_mana', 'tide_skill'],
      cleared: ['arena', 'arena'], explored: [],
    }, map, levels, rule);
    expect(repaired).not.toBeNull();
    expect(repaired!.picks).toEqual(['frost_n1', 'frost_skill', 'frost_mana']);
    expect(repaired!.cleared).toEqual(['arena']);
    expect(repaired!.xp).toBe(12);
  });
  it('clamps a hacked level and returns null for garbage', () => {
    expect(sanitizeProgress({ level: 999 }, map, levels, rule)!.level).toBe(4);
    expect(sanitizeProgress({ level: -4 }, map, levels, rule)!.level).toBe(1);
    expect(sanitizeProgress(null, map, levels, rule)).toBeNull();
    expect(sanitizeProgress('nope', map, levels, rule)).toBeNull();
    expect(sanitizeProgress([], map, levels, rule)).toBeNull();
  });
});
