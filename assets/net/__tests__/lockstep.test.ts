import { describe, expect, it } from 'vitest';
import { emptyInputFrame, type InputFrame } from '../input-frame.ts';
import {
  addPeer, createLockstep, noteWait, pendingPeers, pruneBefore, pushLocal, pushRemote,
  retirePeer, runnableTick, seek, take,
} from '../lockstep.ts';

function frame(tick: number, tag = 0): InputFrame {
  return { ...emptyInputFrame(tick), skill: tag };
}

/** 单机场景：没有 peer，本地帧一到就能推进。 */
function solo() {
  return createLockstep({ localId: 'me', localDelay: 0 });
}

describe('确定性锁步队列', () => {
  it('单机（无 peer）本地帧一到就能推进', () => {
    const ls = solo();
    expect(runnableTick(ls)).toBeNull();
    pushLocal(ls, frame(0));
    expect(runnableTick(ls)).toBe(0);
    const inputs = take(ls);
    expect(inputs!.tick).toBe(0);
    expect(inputs!.local.tick).toBe(0);
    expect(ls.tick).toBe(1);
  });

  it('有 peer 时缺帧就不推进（而不是拿空输入顶上）', () => {
    const ls = createLockstep({ localId: 'A', localDelay: 0 });
    addPeer(ls, 'B');
    pushLocal(ls, frame(0));
    expect(runnableTick(ls)).toBeNull();
    expect(pendingPeers(ls)).toEqual(['B']);
    // 关键断言：等不到就是等不到，绝不自己往前跑
    expect(take(ls)).toBeNull();
    expect(ls.tick).toBe(0);
  });

  it('两端帧齐了才推进，取出的是同一 tick 的两份输入', () => {
    const ls = createLockstep({ localId: 'A', localDelay: 0 });
    addPeer(ls, 'B');
    pushLocal(ls, frame(0, 1));
    pushRemote(ls, 'B', frame(0, 2));
    const inputs = take(ls)!;
    expect(inputs.local.skill).toBe(1);
    expect(inputs.remote.get('B')!.skill).toBe(2);
    expect(ls.tick).toBe(1);
  });

  it('迟到帧（tick 已推进过）被丢弃并计数', () => {
    const ls = solo();
    pushLocal(ls, frame(0));
    take(ls);
    expect(pushRemote(ls, 'B', frame(0))).toBe('late');
    expect(ls.lateFrames).toBe(1);
  });

  it('重复帧被单独计数（可靠的 WS 上出现就是协议接错了）', () => {
    const ls = createLockstep({ localId: 'A', localDelay: 0 });
    addPeer(ls, 'B');
    expect(pushRemote(ls, 'B', frame(3))).toBe('accepted');
    expect(pushRemote(ls, 'B', frame(3))).toBe('duplicate');
    expect(ls.duplicateFrames).toBe(1);
  });

  it('服务端宣布某 peer 掉线后，从该 tick 起不再欠它的帧', () => {
    const ls = createLockstep({ localId: 'A', localDelay: 0 });
    addPeer(ls, 'B');
    pushLocal(ls, frame(0));
    pushRemote(ls, 'B', frame(0));
    take(ls);

    retirePeer(ls, 'B', 1);
    pushLocal(ls, frame(1));
    // B 掉线了，tick 1 不等它
    expect(runnableTick(ls)).toBe(1);
    const inputs = take(ls)!;
    expect(inputs.remote.has('B')).toBe(false);
  });

  it('掉线生效之前的 tick 仍然要等（不能借掉线跳帧）', () => {
    const ls = createLockstep({ localId: 'A', localDelay: 0 });
    addPeer(ls, 'B');
    retirePeer(ls, 'B', 5);
    pushLocal(ls, frame(0));
    expect(runnableTick(ls)).toBeNull();
    expect(pendingPeers(ls)).toEqual(['B']);
  });

  it('掉线后重新入座会撤销掉线标记', () => {
    const ls = createLockstep({ localId: 'A', localDelay: 0 });
    addPeer(ls, 'B');
    retirePeer(ls, 'B', 0);
    expect(pendingPeers(ls)).toEqual([]);
    addPeer(ls, 'B');
    expect(pendingPeers(ls)).toEqual(['B']);
  });

  it('localDelay 让本地帧先攒着，推进从 0 开始', () => {
    const ls = createLockstep({ localId: 'A', localDelay: 3 });
    expect(ls.tick).toBe(0);
    expect(ls.submitTick).toBe(3);
    pushLocal(ls, frame(3));
    // tick 0 没有本地帧 → 不能推进（说明本地帧也走同一条延迟队列）
    expect(runnableTick(ls)).toBeNull();
    pushLocal(ls, frame(0));
    expect(runnableTick(ls)).toBe(0);
  });

  it('推进之后 submitTick 保持领先 localDelay 个 tick', () => {
    const ls = createLockstep({ localId: 'A', localDelay: 3 });
    pushLocal(ls, frame(0));
    take(ls);
    expect(ls.tick).toBe(1);
    expect(ls.submitTick).toBeGreaterThanOrEqual(4);
  });

  it('seek 把整条时间轴平移到 startTick（开局对齐用）', () => {
    const ls = createLockstep({ localId: 'A', localDelay: 3 });
    pushLocal(ls, frame(0));
    take(ls);
    seek(ls, 1000);
    expect(ls.tick).toBe(1000);
    expect(ls.submitTick).toBe(1003);
    expect(ls.localFrames.size).toBe(0);
  });

  it('等待计时：缺帧时累积，补齐后归零', () => {
    const ls = createLockstep({ localId: 'A', localDelay: 0 });
    addPeer(ls, 'B');
    pushLocal(ls, frame(0));
    expect(noteWait(ls, 1000)).toBe(0);
    expect(noteWait(ls, 1050)).toBe(50);
    expect(noteWait(ls, 1200)).toBe(200);
    expect(ls.longestWaitMs).toBe(200);
    pushRemote(ls, 'B', frame(0));
    expect(noteWait(ls, 1300)).toBe(0);
    expect(ls.waitingSinceMs).toBeNull();
  });

  it('pruneBefore 清掉陈旧的本地与远端帧，不碰当前 tick', () => {
    const ls = createLockstep({ localId: 'A', localDelay: 0 });
    for (let t = 0; t < 5; t += 1) pushLocal(ls, frame(t));
    pushRemote(ls, 'B', frame(0));
    pushRemote(ls, 'B', frame(1));
    const dropped = pruneBefore(ls, 3);
    // 本地 0/1/2 三个 + 远端 0/1 两个
    expect(dropped).toBe(5);
    expect([...ls.localFrames.keys()]).toEqual([3, 4]);
  });

  it('同 tick 两份本地帧只有第一份生效（重复采样不覆盖）', () => {
    const ls = solo();
    expect(pushLocal(ls, frame(0, 1))).toBe(true);
    expect(pushLocal(ls, frame(0, 9))).toBe(false);
    expect(take(ls)!.local.skill).toBe(1);
  });

  it('构造顺序不同、结果相同：B 先入队还是先推送都不影响推进', () => {
    const a = createLockstep({ localId: 'A', localDelay: 0 });
    const b = createLockstep({ localId: 'A', localDelay: 0 });
    addPeer(a, 'B');
    pushLocal(a, frame(0, 1));
    pushRemote(a, 'B', frame(0, 2));

    pushRemote(b, 'B', frame(0, 2));
    addPeer(b, 'B');
    pushLocal(b, frame(0, 1));

    expect(take(a)!.remote.get('B')!.skill).toBe(take(b)!.remote.get('B')!.skill);
  });
});
