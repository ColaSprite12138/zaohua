import { describe, expect, it } from 'vitest';
import {
  MAX_CATCHUP_STEPS, NET_DT, NET_HZ, SOLO_DT, SOLO_HZ,
  addTime, advanceClock, clearDebt, createStepClock, forceStep, markExecuted,
  seekClock, setRate, takeStep,
} from '../step-clock.ts';

describe('固定步长时钟：两种帧率', () => {
  it('默认是联机帧率（服务器定帧），单机要显式传 SOLO_HZ', () => {
    expect(createStepClock().hz).toBe(NET_HZ);
    expect(createStepClock().dt).toBe(NET_DT);
    expect(createStepClock(SOLO_HZ).hz).toBe(SOLO_HZ);
    expect(createStepClock(SOLO_HZ).dt).toBe(SOLO_DT);
  });

  it('帧率正好对上时，每帧恰好推一步', () => {
    for (const hz of [NET_HZ, SOLO_HZ]) {
      const clock = createStepClock(hz);
      let total = 0;
      for (let i = 0; i < 120; i += 1) total += advanceClock(clock, 1 / hz);
      expect(total).toBe(120);
      expect(clock.tick).toBe(120);
    }
  });

  it('高刷机器多帧推一步，整 1 秒后步数等于帧率', () => {
    for (const hz of [NET_HZ, SOLO_HZ]) {
      const clock = createStepClock(hz);
      let steps = 0;
      // 144 帧 × (1/144) 秒 = 整 1 秒
      for (let i = 0; i < 144; i += 1) steps += advanceClock(clock, 1 / 144);
      // 允许 ±1 步的取整误差，但绝不能差出 2 步
      expect(Math.abs(steps - hz)).toBeLessThanOrEqual(1);
    }
  });

  it('同样 1 秒、不同切分方式，步数相同（这是帧同步的命根子）', () => {
    const a = createStepClock(SOLO_HZ);
    const b = createStepClock(SOLO_HZ);
    for (let i = 0; i < 60; i += 1) advanceClock(a, 1 / 60);
    for (let i = 0; i < 240; i += 1) advanceClock(b, 1 / 240);
    expect(a.tick).toBe(b.tick);
  });

  it('从联机帧率切回单机，零头和 dt 都换过来', () => {
    const clock = createStepClock(NET_HZ);
    advanceClock(clock, 0.01); // 攒一点不足一步的零头
    expect(clock.acc).toBeGreaterThan(0);
    setRate(clock, SOLO_HZ);
    // 一半 24 Hz 的余数拿到 60 Hz 下没有意义，必须清掉。
    expect(clock.acc).toBe(0);
    expect(clock.hz).toBe(SOLO_HZ);
    expect(clock.dt).toBe(SOLO_DT);
  });
});

describe('固定步长时钟：追帧上限按**步数**而不是秒数', () => {
  it('两种帧率下单帧最多都补 MAX_CATCHUP_STEPS 步', () => {
    for (const hz of [NET_HZ, SOLO_HZ]) {
      const clock = createStepClock(hz);
      // 喂 4 秒（远超上限），只应补上限那么多步。
      const steps = advanceClock(clock, 4);
      expect(steps).toBe(MAX_CATCHUP_STEPS);
      // 多出来的时间是**丢掉**（记 droppedSeconds），不是少跑步。
      expect(clock.droppedSeconds).toBeCloseTo(4 - MAX_CATCHUP_STEPS / hz, 6);
      expect(clock.stalls).toBe(1);
    }
  });

  it('60 Hz 下单帧上限就是 0.1 秒（不会被 24 Hz 的 0.25 秒带偏）', () => {
    const clock = createStepClock(SOLO_HZ);
    advanceClock(clock, 1);
    // 0.1 秒 / (1/60) = 6 步。若沿用 0.25 s 会变成 15 步，单帧工作量翻 2.5 倍。
    expect(clock.tick).toBe(6);
    expect(clock.acc).toBeLessThan(SOLO_DT);
  });

  it('上限之外的时间不会被吃进累加器', () => {
    for (const hz of [NET_HZ, SOLO_HZ]) {
      const clock = createStepClock(hz);
      advanceClock(clock, (MAX_CATCHUP_STEPS / hz) * 2);
      expect(clock.acc).toBeLessThan(clock.dt);
    }
  });
});

