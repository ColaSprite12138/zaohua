import { beforeEach, describe, expect, it } from 'vitest';
import {
  INSURED_GIFT, addToBag, bringBack, createInventoryState, equipItem, insuredCells,
  insuredRect, isInsuredItem, loadoutFromRun, normalizeInsured, placeItem,
  registerItemDefs, runInventoryFrom, splitOnDeath, takeIntoRun, unequipItem,
  type InventoryState,
} from '../inventory.ts';

/**
 * 保险格（设计 4）：死亡掉落范围是「已穿戴 10 个槽 + 背包全部，保险格除外」。
 * 这几条断言守住三件事：格子是谁的、什么算「整件在格子里」、阵亡怎么切账。
 */

const AUTHORED = [
  { id: '30002', name: '红药', item_type: '消耗品', quality: '白' },
  { id: '30003', name: '蓝药', item_type: '消耗品', quality: '白' },
  { id: '10006', name: '霜之哀伤', quality: '暗金', damage_min: 250, damage_max: 400 },
];

function potion(state: InventoryState, uid: string, col: number, row: number): void {
  const placed = addToBag(state, uid, '30002');
  expect(placed).not.toBeNull();
  expect(placeItem(state, uid, 'bag', col, row)).toBe(true);
}

describe('保险格：背包左上角 1x2（赠送）', () => {
  beforeEach(() => {
    registerItemDefs(AUTHORED);
  });

  it('the gift is one column by two rows at the bag origin', () => {
    const s = createInventoryState(0);
    expect(insuredRect(s)).toEqual({ col: 0, row: 0, cols: 1, rows: 2 });
    expect(INSURED_GIFT).toEqual({ col: 0, row: 0, cols: 1, rows: 2 });
    expect(insuredCells(s)).toEqual([{ col: 0, row: 0 }, { col: 0, row: 1 }]);
  });

  it('a v1/v2 save without the field falls back to the gift instead of throwing', () => {
    const legacy = { ...createInventoryState(0), insured: undefined } as InventoryState;
    expect(insuredRect(legacy)).toEqual(INSURED_GIFT);
    // 垃圾数据也夹回包内，不会造出越界的格子
    legacy.insured = { col: -3, row: 99, cols: 99, rows: 99 };
    const fixed = normalizeInsured(legacy);
    expect(fixed.cols).toBeLessThanOrEqual(5);
    expect(fixed.row + fixed.rows).toBeLessThanOrEqual(8);
  });

  it('only an item FULLY inside the region counts as insured', () => {
    const s = createInventoryState(0);
    potion(s, 'p1', 0, 0);
    potion(s, 'p2', 1, 0);
    const inside = s.bag.find((it) => it.uid === 'p1')!;
    const outside = s.bag.find((it) => it.uid === 'p2')!;
    expect(isInsuredItem(s, inside)).toBe(true);
    expect(isInsuredItem(s, outside)).toBe(false);

    // 2x3 的武器不可能整件塞进 1x2：半截露在外面的物品不享受保险
    const demo = createInventoryState(1);
    expect(placeItem(demo, 'sword-1', 'bag', 0, 0)).toBe(true);
    expect(isInsuredItem(demo, demo.bag[0]!)).toBe(false);
  });

  it('splitOnDeath keeps insured bag items and loses every worn slot', () => {
    const s = createInventoryState(1);
    expect(equipItem(s, 'sword-1', 0)).toBe(true);
    potion(s, 'keep-me', 0, 1);
    expect(addToBag(s, 'lose-me', '10006')).not.toBeNull();

    const { kept, lost } = splitOnDeath(s);
    expect(kept.bag.map((i) => i.uid)).toEqual(['keep-me']);
    expect(kept.bag[0]!.col).toBe(0);
    expect(kept.bag[0]!.row).toBe(1);
    // 保险格只保背包：穿在身上的长剑一样掉
    expect(kept.equipped.every((slot) => slot === null)).toBe(true);
    expect(lost.map((i) => i.defId).sort()).toEqual(['10006', 'longsword']);
    // 纯函数：原状态不动
    expect(s.bag).toHaveLength(2);
    expect(s.equipped[0]?.uid).toBe('sword-1');
  });

  it('the insured rect travels into the run and back with the loadout', () => {
    const lobby = createInventoryState(0);
    lobby.insured = { col: 0, row: 0, cols: 2, rows: 2 }; // 扩容后的形状
    const loadout = takeIntoRun(lobby);
    expect(loadout.insured).toEqual({ col: 0, row: 0, cols: 2, rows: 2 });
    const run = runInventoryFrom(loadout);
    expect(insuredCells(run)).toHaveLength(4);
    bringBack(lobby, loadoutFromRun(run));
    expect(lobby.insured).toEqual({ col: 0, row: 0, cols: 2, rows: 2 });
  });

  it('a worn weapon keeps its durability when dragged through the bag', () => {
    // 2026-11-15 深夜：`detach()` 以前只留 uid/defId，拖一次就把耐久修满（5.2 的出口被抹掉）。
    const s = createInventoryState(1);
    expect(equipItem(s, 'sword-1', 0)).toBe(true);
    s.equipped[0] = { uid: 'sword-1', defId: 'longsword', durability: 12 };
    expect(unequipItem(s, 0, 'bag', 2, 3)).toBe(true);
    expect(s.bag[0]!.durability).toBe(12);
    expect(equipItem(s, 'sword-1', 0)).toBe(true);
    expect(s.equipped[0]!.durability).toBe(12);
  });
});
