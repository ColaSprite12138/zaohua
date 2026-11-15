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
import { combat_rule } from '../resource/generated/combat_rule.ts';
import { burst, say } from './effects.ts';
import type { GameState } from './state.ts';

const RULE = combat_rule[0];

/** `item.xlsx` 的两个消耗品 id（与战利品池 / 局外目录同一份来源）。 */
export const POTION_HP_ID = '30002';
export const POTION_MP_ID = '30003';

/** 蓝药总量与速率（8.3：缓慢回复，不是一口回满）。 */
export const POTION_MANA = RULE.potion_mana;
export const POTION_SECONDS = RULE.potion_seconds;
/** 红药一口回多少生命（`combat_rule.xlsx::hp_potion_heal`）。 */
export const POTION_HP_HEAL = RULE.hp_potion_heal;

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
  if (!takeConsumable(s.runInventory, POTION_MP_ID)) return false;
  s.manaSurge = POTION_SECONDS;
  say(s, `喝下蓝药 · ${POTION_SECONDS} 秒内回复 ${POTION_MANA} 点法力`);
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
  if (!takeConsumable(s.runInventory, POTION_HP_ID)) return false;
  s.hp = Math.min(s.maxHp, s.hp + POTION_HP_HEAL);
  say(s, `喝下红药 · 回复 ${POTION_HP_HEAL} 点生命`);
  burst(s, s.player.x, s.player.y - 30, '#e2564f', 12, 90);
  return true;
}
