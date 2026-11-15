import { beforeEach, describe, expect, it } from 'vitest';
import {
  BAG, CONTAINERS, SAFE, addToBag, bringBack, canPlace, createInventoryState, equipItem,
  findItem, loadoutFromRun, normalizeContainers, placeItem, registerItemDefs, runInventoryFrom,
  splitOnDeath, takeIntoRun, unequipItem,
  type InventoryState,
} from '../inventory.ts';

/**
 * **保险格 = 独立容器**（设计 4；2026-11-15 用户拍板：不像背包里划一块地，要像三角洲的保险箱）。
 *
 * 这几条断言守住三件事：它是自己的容器（不占背包格）、自动拾取碰不到它、阵亡只保它。
 */

const AUTHORED = [
  { id: '30002', name: '红药', item_type: '消耗品', quality: '白' },
  { id: '30003', name: '蓝药', item_type: '消耗品', quality: '白' },
  { id: '10006', name: '霜之哀伤', quality: '暗金', damage_min: 250, damage_max: 400 },
];

/** 把一件新物品放进指定容器的指定格子（等价于玩家拖放）。 */
function putIn(
  state: InventoryState, uid: string, defId: string,
  container: 'bag' | 'safe', col: number, row: number,
): boolean {
  if (addToBag(state, uid, defId) === null) return false;
  if (placeItem(state, uid, container, col, row)) return true;
  // 放不进保险格（尺寸不合）时把它从背包里清掉，让测试的起点保持干净
  state.bag = state.bag.filter((i) => i.uid !== uid);
  return false;
}

describe('保险格是独立容器（赠送 2 格）', () => {
  beforeEach(() => {
    registerItemDefs(AUTHORED);
  });

  it('is a container of its own — the bag keeps all 40 cells', () => {
    const s = createInventoryState(0);
    expect(SAFE).toEqual({ cols: 2, rows: 1, label: '保险格' });
    expect(CONTAINERS.safe).toBe(SAFE);
    expect(s.safe).toEqual([]);
    expect([BAG.cols, BAG.rows, BAG.cols * BAG.rows]).toEqual([5, 8, 40]);
    // 背包不再被挖掉两格：整块 5x8 都能放东西
    expect(canPlace(s, 'bag', '30002', 0, 0)).toBe(true);
    expect(canPlace(s, 'bag', '30002', 0, 1)).toBe(true);
  });

  it('a v1/v2 save without the container gets an empty one', () => {
    const legacy = { ...createInventoryState(0) } as unknown as Record<string, unknown>;
    delete legacy.safe;
    normalizeContainers(legacy as unknown as InventoryState);
    expect((legacy as unknown as InventoryState).safe).toEqual([]);
    // 坏数据也修得动：一次调用之后三个容器都是数组
    const broken = { bag: null, stash: null, safe: null } as unknown as InventoryState;
    normalizeContainers(broken);
    expect([broken.bag, broken.stash, broken.safe]).toEqual([[], [], []]);
  });

  it('the safe has its own grid: two 1x1 cells, no room for a weapon', () => {
    const s = createInventoryState(1);
    expect(putIn(s, 'p1', '30002', 'safe', 0, 0)).toBe(true);
    expect(putIn(s, 'p2', '30003', 'safe', 1, 0)).toBe(true);
    expect(s.safe).toHaveLength(2);
    expect(s.bag).toHaveLength(0);
    // 两格放满了就没有第三格
    expect(canPlace(s, 'safe', '30002', 0, 0)).toBe(false);
    // 2x3 的剑进不去保险格（扩容是商店批次的事）
    expect(putIn(s, 'w', '10006', 'safe', 0, 0)).toBe(false);
    expect(s.safe.some((i) => i.defId === '10006')).toBe(false);
  });

  it('moving between bag and safe is a normal cross-container move', () => {
    const s = createInventoryState(0);
    expect(putIn(s, 'p1', '30002', 'safe', 0, 0)).toBe(true);
    expect(placeItem(s, 'p1', 'bag', 3, 4)).toBe(true);
    expect(findItem(s, 'p1')).toMatchObject({ where: 'grid', container: 'bag' });
    expect(s.safe).toEqual([]);
    expect(placeItem(s, 'p1', 'safe', 1, 0)).toBe(true);
    expect(findItem(s, 'p1')).toMatchObject({ where: 'grid', container: 'safe' });
  });

  it('auto pickups never land in the safe (structural, not a special case)', () => {
    // 独立容器从结构上解决了「静默保险」：`addToBag()` 只写背包，碰不到保险格。
    const s = createInventoryState(0);
    for (let i = 0; i < 6; i += 1) addToBag(s, `loot-${i}`, '30002');
    expect(s.bag).toHaveLength(6);
    expect(s.safe).toEqual([]);
  });

  it('splitOnDeath keeps the safe and loses bag + every worn slot', () => {
    const s = createInventoryState(1);
    expect(equipItem(s, 'sword-1', 0)).toBe(true);
    expect(putIn(s, 'keep-me', '30002', 'safe', 0, 0)).toBe(true);
    expect(addToBag(s, 'lose-me', '10006')).not.toBeNull();

    const { kept, lost } = splitOnDeath(s);
    expect(kept.safe?.map((i) => i.uid)).toEqual(['keep-me']);
    expect(kept.bag).toEqual([]);
    expect(kept.equipped.every((slot) => slot === null)).toBe(true);
    expect(lost.map((i) => i.defId).sort()).toEqual(['10006', 'longsword']);
    // 纯函数：原状态不动
    expect(s.bag).toHaveLength(1);
    expect(s.safe).toHaveLength(1);
    expect(s.equipped[0]?.uid).toBe('sword-1');
  });

  it('the safe rides into the run and back with the loadout', () => {
    const lobby = createInventoryState(0);
    expect(putIn(lobby, 'carry-me', '30003', 'safe', 0, 0)).toBe(true);
    const loadout = takeIntoRun(lobby);
    expect(loadout.safe?.map((i) => i.uid)).toEqual(['carry-me']);
    // 出征把局外背包 + 保险格都清空（仓库除外）
    expect(lobby.safe).toEqual([]);
    const run = runInventoryFrom(loadout);
    expect(run.safe.map((i) => i.uid)).toEqual(['carry-me']);
    // 局内再塞一瓶进去，撤离时整份回来
    expect(putIn(run, 'looted', '30002', 'safe', 1, 0)).toBe(true);
    bringBack(lobby, loadoutFromRun(run));
    expect(lobby.safe.map((i) => i.uid).sort()).toEqual(['carry-me', 'looted']);
  });

  it('a worn weapon keeps its durability when dragged through the bag', () => {
    // 2026-11-15：`detach()` 以前只留 uid/defId，拖一次就把耐久修满（5.2 的出口被抹掉）。
    const s = createInventoryState(1);
    expect(equipItem(s, 'sword-1', 0)).toBe(true);
    s.equipped[0] = { uid: 'sword-1', defId: 'longsword', durability: 12 };
    expect(unequipItem(s, 0, 'bag', 2, 3)).toBe(true);
    expect(s.bag[0]!.durability).toBe(12);
    expect(equipItem(s, 'sword-1', 0)).toBe(true);
    expect(s.equipped[0]!.durability).toBe(12);
  });
});
