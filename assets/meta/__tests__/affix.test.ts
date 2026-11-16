/**
 * 词条系统单测（设计 7.1 / 7.2 第一批）。
 *
 * 守护的四件事：**条数按品质**、**同 stat 不重复**、**只出本部位的池子**、
 * **词条跟着物品走**（跨堆 / 拖放 / 拾取都不能丢）。
 *
 * 不钉死具体 seed 的掉落结果（加词条行会改变抽样），只测"规则"。
 */

import { describe, expect, it } from 'vitest';
import { affix as ROWS } from '../../resource/generated/affix.ts';
import { affix_slot as SLOTS } from '../../resource/generated/affix_slot.ts';
import {
  affixCountFor, affixPoolFor, affixText, affixTotal, gearAffixTotal, gearMultiplier,
  qualityTier, rollAffixes, sanitizeAffixes, scopeForEquip,
  type AffixGear, type AffixInstance,
} from '../affix.ts';
import {
  addToBag, bringBack, createInventoryState, equipItem, takeIntoRun, unequipItem,
  type InventoryState,
} from '../inventory.ts';

/** 固定序列 rng：可复现，且不消耗 `GameState.rng`（那条序列属于掉落）。 */
function fixedRng(values: readonly number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

const GEAR_WEAPON: AffixGear = { equipped: [], activeWeaponSlot: 0 };

function gearWith(items: readonly ({ affixes?: readonly AffixInstance[] } | null)[], active: 0 | 1 = 0): AffixGear {
  const equipped = Array.from({ length: 10 }, (_, i) => items[i] ?? null);
  return { equipped, activeWeaponSlot: active };
}

describe('品质与部位', () => {
  it('品质阶梯按 白<绿<蓝<紫<橙<暗金，未知品质按最低', () => {
    expect(qualityTier('白')).toBe(1);
    expect(qualityTier('暗金')).toBe(6);
    expect(qualityTier('绿')).toBeLessThan(qualityTier('紫'));
    expect(qualityTier(undefined)).toBe(1);
    expect(qualityTier('传说')).toBe(1);
  });

  it('装备栏映射到词条范围（武器 / 护甲 / 首饰）', () => {
    expect(scopeForEquip('weapon')).toBe('weapon');
    expect(scopeForEquip('helmet')).toBe('armor');
    expect(scopeForEquip('boots')).toBe('armor');
    expect(scopeForEquip('ring')).toBe('jewelry');
    expect(scopeForEquip('necklace')).toBe('jewelry');
    expect(scopeForEquip(null)).toBe('any');
  });

  it('词条条数来自 affix_slot.xlsx：白 0、绿 1、暗金 4、未知 0', () => {
    expect(affixCountFor(SLOTS, '白')).toBe(0);
    expect(affixCountFor(SLOTS, '绿')).toBe(1);
    expect(affixCountFor(SLOTS, '暗金')).toBe(4);
    expect(affixCountFor(SLOTS, undefined)).toBe(0);
  });
});

describe('rollAffixes', () => {
  it('白装永远 0 条（白装是入场兜底，不给强度）', () => {
    expect(rollAffixes(ROWS, SLOTS, '白', 'weapon', fixedRng([0.5]))).toEqual([]);
  });

  it('武器不会出首饰专属词条（奥能 / 凝神只在首饰上）', () => {
    // 紫武器能抽 3 条；池子里只有 dmg / hp / range / dodge，绝无 mana。
    for (const seed of [0.1, 0.35, 0.6, 0.85]) {
      const rolled = rollAffixes(ROWS, SLOTS, '紫', 'weapon', fixedRng([seed, seed, seed]));
      expect(rolled.every((a) => a.stat !== 'mana_pct')).toBe(true);
    }
  });

  it('护甲不会出 range_px（长臂锁武器）', () => {
    for (const seed of [0.2, 0.5, 0.9]) {
      const rolled = rollAffixes(ROWS, SLOTS, '橙', 'chest', fixedRng([seed]));
      expect(rolled.every((a) => a.stat !== 'range_px')).toBe(true);
    }
  });

  it('同一条 stat 在一件装备上最多一次', () => {
    for (let seed = 0; seed < 40; seed += 1) {
      const rolled = rollAffixes(ROWS, SLOTS, '暗金', 'chest', fixedRng([seed / 40 + 0.001]));
      const stats = rolled.map((a) => a.stat);
      expect(new Set(stats).size).toBe(stats.length);
    }
  });

  it('条数不超过 affix_slot 给的数（池子不够时少出，不补位）', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const rolled = rollAffixes(ROWS, SLOTS, '暗金', 'chest', fixedRng([seed / 20]));
      expect(rolled.length).toBeLessThanOrEqual(4);
    }
    const green = rollAffixes(ROWS, SLOTS, '绿', 'ring', fixedRng([0.3]));
    expect(green.length).toBe(1);
  });

  it('数值落在表里的区间内，且像素类取整', () => {
    const rolled = rollAffixes(ROWS, SLOTS, '暗金', 'weapon', fixedRng([0.13, 0.97, 0.4, 0.6]));
    for (const a of rolled) {
      const row = ROWS.find((r) => r.id === a.id)!;
      expect(a.value).toBeGreaterThanOrEqual(row.value_min);
      expect(a.value).toBeLessThanOrEqual(row.value_max);
      if (a.stat === 'range_px') expect(Number.isInteger(a.value)).toBe(true);
    }
  });

  it('同一条 rng 序列给出同一份词条（掉落可复现）', () => {
    const a = rollAffixes(ROWS, SLOTS, '橙', 'weapon', fixedRng([0.31, 0.72, 0.18]));
    const b = rollAffixes(ROWS, SLOTS, '橙', 'weapon', fixedRng([0.31, 0.72, 0.18]));
    expect(a).toEqual(b);
  });

  it('词条池按部位与门槛过滤（白装门槛以上的词条不出现在绿装池）', () => {
    const green = affixPoolFor(ROWS, 'weapon', '绿');
    expect(green.every((r) => qualityTier(r.quality_min) <= qualityTier('绿'))).toBe(true);
    expect(green.map((r) => r.id)).not.toContain('brutal'); // 蓝门槛
  });
});

