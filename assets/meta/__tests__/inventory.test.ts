import { describe, expect, it } from 'vitest';
import {
  BAG,
  CONTAINERS,
  EQUIP_SLOTS,
  ITEM_DEFS,
  STASH,
  activeWeapon,
  addToBag,
  canPlace,
  findFirstFit,
  coveredCells,
  createInventoryState,
  equipItem,
  findItem,
  moveItem,
  placeItem,
  removeItem,
  setActiveWeapon,
  unequipItem,
} from '../inventory.ts';

const at = (
  state: ReturnType<typeof createInventoryState>,
  uid: string,
  container: 'bag' | 'stash',
) => (container === 'bag' ? state.bag : state.stash).find((it) => it.uid === uid);

describe('grid dimensions', () => {
  it('bag is 5x8 (40 cells) and stash is 16x10 (160 cells)', () => {
    expect([BAG.cols, BAG.rows]).toEqual([5, 8]);
    expect([STASH.cols, STASH.rows]).toEqual([16, 10]);
    expect(BAG.cols * BAG.rows).toBe(40);
    expect(STASH.cols * STASH.rows).toBe(160);
    expect(CONTAINERS.bag).toBe(BAG);
    expect(CONTAINERS.stash).toBe(STASH);
  });

  it('a longsword occupies 2 cols x 3 rows = 6 cells', () => {
    expect([ITEM_DEFS.longsword!.cols, ITEM_DEFS.longsword!.rows]).toEqual([2, 3]);
    const s = createInventoryState(1);
    expect(placeItem(s, 'sword-1', 'bag', 0, 0)).toBe(true);
    expect(coveredCells(at(s, 'sword-1', 'bag')!)).toHaveLength(6);
  });

  it('exposes exactly ten equipment slots with two hotkeyed weapons', () => {
    expect(EQUIP_SLOTS).toHaveLength(10);
    expect(EQUIP_SLOTS.filter((x) => x.accepts === 'weapon')).toHaveLength(2);
    expect(EQUIP_SLOTS.filter((x) => x.accepts === 'ring')).toHaveLength(2);
    expect(EQUIP_SLOTS.map((x) => x.hotkey).filter(Boolean)).toEqual(['1', '2']);
    expect(new Set(EQUIP_SLOTS.map((x) => x.id)).size).toBe(10);
  });
});

describe('placement', () => {
  it('rejects out-of-bounds placements without mutating state', () => {
    const s = createInventoryState(1);
    expect(canPlace(s, 'bag', 'longsword', 4, 0)).toBe(false); // 4+2 > 5
    expect(canPlace(s, 'bag', 'longsword', 0, 6)).toBe(false); // 6+3 > 8
    expect(canPlace(s, 'bag', 'longsword', -1, 0)).toBe(false);
    expect(canPlace(s, 'bag', 'longsword', 1.5, 0)).toBe(false);
    expect(placeItem(s, 'sword-1', 'bag', 4, 0)).toBe(false);
    expect(s.bag).toHaveLength(0);
    expect(s.stash).toHaveLength(1);
  });

  it('rejects rectangular overlap, including partial overlap', () => {
    const s = createInventoryState(2);
    expect(placeItem(s, 'sword-1', 'bag', 0, 0)).toBe(true); // cols 0-1, rows 0-2
    expect(canPlace(s, 'bag', 'longsword', 1, 2)).toBe(false); // corner overlap
    expect(canPlace(s, 'bag', 'longsword', 2, 0)).toBe(true); // adjacent, no overlap
    expect(canPlace(s, 'bag', 'longsword', 0, 3)).toBe(true); // below, no overlap
    expect(placeItem(s, 'sword-2', 'bag', 1, 2)).toBe(false);
    expect(s.bag).toHaveLength(1);
    expect(s.stash).toHaveLength(1);
  });

  it('moves an item inside the same container using its own uid as ignore', () => {
    const s = createInventoryState(1);
    placeItem(s, 'sword-1', 'bag', 0, 0);
    expect(moveItem(s, 'sword-1', 'bag', 3, 5)).toBe(true);
    expect(at(s, 'sword-1', 'bag')).toMatchObject({ col: 3, row: 5 });
    expect(s.bag).toHaveLength(1);
  });

  it('drags items between bag and stash in both directions', () => {
    const s = createInventoryState(1);
    expect(placeItem(s, 'sword-1', 'bag', 1, 1)).toBe(true);
    expect(moveItem(s, 'sword-1', 'stash', 14, 7)).toBe(true);
    expect(s.bag).toHaveLength(0);
    expect(at(s, 'sword-1', 'stash')).toMatchObject({ container: 'stash', col: 14, row: 7 });
    expect(moveItem(s, 'sword-1', 'bag', 0, 0)).toBe(true);
    expect(s.stash).toHaveLength(0);
    expect(at(s, 'sword-1', 'bag')).toMatchObject({ container: 'bag', col: 0, row: 0 });
  });

  it('removeItem drops a run-loot uid and refuses unknown uids', () => {
    const s = createInventoryState(1);
    expect(addToBag(s, 'loot-1', 'longsword')).not.toBeNull();
    expect(s.bag).toHaveLength(1);
    expect(removeItem(s, 'loot-1')).toBe(true);
    expect(s.bag).toHaveLength(0);
    expect(removeItem(s, 'ghost')).toBe(false);
    expect(placeItem(s, 'ghost', 'bag', 0, 0)).toBe(false);
    expect(findItem(s, 'ghost')).toBeNull();
  });
});

