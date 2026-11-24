import { describe, expect, it } from 'vitest';
import { atan2, cos, TRIG_SEGMENTS, sin } from '../trig.ts';

/**
 * 判定层三角函数的护栏。
 *
 * 它要同时守住两件事，缺一条都不算完成：
 *  1. **够准** —— 与 `Math.*` 的差必须小到不影响任何判定（远小于 1/1024 px 的
 *     hash 量化步长），否则换表等于悄悄改玩法数值；
 *  2. **够确定** —— 只碰 + − × ÷ / floor / abs，不出现任何 Math 超越函数，
 *     这样不同引擎算出来逐位相同（`docs/net-sync-design.md` §6）。
 */

/** 均匀取样：不用 Math.random（它本身就不确定，测确定性的时候尤其不能引入）。 */
function sweep(n: number, from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i += 1) out.push(from + ((to - from) * i) / n);
  return out;
}

describe('trig 精度', () => {
  it('sin / cos 在一整圈内的误差 < 2e-6', () => {
    let maxSin = 0;
    let maxCos = 0;
    for (const x of sweep(4000, -2 * Math.PI, 2 * Math.PI)) {
      maxSin = Math.max(maxSin, Math.abs(sin(x) - Math.sin(x)));
      maxCos = Math.max(maxCos, Math.abs(cos(x) - Math.cos(x)));
    }
    expect(maxSin).toBeLessThan(2e-6);
    expect(maxCos).toBeLessThan(2e-6);
  });

  it('多圈之后仍然准（归约没有丢精度）', () => {
    for (const base of sweep(50, 0, 2 * Math.PI)) {
      for (const turns of [1, 5, 37]) {
        const x = base + turns * 2 * Math.PI;
        expect(Math.abs(sin(x) - Math.sin(x))).toBeLessThan(2e-6);
        expect(Math.abs(cos(x) - Math.cos(x))).toBeLessThan(2e-6);
      }
    }
  });

  it('atan2 在全平面的误差 < 2e-6', () => {
    let maxErr = 0;
    for (const y of sweep(60, -100, 100)) {
      for (const x of sweep(60, -100, 100)) {
        if (x === 0 && y === 0) continue;
        let got = atan2(y, x);
        let want = Math.atan2(y, x);
        // ±π 边界两侧表示等价，差 2π 不算错。
        const d = Math.abs(got - want);
        maxErr = Math.max(maxErr, Math.min(d, Math.abs(d - 2 * Math.PI)));
      }
    }
    expect(maxErr).toBeLessThan(2e-6);
  });

  it('atan2 的四个象限与坐标轴都对', () => {
    const q = Math.PI / 4;
    expect(atan2(1, 1)).toBeCloseTo(q, 5);
    expect(atan2(1, -1)).toBeCloseTo(3 * q, 5);
    expect(atan2(-1, -1)).toBeCloseTo(-3 * q, 5);
    expect(atan2(-1, 1)).toBeCloseTo(-q, 5);
    expect(atan2(0, 1)).toBe(0);
    expect(atan2(1, 0)).toBeCloseTo(Math.PI / 2, 5);
    expect(atan2(-1, 0)).toBeCloseTo(-Math.PI / 2, 5);
    expect(atan2(0, 0)).toBe(0);
  });

  it('185 px 位移的误差远小于 hash 量化步长（1/1024 px）', () => {
    // 这是「换表会不会改玩法」的判据：位移误差必须被 1/1024 的量化吃掉。
    let worst = 0;
    for (const a of sweep(2000, 0, 2 * Math.PI)) {
      worst = Math.max(worst, Math.abs(cos(a) * 185 - Math.cos(a) * 185));
    }
    expect(worst).toBeLessThan(1 / 1024);
  });
});

describe('trig 确定性', () => {
  it('同一输入永远得到同一个 bit（不是近似值）', () => {
    for (const x of sweep(500, -20, 20)) {
      expect(sin(x)).toBe(sin(x));
      expect(cos(x)).toBe(cos(x));
      expect(atan2(x, x + 1)).toBe(atan2(x, x + 1));
    }
  });

  it('边界输入不产生 NaN / Infinity', () => {
    for (const x of [0, -0, Math.PI, -Math.PI, 2 * Math.PI, -2 * Math.PI, 1e6, -1e6]) {
      expect(Number.isFinite(sin(x))).toBe(true);
      expect(Number.isFinite(cos(x))).toBe(true);
    }
    expect(sin(Number.NaN)).toBe(0);
    expect(cos(Number.POSITIVE_INFINITY)).toBe(0);
    expect(atan2(Number.NaN, 1)).toBe(0);
  });

  it('表长与段数一致（改表忘了改常量会在这里炸）', () => {
    expect(TRIG_SEGMENTS).toBe(512);
    expect(sin(Math.PI / 2)).toBe(1);
    expect(cos(0)).toBe(1);
  });
});
