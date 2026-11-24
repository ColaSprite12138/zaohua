/**
 * 开局生命 / 法力上限：**只依赖「带了什么」与「点了什么星图」，不依赖地图**。
 *
 * ## 为什么把它单独抽出来（2026-11-24）
 *
 * 联机局里，某个人的属性可能不是他自己的客户端算的 —— 如果他入座后、
 * 点出征前关掉了页面，就只剩服务端那份「点匹配时的装备 + 星图」快照。
 * 这时候属性必须由**每个客户端各自用同一份公式**算出来，否则同一局里
 * 他眼里的自己和你眼里的他会差几十点血 ⇒ 进 hash ⇒ 分叉。
 *
 * 之前这段公式只存在于 `state.ts::applyStarMods`（当时只有"本机 deploy"
 * 这一个调用点）。现在有两个调用点（本机 deploy / 远端影子），复刻第二份
 * 就是必然的漂移源，所以抽成这里，**两边都只调它**。
 *
 * ## 入参为什么带 `base`
 *
 * `PLAYER_HP_MAX` / `PLAYER_MANA_MAX` 住在 `state.ts`，而 `state.ts` 会 import
 * 这里 —— 让这里反过来 import 常量就成环。基数由调用方传，语义也更清楚
 * （"100 点基础血 × 星图 × 装备"）。
 */

import { gearMultiplier, type AffixCarrier } from '../meta/affix.ts';
import type { CombatModifiers } from './modifiers.ts';

/** 只需要 `equipped` + `activeWeaponSlot` —— `RunInventory` 天然满足。 */
export type VitalsGear = {
  readonly equipped: readonly (AffixCarrier | null)[];
  readonly activeWeaponSlot: number;
};

export type VitalsBase = {
  readonly hp: number;
  readonly mana: number;
};

export type Vitals = { readonly hpMax: number; readonly manaMax: number };

/** 基础值 × 星图乘区 × 装备词条，取整到整数点（和 `applyStarMods` 逐位一致）。 */
export function vitalsFrom(gear: VitalsGear, mods: CombatModifiers, base: VitalsBase): Vitals {
  return {
    hpMax: Math.round(base.hp * mods.maxHpMultiplier() * gearMultiplier(gear, 'hp_pct')),
    manaMax: Math.round(base.mana * mods.maxManaMultiplier() * gearMultiplier(gear, 'mana_pct')),
  };
}
