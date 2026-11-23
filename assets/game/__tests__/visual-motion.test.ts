import { describe, expect, it } from 'vitest';
import {
  ENTER_STEPS, SNAP_PX, SPEED_CAP, TELEPORT_PX,
  createVisualMotion, resetVisualMotion, stepVisualMotion, syncVisualTarget,
} from '../visual-motion.ts';

/** 联机 / 单机共用的逻辑步长与典型走速（`movement.ts::walk` 的 205 px/s）。 */
const DT = 1 / 24;
const FRAME = 1 / 60;
const V = 205;
/** 一个逻辑步的位移：205 / 24 ≈ 8.542 px。 */
const STEP = V * DT;

describe('visual-motion：稳态必须绝对匀速（呼吸感的判据）', () => {
  it('24 Hz 逻辑 + 60 fps 渲染：每个渲染帧位移恒为 V·dtRender，没有加速帧', () => {
    const m = createVisualMotion(0, 0);
    syncVisualTarget(m, 0, 0, V);

    const deltas: number[] = [];
    let nextLogicAt = DT;
    let target = 0;
    let t = 0;
    for (let i = 0; i < 120; i += 1) {
      t += FRAME;
      // 渲染帧边界向前推进时，把跨过的逻辑帧全部处理掉（与 advanceNet 一致）。
      while (t + 1e-9 >= nextLogicAt) {
        target += STEP;
        syncVisualTarget(m, target, 0, V);
        nextLogicAt += DT;
      }
      const before = m.x;
      stepVisualMotion(m, FRAME, DT);
      deltas.push(m.x - before);
    }

    const moving = deltas.slice(3);
    const expected = V * FRAME;
    for (const d of moving) {
      // 到达那一帧可能只差零点几像素（目标是离散的），允许 0.2px 的收尾余量。
      expect(d).toBeGreaterThan(expected - 0.2);
      expect(d).toBeLessThan(expected + 1e-6);
    }
    // 关键断言：没有任何一帧冲到 1.3V（旧方案每段末尾会冲到 246 px 的位置）。
    expect(Math.max(...moving)).toBeLessThan(V * FRAME + 1e-6);
  });

  it('稳态落后量收敛到一个逻辑步附近，不会逐帧漂大', () => {
    const m = createVisualMotion(0, 0);
    syncVisualTarget(m, 0, 0, V);
    let nextLogicAt = DT;
    let target = 0;
    let t = 0;
    let worstGap = 0;
    for (let i = 0; i < 240; i += 1) {
      t += FRAME;
      while (t + 1e-9 >= nextLogicAt) {
        target += STEP;
        syncVisualTarget(m, target, 0, V);
        nextLogicAt += DT;
      }
      stepVisualMotion(m, FRAME, DT);
      worstGap = Math.max(worstGap, Math.abs(target - m.x));
    }
    expect(worstGap).toBeLessThanOrEqual(ENTER_STEPS * STEP + 1e-6);
  });
});

describe('visual-motion：补帧用 1.3V 平滑拉近', () => {
  it('一次补 6 步：速度封顶 1.3V，不超目标，最终贴住', () => {
    const m = createVisualMotion(0, 0);
    syncVisualTarget(m, 6 * STEP, 0, V);

    const speeds: number[] = [];
    const positions: number[] = [];
    for (let i = 0; i < 120; i += 1) {
      stepVisualMotion(m, FRAME, DT);
      speeds.push(m.lastSpeed);
      positions.push(m.x);
    }

    const cap = SPEED_CAP * V;
    expect(speeds[0]).toBeGreaterThan(V);
    expect(speeds[0]).toBeLessThanOrEqual(cap + 1e-6);
    for (const s of speeds) expect(s).toBeLessThanOrEqual(cap + 1e-6);
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]!).toBeGreaterThanOrEqual(positions[i - 1]! - 1e-9);
      expect(positions[i]!).toBeLessThanOrEqual(6 * STEP + 1e-9);
    }
    expect(m.x).toBeCloseTo(6 * STEP, 6);
    // 追上之后必须回到 0 速度，不能一直抖。
    expect(m.lastSpeed).toBe(0);
  });

  it('追平后回到近区间：速度重新等于 V（滞回不来回切）', () => {
    const m = createVisualMotion(0, 0);
    syncVisualTarget(m, 4 * STEP, 0, V);
    for (let i = 0; i < 200; i += 1) {
      stepVisualMotion(m, FRAME, DT);
      // 目标始终停在 4 步处（模拟"补帧后玩家停住"）。
    }
    // 贴住之后再推一个逻辑步，速度应恢复为 V 而不是继续 1.3V。
    syncVisualTarget(m, 5 * STEP, 0, V);
    stepVisualMotion(m, FRAME, DT);
    expect(m.lastSpeed).toBeCloseTo(V, 6);
  });
});

describe('visual-motion：V = 0 的残差必须能收敛', () => {
  it('顶墙 / 到点：本段没有位移时用 Vt 收掉残差，不卡住', () => {
    const m = createVisualMotion(0, 0);
    syncVisualTarget(m, STEP, 0, 0);
    let frames = 0;
    while (Math.abs(m.x - STEP) > SNAP_PX && frames < 60) {
      stepVisualMotion(m, FRAME, DT);
      frames += 1;
    }
    expect(frames).toBeLessThan(30);
    expect(m.x).toBeCloseTo(STEP, 6);
  });

  it('残差收敛不会越过目标', () => {
    const m = createVisualMotion(0, 0);
    syncVisualTarget(m, STEP, 0, 0);
    for (let i = 0; i < 60; i += 1) {
      stepVisualMotion(m, FRAME, DT);
      expect(m.x).toBeLessThanOrEqual(STEP + 1e-9);
    }
  });
});

describe('visual-motion：不连续位移直接硬切', () => {
  it('传送 / 复活 / 换图：超过阈值立刻贴到目标，不跨图滑行', () => {
    const m = createVisualMotion(100, 100);
    syncVisualTarget(m, 100 + TELEPORT_PX + 1, 100, V);
    expect(m.x).toBe(100 + TELEPORT_PX + 1);
    expect(m.y).toBe(100);
    expect(m.speed).toBe(0);
    expect(m.lastSpeed).toBe(0);
  });

  it('resetVisualMotion 清掉速度与滞回状态', () => {
    const m = createVisualMotion(0, 0);
    syncVisualTarget(m, 3 * STEP, 0, V);
    stepVisualMotion(m, FRAME, DT);
    resetVisualMotion(m, 50, 60);
    expect(m).toMatchObject({ x: 50, y: 60, targetX: 50, targetY: 60, speed: 0, chasing: false });
  });
});

describe('visual-motion：单帧位移受剩余距离夹住', () => {
  it('大 dtRender + 高速不会冲过目标', () => {
    const m = createVisualMotion(0, 0);
    // 闪避 560 px/s，一帧 50 ms 理论位移 28 px，但只剩 5 px。
    syncVisualTarget(m, 5, 0, 560);
    stepVisualMotion(m, 0.05, DT);
    expect(m.x).toBeCloseTo(5, 9);
  });

  it('非法 dtRender / dt 不产生 NaN', () => {
    const m = createVisualMotion(10, 20);
    syncVisualTarget(m, 30, 40, V);
    expect(stepVisualMotion(m, Number.NaN, DT)).toEqual({ x: 10, y: 20 });
    expect(stepVisualMotion(m, FRAME, 0)).toEqual({ x: 10, y: 20 });
    expect(Number.isFinite(m.x) && Number.isFinite(m.y)).toBe(true);
  });
});
