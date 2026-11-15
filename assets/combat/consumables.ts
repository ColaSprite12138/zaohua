/**
 * 消耗品（设计文档 8.3 / 5.2）。
 *
 * **红药 / 蓝药是背包物品，不是「每局免费发的瓶数」**。这一条是 5.2 抗通胀的第二个出口：
 * 带多少用多少，死了连药一起丢。以前 `GameState.potions` 那个计数器就是它之前的临时形态，
 * 现在删掉了 —— 计数改成「背包里有几瓶」（`countConsumable`），状态只有一份。
 *
 * 两条拒绝必须免费（不消耗）：满蓝不喝蓝药、满血不喝红药；正在回蓝时不叠加。
 */

import type { InventoryState } from '../meta/inventory.ts';
import { removeItem } from '../meta/inventory.ts';
import { consumable } from '../resource/generated/consumable.ts';
import { burst, say } from './effects.ts';
import type { GameState } from './state.ts';

/** `item.xlsx` 的两个消耗品 id（与战利品池 / 局外目录同一份来源）。 */
export const POTION_HP_ID = '30002';
export const POTION_MP_ID = '30003';

const BY_ID = new Map(consumable.map((row) => [String(row.id), row]));

/**
 * 每瓶药的效果**来自 `tables/consumable.xlsx`（每瓶一行）**，不是全局手感常量 ——
 * 加第三种药只要在表里加一行，代码不用动。缺行时按"没有效果"处理并拒绝使用：
 * 宁可提示"未配置"，也别喝下去什么都不发生。
 */
export interface ConsumableEffect {
  readonly hpRestore: number;
  readonly manaRestore: number;
  readonly manaSeconds: number;
  readonly hint: string;
}

export function consumableEffect(id: string): ConsumableEffect | null {
  const row = BY_ID.get(id);
  if (row === undefined) return null;
  return {
    hpRestore: row.hp_restore,
    manaRestore: row.mana_restore,
    manaSeconds: row.mana_seconds,
    hint: row.hint,
  };
}

/** 蓝药：总量与速率（8.3：缓慢回复，不是一口回满）。 */
export const POTION_MANA = consumableEffect(POTION_MP_ID)?.manaRestore ?? 0;
export const POTION_SECONDS = consumableEffect(POTION_MP_ID)?.manaSeconds ?? 0;
/** 红药：一口回多少生命。 */
export const POTION_HP_HEAL = consumableEffect(POTION_HP_ID)?.hpRestore ?? 0;

/** 背包里有几瓶（不统计仓库：仓库永不进战局）。 */
export function countConsumable(run: InventoryState, defId: string): number {
  let total = 0;
  for (const item of run.bag) if (item.defId === defId) total += 1;
  return total;
}

/** 从背包取走一瓶。没有就返回 false，状态不变。 */
function takeConsumable(run: InventoryState, defId: string): boolean {
  const item = run.bag.find((it) => it.defId === defId);
  if (item === undefined) return false;
  return removeItem(run, item.uid);
}

function runOver(s: GameState): boolean {
  return s.gameOver || s.extracted || s.timedOut || s.cleared;
}

/**
 * 喝蓝药：背包里必须真的有一瓶。
 * 拒绝顺序是刻意的 —— 先说「没有药」，再说「用不上」，玩家才知道该去补货还是该留着。
 */
export function drinkPotion(s: GameState): boolean {
  if (runOver(s)) return false;
  if (countConsumable(s.runInventory, POTION_MP_ID) <= 0) {
    say(s, '背包里没有蓝药了 · 局内搜刮或带药下场');
    return false;
  }
  if (s.mana >= s.maxMana) {
    say(s, '法力已满 · 先留着蓝药');
    return false;
  }
  // 药效不叠加：正在回复时再喝只是把计时重置，等于白扔一瓶。
  if (s.manaSurge > 0) {
    say(s, '上一瓶还在回复中');
    return false;
  }
  const effect = consumableEffect(POTION_MP_ID);
  if (effect === null || effect.manaRestore <= 0 || effect.manaSeconds <= 0) {
    say(s, '蓝药还没有配置效果（consumable.xlsx）');
    return false;
  }
  if (!takeConsumable(s.runInventory, POTION_MP_ID)) return false;
  s.manaSurge = effect.manaSeconds;
  say(s, `喝下蓝药 · ${effect.manaSeconds} 秒内回复 ${effect.manaRestore} 点法力`);
  burst(s, s.player.x, s.player.y - 30, '#60a5fa', 12, 90);
  return true;
}

/** 喝红药：一口回 `hp_potion_heal`，满血不喝（不能当水喝）。 */
export function healPotion(s: GameState): boolean {
  if (runOver(s)) return false;
  if (countConsumable(s.runInventory, POTION_HP_ID) <= 0) {
    say(s, '背包里没有红药了');
    return false;
  }
  if (s.hp >= s.maxHp) {
    say(s, '生命已满 · 先留着红药');
    return false;
  }
  const effect = consumableEffect(POTION_HP_ID);
  if (effect === null || effect.hpRestore <= 0) {
    say(s, '红药还没有配置效果（consumable.xlsx）');
    return false;
  }
  if (!takeConsumable(s.runInventory, POTION_HP_ID)) return false;
  s.hp = Math.min(s.maxHp, s.hp + effect.hpRestore);
  say(s, `喝下红药 · 回复 ${effect.hpRestore} 点生命`);
  burst(s, s.player.x, s.player.y - 30, '#e2564f', 12, 90);
  return true;
}
