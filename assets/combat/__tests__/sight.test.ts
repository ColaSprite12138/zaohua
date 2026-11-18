/**
 * 视野契约（设计 11，2026-11-18）。
 *
 * 这一层的三个承诺：
 * 1. **半径可配置**：`state.visionRadius` 是唯一来源，夹在 8–120 格之间。
 * 2. **遮挡是真的**：墙后的点看不见 —— 不是"圆形范围内全都可见"。
 * 3. **多边形不出界**：每条射线都不超过半径（多出来的那 0.6 格是为了照亮墙顶）。
 */
import { describe, expect, it } from 'vitest';
import {
  clampVision, inSight, sightPolygon, visionRadiusOf,
  VISION_BASE_CELLS, VISION_MAX_CELLS, VISION_MIN_CELLS,
} from '../sight.ts';
import { makeWorld, type ArenaMap } from '../world.ts';

/** 21×21 的空地（中心 10,10），可以按需插墙。格 32px。 */
const SIZE = 21;
const CENTER = 10;
const CX = CENTER * 32 + 16;
const CY = CENTER * 32 + 16;

function field(walls: readonly string[] = []): ArenaMap {
  const rows = Array.from({ length: SIZE }, () => new Array<string>(SIZE).fill('0'));
  for (const w of walls) {
    const [c, r] = w.split(',').map(Number);
    rows[r!]![c!] = '1';
  }
  const terrain = rows.map((line) => line.join(''));
  return {
    id: `sight-${walls.length}`,
    gridSize: 32,
    cols: SIZE,
    rows: SIZE,
    pxWid: SIZE * 32,
    pxHei: SIZE * 32,
    terrain,
    spawn: { col: CENTER, row: CENTER, x: CX, y: CY },
    monsters: [],
  };
}

describe('视野半径（可配置）', () => {
  it('默认 16 格，夹在 8–120 格之间', () => {
    expect(VISION_BASE_CELLS).toBe(16);
    expect(clampVision(VISION_BASE_CELLS * 32)).toBe(VISION_BASE_CELLS * 32);
    expect(clampVision(1)).toBe(VISION_MIN_CELLS * 32);
    expect(clampVision(999_999)).toBe(VISION_MAX_CELLS * 32);
    // 非数值（天赋表里缺字段）落回默认值，不是 NaN
    expect(clampVision(Number.NaN)).toBe(VISION_BASE_CELLS * 32);
    expect(visionRadiusOf({ visionRadius: 12 * 32 })).toBe(12 * 32);
  });
});

describe('视线遮挡', () => {
  it('空地上半径内的点看得见，半径外的看不见', () => {
    const w = makeWorld(field());
    const px = CX;
    const py = CY;
    // 3 格远（96px）：看得见
    expect(inSight(w, px, py, px + 96, py, 320)).toBe(true);
    // 半径 320px = 10 格；12 格远看不见
    expect(inSight(w, px, py, px + 384, py, 320)).toBe(false);
  });

  it('墙后的点看不见，墙前 1 格看得见', () => {
    // 玩家在 (10,10)，正东 (13,10) 是一堵墙
    const w = makeWorld(field(['13,10']));
    const px = CX;
    const py = CY;
    // (12,10) 是墙前：看得见
    expect(inSight(w, px, py, 12 * 32 + 16, py, 640)).toBe(true);
    // (14,10) 在墙后：看不见（距离只有 4 格，远小于半径）
    expect(inSight(w, px, py, 14 * 32 + 16, py, 640)).toBe(false);
  });

  it('虚空也挡视线（走出地块不该看见黑暗里的东西）', () => {
    const w = makeWorld(field(['13,10']));
    expect(inSight(w, CX, CY, 14 * 32 + 16, CY + 8, 640)).toBe(false);
  });
});

describe('视野多边形', () => {
  it('每一段都不超过半径（墙顶那点余量除外）', () => {
    const w = makeWorld(field(['12,12', '13,12', '12,13']));
    const radius = 10 * 32;
    const poly = sightPolygon(w, CX, CY, radius, 64);
    expect(poly.length).toBe(64 * 2);
    for (let i = 0; i < poly.length; i += 2) {
      const dx = poly[i]! - CX;
      const dy = poly[i + 1]! - CY;
      const d = Math.hypot(dx, dy);
      expect(d).toBeLessThanOrEqual(radius + 32 * 0.61);
    }
  });

  it('墙方向上的端点被截短：被挡住的那一侧不会伸到半径尽头', () => {
    const w = makeWorld(field(['12,10']));
    const radius = 10 * 32;
    const poly = sightPolygon(w, CX, CY, radius, 8);
    // 8 条射线里 i=0 是正东（cos0=1），正好撞上 (12,10) 的墙；i=4 是正西。
    const east = Math.hypot(poly[0]! - CX, poly[1]! - CY);
    const west = Math.hypot(poly[8]! - CX, poly[9]! - CY);
    expect(east).toBeLessThan(radius);
    expect(west).toBeGreaterThan(radius * 0.9);
  });
});
