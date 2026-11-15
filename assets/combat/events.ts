/**
 * 单局事件（设计 10.2 三段式的情绪高点）。
 *
 * 时间轴：0–4 探索 / 4–11 交战 / 11–15 撤离。**第 7 分钟**的高价值事件是
 * 「抢或收手」那个决定的触发点 —— 一个舍利匣刷在事件点上，声音 + 光柱全图可见，
 * 附近的怪同时被惊动。它不是任务，也不发指引：来不来是你的事。
 *
 * 规则只做三件事：到点、刷东西、喊一声。刷点来自地图（LDtk `EventSite`），
 * 时间与规模来自 `tables/event.xlsx`。撤离阶段的「怪向门聚集」不在这里，
 * 在 `enemies.ts`（那是 AI 的目标选择）。
 */

import { event as eventRows } from '../resource/generated/event.ts';
import { destructibleDef } from './destructibles.ts';
import { burst, say } from './effects.ts';
import { wakeNoise } from './enemies.ts';
import { RUN_SECONDS, type GameState, type RunEventRecord } from './state.ts';
import { nearestWalkable } from './world.ts';

export interface EventDef {
  readonly id: string;
  readonly name: string;
  /** 第几秒（**已经过去的秒数**）触发。 */
  readonly atSeconds: number;
  /** 刷出来的可破坏物 kind（`destructible.xlsx`）。 */
  readonly kind: string;
  readonly count: number;
  /** 事件声响半径：把附近的沉睡怪一起拉过来。 */
  readonly alarmRadius: number;
  /** 光柱 / 光效持续秒数。 */
  readonly beaconSeconds: number;
  readonly hint: string;
}

/**
 * 唯一 join 点。事件里写的 `kind` 必须在 `destructible.xlsx` 里有行 ——
 * 否则到点会刷出一个砸不开的箱子，那是运行期才会发现的空转。
 */
const DEFS: EventDef[] = eventRows.map((row) => {
  destructibleDef(row.kind);
  return {
    id: row.id,
    name: row.name,
    atSeconds: row.at_seconds,
    kind: row.kind,
    count: row.count,
    alarmRadius: row.alarm_radius,
    beaconSeconds: row.beacon_seconds,
    hint: row.hint,
  };
});

export const EVENTS: readonly EventDef[] = Object.freeze(DEFS);

/** 本局已经过去的秒数。和 `phaseAt()` 用同一把尺子（900 - 剩余）。 */
export function runElapsed(s: GameState): number {
  return RUN_SECONDS - s.runSeconds;
}

let eventUid = 0;

/**
 * 触发一个事件：在事件点刷 `count` 个高价值可破坏物 + 广播。
 *
 * 刷点按 `firedEvents.length` 轮转，所以同一张图上事件不会每次刷在同一个角落
 * （玩家跑图路线一变，抢的东西就换地方），但同一局完全确定（可复现）。
 */
function fire(s: GameState, def: EventDef): void {
  const sites = s.map.eventSites ?? [];
  const base = sites.length > 0
    ? sites[s.firedEvents.length % sites.length]!
    : (() => {
      // 没有事件点的图（夹具 / 旧图）：退到地图中心的可走格。
      // 只是「别让事件静默消失」，不是在布点 —— 正式地图的事件点来自 LDtk。
      const at = nearestWalkable(s.world, s.map.pxWid / 2, s.map.pxHei / 2);
      return { x: at.x, y: at.y };
    })();

  for (let i = 0; i < def.count; i += 1) {
    // 多个同时刷出时错开 28px：名字牌不会摞成一列，砸的时候也不会互相挡。
    const angle = (Math.PI * 2 * i) / Math.max(1, def.count) - Math.PI / 2;
    const spot = nearestWalkable(
      s.world,
      base.x + Math.cos(angle) * 28,
      base.y + Math.sin(angle) * 16,
    );
    eventUid += 1;
    s.destructibles.push({
      uid: `event_${def.id}_${eventUid}`,
      kind: def.kind,
      x: spot.x,
      y: spot.y,
      progress: 0,
      rubble: 0,
      smashing: false,
      fromEvent: true,
    });
  }

  const record: RunEventRecord = {
    id: def.id,
    name: def.name,
    x: base.x,
    y: base.y,
    beacon: def.beaconSeconds,
  };
  s.events.push(record);
  s.firedEvents.push(def.id);

  const woke = wakeNoise(s, base.x, base.y, def.alarmRadius);
  burst(s, base.x, base.y - 26, '#ffd166', 30, 200);
  burst(s, base.x, base.y - 54, '#fff3c4', 18, 120);
  say(s, woke > 0
    ? `${def.name} · ${destructibleDef(def.kind).name}刷新，惊动了 ${woke} 只怪`
    : `${def.name} · ${destructibleDef(def.kind).name}刷新（光柱处）`);
}

/**
 * 每帧推进。**已结束的一局不再触发事件**（撤离 / 超时之后没有"抢"这回事），
 * 但光柱要按自己的寿命衰减完。
 */
export function updateEvents(s: GameState, dt: number): void {
  for (const record of s.events) {
    record.beacon = Math.max(0, record.beacon - dt);
  }
  if (s.extracted || s.timedOut || s.gameOver) return;
  const elapsed = runElapsed(s);
  for (const def of DEFS) {
    if (s.firedEvents.includes(def.id)) continue;
    if (elapsed < def.atSeconds) continue;
    fire(s, def);
  }
}
