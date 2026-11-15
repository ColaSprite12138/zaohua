/**
 * 单局事件契约（设计文档 10.2）：
 *
 * 1. **时间轴**：900 秒的一局里，高价值事件在**第 7 分钟**（420 秒）刷新。
 * 2. **只触发一次**：同一张表一行在一局里只刷一次；重开一局（R）重新计时。
 * 3. **刷在地图的事件点上**：刷点来自 `ArenaMap.eventSites`（LDtk `EventSite`），
 *    不是运行时瞎猜的坐标。
 * 4. **广播**：刷出来的是高价值可破坏物（`fromEvent`），并惊醒半径内的沉睡怪。
 * 5. **结束的一局不再刷**：撤离 / 超时之后没有「抢」这回事。
 */

import { describe, expect, it } from 'vitest';
import { EVENTS, runElapsed, updateEvents } from '../events.ts';
import { destructibleDef } from '../destructibles.ts';
import {
  RUN_SECONDS, createState, projection, reset, step,
  type GameState, type StepInput,
} from '../simulation.ts';
import { testArena } from '../../resource/maps/arena-test.ts';

const input = (over: Partial<StepInput> = {}): StepInput => ({
  mouse: undefined,
  pointerDown: false,
  pointerHeld: false,
  pointerUp: false,
  dodge: false,
  restart: false,
  ...over,
});

function tick(s: GameState, seconds: number, dt = 0.25): void {
  let left = seconds;
  while (left > 1e-9) {
    step(s, Math.min(dt, left), input());
    left -= dt;
  }
}

describe('表驱动（event.xlsx）', () => {
  it('高价值事件落在第 7 分钟，刷的东西在可破坏物表里有行', () => {
    const high = EVENTS.find((e) => e.id === 'high_value');
    expect(high).toBeTruthy();
    expect(high!.atSeconds).toBe(420);
    expect(high!.atSeconds / 60).toBe(7);
    expect(() => destructibleDef(high!.kind)).not.toThrow();
    expect(high!.count).toBeGreaterThan(0);
    expect(high!.beaconSeconds).toBeGreaterThan(0);
  });
});

describe('触发', () => {
  it('到点之前什么都不发生', () => {
    const s = createState();
    s.runSeconds = RUN_SECONDS - 419;
    updateEvents(s, 0.016);
    expect(s.firedEvents).toEqual([]);
    expect(s.events).toEqual([]);
  });

  it('第 7 分钟刷出舍利匣，落在事件点上并只触发一次', () => {
    const s = createState();
    s.skeletons = [];
    const before = s.destructibles.length;
    s.runSeconds = RUN_SECONDS - 421;
    updateEvents(s, 0.016);
    expect(s.firedEvents).toEqual(['high_value']);
    expect(s.events.length).toBe(1);
    const record = s.events[0]!;
    const site = testArena.eventSites[0]!;
    expect(Math.hypot(record.x - site.x, record.y - site.y)).toBeLessThan(64);
    const spawned = s.destructibles.filter((obj) => obj.fromEvent);
    expect(spawned.length).toBe(EVENTS[0]!.count);
    expect(s.destructibles.length).toBe(before + spawned.length);
    for (const obj of spawned) {
      expect(obj.kind).toBe('reliquary');
      expect(obj.progress).toBe(0);
    }
    // 再过一帧不会刷第二份。
    updateEvents(s, 0.016);
    expect(s.destructibles.filter((obj) => obj.fromEvent).length).toBe(spawned.length);
  });

  it('光柱会自己熄灭，但事件记录还在', () => {
    const s = createState();
    s.runSeconds = RUN_SECONDS - 421;
    updateEvents(s, 0.016);
    expect(s.events[0]!.beacon).toBeGreaterThan(0);
    updateEvents(s, EVENTS[0]!.beaconSeconds + 1);
    expect(s.events[0]!.beacon).toBe(0);
    expect(s.firedEvents).toEqual(['high_value']);
  });

  it('事件声响惊醒事件点附近的沉睡怪', () => {
    const s = createState();
    const site = testArena.eventSites[0]!;
    const def = EVENTS[0]!;
    s.skeletons = [{
      x: site.x + def.alarmRadius * 0.5, y: site.y, hp: 66, maxHp: 66, alive: true,
      attackCd: 9, hit: 0, bob: 0, face: 0, swing: 0, stride: 0, moving: false,
      monsterId: '100001', path: [], repath: 0, statuses: [], awake: false, goal: 'none',
    }];
    s.runSeconds = RUN_SECONDS - 421;
    updateEvents(s, 0.016);
    expect(s.skeletons[0]!.awake).toBe(true);
  });

  it('已结束的一局不再刷事件', () => {
    const s = createState();
    s.extracted = true;
    s.runSeconds = RUN_SECONDS - 500;
    updateEvents(s, 0.016);
    expect(s.firedEvents).toEqual([]);
  });

  it('整局真的会走到第 7 分钟（时间轴只有一个人在推）', () => {
    const s = createState();
    s.skeletons = [];
    tick(s, 425);
    expect(runElapsed(s)).toBeGreaterThan(420);
    expect(s.firedEvents).toEqual(['high_value']);
    expect(projection(s).eventLog).toEqual(['high_value']);
  });

  it('重开一局（R）把事件与箱子都放回去', () => {
    const s = createState();
    s.runSeconds = RUN_SECONDS - 421;
    updateEvents(s, 0.016);
    expect(s.firedEvents.length).toBe(1);
    reset(s);
    expect(s.firedEvents).toEqual([]);
    expect(s.events).toEqual([]);
    expect(s.destructibles.every((obj) => obj.fromEvent === false)).toBe(true);
  });
});

describe('撤离阶段：怪向传送门聚集（设计 10.2 第三段）', () => {
  it('离玩家很远的怪去守最近的门，近身的照常打人', async () => {
    const { updateSkeletons } = await import('../enemies.ts');
    const s = createState();
    const far = s.skeletons[0]!;
    // 摆在中庭靠北的位置，玩家在南边（距离 > monster_converge_px = 320）。
    far.x = 640;
    far.y = 200;
    s.player.x = 640;
    s.player.y = 620;
    s.phase = 'extract';
    updateSkeletons(s, 0.016);
    expect(far.awake).toBe(true);
    expect(far.goal).toBe('portal');
    // 「最近的门」是它自己挑的，测试也跟着挑，而不是硬认 portals[0]。
    const target = s.portals.reduce((best, p) => (
      Math.hypot(p.x - far.x, p.y - far.y) < Math.hypot(best.x - far.x, best.y - far.y)
        ? p : best
    ), s.portals[0]!);
    const d0 = Math.hypot(far.x - target.x, far.y - target.y);
    for (let i = 0; i < 30; i += 1) updateSkeletons(s, 0.1);
    expect(Math.hypot(far.x - target.x, far.y - target.y)).toBeLessThan(d0);

    // 近身（320px 内）改回追玩家。
    far.x = s.player.x + 120;
    far.y = s.player.y;
    updateSkeletons(s, 0.016);
    expect(far.goal).toBe('player');
  });
});
