import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildLoadout, createInventoryState, equipItem, findItem,
  itemDef, registerItemDefs, settleRun, EQUIP_SLOTS,
  type InventoryState,
} from '../inventory.ts';

const AUTHORED = [
  { id: '10001', name: '巨剑', quality: '白', damage_min: 10, damage_max: 15 },
  { id: '10006', name: '霜之哀伤', quality: '暗金', damage_min: 250, damage_max: 400 },
  { id: '20006', name: '射日', quality: '暗金', damage_min: 250, damage_max: 400 },
];

describe('authored item catalog', () => {
  it('registers table ids without overwriting the demo longsword', () => {
    expect(registerItemDefs(AUTHORED)).toBe(3);
    expect(registerItemDefs(AUTHORED)).toBe(0);
    expect(itemDef('10006').name).toBe('霜之哀伤');
    expect(itemDef('10006').cols).toBe(2);
    expect(itemDef('10006').rows).toBe(3);
    expect(itemDef('10006').equip).toBe('weapon');
    expect(itemDef('longsword').name).toBe('长剑');
    expect(itemDef('20006').glyph).toBe('➶');
    expect(itemDef('10001').color).toBe('#dbe9f5');
  });
});

describe('standard extraction-shooter settlement', () => {
  let state: InventoryState;
  beforeEach(() => {
    registerItemDefs(AUTHORED);
    state = createInventoryState(2);
    expect(equipItem(state, 'sword-1', 0)).toBe(true);
  });

  it('buildLoadout borrows only weapon slots, leaving armour at home', () => {
    const loan = buildLoadout(state);
    expect(loan.items).toHaveLength(1);
    expect(loan.armedWeapons).toBe(1);
    expect(loan.items[0]!.defId).toBe('longsword');
    expect(state.equipped[0]).toBeNull();
    expect(findItem(state, 'sword-1')).toBeNull();
    expect(state.loose).toHaveLength(1);
    expect(EQUIP_SLOTS).toHaveLength(10);
  });

  it('cleared returns borrowed weapons and banks authored loot', () => {
    const loan = buildLoadout(state);
    const report = settleRun(state, loan, {
      outcome: 'cleared', lootItemIds: ['10006', '20006'],
    });
    expect(report).toEqual({
      returned: 1, lost: 0, gained: 2, unregistered: [], overflow: [],
    });
    expect(state.equipped[0]?.uid).toBe('sword-1');
    expect(state.bag).toHaveLength(2);
    expect(state.bag.map((i) => i.defId).sort()).toEqual(['10006', '20006']);
  });

  it('gameOver permanently loses borrowed weapons and loot', () => {
    const loan = buildLoadout(state);
    const report = settleRun(state, loan, {
      outcome: 'gameOver', lootItemIds: ['10006'],
    });
    expect(report).toEqual({
      returned: 0, lost: 1, gained: 0, unregistered: [], overflow: [],
    });
    expect(state.equipped[0]).toBeNull();
    expect(state.bag).toHaveLength(0);
    expect(state.loose).toHaveLength(1); // only the spare demo sword
  });

  it('unknown loot ids are reported, never silently dropped', () => {
    const loan = buildLoadout(state);
    const report = settleRun(state, loan, {
      outcome: 'cleared', lootItemIds: ['99999', '10001'],
    });
    expect(report.unregistered).toEqual(['99999']);
    expect(report.gained).toBe(1);
    expect(state.bag.map((i) => i.defId)).toEqual(['10001']);
  });

  it('a full bag spills loot into the stash, then the loose tray', () => {
    const loan = buildLoadout(state);
    // 5x8 bag holds at most 4 of the 2x3 items per row-pair; stash 16x10 holds
    // far more. Push 30 items so both grids overflow.
    const ids = Array.from({ length: 30 }, () => '10001');
    const report = settleRun(state, loan, { outcome: 'cleared', lootItemIds: ids });
    expect(report.gained).toBe(30);
    const total = state.bag.length + state.stash.length + state.loose.length;
    // 1 spare demo sword + 30 loot items, none discarded.
    expect(total).toBe(31);
    expect(report.overflow.length).toBeGreaterThan(0);
  });

  it('two borrowed weapons both come home on a clear', () => {
    expect(equipItem(state, 'sword-2', 1)).toBe(true);
    const loan = buildLoadout(state);
    expect(loan.armedWeapons).toBe(2);
    const report = settleRun(state, loan, { outcome: 'cleared', lootItemIds: [] });
    expect(report.returned).toBe(2);
    expect(state.equipped[0]?.uid).toBe('sword-1');
    expect(state.equipped[1]?.uid).toBe('sword-2');
  });
});
