/**
 * 状态栏（技能栏上方一行正方形图标）—— **纯几何 + 纯文案**，不碰 canvas。
 *
 * 为什么单独成文件：这一行有三个容易错的地方，全都想被单测钉住：
 * 1. **位置**：必须贴着技能栏上沿、左端对齐技能栏左端，且永远不与血条 / 武器槽重叠；
 * 2. **命中**：hover 判定要和画出来的矩形**完全同一份数据**（`icons` 既用于绘制也用于
 *    `statusBarHit`），否则「看着指着它、提示却不出来」这种鬼故事必然出现；
 * 3. **进度**：阴影是「已经过去了多少」，不是「还剩多少」—— 时针顺时针扫过去，
 *    扫满 = 该结束了。反着写会让玩家以为还剩一大截。
 *
 * 绘制在 `paint.ts::drawStatusBar`，本文件只出数据。
 */

import type { StatusId } from '../combat/state.ts';

/** 一格图标边长（正方形）。与技能栏 46px 拉开层级：状态是读的，技能是点的。 */
export const STATUS_ICON = 34;
/** 图标间距。 */
export const STATUS_GAP = 6;
/** 图标行与技能栏上沿的距离。 */
export const STATUS_ROW_GAP = 10;
/** 最多显示几个。技能栏宽 396，12 个缩到 27px 仍能读清字形。 */
export const STATUS_MAX_ICONS = 12;
/** 缩到这个尺寸就不再缩，改砍个数（再小里面的汉字就糊成一团）。 */
export const STATUS_MIN_ICON = 24;

export interface StatusIconRect {
  /** 在 `host.statuses` 里的下标 —— 命中后直接用它对回实例。 */
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

export interface StatusBarLayout {
  readonly icons: readonly StatusIconRect[];
  readonly size: number;
  readonly y: number;
}

/**
 * 排一行图标：从 `anchorX`（技能栏左端）往右排，底边停在 `skillTopY - STATUS_ROW_GAP`。
 *
 * 放不下先缩格子、缩到 24 还放不下就砍尾（最晚施加的那几个不显示）—— 1280 宽度下
 * 12 个格子只需 27px，永远走不到砍尾这一步，但公式必须是收敛的。
 */
export function statusBarLayout(
  anchorX: number,
  skillTopY: number,
  count: number,
  width: number,
): StatusBarLayout {
  const n = Math.max(0, Math.min(count, STATUS_MAX_ICONS));
  if (n === 0 || width <= 0) return { icons: [], size: 0, y: skillTopY };
  let size = STATUS_ICON;
  let shown = n;
  const needed = (): number => shown * size + (shown - 1) * STATUS_GAP;
  while (shown > 1 && needed() > width) {
    if (size > STATUS_MIN_ICON) size -= 1;
    else shown -= 1;
  }
  const y = skillTopY - STATUS_ROW_GAP - size;
  const icons: StatusIconRect[] = [];
  for (let i = 0; i < shown; i += 1) {
    icons.push({ index: i, x: anchorX + i * (size + STATUS_GAP), y, size });
  }
  return { icons, size, y };
}

/** 指针落在哪一格；没落在任何一格返回 null。 */
export function statusBarHit(
  icons: readonly StatusIconRect[],
  px: number,
  py: number,
): number | null {
  for (const rect of icons) {
    if (px >= rect.x && px < rect.x + rect.size && py >= rect.y && py < rect.y + rect.size) {
      return rect.index;
    }
  }
  return null;
}

/**
 * 已流逝的比例（0 = 刚上身，1 = 到点）。
 *
 * 它是**阴影**的大小：时针扫过的区域变暗，所以刚上的状态是亮的、快结束的几乎全暗。
 * `total` 缺失 / 非正数（脏数据）一律当「已经到点」，宁可显示成马上要没，
 * 也不要显示成「还剩一辈子」。
 */
export function statusSweep(left: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 1;
  if (!Number.isFinite(left) || left <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - left / total));
}

/** 图标上的一个字。19 条状态各一个，全部不重名 —— 单测守这条。 */
const GLYPH: Readonly<Record<StatusId, string>> = Object.freeze({
  stun: '晕',
  freeze: '冻',
  paralyze: '麻',
  root: '锢',
  petrify: '石',
  sleep: '眠',
  slow: '缓',
  chill: '滞',
  silence: '默',
  disarm: '缴',
  vulnerable: '伤',
  grievous: '重',
  bleed: '血',
  poison: '毒',
  burn: '燃',
  wet: '湿',
  shock: '电',
  wind: '风',
});

export function statusGlyph(id: StatusId): string {
  return GLYPH[id] ?? '?';
}

/** 分类的中文名（提示框第二行开头）。 */
export const STATUS_CATEGORY_LABEL: Readonly<Record<string, string>> = Object.freeze({
  hard: '硬控',
  soft: '削弱',
  dot: '持续伤害',
  element: '元素附着',
});

/** 剩余秒数的显示口径：10 秒以内留一位小数，再长就取整（HUD 上不需要 0.1 的精度）。 */
export function formatStatusSeconds(left: number): string {
  if (!Number.isFinite(left) || left <= 0) return '0.0';
  // 先按一位小数取整再判断：9.96 要显示成 10，不能显示成「10.0」（那一格放不下）。
  const rounded = Math.round(left * 10) / 10;
  return rounded >= 10 ? String(Math.round(rounded)) : rounded.toFixed(1);
}
