import { describe, expect, it } from 'vitest';
import {
  createLoadout, lock, pick, type TalentTree,
} from '../index.ts';

const tree: TalentTree = {
  nodes: [
    { id: 't1', name: '锋刃', requires: [], effectId: 'combat.damage+', cost: 1 },
    { id: 't2', name: '长臂', requires: ['t1'], effectId: 'combat.range+', cost: 2 },
  ],
};

describe('talent selection (out-of-run only)', () => {
  it('validates prerequisites, duplicates and budget', () => {
    const loadout = createLoadout();
    expect(pick(loadout, tree, 't2', 5)).toBe(false); // prerequisite missing
    expect(pick(loadout, tree, 'unknown', 5)).toBe(false);
    expect(pick(loadout, tree, 't1', 5)).toBe(true);
    expect(pick(loadout, tree, 't1', 5)).toBe(false); // duplicate
    expect(loadout.pointsSpent).toBe(1);
    expect(pick(loadout, tree, 't2', 2)).toBe(false); // over budget
    expect(pick(loadout, tree, 't2', 3)).toBe(true);
  });

  it('locking freezes the loadout and emits effect ids for combat', () => {
    const loadout = createLoadout();
    pick(loadout, tree, 't1', 3);
    const ids = lock(loadout);
    expect(ids).toEqual(['combat.damage+']);
    expect(loadout.locked).toBe(true);
    expect(pick(loadout, tree, 't2', 10)).toBe(false);
    expect(loadout.effectIds).toEqual(['combat.damage+']);
  });

  it('emits ids, never concrete damage or range numbers', () => {
    const loadout = createLoadout();
    pick(loadout, tree, 't1', 3);
    pick(loadout, tree, 't2', 3);
    expect(loadout.effectIds).toEqual(['combat.damage+', 'combat.range+']);
    expect(loadout.effectIds.every((id) => typeof id === 'string')).toBe(true);
  });
});
