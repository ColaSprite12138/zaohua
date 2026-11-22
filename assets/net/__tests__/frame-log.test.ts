import { describe, expect, it } from 'vitest';
import {
  MAX_PENDING_PER_PLAYER,
  advanceFrame,
  backlog,
  createFrameLog,
  forgetPlayer,
  intentAt,
  sliceHistory,
  submitIntent,
} from '../frame-log.ts';
import { emptyInputFrame, type InputFrame } from '../input-frame.ts';

function intent(seq: number, pointerDown = false): InputFrame {
  return { ...emptyInputFrame(seq), pointerDown };
}

describe('frame-log：帧号只由服务器推进', () => {
  it('没有任何意图也照样推进', () => {
    const log = createFrameLog();
    expect(log.frame).toBe(-1);
    expect(advanceFrame(log)).toBe(0);
    expect(advanceFrame(log)).toBe(1);
    expect(advanceFrame(log)).toBe(2);
    // 一帧输入都没收到，但帧号照走 —— 这就是「绝不等待客户端」。
    expect(log.history.size).toBe(0);
    expect(log.stats.frames).toBe(3);
  });

  it('submitIntent 本身不推进帧号', () => {
    const log = createFrameLog();
    submitIntent(log, 'a', intent(0));
    expect(log.frame).toBe(-1);
    expect(backlog(log)).toEqual([{ playerId: 'a', depth: 1 }]);
  });
});

describe('frame-log：意图按到达顺序贴帧', () => {
  it('连续三次申报落在连续三帧上，一个都不丢', () => {
    const log = createFrameLog();
    submitIntent(log, 'a', intent(0, true));
    submitIntent(log, 'a', intent(1));
    submitIntent(log, 'a', intent(2, true));

    advanceFrame(log);
    advanceFrame(log);
    advanceFrame(log);

    // 第一帧和第三帧有按下，第二帧没有 —— 顺序原样保留。
    expect(intentAt(log, 0, 'a')?.pointerDown).toBe(true);
    expect(intentAt(log, 1, 'a')?.pointerDown).toBe(false);
    expect(intentAt(log, 2, 'a')?.pointerDown).toBe(true);
    expect(log.stats.applied).toBe(3);
    expect(log.stats.dropped).toBe(0);
  });

  it('队列攒得比帧钟快时，后面的意图依次往后贴（不覆盖、不丢）', () => {
    const log = createFrameLog();
    for (let i = 0; i < 5; i += 1) submitIntent(log, 'a', intent(i));
    advanceFrame(log);
    expect(log.frame).toBe(0);
    expect(intentAt(log, 0, 'a')?.seq).toBe(0);
    // 还剩 4 条没贴。
    expect(backlog(log)).toEqual([{ playerId: 'a', depth: 4 }]);
    advanceFrame(log);
    expect(intentAt(log, 1, 'a')?.seq).toBe(1);
  });

  it('两个玩家的队列互相独立', () => {
    const log = createFrameLog();
    submitIntent(log, 'a', intent(0));
    submitIntent(log, 'b', intent(0));
    submitIntent(log, 'b', intent(1));
    advanceFrame(log);
    advanceFrame(log);
    // 第 0 帧两人都有意图；第 1 帧只有 b（a 队列空了，不写 = 空输入）。
    expect(intentAt(log, 0, 'a')).toBeDefined();
    expect(intentAt(log, 1, 'a')).toBeUndefined();
    expect(intentAt(log, 1, 'b')?.seq).toBe(1);
  });

  it('某帧全员没意图时不建空行（省内存，读不到就是空输入）', () => {
    const log = createFrameLog();
    submitIntent(log, 'a', intent(0));
    advanceFrame(log);
    advanceFrame(log);
    advanceFrame(log);
    expect(log.history.has(0)).toBe(true);
    expect(log.history.has(1)).toBe(false);
    expect(log.history.has(2)).toBe(false);
  });
});

describe('frame-log：队列上限与离场', () => {
  it('灌太多只丢最旧的，且记 dropped', () => {
    const log = createFrameLog();
    for (let i = 0; i < MAX_PENDING_PER_PLAYER + 3; i += 1) submitIntent(log, 'a', intent(i));
    expect(backlog(log)[0]!.depth).toBe(MAX_PENDING_PER_PLAYER);
    expect(log.stats.dropped).toBe(3);
    advanceFrame(log);
    // 丢掉的是最旧的三条，队首从 seq=3 开始。
    expect(intentAt(log, 0, 'a')?.seq).toBe(3);
  });

  it('离场清掉待贴队列，但历史保持原样', () => {
    const log = createFrameLog();
    submitIntent(log, 'a', intent(0));
    advanceFrame(log);
    submitIntent(log, 'a', intent(1));
    forgetPlayer(log, 'a');
    expect(backlog(log)).toEqual([]);
    expect(intentAt(log, 0, 'a')).toBeDefined();
    expect(advanceFrame(log)).toBe(1);
    expect(intentAt(log, 1, 'a')).toBeUndefined();
  });
});

describe('frame-log：历史切片（补帧的唯一来源）', () => {
  it('取区间两端都含，空帧也补齐（players 为空表）', () => {
    const log = createFrameLog();
    submitIntent(log, 'a', intent(0));
    advanceFrame(log);           // tick 0 有
    advanceFrame(log);           // tick 1 空
    submitIntent(log, 'a', intent(2));
    advanceFrame(log);           // tick 2 有

    const slice = sliceHistory(log, 0, 2);
    // **每一帧都要给**：跳过空帧，客户端会以为那些 tick 还缺，于是反复请求同一段。
    expect(slice.map((f) => f.tick)).toEqual([0, 1, 2]);
    expect(slice[0]!.players.get('a')?.seq).toBe(0);
    expect(slice[1]!.players.size).toBe(0);
    expect(slice[2]!.players.get('a')?.seq).toBe(2);
  });

  it('请求超过当前帧号时夹到已有范围，不返回未来帧', () => {
    const log = createFrameLog();
    submitIntent(log, 'a', intent(0));
    advanceFrame(log);
    // 客户端可能刚连上就报了个很大的帧号。
    const slice = sliceHistory(log, 0, 9999);
    expect(slice.map((f) => f.tick)).toEqual([0]);
  });

  it('from 大于 to 时自动交换', () => {
    const log = createFrameLog();
    for (let i = 0; i < 4; i += 1) {
      submitIntent(log, 'a', intent(i));
      advanceFrame(log);
    }
    const slice = sliceHistory(log, 3, 1);
    expect(slice.map((f) => f.tick)).toEqual([1, 2, 3]);
  });

  it('分块取：120 帧一块，第二块从下一帧继续', () => {
    const log = createFrameLog();
    for (let i = 0; i < 200; i += 1) {
      submitIntent(log, 'a', intent(i));
      advanceFrame(log);
    }
    const first = sliceHistory(log, 0, 119);
    const second = sliceHistory(log, 120, 199);
    expect(first).toHaveLength(120);
    expect(second).toHaveLength(80);
    expect(second[0]!.tick).toBe(120);
  });
});
