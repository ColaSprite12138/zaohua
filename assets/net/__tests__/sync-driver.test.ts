import { describe, expect, it } from 'vitest';
import { emptyInputFrame, type InputFrame } from '../input-frame.ts';
import {
  accept, canStep, contiguous, createSyncDriver, missingRange,
  pendingTicks, requestReplay, reset, take, type FramePacket, type SyncDriver,
} from '../sync-driver.ts';

function frame(tick = 0): InputFrame {
  return emptyInputFrame(tick);
}

/** 一帧「全员广播」：只有一个玩家，内容不重要，驱动层不看内容。 */
function packet(tick: number): FramePacket {
  return { tick, frames: new Map([['p1', frame(tick)]]) };
}

/** 依次收进来（模拟实时流顺序到达），不执行。 */
function feed(d: SyncDriver, ...ticks: number[]): void {
  for (const tick of ticks) accept(d, packet(tick));
}

describe('sync-driver：只执行服务器广播的连续帧', () => {
  it('连续帧依次执行，nextTick 一帧一帧前进', () => {
    const d = createSyncDriver(0, 1);
    feed(d, 0, 1, 2);
    expect(take(d)?.tick).toBe(0);
    expect(take(d)?.tick).toBe(1);
    expect(take(d)?.tick).toBe(2);
    expect(take(d)).toBeNull();
    expect(d.nextTick).toBe(3);
  });

  it('缺帧时既不能执行也不能跳过去', () => {
    const d = createSyncDriver(0, 1);
    feed(d, 0, 2, 3); // 1 没到
    expect(take(d)?.tick).toBe(0);
    // 1 不在手里：2、3 再齐也不能执行
    expect(canStep(d)).toBe(false);
    expect(take(d)).toBeNull();
    expect(d.nextTick).toBe(1);
    expect(contiguous(d)).toBe(0);
  });

  it('nextTick 永远不会超过服务器已广播的最大帧号', () => {
    const d = createSyncDriver(0, 1);
    feed(d, 0, 1);
    take(d);
    take(d);
    expect(d.nextTick).toBe(2);
    expect(d.highestSeen).toBe(1);
    // 没有新帧就一帧都推不动
    expect(take(d)).toBeNull();
    expect(d.nextTick).toBeLessThanOrEqual(d.highestSeen + 1);
  });

  it('播放缓冲 lookahead=2：只来一帧先不执行，第二帧到了才开始', () => {
    const d = createSyncDriver(0, 2);
    feed(d, 0);
    expect(canStep(d)).toBe(false);
    expect(take(d)).toBeNull();
    expect(d.nextTick).toBe(0);
    feed(d, 1);
    expect(canStep(d)).toBe(true);
    expect(take(d)?.tick).toBe(0);
  });
});

describe('sync-driver：缺口与补帧', () => {
  it('看到更高的帧号才知道有洞', () => {
    const d = createSyncDriver(0, 1);
    expect(missingRange(d)).toBeNull(); // 一帧都没收到
    feed(d, 0);
    expect(missingRange(d)).toBeNull(); // 连续顶到 0，没有洞
    feed(d, 1, 3);
    take(d);
    take(d);
    // 现在 nextTick=2，手里没有 2、最高看到 3
    expect(missingRange(d)).toEqual({ from: 2, to: 3 });
    expect(pendingTicks(d)).toEqual([2]);
  });

  it('补帧块到了就依次快进，不跳帧', () => {
    const d = createSyncDriver(0, 1);
    feed(d, 0, 1, 4);
    take(d);
    take(d);
    expect(missingRange(d)).toEqual({ from: 2, to: 4 });
    // 补帧块回来（2、3、4 一起）
    feed(d, 2, 3, 4);
    const executed: number[] = [];
    for (let f = take(d); f !== null; f = take(d)) executed.push(f.tick);
    expect(executed).toEqual([2, 3, 4]);
    expect(d.nextTick).toBe(5);
  });

  it('同一缺口只请求一次，起点变了或超时才重发', () => {
    const d = createSyncDriver(0, 1);
    feed(d, 0, 2);
    take(d);
    const first = requestReplay(d, 1000);
    expect(first).toEqual({ from: 1, to: 2 });
    // 100ms 后：同一缺口，不重复打服务器
    expect(requestReplay(d, 1100)).toBeNull();
    // 又收到 3：洞的**终点**变大了（1..2 → 1..3），但起点没变。
    //
    // 这**不构成**重发理由：一次请求要的是 `from..from+120`，服务器按块回，
    // 终点长大本来就在覆盖范围内。若按「终点变了就重发」，`highestSeen` 每帧
    // 都在长，就变成每渲染帧打一次服务器。
    feed(d, 3);
    expect(requestReplay(d, 1200)).toBeNull();
    // 请求可能丢：超过 retry 时间允许重发
    expect(requestReplay(d, 1200 + 600)).toEqual({ from: 1, to: 3 });
    expect(d.replays).toBe(2);
  });

  it('补帧填上洞之后不再请求', () => {
    const d = createSyncDriver(0, 1);
    feed(d, 0, 1);
    take(d);
    take(d);
    expect(missingRange(d)).toBeNull();
    expect(requestReplay(d, 5000)).toBeNull();
    expect(d.replayAskedFor).toBeNull();
  });
});

describe('sync-driver：迟到帧与重复帧', () => {
  it('已执行过的帧再来一次：记 stale，不回滚', () => {
    const d = createSyncDriver(0, 1);
    feed(d, 0, 1);
    take(d);
    take(d);
    expect(accept(d, packet(0))).toBe('stale');
    expect(d.stale).toBe(1);
    expect(d.nextTick).toBe(2);
  });

  it('同一帧重复到达：记 duplicate，不覆盖、不重复执行', () => {
    const d = createSyncDriver(0, 1);
    expect(accept(d, packet(0))).toBe('accepted');
    expect(accept(d, packet(0))).toBe('duplicate');
    expect(d.duplicates).toBe(1);
    expect(take(d)?.tick).toBe(0);
    expect(take(d)).toBeNull();
  });

  it('reset 能把指针挪到新开局', () => {
    const d = createSyncDriver(0, 2);
    feed(d, 0, 1, 2);
    take(d);
    reset(d, 100);
    expect(d.nextTick).toBe(100);
    expect(d.highestSeen).toBe(99);
    expect(d.buffer.size).toBe(0);
    expect(d.lookahead).toBe(2);
  });
});
