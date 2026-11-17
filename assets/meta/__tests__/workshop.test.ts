/**
 * 工坊：词条重铸 + 武器修理（设计 5.2 的后两个金币出口，用户 2026-11-17 定稿）。
 *
 * 这一批的口径与 5.2 的原文有一处**收紧**，测试就是它的看门人：
 *
 * 1. **重铸每件只洗一次**，扣费后**直接生效**（没有新旧二选一）。所以这里断言
 *    "洗过就洗不动"、"掷出空词条要退钱"、"不许把同一种类当成一次成功"。
 * 2. **重铸不碰耐久**：洗词条与修耐久是两条独立出口，混在一起等于吞掉一条。
 * 3. **修理按补回的量永久压低上限**（用户：修得越多掉得越多），价格还随次数
 *    `step_pct` 递增。所以断言"上限严格递减且有 1 点硬底"、"补得越来越少"、
 *    "修满的东西不再产生 0 金 0 效果的假成交"。
 */

import { describe, expect, it } from 'vitest';
import { workshop } from '../../resource/generated/workshop.ts';
import {
  canPay, reforge, reforgeLabel, reforgeQuote, repair, repairLabel, repairQuote, workshopRow,
} from '../workshop.ts';

const ROWS = workshop;
const wallet = (gold: number) => ({ gold });

/**
 * 测试用的物品形状：**故意不带 quality**，因为真实实例上就没有这个字段
 * （品质是 `ItemDef` 的展示副本）—— `reforge()` 的品质是参数。
 */
interface TestItem {
  readonly uid?: string;
  readonly defId?: string;
  readonly durability?: number;
  readonly durabilityMax?: number;
  readonly repairs?: number;
  readonly reforges?: number;
  readonly affixes?: readonly { readonly id: string; readonly stat: string; readonly value: number }[];
}

/** 一件紫武器：重铸 260 金 / 上限 1 次；修单价 2.4 / 每次 ×1.6 / 补 100 掉 25 上限。 */
const PURPLE: TestItem = { affixes: [{ id: 'keen', stat: 'dmg_pct', value: 0.06 }] };

describe('workshop.xlsx is the only price list', () => {
  it('every quality has a reforge row and a repair row', () => {
    for (const quality of ['白', '绿', '蓝', '紫', '橙', '暗金']) {
      expect(workshopRow(ROWS, 'reforge', quality), `${quality} 缺重铸行`).not.toBeNull();
      expect(workshopRow(ROWS, 'repair', quality), `${quality} 缺修理行`).not.toBeNull();
    }
  });

  it('白装不可重铸（没有词条可洗），但可以修', () => {
    expect(reforgeQuote(ROWS, '白', 0).ok).toBe(false);
    expect(reforgeQuote(ROWS, '白', 0).max).toBe(0);
    expect(repairQuote(ROWS, '白', 0, 160, 0).ok).toBe(true);
  });

  it('每件只能洗一次（用户 2026-11-17 定），不是设计稿的 1–3 次', () => {
    for (const quality of ['绿', '蓝', '紫', '橙', '暗金']) {
      expect(reforgeQuote(ROWS, quality, 0).max, quality).toBe(1);
    }
  });

  it('未知品质既不报价也不成交', () => {
    expect(reforgeQuote(ROWS, '彩色', 0).reason).toBe('unknown');
    expect(repairQuote(ROWS, '彩色', 0, 160, 0).reason).toBe('unknown');
  });
});

describe('reforge: pay once, take the new roll', () => {
  it('扣费、写入新词条、记一次账；耐久一个字节都不动', () => {
    const item = { ...PURPLE, uid: 'u1', defId: '10004', durability: 61, durabilityMax: 135 };
    const w = wallet(500);
    const out = reforge(item, '紫', ROWS, w, () => [{ id: 'vital', stat: 'hp_pct', value: 0.09 }]);
    expect(out.outcome).toBe('done');
    expect(w.gold).toBe(240);
    expect(out.item.affixes).toEqual([{ id: 'vital', stat: 'hp_pct', value: 0.09 }]);
    expect(out.item.reforges).toBe(1);
    // 重铸不碰耐久（两条独立出口）。
    expect(out.item.durability).toBe(61);
    expect(out.item.durabilityMax).toBe(135);
    // 原对象没有被就地改掉（页面靠"新实例"替换容器里的那一件）。
    expect(item.affixes?.[0]!.id).toBe('keen');
  });

  it('品质由参数传入：实例上没有 quality 字段也能洗（PlacedItem 就是这种）', () => {
    // 踩过一次：`reforge()` 以前从 item 上读 quality，而背包项根本没有这个字段
    // （品质是物品定义的展示副本），于是每次都被当成"未知品质"静默拒绝。
    const item: TestItem = {
      uid: 'u9', defId: '10004',
      affixes: [{ id: 'keen', stat: 'dmg_pct', value: 0.06 }],
    };
    const out = reforge(item, '紫', ROWS, wallet(500), () => [
      { id: 'vital', stat: 'hp_pct', value: 0.09 },
    ]);
    expect(out.outcome).toBe('done');
    expect(out.item.reforges).toBe(1);
  });

  it('洗过一次就洗不动了，再点一次不扣钱', () => {
    const out = reforge({ ...PURPLE, reforges: 1 }, '紫', ROWS, wallet(9999), () => [
      { id: 'vital', stat: 'hp_pct', value: 0.09 },
    ]);
    expect(out.outcome).toBe('used');
  });

  it('钱不够：既不扣钱也不改词条', () => {
    const item = { ...PURPLE };
    const w = wallet(100);
    const out = reforge(item, '紫', ROWS, w, () => [{ id: 'vital', stat: 'hp_pct', value: 0.09 }]);
    expect(out.outcome).toBe('poor');
    expect(w.gold).toBe(100);
    expect(out.item).toBe(item);
  });

  it('掷出空词条 = 数据异常：不扣钱、不改物品', () => {
    const item = { ...PURPLE };
    const w = wallet(500);
    const out = reforge(item, '紫', ROWS, w, () => []);
    expect(out.outcome).toBe('failed');
    expect(w.gold).toBe(500);
    expect(out.item).toBe(item);
  });

  it('掷出来和原来一模一样会重掷（花钱零变化是最难解释的结果）', () => {
    let calls = 0;
    const out = reforge({ ...PURPLE }, '紫', ROWS, wallet(500), () => {
      calls += 1;
      return calls === 1
        ? [{ id: 'keen', stat: 'dmg_pct', value: 0.081 }]   // 同一种类 → 白洗
        : [{ id: 'agile', stat: 'dodge_cd_pct', value: 0.07 }];
    });
    expect(out.outcome).toBe('done');
    expect(calls).toBe(2);
    expect(out.item.affixes?.[0]!.id).toBe('agile');
  });

  it('一直撞同一种类也不会卡死（最多试 7 次就接受）', () => {
    let calls = 0;
    const out = reforge({ ...PURPLE }, '紫', ROWS, wallet(500), () => {
      calls += 1;
      return [{ id: 'keen', stat: 'dmg_pct', value: 0.05 + calls / 1000 }];
    });
    expect(out.outcome).toBe('done');
    expect(calls).toBe(7);
  });

  it('文案：可洗 / 已洗 / 白装不可洗', () => {
    expect(reforgeLabel(reforgeQuote(ROWS, '紫', 0))).toBe('重铸 · 260 金');
    expect(reforgeLabel(reforgeQuote(ROWS, '紫', 1))).toBe('已重铸');
    expect(reforgeLabel(reforgeQuote(ROWS, '白', 0))).toBe('不可重铸');
  });
});

