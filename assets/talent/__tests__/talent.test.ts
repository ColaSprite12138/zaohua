import { describe, expect, it } from 'vitest';
import {
  affinityMissing, affinityOf, awardClear, awardExplore, canPick, constellationOpen,
  createStarMap, createStarState, effectsOf, grantXp, levelCap, pickNode, pointsEarned,
  pointsLeft, pointsSpent, respec, sanitizeProgress, unlockedSkills, xpToNext,
  AFFINITIES, type ConstellationRow, type LevelRow, type StarNodeRow, type StarRule,
} from '../index.ts';

/** 夹具：4 个等级 / 4 个星座 / 7 个节点。数值小到能手算，形状与真实表一致。 */
const levels: LevelRow[] = [
  { id: 'lv1', level: 1, xp_to_next: 60, star_points: 1 },
  { id: 'lv2', level: 2, xp_to_next: 90, star_points: 1 },
  { id: 'lv3', level: 3, xp_to_next: 120, star_points: 1 },
  { id: 'lv4', level: 4, xp_to_next: 0, star_points: 1 },
];

const rule: StarRule = { mainline_star_points: 2, explore_star_points: 1 };

const constellations: ConstellationRow[] = [
  { id: 'ember', name: '余烬', color: 'fire', requirement: 0, x: 0, y: 0, hint: '' },
  { id: 'frost', name: '霜牙', color: 'ice', requirement: 0, x: 0, y: 0, hint: '' },
  { id: 'tide', name: '潮汐', color: 'water', requirement: 2, x: 0, y: 0, hint: '' },
  { id: 'warlord', name: '战意', color: 'fire', requirement: 5, x: 0, y: 0, hint: '' },
];

const zeroAff = {
  aff_fire: 0, aff_ice: 0, aff_water: 0, aff_poison: 0, aff_shock: 0, aff_wind: 0,
};

const node = (
  partial: Partial<StarNodeRow> & { id: string; constellation: string },
): StarNodeRow => ({
  name: partial.id,
  kind: 'attribute',
  effect: 'dmg_pct',
  magnitude: 0.05,
  cost: 1,
  skill_id: '',
  hint: '',
  ...zeroAff,
  ...partial,
});

const nodeRows: StarNodeRow[] = [
  node({
    id: 'ember_skill', constellation: 'ember', kind: 'skill', effect: '', magnitude: 0,
    skill_id: 'fire_wall', aff_fire: 2,
  }),
  // 被动是**通用乘区**，绝不写「提升某个技能」（设计 6.3 v7）。
  node({ id: 'ember_dmg', constellation: 'ember', aff_fire: 1, aff_poison: 1 }),
  node({
    id: 'frost_skill', constellation: 'frost', kind: 'skill', effect: '', magnitude: 0,
    skill_id: 'ice_shard', aff_ice: 2,
  }),
  node({ id: 'frost_mana', constellation: 'frost', effect: 'mana_pct', magnitude: 0.1, aff_ice: 1, aff_water: 1 }),
  node({ id: 'frost_range', constellation: 'frost', effect: 'range_px', magnitude: 12, aff_ice: 1, aff_water: 1 }),
  node({
    id: 'tide_skill', constellation: 'tide', kind: 'skill', effect: '', magnitude: 0,
    skill_id: 'water_wave', aff_water: 2,
  }),
  node({ id: 'ember_big', constellation: 'ember', kind: 'passive', magnitude: 0.1, cost: 2, aff_fire: 1 }),
  node({ id: 'warlord_dmg', constellation: 'warlord', kind: 'passive', magnitude: 0.12, cost: 2, aff_fire: 1 }),
];

const map = createStarMap(nodeRows, constellations);