describe('穿戴合计（设计 7.2：双武器槽只算激活那把）', () => {
  const keen: AffixInstance[] = [{ id: 'keen', stat: 'dmg_pct', value: 0.05 }];
  const brutal: AffixInstance[] = [{ id: 'brutal', stat: 'dmg_pct', value: 0.1 }];
  const vital: AffixInstance[] = [{ id: 'vital', stat: 'hp_pct', value: 0.08 }];

  it('激活槽生效，副手不生效', () => {
    const gear = gearWith([{ affixes: keen }, { affixes: brutal }], 0);
    expect(affixTotal(keen, 'dmg_pct')).toBeCloseTo(0.05, 6);
    expect(gearAffixTotal(gear, 'dmg_pct')).toBeCloseTo(0.05, 6);
    expect(gearAffixTotal({ ...gear, activeWeaponSlot: 1 }, 'dmg_pct')).toBeCloseTo(0.1, 6);
  });

  it('非武器槽全都算（胸甲 + 武器累加）', () => {
    const gear = gearWith([{ affixes: keen }, null, null, null, null, null, null, null, null, { affixes: vital }]);
    expect(gearAffixTotal(gear, 'dmg_pct')).toBeCloseTo(0.05, 6);
    expect(gearAffixTotal(gear, 'hp_pct')).toBeCloseTo(0.08, 6);
    expect(gearMultiplier(gear, 'hp_pct')).toBeCloseTo(1.08, 6);
  });

  it('空手 / 空槽不产生乘区', () => {
    expect(gearMultiplier(GEAR_WEAPON, 'dmg_pct')).toBe(1);
    expect(gearAffixTotal(gearWith([null, null]), 'range_px')).toBe(0);
  });
});

describe('存档清洗与文案', () => {
  it('sanitizeAffixes 丢掉未知 id / 非数值，并裁掉同 stat 的重复项', () => {
    const cleaned = sanitizeAffixes(ROWS, [
      { id: 'keen', stat: 'dmg_pct', value: 0.05 },
      { id: 'brutal', stat: 'dmg_pct', value: 0.1 },
      { id: 'not_a_real_affix', stat: 'dmg_pct', value: 0.5 },
      { id: 'vital', stat: 'hp_pct', value: Number.NaN },
      { id: 'agile', stat: 'dodge_cd_pct', value: 0.08 },
    ]);
    expect(cleaned.map((a) => a.id)).toEqual(['keen', 'agile']);
  });

  it('sanitizeAffixes 对非数组给空数组（旧存档）', () => {
    expect(sanitizeAffixes(ROWS, undefined)).toEqual([]);
    expect(sanitizeAffixes(ROWS, { id: 'keen' })).toEqual([]);
  });

  it('减 CD 文案带负号，加成带正号', () => {
    expect(affixText({ id: 'keen', stat: 'dmg_pct', value: 0.06 }, ROWS)).toBe('锋锐 +6.0% 武器伤害');
    expect(affixText({ id: 'agile', stat: 'dodge_cd_pct', value: 0.08 }, ROWS)).toBe('轻灵 -8.0% 闪避冷却');
    expect(affixText({ id: 'longarm', stat: 'range_px', value: 15.4 }, ROWS)).toBe('长臂 +15 攻击距离');
  });
});

describe('词条跟着物品走（跨堆 / 拖放 / 拾取）', () => {
  const affixes: AffixInstance[] = [{ id: 'keen', stat: 'dmg_pct', value: 0.06 }];

  function lobbyWithAffixedSword(): InventoryState {
    const lobby = createInventoryState(0);
    // 用内置的 `longsword`：它不需要注册表（`addToBag` 对未知 id 返回 null）。
    // 词条是手动传给实例的，与品质无关 —— 这里测的是"字段跟不跟着走"。
    expect(addToBag(lobby, 'u1', 'longsword', undefined, affixes)).not.toBeNull();
    return lobby;
  }

  it('出征 / 带回都不丢词条，且是深拷贝（改一处不影响另一处）', () => {
    const lobby = lobbyWithAffixedSword();
    const loadout = takeIntoRun(lobby);
    expect(loadout.bag[0]!.affixes).toEqual(affixes);
    // 深拷贝：数组与元素都不能是同一个引用（否则两个堆 / 两件装备共享一份）。
    expect(loadout.bag[0]!.affixes).not.toBe(affixes);
    expect(loadout.bag[0]!.affixes![0]).not.toBe(affixes[0]);

    bringBack(lobby, loadout);
    expect(lobby.bag[0]!.affixes).toEqual(affixes);
  });

  it('穿戴 / 脱下不丢词条', () => {
    const lobby = lobbyWithAffixedSword();
    expect(equipItem(lobby, 'u1', 0)).toBe(true);
    expect(lobby.equipped[0]!.affixes).toEqual(affixes);
    expect(lobby.equipped[0]!.affixes).not.toBe(affixes);
    expect(unequipItem(lobby, 0, 'bag', 0, 0)).toBe(true);
    expect(lobby.bag[0]!.affixes).toEqual(affixes);
  });
});
