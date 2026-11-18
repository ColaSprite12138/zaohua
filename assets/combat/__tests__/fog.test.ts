/**
 * 迷雾可见度场（设计 11，2026-11-19 第四版）。
 *
 * 这一层的四条承诺，正好对应用户三轮反馈：
 * 1. **贴墙**：墙格自己亮、墙后第一格就暗 —— 阴影边界不离开墙面。
 * 2. **不抖**：射线原点是玩家所在**格的中心**，玩家在同一格里挪动时可见度场逐格不变。
 * 3. **不漏光**：格遍历（不是按距离采样），擦角时两侧都要求通畅。
 * 4. **渐变**：丢视野 0.6 秒暗下去、新探索 0.22 秒亮起来，不是一帧切换。
 */
import { describe, expect, it } from 'vitest';
import {
  FogField, FOG_FADE_IN, FOG_FADE_OUT, approachShade, lineOfSight,
} from '../fog.ts';
import { makeWorld, type ArenaMap } from '../world.ts';

const SIZE = 25;
const CENTER = 10;
const CX = CENTER * 32 + 16;
const CY = CENTER * 32 + 16;

function field(walls: readonly string[] = [], voids: readonly string[] = []): ArenaMap {
  const rows = Array.from({ length: SIZE }, () => new Array<string>(SIZE).fill('0'));
  for (const v of voids) {
    const [c, r] = v.split(',').map(Number);
    rows[r!]![c!] = '3';
  }
  for (const v of walls) {
    const [c, r] = v.split(',').map(Number);
    rows[r!]![c!] = '1';
  }
  return {
    id: `fog-${walls.length}-${voids.length}`,
    gridSize: 32,
    cols: SIZE,
    rows: SIZE,
    pxWid: SIZE * 32,
    pxHei: SIZE * 32,
    terrain: rows.map((line) => line.join('')),
    spawn: { col: CENTER, row: CENTER, x: CX, y: CY },
    monsters: [],
  };
}

/** 推进到稳定（dt 会被 `advance` 夹到 0.25，所以多跑几帧）。 */
function settle(f: FogField, px: number, py: number, radius: number, frames = 20): void {
  for (let i = 0; i < frames; i += 1) f.advance(px, py, radius, 0.1);
}

describe('格子视线（lineOfSight）', () => {
  it('空地上直线通透', () => {
    const w = makeWorld(field());
    expect(lineOfSight(w, CENTER, CENTER, CENTER + 6, CENTER + 2)).toBe(true);
  });

  it('墙格自己可见（要被照亮），墙后第一格就不可见 —— 这就是"贴墙"', () => {
    const w = makeWorld(field(['13,10']));
    expect(lineOfSight(w, CENTER, CENTER, 13, 10)).toBe(true);
    expect(lineOfSight(w, CENTER, CENTER, 14, 10)).toBe(false);
  });

  it('对角擦过墙角也不漏光', () => {
    const w = makeWorld(field(['11,11']));
    // (10,10) → (12,12) 正好穿过 (11,11) 这个角。
    expect(lineOfSight(w, CENTER, CENTER, 12, 12)).toBe(false);
  });

  it('虚空挡视线（没铺地的地方看不见）', () => {
    const w = makeWorld(field([], ['13,10']));
    expect(lineOfSight(w, CENTER, CENTER, 14, 10)).toBe(false);
  });
});

describe('暗度渐变（approachShade）', () => {
  it('淡入比淡出快（亮起来跟手、暗下去留痕）', () => {
    expect(FOG_FADE_IN).toBeLessThan(FOG_FADE_OUT);
    // 一帧 1/60 秒只走一小步，绝不是"一帧切换"。
    const a = approachShade(1, 0, 1 / 60);
    expect(a).toBeGreaterThan(0.9);
    expect(a).toBeLessThan(1);
    const b = approachShade(0, 1, 1 / 60);
    expect(b).toBeGreaterThan(0);
    expect(b).toBeLessThan(0.1);
  });

  it('走完全程用的时间就是常量（0.22s 亮 / 0.6s 暗）', () => {
    let v = 1;
    let t = 0;
    while (v > 0 && t < 5) {
      v = approachShade(v, 0, 1 / 240);
      t += 1 / 240;
    }
    expect(t).toBeGreaterThan(FOG_FADE_IN - 0.02);
    expect(t).toBeLessThan(FOG_FADE_IN + 0.02);

    let d = 0;
    let td = 0;
    while (d < 1 && td < 5) {
      d = approachShade(d, 1, 1 / 240);
      td += 1 / 240;
    }
    expect(td).toBeGreaterThan(FOG_FADE_OUT - 0.02);
    expect(td).toBeLessThan(FOG_FADE_OUT + 0.02);
  });
});

describe('可见度场（FogField）', () => {
  it('新图从全暗开始，看见之后逐渐变亮（不是一帧）', () => {
    const w = makeWorld(field());
    const f = new FogField(w);
    expect(f.shadeAt(CENTER, CENTER)).toBe(1);
    f.advance(CX, CY, 10 * 32, 0.1);
    const half = f.shadeAt(CENTER, CENTER);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(1);
    settle(f, CX, CY, 10 * 32);
    expect(f.shadeAt(CENTER, CENTER)).toBe(0);
  });

  it('同一格内挪动不改变可见度场（这就是"不抖"）', () => {
    const walls = ['13,10', '13,11'];
    const w = makeWorld(field(walls));
    const a = new FogField(w);
    const b = new FogField(w);
    settle(a, CX, CY, 10 * 32);
    // 12px 之后仍在同一格里（格 32px，起点在格中心）。
    settle(b, CX + 12, CY - 9, 10 * 32);
    for (let r = CENTER - 6; r <= CENTER + 6; r += 1) {
      for (let c = CENTER - 6; c <= CENTER + 6; c += 1) {
        expect(b.shadeAt(c, r)).toBe(a.shadeAt(c, r));
      }
    }
  });

  it('走出视野后逐渐暗回去（先半暗、再全暗）', () => {
    const w = makeWorld(field());
    const f = new FogField(w);
    settle(f, CX, CY, 10 * 32);
    expect(f.shadeAt(CENTER, CENTER)).toBe(0);
    // 玩家瞬移到远处：原地的格丢视野，单帧只暗一点。
    const far = 20 * 32 + 16;
    f.advance(far, far, 10 * 32, 0.1);
    const half = f.shadeAt(CENTER, CENTER);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(0.5);
    settle(f, far, far, 10 * 32);
    expect(f.shadeAt(CENTER, CENTER)).toBe(1);
  });

  it('墙后不会亮：视野半径内、墙后一格仍是暗的', () => {
    const w = makeWorld(field(['13,10']));
    const f = new FogField(w);
    settle(f, CX, CY, 10 * 32);
    expect(f.shadeAt(13, 10)).toBe(0);   // 墙自己被照亮
    expect(f.shadeAt(14, 10)).toBe(1);   // 墙后一格是暗的
  });
});
