/**
 * 耐久（设计文档 5.2「抗通胀四条出口」之一 / 7.4「武器类型与消耗」）。
 *
 * 三条规则：
 *
 * 1. **三类武器都有耐久**，上限来自 `weapon.xlsx::durability`（巨剑 160 / 弓 110）。
 * 2. **按造成 / 承受伤害扣**，承受 : 造成 ≈ 7 : 3 —— 比值在
 *    `combat_rule.xlsx::durability_taken / durability_dealt`，代码里没有数字。
 *    所以近战（贴身挨打多）天然更费，远程天然更省：这不是惩罚，是堵住「远程完全免费」的口子。
 * 3. **扣到 0 = 损坏**：装备还在槽里，但伤害回落空手、HUD 标红。
 * 4. **上限会被修低**（2026-11-17，用户定的抗通胀口径）：局外工坊修理时按补回的
 *    耐久永久扣掉一部分上限（`workshop.xlsx::max_loss_pct`），存在
 *    `ItemInstance.durabilityMax` 上。磨到很低以后玩家自然会销毁 / 卖掉 / 换一把 ——
 *    这就是设计 5.2「修不如重铸」的落地方式（价格递增 + 上限损耗，双重收敛）。
 *
 * 耐久写在 `ItemInstance.durability` 上，跟着物品跨堆 / 跨局 / 进存档；缺口只在
 * 「捡到时没有这个字段」—— 那时按上限补齐，所以新装备永远是满耐久。
 *
 * ⚠ 读上限一律走 `durabilityMaxOf(item)`，**不要直接读 `weapon.xlsx`**：
 * 出厂上限只是第一任上限，被修过的东西更短。
 */

import { combat_rule } from '../resource/generated/combat_rule.ts';
import { weapon } from '../resource/generated/weapon.ts';
import type { ItemInstance } from '../meta/inventory.ts';
import { durabilityCap, durabilityCurrent } from '../meta/inventory.ts';
import { say } from './effects.ts';
import type { GameState, Player } from './state.ts';

const RULE = combat_rule[0];
const WEAPON_BY_ID = new Map(weapon.map((row) => [String(row.id), row]));

/**
 * **出厂**耐久上限；表里没有这一行（例如演示用的 `longsword`）按 0 = 不参与耐久。
 *
 * 只用来判断「这件东西有没有耐久这个概念」，以及作为实例上限的上界。
 * 要读"这件现在还耐多久"用 `durabilityMaxOf()`。
 */
export function maxDurability(defId: string): number {
  return WEAPON_BY_ID.get(defId)?.durability ?? 0;
}

/**
 * 这一件**现在**的耐久上限（设计 5.2：修一次就永久掉一截）。
 *
 * - 没有 `durabilityMax` 字段 = 没修过 = 出厂上限（老存档天然如此）。
 * - 夹在 `[1, 出厂上限]`：修过的只会更低；存档里出现比出厂还大的值（篡改 / 旧数据）
 *   按出厂算，**绝不放宽**。下限 1 是硬底 —— 上限 0 的战斗语义是"不参与耐久"，
 *   那会让一把磨废的武器突然变成永不磨损。
 */
export function durabilityMaxOf(item: ItemInstance | null): number {
  if (item === null) return 0;
  // 夹取规则只有一份：`inventory.ts::durabilityCap`（局外工坊面板读的是同一个）。
  return durabilityCap(maxDurability(item.defId), item.durabilityMax);
}

/** 当前耐久。没有字段＝刚捡到，按上限算（**不写回**，读了就知道）。 */
export function durabilityOf(item: ItemInstance | null): number {
  if (item === null) return 0;
  return durabilityCurrent(durabilityMaxOf(item), item.durability);
}

/** 这把武器还能不能用。没有耐久概念的物品（演示长剑）永远可用。 */
export function weaponUsable(item: ItemInstance | null): boolean {
  if (item === null) return true;
  const max = durabilityMaxOf(item);
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
/**
 * `target` 是**这件武器属于谁**。帧同步下每台机器都持有全体玩家的背包，
 * 所以「谁挨打」「谁出手」必须显式传那个 `Player`；缺省 `s.player` 只是
 * PVE 单测的兼容写法（那时 `s.player` 就是唯一玩家）。
 * 若伤害结算发生在按玩家循环之外（怪物近战 / 弹道 / DOT），不传目标就会
 * 磨到各端**自己本机**的武器，两端背包当场分叉。
 */
export function wearWeapon(
  s: GameState, dealt: number, taken = 0, target?: Player,
): void {
  const p = target ?? s.player;
  const slot = p.activeWeaponSlot;
  const item = p.runInventory.equipped[slot] ?? null;
  if (item === null) return;
  const max = durabilityMaxOf(item);
  if (max <= 0) return;
  const before = durabilityOf(item);
  if (before <= 0) return;

  const loss = Math.max(0, dealt) * RULE.durability_dealt
    + Math.max(0, taken) * RULE.durability_taken;
  if (loss <= 0) return;
  const after = Math.max(0, before - loss);
  // 整份实例透传，只覆盖 durability —— 白名单会顺手抹掉词条与生成时掷好的
  // 恒定伤害（damage），那会让「打了一刀以后这把剑突然变回中值伤害」。
  p.runInventory.equipped[slot] = { ...item, durability: after };
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
    const max = item === null ? 0 : durabilityMaxOf(item);
    const current = item === null ? 0 : durabilityOf(item);
    return { slot, current, max, broken: item !== null && max > 0 && current <= 0 };
  });
}
