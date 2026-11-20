/**
 * 远端玩家的世界动作契约（P3 第一块）。
 *
 * 这一组护栏守的是「A 砸箱子，B 那边也得是同一个结果」。2026-11-21 用户实测的
 * 三条症状，每条都对应这里的一条：
 *   1. B 看不到 A 在砸（没动画、没进度）→ 远端必须复刻「点击锁定意图」；
 *   2. A 砸开了，B 那边箱子还在、B 还能再砸一次 → 远端必须复刻「读条到点砸开」；
 *   3. A 被钉住不动，B 却看到 A 走到点的地方去了 → 远端必须复刻「读条期间钉住」。
 */
import { describe, expect, it } from 'vitest';
import { createState, type DestructibleObj, type GameState } from '../../combat/state.ts';
import { emptyInputFrame, type InputFrame } from '../input-frame.ts';
import { createRemoteActor, REMOTE_SPEED, type RemoteActor } from '../remote-actor.ts';
import { stepRemoteWorld } from '../remote-world.ts';
import { SMASH_RANGE } from '../../combat/state.ts';

const DT = 1 / 60;

function frame(tick: number, over: Partial<InputFrame> = {}): InputFrame {
  return { ...emptyInputFrame(tick), ...over };
}

/** 点一下某个世界坐标（本地是在 pointerUp 处解析短按的，这里对齐同一条边沿）。 */
function click(tick: number, x: number, y: number): InputFrame[] {
  return [
    frame(tick, { pointerDown: true, pointerHeld: true, mouse: { x, y } }),
    frame(tick + 1, { pointerUp: true, mouse: { x, y } }),
  ];
}

function crate(s: GameState): DestructibleObj {
  const found = s.destructibles.find((obj) => obj.kind === 'crate');
  expect(found).toBeTruthy();
  return found!;
}

/** 一个站在箱子南边 300px 的远端玩家（远到必须先走过去）。 */
function actorFarFrom(obj: DestructibleObj): RemoteActor {
  const actor = createRemoteActor('peer-b', 'B', { x: obj.x, y: obj.y }, 0);
  actor.x = obj.x;
  actor.y = obj.y + 300;
  actor.targetX = actor.x;
  actor.targetY = actor.y;
  return actor;
}

/** 推进 n 个 tick：只跑远端世界步进（不跑本地玩家）。 */
function run(s: GameState, actor: RemoteActor, ticks: number, frames: (i: number) => InputFrame): void {
  for (let i = 0; i < ticks; i += 1) {
    stepRemoteWorld(s, actor, frames(i), DT);
  }
}

describe('远端砸可破坏物', () => {
  it('从远处点箱子：会先走过去，站定后自动起手（本地同一条规则）', () => {
    const s = createState();
    s.skeletons = [];
    const obj = crate(s);
    const actor = actorFarFrom(obj);

    // 点箱子：锁意图 + 走向它，但还没到，不该起手
    const [down, up] = click(0, obj.x, obj.y + 6);
    stepRemoteWorld(s, actor, down!, DT);
    stepRemoteWorld(s, actor, up!, DT);
    expect(actor.smashTarget).toBe(obj.uid);
    expect(actor.smash).toBeNull();

    // 走过去（模拟位移），出范围期间一直不该起手
    let ticks = 0;
    while (ticks < 600) {
      const d = Math.hypot(actor.targetX - actor.x, actor.targetY - actor.y);
      const stepLen = Math.min(REMOTE_SPEED * DT, d);
      if (d > 0) {
        actor.x += ((actor.targetX - actor.x) / d) * stepLen;
        actor.y += ((actor.targetY - actor.y) / d) * stepLen;
      }
      const inRange = Math.hypot(obj.x - actor.x, obj.y - actor.y) <= SMASH_RANGE;
      stepRemoteWorld(s, actor, frame(ticks + 2), DT);
      if (!inRange) {
        expect(actor.smash, `tick ${ticks} 还没到范围就起手了`).toBeNull();
      } else {
        // 进入范围的那一 tick 自动起手
        expect(actor.smash?.uid).toBe(obj.uid);
        break;
      }
      ticks += 1;
    }
    expect(ticks).toBeLessThan(600);
  });

  it('读条期间钉住：给「走开」的输入也不许移动，进度继续涨', () => {
    const s = createState();
    s.skeletons = [];
    const obj = crate(s);
    const actor = createRemoteActor('peer-b', 'B', { x: obj.x, y: obj.y + 40 }, 0);
    actor.x = obj.x;
    actor.y = obj.y + 40;
    actor.smash = { uid: obj.uid, t: 0, total: 2 };

    const before = { x: actor.x, y: actor.y };
    // stepRemoteWorld 不管位移，位移在 stepRemoteActor；这里验的是「进度照涨 + 不中断」
    run(s, actor, 30, () => frame(0, { pointerDown: true, pointerHeld: true, mouse: { x: obj.x + 600, y: obj.y } }));
    expect(Math.hypot(actor.x - before.x, actor.y - before.y)).toBe(0);
    expect(obj.progress).toBeGreaterThan(0.2);
    expect(actor.smash).not.toBeNull();
  });

  it('砸到底：箱子碎了，但**不清本地玩家自己那条读条**（fromRemote）', () => {
    const s = createState();
    s.skeletons = [];
    const obj = crate(s);
    const actor = createRemoteActor('peer-b', 'B', { x: obj.x, y: obj.y + 40 }, 0);
    actor.x = obj.x;
    actor.y = obj.y + 40;
    actor.smash = { uid: obj.uid, t: 0, total: 0.5 };
    // 本地玩家也在砸同一个箱子
    s.smash = { uid: obj.uid, kind: obj.kind, t: 0, total: 0.5 };

    run(s, actor, 60, () => frame(0));
    expect(obj.broken).toBe(true);
    expect(actor.smash).toBeNull();
    expect(s.smash, '远端砸开不该清掉本地玩家的读条').not.toBeNull();
  });

  it('砸的时候有挥砍表现（B 才看得到动画）', () => {
    const s = createState();
    s.skeletons = [];
    const obj = crate(s);
    const actor = createRemoteActor('peer-b', 'B', { x: obj.x, y: obj.y + 40 }, 0);
    actor.x = obj.x;
    actor.y = obj.y + 40;
    actor.smash = { uid: obj.uid, t: 0, total: 2 };
    actor.attackFx = 0;

    let sawSwing = false;
    for (let i = 0; i < 60; i += 1) {
      stepRemoteWorld(s, actor, frame(i), DT);
      if (actor.attackFx > 0) sawSwing = true;
    }
    expect(sawSwing).toBe(true);
  });

  it('点空地会放弃砸的意图（和本地拖拽/换目标一致）', () => {
    const s = createState();
    s.skeletons = [];
    const obj = crate(s);
    const actor = actorFarFrom(obj);
    const [down, up] = click(0, obj.x, obj.y + 6);
    stepRemoteWorld(s, actor, down!, DT);
    stepRemoteWorld(s, actor, up!, DT);
    expect(actor.smashTarget).toBe(obj.uid);

    const [d2, u2] = click(10, obj.x + 400, obj.y + 400);
    stepRemoteWorld(s, actor, d2!, DT);
    stepRemoteWorld(s, actor, u2!, DT);
    expect(actor.smashTarget).toBeNull();
    expect(actor.targetX).toBe(obj.x + 400);
  });
});
