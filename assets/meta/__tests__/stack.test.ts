import { describe, expect, it } from 'vitest';
import {
  BAG,
  SAFE,
  SAFE_MAX_COLS,
  addToBag,
  bagHasRoomFor,
  bringBack,
  canPlace,
  containerSpec,
  countOf,
  createInventoryState,
  itemCount,
  itemDef,
  normalizeContainers,
  normalizeStackCounts,
  placeItem,
  registerItemDefs,
  safeColsOf,
  setSafeCols,
  takeFromStack,
  takeIntoRun,
  takeOneFromBag,
} from '../inventory.ts';

/**
 * 堆叠（设计 5.1）+ 保险格扩容（设计 5.2）。
 *
 * 这里守的五件事：
 * 1. `item.xlsx::stack_size` 真的被用上了（不然箭 / 药 / 收藏品仍是一件一格）；
 * 2. **带实例属性的东西不叠**（词条 / 耐久 / 掷定伤害）—— 合起来就分不出来了；
 * 3. 取一件 = 一叠里扣 1，扣到 0 才删格（不然一箭打光 10 支）；
 * 4. 跨堆（出征 / 带回）时数量跟着物品走；
 * 5. 保险格扩容只写在状态上，`SAFE` 常量不动。
 */

function fresh() {
  const state = createInventoryState(0);
  registerItemDefs([
    // 与 `item.xlsx` 同形：弹药 10 / 消耗品 5 / 武器 1 / 收藏品 3。
    { id: '30001', name: '弓箭', item_type: '弹药', stack_size: 10 },
    { id: '30002', name: '红药', item_type: '消耗品', stack_size: 5 },
    { id: '40003', name: '星陨石', item_type: '收藏品', stack_size: 3, sell_price: 400 },
    { id: '10001', name: '巨剑', item_type: '武器', stack_size: 1 },
  ]);
  return state;
}

describe('stack_size 来自数值表', () => {
  it('reads stack_size into the def, and 1 stays 1', () => {
    fresh();
    expect(itemDef('30001').stackSize).toBe(10);
    expect(itemDef('30002').stackSize).toBe(5);
    expect(itemDef('10001').stackSize).toBe(1);
    // 演示长剑没有表行，默认不可叠。
    expect(itemDef('longsword').stackSize).toBe(1);
  });
});

describe('合堆只发生在入包', () => {
  it('two arrows share one cell, count = 2', () => {
    const s = fresh();
    addToBag(s, 'a1', '30001');
    addToBag(s, 'a2', '30001');
    expect(s.bag).toHaveLength(1);
    expect(itemCount(s.bag[0]!)).toBe(2);
    expect(countOf(s.bag, '30001')).toBe(2);
  });

  it('opens a second cell only when the stack is full', () => {
    const s = fresh();
    for (let i = 0; i < 10; i += 1) addToBag(s, `a${i}`, '30001');
    expect(s.bag).toHaveLength(1);
    expect(itemCount(s.bag[0]!)).toBe(10);
    addToBag(s, 'a10', '30001');
    expect(s.bag).toHaveLength(2);
    expect(itemCount(s.bag[1]!)).toBe(1);
  });

  it('never merges non-stackable items, even with the same defId', () => {
    const s = fresh();
    addToBag(s, 'w1', '10001');
    addToBag(s, 'w2', '10001');
    expect(s.bag).toHaveLength(2);
    expect(s.bag.every((it) => itemCount(it) === 1)).toBe(true);
  });

  it('never merges an instance that carries affixes or durability', () => {
    const s = fresh();
    addToBag(s, 'p1', '30002');
    // 带词条 / 磨损的药（现实中不存在，但协议上可能出现）必须自成一格：
    // 否则"这一叠里的第二瓶"是从哪来的就说不清，重铸还会一次改掉两件。
    addToBag(s, 'p2', '30002', 3);
    addToBag(s, 'p3', '30002', undefined, [{ id: 'sharp', stat: 'dmg_pct', value: 0.06 }]);
    expect(s.bag).toHaveLength(3);
  });

  it('adds a bought bundle into ONE cell with the right count', () => {
    const s = fresh();
    addToBag(s, 'buy-1', '30002', undefined, undefined, undefined, 5);
    expect(s.bag).toHaveLength(1);
    expect(itemCount(s.bag[0]!)).toBe(5);
  });

  it('bagHasRoomFor counts merges, not just empty cells', () => {
    const s = fresh();
    addToBag(s, 'p1', '30002', undefined, undefined, undefined, 4);
    // 一格 4/5：再买 3 瓶需要 1 格（先补满，剩 2 开新格），不是 3 格。
    expect(bagHasRoomFor(s, '30002', 3)).toBe(true);
    expect(bagHasRoomFor(s, '30002', 300)).toBe(false);
    // 预检不能改状态：它只是在克隆上试跑。
    expect(s.bag).toHaveLength(1);
    expect(itemCount(s.bag[0]!)).toBe(4);
  });
});

