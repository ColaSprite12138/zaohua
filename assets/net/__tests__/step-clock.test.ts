import { describe, expect, it } from 'vitest';
import {
  FIXED_DT, MAX_FRAME_DELTA, advanceClock, createStepClock, seekClock,
} from '../step-clock.ts';

describe('固定步长时钟', () => {
  it('60Hz 的机器每帧恰好推一步', () => {
    const clock = createStepClock();
    let total = 0;
    // 1/60 秒 × 120 帧
    for (let i = 0; i < 120; i += 1) total += advanceClock(clock, 1 / 60);
    expect(total).toBe(120);
    expect(clock.tick).toBe(120);
  });

  it('144Hz 的机器两帧推一步，一百帧后步数与 60Hz 一致', () => {
    const clock = createStepClock();
    let steps = 0;
    // 144 帧 × (1/144) 秒 = 整 1 秒 = 60 个逻辑步
    for (let i = 0; i < 144; i += 1) steps += advanceClock(clock, 1 / 144);
    // 允许 ±1 步的取整误差，但绝不能差出 2 步
    expect(Math.abs(steps - 60)).toBeLessThanOrEqual(1);
  });

  it('同样的总时长、不同的帧率切分，步数相同（这是帧同步的命根子）', () => {
    const a = createStepClock();
    const b = createStepClock();
    for (let i = 0; i < 60; i += 1) advanceClock(a, 1 / 60);
    for (let i = 0; i < 240; i += 1) advanceClock(b, 1 / 240);
    expect(a.tick).toBe(b.tick);
  });

  it('单帧超长时截断到 MAX_FRAME_DELTA，但把该跑完的步都跑完', () => {
    const clock = createStepClock();
    const steps = advanceClock(clock, 4);
    // 截断窗口由 MAX_FRAME_DELTA 决定（现在是 0.1s = 6 步）。
    // 它压小的理由写在 step-clock.ts 的注释里：15 步的补帧在联机时会变成卡顿尖峰。
    const expected = Math.round(MAX_FRAME_DELTA / FIXED_DT);
    expect(steps).toBe(expected);
    expect(clock.droppedSeconds).toBeCloseTo(4 - MAX_FRAME_DELTA, 6);
    expect(clock.stalls).toBe(1);
  });

  it('截断不丢步：多出来的时间是丢掉，不是少跑步', () => {
    const clock = createStepClock();
    advanceClock(clock, 1);
    // 1 秒远超截断窗口，所以只推进截断窗口内的那些步。
    expect(clock.tick).toBe(Math.round(MAX_FRAME_DELTA / FIXED_DT));
    expect(clock.acc).toBeLessThan(FIXED_DT);
  });

  it('负数和 NaN 当作 0，不会把时钟倒回去', () => {
    const clock = createStepClock();
    advanceClock(clock, 1 / 60);
    const before = clock.tick;
    expect(advanceClock(clock, -1)).toBe(0);
    expect(advanceClock(clock, Number.NaN)).toBe(0);
    expect(clock.tick).toBe(before);
  });

  it('seekClock 把时间轴直接对齐到指定 tick', () => {
    const clock = createStepClock();
    advanceClock(clock, 0.1);
    seekClock(clock, 900);
    expect(clock.tick).toBe(900);
    expect(clock.acc).toBe(0);
  });

  it('MAX_FRAME_DELTA 之外的时间不会被吃进累加器', () => {
    const clock = createStepClock();
    advanceClock(clock, MAX_FRAME_DELTA * 2);
    expect(clock.acc).toBeLessThan(FIXED_DT);
  });
});
