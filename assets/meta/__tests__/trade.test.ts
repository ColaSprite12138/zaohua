/**
 * 收藏品卖出（设计 5.1）—— 只测规则：
 * 表是白名单、三个容器都能卖、非收藏品一件不动、卖两次第二次是 0。
 */

import { describe, expect, it } from 'vitest';
import { treasure as TREASURE } from '../../resource/generated/treasure.ts';
import { priceOf, sellTreasure, treasureCount, type TreasureHold } from '../trade.ts';

/** 手搭一份三容器状态（不走 addToBag，避免依赖物品目录注册）。 */
function hold(): TreasureHold & { all: { defId: string }[] } {
  const bag = [{ defId: '40001' }, { defId: '10001' }, { defId: '40002' }];
  const stash = [{ defId: '40003' }, { defId: '30002' }];
  const safe = [{ defId: '40001' }];
  return {
    bag, stash, safe,
    get all() { return [...bag, ...stash, ...safe]; },
  };
}

describe('priceOf', () => {
  it('只认表里的 id，表外一律 0（武器 / 药不能卖）', () => {
    expect(priceOf(TREASURE, '40001')).toBeGreaterThan(0);
    expect(priceOf(TREASURE, '10001')).toBe(0);
    expect(priceOf(TREASURE, '30002')).toBe(0);
    expect(priceOf(TREASURE, 'not_an_item')).toBe(0);
  });
});

describe('sellTreasure', () => {
  it('三个容器都卖，非收藏品一件不动', () => {
    const state = hold();
    const result = sellTreasure(state, TREASURE);
    // 背包 40001 + 40002、仓库 40003、保险格 40001
    expect(result.lines.map((l) => l.id).sort()).toEqual(['40001', '40002', '40003']);
    expect(result.gold).toBe(
      priceOf(TREASURE, '40001') * 2 + priceOf(TREASURE, '40002') + priceOf(TREASURE, '40003'),
    );
    expect(state.bag.map((i) => i.defId)).toEqual(['10001']);
    expect(state.stash.map((i) => i.defId)).toEqual(['30002']);
    expect(state.safe).toEqual([]);
  });

  it('明细按 id 汇总件数', () => {
    const state = hold();
    const result = sellTreasure(state, TREASURE);
    const coin = result.lines.find((l) => l.id === '40001')!;
    expect(coin.count).toBe(2);
    expect(coin.gold).toBe(priceOf(TREASURE, '40001') * 2);
  });

  it('幂等：卖第二次是 0，不会凭空生钱', () => {
    const state = hold();
    sellTreasure(state, TREASURE);
    const again = sellTreasure(state, TREASURE);
    expect(again.gold).toBe(0);
    expect(again.lines).toEqual([]);
  });

  it('空背包 / 没有 safe 字段都不炸', () => {
    const bare: TreasureHold = { bag: [], stash: [] };
    expect(sellTreasure(bare, TREASURE).gold).toBe(0);
    expect(treasureCount(bare, TREASURE)).toBe(0);
  });

  it('treasureCount 数的是"能卖的件数"，不是格数或总件数', () => {
    const state = hold();
    expect(treasureCount(state, TREASURE)).toBe(4);
    sellTreasure(state, TREASURE);
    expect(treasureCount(state, TREASURE)).toBe(0);
  });
});
