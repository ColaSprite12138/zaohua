import { describe, expect, it } from 'vitest';
import {
  HASH_INTERVAL_TICKS, createHasher, hashGameState, hashWords, quantize,
  type HashableState,
} from '../state-hash.ts';

function state(overrides: Partial<HashableState> = {}): HashableState {
  return {
    hp: 100,
    kills: 2,
    player: { x: 120.5, y: 88.25, face: 0.5 },
    skeletons: [
      { x: 300, y: 200, hp: 40, alive: true },
      { x: 500, y: 200, hp: 0, alive: false },
    ],
    drops: [{ uid: 'd1' }, { uid: 'd2' }],
    ...overrides,
  };
}

describe('状态 hash', () => {
  it('同样的状态算出同样的值', () => {
    expect(hashGameState(state(), 60)).toBe(hashGameState(state(), 60));
  });

  it('tick 参与 hash：不同 tick 不会撞成同一个值', () => {
    expect(hashGameState(state(), 60)).not.toBe(hashGameState(state(), 61));
  });

  it('1/1024 像素以内的浮点抖动不报分叉（避免跨 V8 版本误杀）', () => {
    const a = state({ player: { x: 120.5, y: 88.25, face: 0.5 } });
    const b = state({ player: { x: 120.5 + 1e-9, y: 88.25 - 1e-9, face: 0.5 } });
    expect(hashGameState(a, 60)).toBe(hashGameState(b, 60));
  });

  it('真的走位差 1 像素一定报', () => {
    const a = state();
    const b = state({ player: { x: 121.5, y: 88.25, face: 0.5 } });
    expect(hashGameState(a, 60)).not.toBe(hashGameState(b, 60));
  });

  it('血量差一点就报（伤害公式算错必须抓得到）', () => {
    expect(hashGameState(state({ hp: 100 }), 7)).not.toBe(hashGameState(state({ hp: 99 }), 7));
  });

  it('掉落顺序不同不算分叉（两个人捡东西先后不一样）', () => {
    const a = state({ drops: [{ uid: 'd1' }, { uid: 'd2' }] });
    const b = state({ drops: [{ uid: 'd2' }, { uid: 'd1' }] });
    expect(hashGameState(a, 5)).toBe(hashGameState(b, 5));
  });

  it('掉落数量变化要报', () => {
    const a = state({ drops: [{ uid: 'd1' }] });
    const b = state({ drops: [{ uid: 'd1' }, { uid: 'd2' }] });
    expect(hashGameState(a, 5)).not.toBe(hashGameState(b, 5));
  });

  it('死怪不进 hash：打死一只与本来就少一只等价于同一种「场上没有它」', () => {
    const dead = state({
      skeletons: [{ x: 300, y: 200, hp: 40, alive: true }, { x: 500, y: 200, hp: 0, alive: false }],
    });
    const absent = state({ skeletons: [{ x: 300, y: 200, hp: 40, alive: true }] });
    expect(hashGameState(dead, 30)).toBe(hashGameState(absent, 30));
  });

  it('活怪的位置变化要报', () => {
    const a = state();
    const b = state({ skeletons: [{ x: 301, y: 200, hp: 40, alive: true }] });
    expect(hashGameState(a, 30)).not.toBe(hashGameState(b, 30));
  });

  it('NaN / Infinity 不污染 hash（模拟里出现它就是 bug，但不能因此崩在 hash 上）', () => {
    const bad = state({ player: { x: Number.NaN, y: Infinity, face: 0 } });
    expect(() => hashGameState(bad, 1)).not.toThrow();
    expect(hashGameState(bad, 1)).toBe(hashGameState(state({ player: { x: 0, y: 0, face: 0 } }), 1));
  });

  it('quantize 是四舍五入到 1/1024', () => {
    expect(quantize(1)).toBe(1024);
    expect(quantize(-1)).toBe(-1024);
    expect(quantize(0.0004)).toBe(0);
    expect(quantize(Number.NaN)).toBe(0);
  });

  it('hasher 是纯函数式的：同一个 seed 顺序相同结果相同', () => {
    expect(hashWords([1, 2, 3])).toBe(hashWords([1, 2, 3]));
    expect(hashWords([1, 2, 3])).not.toBe(hashWords([3, 2, 1]));
    const h = createHasher();
    h.add(1);
    const a = h.digest();
    h.add(2);
    expect(h.digest()).not.toBe(a);
  });

  it('对账间隔是 60 tick（1 秒）', () => {
    expect(HASH_INTERVAL_TICKS).toBe(60);
  });
});
