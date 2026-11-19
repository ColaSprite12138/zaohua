import { describe, expect, it } from 'vitest';
import {
  capture, createInputLatch, emptyRawInput, take, type RawInput,
} from '../input-latch.ts';
import { NO_SKILL } from '../input-frame.ts';

const raw = (patch: Partial<RawInput> = {}): RawInput => ({ ...emptyRawInput(), ...patch });

describe('input-latch', () => {
  it('同一渲染帧跑 3 个逻辑步，点击边沿只给第一步', () => {
    const latch = createInputLatch();
    capture(latch, raw({ pointerDown: true, mouse: { x: 10, y: 20 } }));
    expect(take(latch, 0).pointerDown).toBe(true);
    expect(take(latch, 1).pointerDown).toBe(false);
    expect(take(latch, 2).pointerDown).toBe(false);
    // 持续态在后续步里仍然成立。
    expect(take(latch, 3).mouse).toEqual({ x: 10, y: 20 });
  });

  it('等齐期间连续几帧没有逻辑步，点击边沿不会丢失（联机回归）', () => {
    const latch = createInputLatch();
    capture(latch, raw({ pointerDown: true, mouse: { x: 100, y: 200 } }));
    // 这 3 帧引擎照样渲染、照样 capture，但 runnableTick 为 null，不调 take。
    capture(latch, raw());
    capture(latch, raw());
    capture(latch, raw({ pointerHeld: true }));
    const frame = take(latch, 7);
    expect(frame.pointerDown).toBe(true);
    expect(frame.mouse).toEqual({ x: 100, y: 200 });
    expect(frame.pointerHeld).toBe(true);
    // 取走一次之后不能重复生效。
    expect(take(latch, 8).pointerDown).toBe(false);
  });

  it('多帧内的多个不同边沿会合并在同一次 take 里，且不重复', () => {
    const latch = createInputLatch();
    capture(latch, raw({ pointerDown: true }));
    capture(latch, raw({ dodge: true }));
    capture(latch, raw({ healPotion: true, skill: 3 }));
    const frame = take(latch, 0);
    expect(frame.pointerDown).toBe(true);
    expect(frame.dodge).toBe(true);
    expect(frame.healPotion).toBe(true);
    expect(frame.skill).toBe(3);
    const next = take(latch, 1);
    expect(next.dodge).toBe(false);
    expect(next.skill).toBe(NO_SKILL);
  });

  it('mouse 为 null 的帧沿用上一个已知位置（sticky）', () => {
    const latch = createInputLatch();
    capture(latch, raw({ mouse: { x: 321, y: 654 } }));
    capture(latch, raw());
    expect(take(latch, 0).mouse).toEqual({ x: 321, y: 654 });
  });
});
