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

/** 喝红药的键（`Z`：挨打后回血，和 `X` 蓝药并排）。 */
export const HEAL_KEY = 'KeyZ';

/** `KeyQ` → `Q`；HUD 角标只显示字母。 */
export function keyLabel(code: string): string {
  return code.startsWith('Key') ? code.slice(3) : code;
}

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/**
 * 六权能（Domain）—— 星图亲和与战斗元素的**唯一权威 id 表**。
 * 神话配对：ares 兵燹(阿瑞斯/赫菲斯托斯) / poseidon 沧溟(波塞冬/阿佛洛狄忒) /
 * zeus 天威(宙斯/赫拉) / apollo 双曜(阿波罗/阿尔忒弥斯) /
 * demeter 霜序(得墨忒尔/狄俄尼索斯) / athena 神行(雅典娜/赫尔墨斯)。
 * `talent/index.ts` 零 import（要转译成浏览器脚本），保留一份镜像，
 * 由 `assets/talent/__tests__/starmap-data.test.ts` 的一致性断言防漂移。
 */
export const DOMAIN_IDS = [
  'ares', 'demeter', 'poseidon', 'apollo', 'zeus', 'athena',
] as const;
export type DomainId = (typeof DOMAIN_IDS)[number];

/** 权能的中文名与 HUD 色值（视觉资产，颜色沿用初版）。 */
export const DOMAIN_LABEL: Readonly<Record<DomainId, { name: string; color: string }>> =
  Object.freeze({
    ares: { name: '兵燹', color: '#fb923c' },
    demeter: { name: '霜序', color: '#8be9fd' },
    poseidon: { name: '沧溟', color: '#60a5fa' },
    apollo: { name: '双曜', color: '#4ade80' },
    zeus: { name: '天威', color: '#c084fc' },
    athena: { name: '神行', color: '#a7f3d0' },
  });