describe('固定步长时钟：边界', () => {
  it('负数和 NaN 当作 0，不会把时钟倒回去', () => {
    const clock = createStepClock(SOLO_HZ);
    advanceClock(clock, SOLO_DT);
    const before = clock.tick;
    expect(advanceClock(clock, -1)).toBe(0);
    expect(advanceClock(clock, Number.NaN)).toBe(0);
    expect(clock.tick).toBe(before);
  });

  it('seekClock 把时间轴直接对齐到指定 tick', () => {
    const clock = createStepClock(NET_HZ);
    advanceClock(clock, 0.1);
    seekClock(clock, 900);
    expect(clock.tick).toBe(900);
    expect(clock.acc).toBe(0);
  });

  it('forceStep 不等墙钟：acc 欠账由后续 addTime 填回', () => {
    const clock = createStepClock(NET_HZ);
    // 追帧：连跑 5 步，一步墙钟时间都没吃进来
    for (let i = 0; i < 5; i += 1) forceStep(clock);
    expect(clock.tick).toBe(5);
    expect(clock.acc).toBeCloseTo(-5 * NET_DT, 9);
    // 之后按实时喂 2 步的时间：只补得回 2 步的账，tick 不会回退
    addTime(clock, 2 * NET_DT);
    expect(clock.tick).toBe(5);
    expect(clock.acc).toBeCloseTo(-3 * NET_DT, 9);
    // 攒够一步才能再走 —— 证明负 acc 不会凭空变出步数
    expect(advanceClock(clock, 4 * NET_DT)).toBe(1);
    expect(clock.tick).toBe(6);
  });
});

/*
 * 追帧欠账必须能被清掉（2026-11-22 用户实测「切后台回来走完补帧，之后一直卡」）。
 *
 * `forceStep` 每步扣一个 `dt`，而 `addTime` 每帧只加真实帧间隔。积压卡在
 * 触发/退出之间时 `acc` 单调变负 —— 负了之后非追帧分支一步都走不了，
 * `renderAlpha` 也恒为 0（无插值），画面变成 24Hz 逐帧跳，而渲染/执行帧率
 * 全都显示正常。`clearDebt` 就是那个封顶。
 */
describe('clearDebt：追帧欠账封顶', () => {
  it('连续 forceStep 让 acc 变负，clearDebt 归零', () => {
    const c = createStepClock(24);
    for (let i = 0; i < 5; i += 1) forceStep(c);
    expect(c.acc).toBeLessThan(0);
    clearDebt(c);
    expect(c.acc).toBe(0);
  });

  it('正余额不动（不能把攒好的时间抹掉）', () => {
    const c = createStepClock(24);
    addTime(c, c.dt * 0.5);
    const before = c.acc;
    expect(before).toBeGreaterThan(0);
    clearDebt(c);
    expect(c.acc).toBe(before);
  });

  it('清完之后 takeStep 仍按墙钟节奏走（不会因为清零而丢步或暴走）', () => {
    const c = createStepClock(24);
    for (let i = 0; i < 8; i += 1) forceStep(c);
    clearDebt(c);
    // 攒满一步就该走一步，且只走一步。
    addTime(c, c.dt);
    expect(takeStep(c)).toBe(true);
    expect(takeStep(c)).toBe(false);
  });
});

/**
 * 低延迟临时模式（2026-11-23）：执行由服务器帧到达驱动，不再等 `acc` 攒满。
 * 最大的风险是 `acc` 被扣成负数或恒 0 —— `renderAlpha` 会永远返回 0，
 * 画面退化成 24 Hz 逐帧跳，而渲染/执行帧率数字全都正常。
 */
describe('markExecuted：执行由广播驱动，插值相位仍由真实时间推进', () => {
  it('每执行一步 tick +1、acc 归零，随后 alpha 能从 0 涨到 1', () => {
    const c = createStepClock(NET_HZ);
    addTime(c, NET_DT * 3); // 收包前攒了不少墙钟时间
    markExecuted(c);
    expect(c.tick).toBe(1);
    expect(c.acc).toBe(0);
    // 归零后由真实时间推进（等价于 renderAlpha(acc, dt)，它把值夹在 [0,1]）
    addTime(c, NET_DT * 0.5);
    expect(c.acc / c.dt).toBeCloseTo(0.5, 6);
    addTime(c, NET_DT * 0.5);
    expect(c.acc / c.dt).toBeCloseTo(1, 6);
    // 下一帧到达：再走一步，相位重新从 0 开始
    markExecuted(c);
    expect(c.tick).toBe(2);
    expect(c.acc / c.dt).toBe(0);
  });
});
