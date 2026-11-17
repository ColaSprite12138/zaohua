/**
 * 耐久（设计文档 5.2「抗通胀四条出口」之一 / 7.4「武器类型与消耗」）。
 *
 * 三条规则：
 *
 * 1. **三类武器都有耐久**，上限来自 `weapon.xlsx::durability`（巨剑 160 / 弓 110）。
 * 2. **按造成 / 承受伤害扣**，承受 : 造成 ≈ 7 : 3 —— 比值在
 *    `combat_rule.xlsx::durability_taken / durability_dealt`，代码里没有数字。
 *    所以近战（贴身挨打多）天然更费，远程天然更省：这不是惩罚，是堵住「远程完全免费」的口子。
 * 3. **扣到 0 = 损坏**：装备还在槽里，但伤害回落空手、HUD 标红。**本轮不做修理** ——
 *    设计 5.2 的原话是「修不如重铸」，修理/重铸要等金币经济与词条批次一起做。
 *    装备真的是消耗品：坏了就换下一件（5.3）。
 *
 * 耐久写在 `ItemInstance.durability` 上，跟着物品跨堆 / 跨局 / 进存档；缺口只在
 * 「捡到时没有这个字段」—— 那时按上限补齐，所以新装备永远是满耐久。
 */

import { combat_rule } from '../resource/generated/combat_rule.ts';
import { weapon } from '../resource/generated/weapon.ts';
import type { ItemInstance } from '../meta/inventory.ts';
import { say } from './effects.ts';
import type { GameState } from './state.ts';

const RULE = combat_rule[0];
const WEAPON_BY_ID = new Map(weapon.map((row) => [String(row.id), row]));

/** 耐久上限；表里没有这一行（例如演示用的 `longsword`）按 0 = 不参与耐久。 */
export function maxDurability(defId: string): number {
  return WEAPON_BY_ID.get(defId)?.durability ?? 0;
}

/** 当前耐久。没有字段＝刚捡到，按上限算（**不写回**，读了就知道）。 */
export function durabilityOf(item: ItemInstance | null): number {
  if (item === null) return 0;
  const max = maxDurability(item.defId);
  if (max <= 0) return 0;
  return item.durability === undefined ? max : Math.min(item.durability, max);
}

/** 这把武器还能不能用。没有耐久概念的物品（演示长剑）永远可用。 */
export function weaponUsable(item: ItemInstance | null): boolean {
  if (item === null) return true;
  const max = maxDurability(item.defId);
  if (max <= 0) return true;
  return durabilityOf(item) > 0;
}

/** 当前激活的武器槽是否已经损坏（HUD 与 `attack.ts` 都读它）。 */
export function activeWeaponBroken(s: GameState): boolean {
  return !weaponUsable(s.runInventory.equipped[s.activeWeaponSlot] ?? null);
}

/**
 * 扣耐久。`dealt` = 这一下打出去的伤害，`taken` = 玩家这一下挨的伤害。
 *
 * 只作用于**当前激活的武器槽**：副手在背包里不磨损（否则玩家要为不用的武器付账）。
 * 没有耐久概念的物品、空手、已经坏了 —— 全部直接返回，不写状态。
 */
export function wearWeapon(s: GameState, dealt: number, taken = 0): void {
  const slot = s.activeWeaponSlot;
  const item = s.runInventory.equipped[slot] ?? null;
  if (item === null) return;
  const max = maxDurability(item.defId);
  if (max <= 0) return;
  const before = durabilityOf(item);
  if (before <= 0) return;

  const loss = Math.max(0, dealt) * RULE.durability_dealt
    + Math.max(0, taken) * RULE.durability_taken;
  if (loss <= 0) return;
  const after = Math.max(0, before - loss);
  // 整份实例透传，只覆盖 durability —— 白名单会顺手抹掉词条与生成时掷好的
  // 恒定伤害（damage），那会让「打了一刀以后这把剑突然变回中值伤害」。
  s.runInventory.equipped[slot] = { ...item, durability: after };
  if (after <= 0 && before > 0) {
    say(s, '武器损坏 · 伤害回落空手（带回局外可换一把）');
  }
}

/** 投影用：两个武器槽的「当前 / 上限」，HUD 与验收脚本都读它。 */
export function durabilitySnapshot(
  s: GameState,
): { slot: number; current: number; max: number; broken: boolean }[] {
  return [0, 1].map((slot) => {
    const item = s.runInventory.equipped[slot] ?? null;
    const max = item === null ? 0 : maxDurability(item.defId);
    const current = item === null ? 0 : durabilityOf(item);
    return { slot, current, max, broken: item !== null && max > 0 && current <= 0 };
  });
}
