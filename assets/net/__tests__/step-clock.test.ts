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

  it('单帧超长时截断到 0.25s，但把该跑完的步都跑完', () => {
    const clock = createStepClock();
    const steps = advanceClock(clock, 4);
    // 0.25 / (1/60) = 15 步
    expect(steps).toBe(15);
    expect(clock.droppedSeconds).toBeCloseTo(3.75, 6);
    expect(clock.stalls).toBe(1);
  });

  it('截断不丢步：多出来的时间是丢掉，不是少跑步', () => {
    const clock = createStepClock();
    advanceClock(clock, 1);
    // 1 秒 = 60 步（1 > 0.25 所以只跑 15 步）
    expect(clock.tick).toBe(15);
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
