import { describe, expect, it } from 'vitest';
import {
  awardClear, awardExplore, canPick, createStarState, createStarTree, effectsOf,
  grantXp, levelCap, pickNode, pointsEarned, pointsLeft, pointsSpent,
  prerequisitesMet, respec, sanitizeProgress, unlockedSkills, xpToNext,
  type LevelRow, type StarNodeRow, type StarRule,
} from '../index.ts';

/** 夹具：三个等级 / 一棵 4 节点的小星图（真实表的形状，数值小到能手算）。 */
const levels: LevelRow[] = [
  { id: 'lv1', level: 1, xp_to_next: 60, star_points: 1 },
  { id: 'lv2', level: 2, xp_to_next: 90, star_points: 1 },
  { id: 'lv3', level: 3, xp_to_next: 120, star_points: 1 },
  { id: 'lv4', level: 4, xp_to_next: 0, star_points: 1 },
];

const rule: StarRule = { mainline_star_points: 2, explore_star_points: 1 };

const node = (partial: Partial<StarNodeRow> & { id: string }): StarNodeRow => ({
  name: partial.id,
  tier: 0,
  requires: '',
  kind: 'attribute',
  effect: 'dmg_pct',
  magnitude: 0.05,
  cost: 1,
  x: 0,
  y: 0,
  skill_id: '',
  hint: '',
  ...partial,
});

const rows: StarNodeRow[] = [
  node({ id: 'core' }),
  node({ id: 'cleave', kind: 'skill', skill_id: 'cleave', requires: 'core', magnitude: 0 }),
  node({ id: 'charge', kind: 'skill', skill_id: 'charge', requires: 'core', magnitude: 0 }),
  node({ id: 'capstone', requires: 'cleave,charge', cost: 3, magnitude: 0.12 }),
];
const tree = createStarTree(rows);

describe('star tree parsing rejects broken wiring', () => {
  it('parses comma-separated prerequisites', () => {
    expect(tree.byId.capstone!.requires).toEqual(['cleave', 'charge']);
    expect(tree.byId.core!.requires).toEqual([]);
  });

  it('throws on unknown prerequisite, duplicate id and skill without skill_id', () => {
    expect(() => createStarTree([node({ id: 'a', requires: 'ghost' })]))
      .toThrow(/requires unknown ghost/);
    expect(() => createStarTree([node({ id: 'a' }), node({ id: 'a' })]))
      .toThrow(/duplicate/);
    expect(() => createStarTree([node({ id: 'a', kind: 'skill' })]))
      .toThrow(/skill without skill_id/);
  });
});

describe('star points come from levels and one-off clears', () => {
  it('accumulates one point per level reached', () => {
    const state = createStarState(1);
    expect(pointsEarned(state, levels, rule)).toBe(1);
    state.level = 3;
    expect(pointsEarned(state, levels, rule)).toBe(3);
  });

  it('adds mainline first-clear and exploration points, once each', () => {
    const state = createStarState(1);
    expect(awardClear(state, 'arena')).toBe(true);
    expect(awardClear(state, 'arena')).toBe(false); // 重复首通不给点
    expect(awardExplore(state, 'shrine')).toBe(true);
    expect(awardExplore(state, 'shrine')).toBe(false);
    expect(awardClear(state, '')).toBe(false);
    // 1 级 1 点 + 首通 2 点 + 探索 1 点
    expect(pointsEarned(state, levels, rule)).toBe(4);
  });
});