describe('three storage areas only', () => {
  it('starts with three swords in the stash and no fourth container', () => {
    const s = createInventoryState(3);
    expect(s.bag).toHaveLength(0);
    expect(s.stash).toHaveLength(3);
    expect(s.stash.map((i) => [i.col, i.row])).toEqual([[0, 0], [2, 0], [4, 0]]);
    expect('loose' in s).toBe(false);
  });

  it('addToBag occupies cells and reports a full bag instead of hiding items', () => {
    const s = createInventoryState(0);
    const placed = [0, 1, 2, 3].map((i) => addToBag(s, `loot-${i}`, 'longsword'));
    expect(placed.every((p) => p !== null)).toBe(true);
    expect(s.bag).toHaveLength(4);
    expect(addToBag(s, 'loot-overflow', 'longsword')).toBeNull();
    expect(s.bag).toHaveLength(4);
    expect(findFirstFit(s, 'longsword')?.container).toBe('stash');
  });
});

describe('equipment', () => {
  it('equips a longsword only into weapon slots', () => {
    const s = createInventoryState(1);
    expect(equipItem(s, 'sword-1', 2)).toBe(false); // ring slot
    expect(s.equipped[2]).toBeNull();
    expect(equipItem(s, 'sword-1', 0)).toBe(true);
    expect(s.equipped[0]).toMatchObject({ uid: 'sword-1' });
    expect(s.stash).toHaveLength(0);
  });

  it('equips directly from a grid cell and unequips back to a chosen cell', () => {
    const s = createInventoryState(1);
    placeItem(s, 'sword-1', 'bag', 0, 0);
    expect(equipItem(s, 'sword-1', 1)).toBe(true);
    expect(s.bag).toHaveLength(0);
    expect(unequipItem(s, 1, 'stash', 5, 5)).toBe(true);
    expect(s.equipped[1]).toBeNull();
    expect(at(s, 'sword-1', 'stash')).toMatchObject({ col: 5, row: 5 });
  });

  it('rejects an unequip when the destination cannot fit', () => {
    const s = createInventoryState(1);
    equipItem(s, 'sword-1', 0);
    expect(unequipItem(s, 0, 'bag', 4, 7)).toBe(false);
    expect(s.equipped[0]).toMatchObject({ uid: 'sword-1' });
    expect(s.bag).toHaveLength(0);
  });

  it('swapping an occupied slot never loses the displaced item', () => {
    const s = createInventoryState(2);
    placeItem(s, 'sword-1', 'bag', 0, 0);
    equipItem(s, 'sword-1', 0);
    // sword-2 comes from the stash; the displaced sword must land in a grid.
    expect(equipItem(s, 'sword-2', 0)).toBe(true);
    expect(s.equipped[0]).toMatchObject({ uid: 'sword-2' });
    expect(findItem(s, 'sword-1')?.where).toBe('grid');
    expect(s.bag.length + s.stash.length + s.equipped.filter(Boolean).length).toBe(2);
  });
});

describe('active weapon (1 / 2)', () => {
  it('starts on slot 1 and only the active weapon is exposed', () => {
    const s = createInventoryState(2);
    expect(s.activeWeaponSlot).toBe(0);
    equipItem(s, 'sword-1', 0);
    equipItem(s, 'sword-2', 1);
    expect(s.equipped[0]).not.toBeNull();
    expect(s.equipped[1]).not.toBeNull();
    expect(activeWeapon(s)?.uid).toBe('sword-1');
    expect(setActiveWeapon(s, 1)).toBe(1);
    expect(activeWeapon(s)?.uid).toBe('sword-2');
    expect(setActiveWeapon(s, 0)).toBe(0);
    expect(activeWeapon(s)?.uid).toBe('sword-1');
  });

  it('switching to an empty slot means bare hands (null)', () => {
    const s = createInventoryState(1);
    equipItem(s, 'sword-1', 0);
    setActiveWeapon(s, 1);
    expect(activeWeapon(s)).toBeNull();
    setActiveWeapon(s, 0);
    expect(activeWeapon(s)?.defId).toBe('longsword');
  });
});
