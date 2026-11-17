import { describe, expect, it } from 'vitest';
import { createState } from '../simulation.ts';
import { ammoCount, takeAmmo } from '../projectile-runtime.ts';
import { countConsumable, drinkPotion, POTION_MP_ID } from '../consumables.ts';
import { itemCount } from '../../meta/inventory.ts';

/**
 * 堆叠在战斗侧的落点（设计 5.1）。
 *
 * 夹具药以前是「3 瓶 = 3 格」，现在是「3 瓶 = 1 格 ×3」。数格子会让 UI 显示
 * "只有 1 瓶"，数件数才和玩家看到的一致；取一件也只是一叠里扣一件。
 */

describe('药：一叠 = 多瓶', () => {
  it('counts bottles, not cells', () => {
    const s = createState();
    const cells = s.runInventory.bag.filter((it) => it.defId === POTION_MP_ID);
    const bottles = countConsumable(s.runInventory, POTION_MP_ID);
    expect(bottles).toBeGreaterThan(0);
    // 夹具的药现在落在一格里，数量与瓶数一致。
    expect(cells).toHaveLength(1);
    expect(itemCount(cells[0]!)).toBe(bottles);
  });

  it('drinking one leaves the rest of the stack in place', () => {
    const s = createState();
    const before = countConsumable(s.runInventory, POTION_MP_ID);
    s.mana = 0;
    s.manaSurge = 0;
    expect(drinkPotion(s)).toBe(true);
    expect(countConsumable(s.runInventory, POTION_MP_ID)).toBe(before - 1);
    expect(s.runInventory.bag.some((it) => it.defId === POTION_MP_ID)).toBe(true);
  });
});

describe('箭：一叠 = 多支', () => {
  it('one shot takes one arrow out of the stack', () => {
    const s = createState();
    s.runInventory.bag.push({ uid: 'quiver', defId: '30001', container: 'bag', col: 4, row: 7, count: 10 });
    expect(ammoCount(s, '30001')).toBe(10);
    expect(takeAmmo(s, '30001')).toBe(true);
    expect(ammoCount(s, '30001')).toBe(9);
    // 背包里还有夹具的药，但箭仍然只有**一格**（打一发不会把整叠删掉）。
    expect(s.runInventory.bag.filter((it) => it.defId === '30001')).toHaveLength(1);

    for (let i = 0; i < 9; i += 1) expect(takeAmmo(s, '30001')).toBe(true);
    expect(ammoCount(s, '30001')).toBe(0);
    // 打空才删格，且不会给出第 11 支。
    expect(s.runInventory.bag.some((it) => it.defId === '30001')).toBe(false);
    expect(takeAmmo(s, '30001')).toBe(false);
  });
});
