import { describe, expect, it } from 'vitest';
import {
  addItem, canEnter, createInventory, createProgress, createWallet,
  credit, removeItem, spend, usedSlots, type MetaNode,
} from '../index.ts';

describe('meta wallet', () => {
  it('rejects non-positive / non-finite credits and overspending', () => {
    const w = createWallet();
    expect(credit(w, 'gold', 0)).toBe(false);
    expect(credit(w, 'gold', Number.NaN)).toBe(false);
    expect(spend(w, 'gold', 10)).toBe(false);
    expect(credit(w, 'gold', 10)).toBe(true);
    expect(spend(w, 'gold', 4)).toBe(true);
    expect(w.balances.gold).toBe(6);
    expect(spend(w, 'gold', 7)).toBe(false);
  });
});

describe('meta inventory', () => {
  it('respects capacity and removes empty slots', () => {
    const inv = createInventory(3);
    expect(addItem(inv, 'longsword', 2)).toBe(true);
    expect(usedSlots(inv)).toBe(2);
    expect(addItem(inv, 'potion', 2)).toBe(false);
    expect(removeItem(inv, 'longsword', 2)).toBe(true);
    expect(inv.slots.longsword).toBeUndefined();
    expect(usedSlots(inv)).toBe(0);
  });
});

describe('meta progression / battle entry', () => {
  const node: MetaNode = {
    id: 'node-2', stageId: 'stage-2', requires: ['node-1'], cost: { currency: 'ticket', amount: 1 },
  };

  it('requires unlocked prerequisites and the entry fee', () => {
    const w = createWallet();
    const p = createProgress('node-1');
    expect(canEnter(p, node, w)).toBe(false);
    credit(w, 'ticket', 1);
    expect(canEnter(p, node, w)).toBe(true);
    expect(canEnter(createProgress('other'), node, w)).toBe(false);
  });
});