describe('取一件是一叠里的一件', () => {
  it('decrements the count and only removes the cell at zero', () => {
    const s = fresh();
    addToBag(s, 'p1', '30002', undefined, undefined, undefined, 3);
    expect(takeFromStack(s, 'p1', 1)).toBe(1);
    expect(itemCount(s.bag[0]!)).toBe(2);
    expect(takeFromStack(s, 'p1', 1)).toBe(1);
    expect(itemCount(s.bag[0]!)).toBe(1);
    expect(takeFromStack(s, 'p1', 1)).toBe(1);
    expect(s.bag).toHaveLength(0);
    expect(takeFromStack(s, 'p1', 1)).toBe(0);
  });

  it('takeOneFromBag prefers the least-full stack and reports empty honestly', () => {
    const s = fresh();
    // 先造一格满的，再造一格 2 支：取箭应该先动 2 支那格，玩家看到的角标更稳。
    addToBag(s, 'full', '30001', undefined, undefined, undefined, 10);
    addToBag(s, 'few', '30001', undefined, undefined, undefined, 2);
    const few = s.bag.find((it) => it.uid === 'few')!;
    const full = s.bag.find((it) => it.uid === 'full')!;
    expect(takeOneFromBag(s, '30001')).toBe(true);
    expect(itemCount(s.bag.find((it) => it.uid === few.uid)!)).toBe(1);
    expect(itemCount(s.bag.find((it) => it.uid === full.uid)!)).toBe(10);
    for (let i = 0; i < 11; i += 1) takeOneFromBag(s, '30001');
    expect(countOf(s.bag, '30001')).toBe(0);
    expect(takeOneFromBag(s, '30001')).toBe(false);
  });
});

describe('读档兜底', () => {
  it('normalizes junk counts without deleting items', () => {
    const s = fresh();
    s.bag.push(
      { uid: 'x', defId: '30001', container: 'bag', col: 0, row: 0, count: 0 },
      { uid: 'y', defId: '30001', container: 'bag', col: 1, row: 0, count: 99 },
      { uid: 'z', defId: '10001', container: 'bag', col: 2, row: 0, count: 4 },
    );
    normalizeStackCounts(s.bag);
    expect(s.bag).toHaveLength(3);
    // count 0 会被读成 1（绝不返回 0，否则物品凭空消失）。
    expect(itemCount(s.bag[0]!)).toBe(1);
    expect(s.bag[0]!.count).toBeUndefined();
    // 超量保留原值，只是不再往里加（拆格需要空格，修存档没资格替玩家搬东西）。
    expect(s.bag[1]!.count).toBe(99);
    // 不可叠的物品上的 count 是脏数据，清掉 —— 否则 UI 会画出"巨剑 ×4"。
    expect(s.bag[2]!.count).toBeUndefined();
  });

  it('count and safeCols survive deploy and bring-back', () => {
    const lobby = fresh();
    addToBag(lobby, 'p1', '30002', undefined, undefined, undefined, 4);
    setSafeCols(lobby, 4);
    const loadout = takeIntoRun(lobby);
    expect(itemCount(loadout.bag[0]!)).toBe(4);
    bringBack(lobby, loadout);
    expect(itemCount(lobby.bag[0]!)).toBe(4);
    // 保险格容量是"账本"，出征不会把它抹掉（它写在状态上，随存档走）。
    expect(safeColsOf(lobby)).toBe(4);
  });
});

describe('保险格扩容（商店的付费出口）', () => {
  it('defaults to the gifted 2 columns and grows without touching SAFE', () => {
    const s = fresh();
    expect(safeColsOf(s)).toBe(SAFE.cols);
    expect(containerSpec(s, 'safe').cols).toBe(2);
    expect(canPlace(s, 'safe', '30002', 2, 0)).toBe(false);
    expect(setSafeCols(s, 4)).toBe(true);
    expect(containerSpec(s, 'safe').cols).toBe(4);
    expect(canPlace(s, 'safe', '30002', 3, 0)).toBe(true);
    // 常量没被改：背包 / 仓库 / 其他存档仍然是 2 列。
    expect(SAFE.cols).toBe(2);
    expect(safeColsOf(fresh())).toBe(2);
  });

  it('clamps to SAFE_MAX_COLS and refuses to shrink', () => {
    const s = fresh();
    expect(setSafeCols(s, 99)).toBe(true);
    expect(safeColsOf(s)).toBe(SAFE_MAX_COLS);
    expect(setSafeCols(s, 3)).toBe(false);
    expect(safeColsOf(s)).toBe(SAFE_MAX_COLS);
  });

  it('repairs a corrupt safeCols instead of building a NaN-wide grid', () => {
    const s = fresh();
    (s as { safeCols?: number }).safeCols = Number.NaN;
    normalizeContainers(s);
    expect(s.safeCols).toBeUndefined();
    expect(safeColsOf(s)).toBe(2);
    (s as { safeCols?: number }).safeCols = 0;
    normalizeContainers(s);
    expect(safeColsOf(s)).toBe(2);
  });

  it('lets an item be dropped into the expanded cell', () => {
    const s = fresh();
    setSafeCols(s, 3);
    addToBag(s, 'p1', '30002');
    expect(placeItem(s, 'p1', 'safe', 2, 0)).toBe(true);
    expect(s.bag).toHaveLength(0);
    expect(s.safe).toHaveLength(1);
    // 缩不回去，所以越界仍然是越界。
    expect(placeItem(s, 'p1', 'safe', 3, 0)).toBe(false);
  });
});

describe('背包容量没被堆叠偷偷放大', () => {
  it('bag still has 40 cells; a full bag of potions is 200 potions', () => {
    expect(BAG.cols * BAG.rows).toBe(40);
    const s = fresh();
    addToBag(s, 'p', '30002', undefined, undefined, undefined, 40 * 5);
    expect(s.bag).toHaveLength(40);
    expect(countOf(s.bag, '30002')).toBe(200);
    expect(addToBag(s, 'overflow', '30002')).toBeNull();
  });
});
