/**
 * 状态栏（技能栏上方一行正方形图标）的几何与文案契约。
 *
 * 用户 2026-11-18 的口径：
 *   - 位置：**技能栏上方**，显示当前全部增益 / 减益；
 *   - 图标：**正方形**；
 *   - 不悬停：图标上有一个**时针一样的阴影顺时针扫**（扫过 = 已经过去的时间）；
 *   - 悬停：显示名字 / 一句描述 / 剩余时间。
 *
 * 这几条里最容易出错的两处是「阴影是已流逝还是剩余」和「命中矩形与绘制矩形是不是同一份」，
 * 所以它们各自有断言。真正画出来长什么样由浏览器截图自证（paint 里的绘制没法在 node 里断言）。
 */

import { describe, expect, it } from 'vitest';
import {
  STATUS_GAP,
  STATUS_ICON,
  STATUS_MAX_ICONS,
  STATUS_MIN_ICON,
  STATUS_ROW_GAP,
  formatStatusSeconds,
  statusBarHit,
  statusBarLayout,
  statusGlyph,
  statusSweep,
} from '../game/status-bar.ts';
import { STATUS } from '../combat/status.ts';

/** 1280×720 下真实的技能栏几何（`paint.ts::hud` 里算出来的那两个数）。 */
const BAR_X = 504;
const BAR_W = 396;
const ROW_Y = 622;

describe('the status row sits directly above the skill bar', () => {
  it('is empty when nothing is on the player', () => {
    const layout = statusBarLayout(BAR_X, ROW_Y, 0, BAR_W);
    expect(layout.icons).toEqual([]);
    expect(layout.size).toBe(0);
  });

  it('anchors its left edge to the skill bar, one gap above it', () => {
    const layout = statusBarLayout(BAR_X, ROW_Y, 2, BAR_W);
    expect(layout.size).toBe(STATUS_ICON);
    expect(layout.icons.map((i) => i.x)).toEqual([BAR_X, BAR_X + STATUS_ICON + STATUS_GAP]);
    // 底边停在技能栏上沿之上：图标不许压到技能格
    for (const icon of layout.icons) {
      expect(icon.y + icon.size).toBe(ROW_Y - STATUS_ROW_GAP);
      expect(icon.size).toBe(icon.size);   // 正方形：宽高同一个数
    }
  });

  it('shrinks to fit instead of running off the right edge', () => {
    const layout = statusBarLayout(BAR_X, ROW_Y, STATUS_MAX_ICONS, BAR_W);
    const last = layout.icons[layout.icons.length - 1]!;
    expect(last.x + last.size).toBeLessThanOrEqual(BAR_X + BAR_W);
    expect(layout.size).toBeGreaterThanOrEqual(STATUS_MIN_ICON);
  });

  it('never renders more than the cap, and keeps the array index intact', () => {
    const layout = statusBarLayout(BAR_X, ROW_Y, STATUS_MAX_ICONS + 5, BAR_W);
    expect(layout.icons.length).toBeLessThanOrEqual(STATUS_MAX_ICONS);
    expect(layout.icons.map((i) => i.index)).toEqual(layout.icons.map((_, i) => i));
  });
});

describe('hover picks the icon that was actually drawn there', () => {
  const layout = statusBarLayout(BAR_X, ROW_Y, 3, BAR_W);

  it('hits the centre of each cell', () => {
    layout.icons.forEach((icon, i) => {
      expect(statusBarHit(layout.icons, icon.x + icon.size / 2, icon.y + icon.size / 2)).toBe(i);
    });
  });

  it('includes the top-left corner, excludes the bottom-right one', () => {
    const first = layout.icons[0]!;
    expect(statusBarHit(layout.icons, first.x, first.y)).toBe(0);
    // 右下角属于下一格（半开区间），否则相邻两格会同时命中
    expect(statusBarHit(layout.icons, first.x + first.size, first.y + first.size)).not.toBe(0);
  });

  it('returns null in the gap, above the row, and past the last icon', () => {
    const first = layout.icons[0]!;
    expect(statusBarHit(layout.icons, first.x + first.size + 2, first.y + 4)).toBeNull();
    expect(statusBarHit(layout.icons, first.x + 4, first.y - 6)).toBeNull();
    const last = layout.icons[layout.icons.length - 1]!;
    expect(statusBarHit(layout.icons, last.x + last.size + 4, last.y + 4)).toBeNull();
  });
});

describe('the sweep is ELAPSED time, not remaining', () => {
  it('starts empty and ends full', () => {
    expect(statusSweep(2, 2)).toBe(0);
    expect(statusSweep(1, 2)).toBeCloseTo(0.5, 6);
    expect(statusSweep(0, 2)).toBe(1);
  });

  it('treats dirty totals as expired rather than as "forever"', () => {
    // total 为 0 / NaN 时，绝不能显示成「还剩一大截」
    expect(statusSweep(1, 0)).toBe(1);
    expect(statusSweep(1, Number.NaN)).toBe(1);
    expect(statusSweep(Number.NaN, 2)).toBe(1);
    // left 比 total 还长（被续过时长）→ 夹在 0，不要画出一个负扇形
    expect(statusSweep(5, 2)).toBe(0);
  });
});

describe('every authored status has its own single-character icon', () => {
  it('covers the whole status table with no duplicates', () => {
    const ids = Object.keys(STATUS);
    const glyphs = ids.map((id) => statusGlyph(id as never));
    expect(glyphs.every((g) => Array.from(g).length === 1)).toBe(true);
    expect(new Set(glyphs).size).toBe(glyphs.length);
    // 18 条：6 硬控 + 6 软控 + 3 DOT + 3 元素附着（`status.xlsx` 的行数）
    expect(ids.length).toBe(18);
  });
});

describe('remaining seconds read the way a player counts', () => {
  it('keeps one decimal under ten seconds and rounds above it', () => {
    expect(formatStatusSeconds(1.84)).toBe('1.8');
    expect(formatStatusSeconds(9.96)).toBe('10');
    expect(formatStatusSeconds(12.4)).toBe('12');
    expect(formatStatusSeconds(0)).toBe('0.0');
    expect(formatStatusSeconds(-3)).toBe('0.0');
  });
});