describe('repair: restore now, permanently lower the ceiling', () => {
  it('缺 100 点：花 240 金、补满到新上限 135（160 − 25）', () => {
    const q = repairQuote(ROWS, '紫', 60, 160, 0);
    expect(q.ok).toBe(true);
    expect(q.restored).toBe(100);
    expect(q.cost).toBe(240);
    expect(q.maxLoss).toBe(25);
    expect(q.newMax).toBe(135);
    expect(q.newCurrent).toBe(135);
  });

  it('修满的东西没有"假成交"', () => {
    const q = repairQuote(ROWS, '紫', 160, 160, 0);
    expect(q.ok).toBe(false);
    expect(q.reason).toBe('pristine');
    expect(repair({ ...PURPLE, durability: 160, durabilityMax: 160 }, q, wallet(9999)).outcome)
      .toBe('pristine');
  });

  it('成交写回 durability / durabilityMax / repairs，并按次数涨价', () => {
    const item = { ...PURPLE, durability: 60, durabilityMax: 160, repairs: 0 };
    const w = wallet(1000);
    const q = repairQuote(ROWS, '紫', 60, 160, 0);
    const out = repair(item, q, w);
    expect(out.outcome).toBe('done');
    expect(w.gold).toBe(760);
    expect(out.item.durability).toBe(135);
    expect(out.item.durabilityMax).toBe(135);
    expect(out.item.repairs).toBe(1);
    // 第二次修同一个上限段：单价不变、次数系数 1.6。
    const q2 = repairQuote(ROWS, '紫', 0, 135, 1);
    expect(q2.cost).toBe(519);
  });

  it('钱不够：不扣钱、不改装备', () => {
    const item = { ...PURPLE, durability: 60, durabilityMax: 160 };
    const w = wallet(10);
    const out = repair(item, repairQuote(ROWS, '紫', 60, 160, 0), w);
    expect(out.outcome).toBe('poor');
    expect(w.gold).toBe(10);
    expect(out.item).toBe(item);
  });

  it('反复修：上限严格递减、补得越来越少、永远不归零', () => {
    let cap = 160;
    let lastCost = 0;
    let lastRestored = 999;
    for (let i = 0; i < 8; i += 1) {
      const q = repairQuote(ROWS, '紫', 0, cap, i);
      expect(q.ok, `第 ${i + 1} 次应可修`).toBe(true);
      expect(q.newMax).toBeGreaterThanOrEqual(1);
      expect(q.newMax).toBeLessThan(cap);
      expect(q.restored).toBeLessThan(lastRestored);
      expect(q.cost).toBeGreaterThan(lastCost);
      cap = q.newMax;
      lastRestored = q.restored;
      lastCost = q.cost;
    }
  });

  it('上限硬底 1 点：再怎么修也不会变成「不参与耐久」', () => {
    const q = repairQuote(ROWS, '紫', 0, 2, 3);
    expect(q.newMax).toBe(1);
    expect(q.maxLoss).toBe(1);
    // 上限 1 时再修：还是 1（掉不下去），但钱照收 —— 到这一步玩家该扔了。
    expect(repairQuote(ROWS, '紫', 0, 1, 4).newMax).toBe(1);
  });

  it('文案：写着上限从多少掉到多少', () => {
    expect(repairLabel(repairQuote(ROWS, '紫', 60, 160, 0)))
      .toBe('修 · 240 金 · 上限 160 → 135');
    expect(repairLabel(repairQuote(ROWS, '紫', 160, 160, 0))).toBe('耐久已满');
  });

  it('canPay：0 价一律算买不起（表里没填价格不能白送）', () => {
    expect(canPay(100, 0)).toBe(false);
    expect(canPay(100, 100)).toBe(true);
    expect(canPay(99, 100)).toBe(false);
  });
});
