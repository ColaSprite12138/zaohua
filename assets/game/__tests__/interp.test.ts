import { describe, expect, it } from 'vitest';
import { interpPos, lerp, renderAlpha } from '../interp.ts';

describe('renderAlpha：渲染落后逻辑一步', () => {
  it('刚执行完一步（acc=0）→ 画上一步', () => {
    expect(renderAlpha(0, 1 / 24)).toBe(0);
  });

  it('快执行下一步（acc→dt）→ 画当前步', () => {
    expect(renderAlpha(1 / 24, 1 / 24)).toBe(1);
    expect(renderAlpha(0.5 / 24, 1 / 24)).toBeCloseTo(0.5, 9);
  });

  it('快进追帧时 acc 可能越过 dt，不外插', () => {
    expect(renderAlpha(5 / 24, 1 / 24)).toBe(1);
  });

  it('负数 / NaN / dt<=0 都不产生 NaN 坐标', () => {
    expect(renderAlpha(-0.5, 1 / 24)).toBe(0);
    expect(renderAlpha(Number.NaN, 1 / 24)).toBe(1);
    expect(renderAlpha(0.01, 0)).toBe(1);
    expect(renderAlpha(0.01, Number.NaN)).toBe(1);
  });
});

describe('lerp / interpPos', () => {
  it('线性插值两端与中点', () => {
    expect(lerp(10, 20, 0)).toBe(10);
    expect(lerp(10, 20, 1)).toBe(20);
    expect(lerp(10, 20, 0.25)).toBe(12.5);
  });

  it('有上一帧位置时按 alpha 插值', () => {
    const p = interpPos({ x: 100, y: 50 }, { x: 108, y: 58 }, 0.5);
    expect(p.x).toBeCloseTo(104, 9);
    expect(p.y).toBeCloseTo(54, 9);
  });

  it('没有上一帧位置（刚生成 / 刚进视野）直接用当前值', () => {
    // 否则新实体会从 (0,0) 飞过来 —— 比不插值更难看。
    const p = interpPos(undefined, { x: 300, y: 120 }, 0.3);
    expect(p).toEqual({ x: 300, y: 120 });
  });

  it('两步之间的位移被切成 60 fps 的连续位移（不再是 8.5 px 一跳）', () => {
    // 205 px/s、24 Hz：每逻辑步 8.54 px。渲染 60 fps 时，每帧应只前进约 3.4 px。
    const perStep = 205 / 24;
    const prev = { x: 0, y: 0 };
    const cur = { x: perStep, y: 0 };
    const frames = [0, 1 / 3, 2 / 3, 1].map((a) => interpPos(prev, cur, a).x);
    const deltas = frames.slice(1).map((v, i) => v - frames[i]!);
    for (const d of deltas) expect(d).toBeCloseTo(perStep / 3, 6);
    // 关键：单个渲染帧的位移远小于「一步跳完」。
    expect(Math.max(...deltas)).toBeLessThan(perStep / 2);
  });
});