describe('star map parsing rejects broken wiring', () => {
  it('normalizes affinity grants and keeps nodes grouped per constellation', () => {
    expect(map.byId.ember_skill!.grants).toEqual({ fire: 2 });
    expect(map.byId.ember_dmg!.grants).toEqual({ fire: 1, poison: 1 });
    expect(map.constellationById.ember!.nodes.map((n) => n.id))
      .toEqual(['ember_skill', 'ember_dmg', 'ember_big']);
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

describe('affinity is the only gate (design 6.3 v7, Grim Dawn style)', () => {
  it('every node grants affinity; the total is derived, never spent', () => {
    const state = createStarState(3);
    expect(affinityOf(state, map).fire).toBe(0);
    pickNode(state, map, levels, rule, 'ember_skill');
    expect(affinityOf(state, map).fire).toBe(2);
    expect(affinityOf(state, map).poison).toBe(0);
    // 亲和不是货币：点完两点火，点数只少 1，火亲和不会变成 1。
    expect(pointsSpent(state, map)).toBe(1);
    expect(pointsEarned(state, levels, rule)).toBe(3);
    // 六种颜色齐全（UI 直接遍历，不需要在页面里再写一份列表）。
    expect(Object.keys(affinityOf(state, map)).sort()).toEqual([...AFFINITIES].sort());
  });

  it('a constellation opens only when its colour affinity is high enough', () => {
    const state = createStarState(3);
    expect(constellationOpen(state, map, 'tide')).toBe(false);
    expect(affinityMissing(state, map, 'tide')).toBe(2);
    expect(canPick(state, map, levels, rule, 'tide_skill')).toBe(false);
    pickNode(state, map, levels, rule, 'frost_mana'); // 水 +1
    expect(constellationOpen(state, map, 'tide')).toBe(false);
    expect(affinityMissing(state, map, 'tide')).toBe(1);
    pickNode(state, map, levels, rule, 'frost_range'); // 水 +1
    expect(affinityMissing(state, map, 'tide')).toBe(0);
    expect(constellationOpen(state, map, 'tide')).toBe(true);
    expect(pickNode(state, map, levels, rule, 'tide_skill')).toBe(true);
  });

  it('there is NO node-to-node prerequisite: order inside a constellation is free', () => {
    const state = createStarState(3);
    // 先点「后排」节点，再点「前排」技能 —— 旧版本（requires）会拒绝，现在必须允许。
    expect(pickNode(state, map, levels, rule, 'ember_dmg')).toBe(true);
    expect(pickNode(state, map, levels, rule, 'ember_skill')).toBe(true);
    expect(canPick(state, map, levels, rule, 'warlord_dmg')).toBe(false); // 火 3 < 5
    expect(affinityOf(state, map).fire).toBe(3);
  });

  it('refuses unknown / duplicate picks and leaves state untouched', () => {
    const state = createStarState(3);
    pickNode(state, map, levels, rule, 'ember_dmg');
    const before = JSON.stringify(state);
    expect(pickNode(state, map, levels, rule, 'ghost')).toBe(false);
    expect(pickNode(state, map, levels, rule, 'ember_dmg')).toBe(false);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('gates on points AND affinity independently', () => {
    const state = createStarState(1);
    pickNode(state, map, levels, rule, 'ember_skill');
    expect(pointsLeft(state, map, levels, rule)).toBe(0);
    expect(pickNode(state, map, levels, rule, 'ember_big')).toBe(false); // 2 点的节点差 1 点

    state.level = 3; // 3 点，已花 1
    expect(pickNode(state, map, levels, rule, 'ember_big')).toBe(true);
    expect(pointsLeft(state, map, levels, rule)).toBe(0);
    expect(pointsSpent(state, map)).toBe(3);

    state.cleared = ['arena']; // +2 首通 → 2 点余额
    expect(pointsLeft(state, map, levels, rule)).toBe(2);
    // 有点数但火亲和只有 3（< 5）：卡在亲和，不是点数。两道门互不替代。
    expect(affinityOf(state, map).fire).toBe(3);
    expect(pickNode(state, map, levels, rule, 'warlord_dmg')).toBe(false);
  });
});

describe('respec is free and affinity follows it back to zero', () => {
  it('clears picks but keeps level, xp and first-clear history', () => {
    const state = createStarState(3);
    state.xp = 40;
    awardClear(state, 'arena');
    pickNode(state, map, levels, rule, 'ember_skill');
    pickNode(state, map, levels, rule, 'ember_dmg');
    expect(affinityOf(state, map).fire).toBe(3);
    expect(respec(state)).toBe(2);
    expect(state.picks).toEqual([]);
    expect(affinityOf(state, map).fire).toBe(0); // 亲和是算出来的，洗点即归零
    expect(state.level).toBe(3);
    expect(state.xp).toBe(40);
    expect(state.cleared).toEqual(['arena']);
    expect(pointsLeft(state, map, levels, rule)).toBe(5);
  });
});

describe('the star map is what the skill bar reads (design 6.2)', () => {
  it('emits unlocked skills in pick order and ignores passive nodes', () => {
    const state = createStarState(3);
    expect(unlockedSkills(state, map)).toEqual([]); // 没点就是空手
    pickNode(state, map, levels, rule, 'frost_skill');
    pickNode(state, map, levels, rule, 'ember_skill');
    expect(unlockedSkills(state, map)).toEqual(['ice_shard', 'fire_wall']);
    expect(effectsOf(state)).toEqual(['frost_skill', 'ember_skill']);
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
      level: 4, // 4 点
      xp: 12,
      picks: ['tide_skill', 'frost_mana', 'frost_range', 'tide_skill'],
      cleared: ['arena', 'arena'],
      explored: [],
    }, map, levels, rule);
    expect(repaired).not.toBeNull();
    // tide_skill 排在最前面时水亲和是 0 → 丢；第二条重复也不再生效。
    expect(repaired!.picks).toEqual(['frost_mana', 'frost_range']);
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