describe('picking respects path constraints and budget', () => {
  it('requires the prerequisite to be lit first', () => {
    const state = createStarState(3);
    expect(prerequisitesMet(state, tree, 'cleave')).toBe(false);
    expect(canPick(state, tree, levels, rule, 'cleave')).toBe(false);
    expect(pickNode(state, tree, levels, rule, 'cleave')).toBe(false);
    expect(pickNode(state, tree, levels, rule, 'core')).toBe(true);
    expect(pickNode(state, tree, levels, rule, 'cleave')).toBe(true);
  });

  it('rejects unknown and duplicate picks without changing state', () => {
    const state = createStarState(3);
    pickNode(state, tree, levels, rule, 'core');
    const before = JSON.stringify(state);
    expect(pickNode(state, tree, levels, rule, 'ghost')).toBe(false);
    expect(pickNode(state, tree, levels, rule, 'core')).toBe(false);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('stops at the budget: a 3-point capstone needs 3 spare points', () => {
    const state = createStarState(1); // 只有 1 点
    pickNode(state, tree, levels, rule, 'core');
    expect(pointsLeft(state, tree, levels, rule)).toBe(0);
    expect(pickNode(state, tree, levels, rule, 'cleave')).toBe(false);

    state.level = 3; // 3 点
    expect(pickNode(state, tree, levels, rule, 'cleave')).toBe(true);
    expect(pickNode(state, tree, levels, rule, 'charge')).toBe(true);
    expect(pointsLeft(state, tree, levels, rule)).toBe(0);
    expect(pickNode(state, tree, levels, rule, 'capstone')).toBe(false);

    state.cleared = ['arena', 'shrine-run']; // 两个首通 = +4 点
    expect(pickNode(state, tree, levels, rule, 'capstone')).toBe(true);
    expect(pointsSpent(state, tree)).toBe(6);
    expect(pointsEarned(state, levels, rule)).toBe(3 + 4);
  });
});

describe('respec is free and only refunds points', () => {
  it('clears picks but keeps level, xp and first-clear history', () => {
    const state = createStarState(3);
    state.xp = 40;
    awardClear(state, 'arena');
    pickNode(state, tree, levels, rule, 'core');
    pickNode(state, tree, levels, rule, 'cleave');
    expect(respec(state)).toBe(2);
    expect(state.picks).toEqual([]);
    expect(state.level).toBe(3);
    expect(state.xp).toBe(40);
    expect(state.cleared).toEqual(['arena']);
    expect(pointsLeft(state, tree, levels, rule)).toBe(5);
  });
});

describe('the star map is what the skill bar reads (design 6.2)', () => {
  it('emits unlocked skills in pick order and ignores non-skill nodes', () => {
    const state = createStarState(3);
    expect(unlockedSkills(state, tree)).toEqual([]); // 没点就是空手
    pickNode(state, tree, levels, rule, 'core');
    pickNode(state, tree, levels, rule, 'charge');
    pickNode(state, tree, levels, rule, 'cleave');
    expect(unlockedSkills(state, tree)).toEqual(['charge', 'cleave']);
    expect(effectsOf(state)).toEqual(['core', 'charge', 'cleave']);
  });
});

describe('level baseline: xp in, levels out', () => {
  it('carries leftover xp across several level-ups', () => {
    const state = createStarState(1);
    // 1 级需要 60，2 级需要 90：一次 200 点升两级并余 50。
    const result = grantXp(state, 200, levels);
    expect(result).toEqual({ levelUps: 2, level: 3, xp: 50 });
  });

  it('stops at the cap and refuses to bank xp there', () => {
    const state = createStarState(4);
    expect(levelCap(levels)).toBe(4);
    expect(xpToNext(levels, 4)).toBe(0);
    const result = grantXp(state, 500, levels);
    expect(result.levelUps).toBe(0);
    expect(state.level).toBe(4);
    expect(state.xp).toBe(0);
  });

  it('ignores non-positive / non-finite amounts', () => {
    const state = createStarState(1);
    expect(grantXp(state, 0, levels).level).toBe(1);
    expect(grantXp(state, -5, levels).level).toBe(1);
    expect(grantXp(state, Number.NaN, levels).level).toBe(1);
    expect(state.xp).toBe(0);
  });
});

describe('save data is repaired, never trusted blindly', () => {
  it('drops unknown nodes, prereq-less nodes and over-budget picks', () => {
    const repaired = sanitizeProgress({
      level: 2, // 2 点
      xp: 12,
      picks: ['cleave', 'ghost', 'core', 'capstone'],
      cleared: ['arena', 'arena'],
      explored: [],
    }, tree, levels, rule);
    expect(repaired).not.toBeNull();
    // cleave 没有 core → 丢；ghost 未知 → 丢；core 保留；capstone 超出预算 → 丢。
    expect(repaired!.picks).toEqual(['core']);
    expect(repaired!.cleared).toEqual(['arena']);
    expect(repaired!.level).toBe(2);
    expect(repaired!.xp).toBe(12);
  });

  it('clamps a hacked level to the table and returns null for garbage', () => {
    expect(sanitizeProgress({ level: 999 }, tree, levels, rule)!.level).toBe(4);
    expect(sanitizeProgress({ level: -4 }, tree, levels, rule)!.level).toBe(1);
    expect(sanitizeProgress(null, tree, levels, rule)).toBeNull();
    expect(sanitizeProgress('nope', tree, levels, rule)).toBeNull();
    expect(sanitizeProgress([], tree, levels, rule)).toBeNull();
  });
});
