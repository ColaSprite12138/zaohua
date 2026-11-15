/**
 * Cross-module constants and pure types.
 *
 * This is the ONLY module every other module may import without creating a
 * cycle. It contains no game state and no logic beyond `clamp`.
 */

/** Logical canvas size. World maps may be much larger; the camera decides what is visible. */
export const VIEW_W = 1280;
export const VIEW_H = 720;

/**
 * Read-only minimap, top-right. The engine layer must suppress pointer orders
 * inside this rectangle so the minimap can never be clicked to move.
 */
export const MINIMAP = Object.freeze({ x: VIEW_W - 244, y: 20, w: 220, h: 165 });

export interface Vec {
  x: number;
  y: number;
}

/**
 * 7 个主动技能键（设计文档 8.2：技能栏 7 格）。
 *
 * 为什么不是 1–7：`Digit1` / `Digit2` 已经是武器槽切换、`Space` 是闪避、`E` 是引导
 * 传送门、`R` 是重开，全被占住了。这 7 个键**只在技能栏与输入层出现一次**（本常量），
 * HUD 直接读它画格子角标，所以改键不会出现「显示的和按的对不上」。
 */
export const SKILL_KEYS: readonly string[] = Object.freeze([
  'KeyQ', 'KeyW', 'KeyT', 'KeyF', 'KeyG', 'KeyV', 'KeyC',
]);

/** 喝蓝药的键（法力不自动恢复，这是唯一的续航手段）。 */
export const POTION_KEY = 'KeyX';

/** `KeyQ` → `Q`；HUD 角标只显示字母。 */
export function keyLabel(code: string): string {
  return code.startsWith('Key') ? code.slice(3) : code;
}

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;
