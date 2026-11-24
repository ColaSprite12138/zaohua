/**
 * 可破坏物（设计 10.5「用动作语言替代搜容器」）。
 *
 * 市场同类玩法靠 UI 遮挡制造「脆弱时刻」（蹲下、视野被挡、不能动）；这里换成
 * 三件**看得见的事**：
 *
 * 1. **站桩**：砸开是一段 2–4 秒的引导（`smash_seconds`），期间玩家被钉住，
 *    和引导传送门共用一套 `pinPlayer()`。
 * 2. **背身**：你站在箱子前面砍，背后就是空门 —— 挨一刀就断，进度清空。
 * 3. **声音**：起手和砸开都会 `wakeNoise()` 惊醒半径内的沉睡怪，
 *    所以「先清场再破坏」是必须的，不是建议。
 *
 * 最高价值的舍利匣还有一道**机关**（设计 10.5 最后一行）：`guard_radius` 内
 * 还有活怪时根本起不了手 —— 先打掉守卫。
 *
 * 这个模块不写 `sk.hp`，也不碰掉落算法：战利品走 `loot.ts::rollPool()`，
 * 掉落物走同一份 `Drop` 结构，所以「砸出来的剑」和「打怪掉的剑」一模一样。
 */

import { atan2, cos, sin } from '../net/trig.ts';
import { destructible as destructibleRows } from '../resource/generated/destructible.ts';
import { burst, pinPlayer, say, setTarget } from './effects.ts';
import { wakeNoise } from './enemies.ts';
import { rollPool, rollWeaponDamage } from './loot.ts';
import {
  makeDropFlight, nextDropUid, PLAYER_SWING_TIME, RUBBLE_SECONDS, SMASH_RANGE, SMASH_SWING_SECONDS,
  type DestructibleObj, type GameState,
} from './state.ts';
import { nearestWalkable } from './world.ts';

/** 可破坏物的点击盒（世界像素）：一个 24×44 的方块，模型正压在里面。 */
export const DESTRUCTIBLE_HALF_WIDTH = 26;
export const DESTRUCTIBLE_TOP = -44;
export const DESTRUCTIBLE_BOTTOM = 6;

export interface DestructibleDef {
  readonly id: string;
  readonly name: string;
  /** 站桩砸开的秒数（设计 10.5：高价值 2–4 秒，更高级更久）。 */
  readonly smashSeconds: number;
  readonly lootPoolId: number;
  /** 抽几次战利品。 */
  readonly drops: number;
  /** 声响半径：起手 / 砸开都会惊醒这个圈内的沉睡怪。 */
  readonly alarmRadius: number;
  /** 机关门槛：这个圈内还有活怪时不能起手（0 = 没有门槛）。 */
  readonly guardRadius: number;
  readonly hint: string;
}

/**
 * 唯一 join 点：表有行、代码要真能用。表里多一行但没人能画 / 没人能砸，
 * 比启动就抛错更难查 —— 所以这里宁可炸。
 */
const DEFS = new Map<string, DestructibleDef>();
for (const row of destructibleRows) {
  DEFS.set(row.id, {
    id: row.id,
    name: row.name,
    smashSeconds: row.smash_seconds,
    lootPoolId: row.loot_pool_id,
    drops: row.drops,
    alarmRadius: row.alarm_radius,
    guardRadius: row.guard_radius,
    hint: row.hint,
  });
}

export function destructibleDef(id: string): DestructibleDef {
  const def = DEFS.get(id);
  if (def === undefined) {
    throw new Error(
      `可破坏物 ${id} 没有表行：在 tables/destructible.xlsx 里加一行再 export_tables.py`,
    );
  }
  return def;
}

export const DESTRUCTIBLE_IDS: readonly string[] = Object.freeze([...DEFS.keys()]);

/**
 * 指针下的可破坏物 —— 点击与悬停共用的唯一命中入口（和 `hitTestEnemy()` 同理）。
 * 已经砸开（`broken`）的不再响应：那不是目标，是一堆木头（或者连木头都散了）。
 */
export function destructibleAtPoint(
  s: GameState, x: number, y: number,
): DestructibleObj | null {
  let hit: DestructibleObj | null = null;
  let best = Infinity;
  for (const obj of s.destructibles) {
    if (obj.broken) continue;
    if (Math.abs(x - obj.x) > DESTRUCTIBLE_HALF_WIDTH) continue;
    if (y < obj.y + DESTRUCTIBLE_TOP || y > obj.y + DESTRUCTIBLE_BOTTOM) continue;
    const d = Math.sqrt((x - obj.x) * (x - obj.x) + (y - (obj.y + DESTRUCTIBLE_TOP / 2)) * (y - (obj.y + DESTRUCTIBLE_TOP / 2)));
    if (d < best) {
      best = d;
      hit = obj;
    }
  }
  return hit;
}

/** 机关门槛：`guard_radius` 内还活着的怪有几只。 */
export function guardsAround(s: GameState, obj: DestructibleObj): number {
  const def = destructibleDef(obj.kind);
  if (def.guardRadius <= 0) return 0;
  let n = 0;
  for (const sk of s.skeletons) {
    if (!sk.alive) continue;
    if (Math.sqrt((sk.x - obj.x) * (sk.x - obj.x) + (sk.y - obj.y) * (sk.y - obj.y)) <= def.guardRadius) n += 1;
  }
  return n;
}

function find(s: GameState, uid: string): DestructibleObj | null {
  return s.destructibles.find((obj) => obj.uid === uid) ?? null;
}

/**
 * 点击一个可破坏物：先锁定它、走过去，到了才起手（和「点怪 → 进距离才砍」
 * 同一条规矩）。`smashTarget` 是这次点击的意图，不是「永远想砸它」。
 */
export function orderSmash(s: GameState, obj: DestructibleObj): void {
  const def = destructibleDef(obj.kind);
  const dist = Math.sqrt((obj.x - s.player.x) * (obj.x - s.player.x) + (obj.y - s.player.y) * (obj.y - s.player.y));
  s.smashTarget = obj.uid;
  s.attackOrder = false;
  s.targetEnemy = null;
  s.pickupTarget = null;
  if (dist <= SMASH_RANGE) {
    beginSmash(s, obj);
    return;
  }
  setTarget(s, obj.x, obj.y);
  s.moveMode = 'point';
  say(s, `走向「${def.name}」· 站定后开始破坏（${def.smashSeconds.toFixed(1)} 秒）`);
}

/**
 * 起手。拒绝（`guarded` / `gone` / `busy`）一律**免费**：不清进度、不扣任何东西，
 * 但也**清掉 `smashTarget`** —— 否则守卫一直在，每一帧都会重试并刷屏。
 */
export function beginSmash(s: GameState, obj: DestructibleObj): 'ok' | 'guarded' | 'gone' | 'busy' {
  if (obj.broken) {
    s.smashTarget = null;
    return 'gone';
  }
  if (s.smash !== null) return 'busy';
  if (Math.sqrt((obj.x - s.player.x) * (obj.x - s.player.x) + (obj.y - s.player.y) * (obj.y - s.player.y)) > SMASH_RANGE) return 'busy';
  const def = destructibleDef(obj.kind);
  const guards = guardsAround(s, obj);
  if (guards > 0) {
    s.smashTarget = null;
    say(s, `「${def.name}」有机关 · 先打掉 ${def.guardRadius}px 内的 ${guards} 名守卫`);
    return 'guarded';
  }
  s.smash = { uid: obj.uid, kind: obj.kind, t: 0, total: def.smashSeconds };
  s.smashTarget = obj.uid;
  obj.smashing = true;
  pinPlayer(s);
  // 起手就是第一个声音：周围沉睡的怪被惊动（设计 10.5 第三个要素）。
  const woke = wakeNoise(s, obj.x, obj.y, def.alarmRadius);
  burst(s, obj.x, obj.y - 18, '#ffd166', 8, 120);
  say(s, woke > 0
    ? `开始破坏「${def.name}」· ${def.smashSeconds.toFixed(1)} 秒 · 惊动了 ${woke} 只怪`
    : `开始破坏「${def.name}」· ${def.smashSeconds.toFixed(1)} 秒 · 受击 / 闪避会中断`);
  return 'ok';
}

/** 打断 / 放弃：只清进度与意图，不给硬直、不扣血（和门引导同一条规矩）。 */
export function cancelSmash(s: GameState, reason?: string): void {
  if (s.smash === null) return;
  const obj = find(s, s.smash.uid);
  if (obj !== null) {
    obj.progress = 0;
    obj.smashing = false;
  }
  s.smash = null;
  s.smashTarget = null;
  if (reason !== undefined) say(s, reason);
}

/**
 * 砸开：抽 `drops` 次战利品撒在箱子周围，留一段残骸，响起第二声。
 *
 * 掉落物走同一份 `Drop` 结构（名字牌 / 品质色 / 显式拾取都复用），所以砸出来
 * 的东西和打怪掉的东西在拾取规则上没有任何区别。
 */
/**
 * 砸开结算：标 `broken`、撒掉落、惊动周围的怪。
 *
 * `fromRemote = true` 表示「这是远端玩家砸的」，此时**不能**清本地玩家的
 * `s.smash` / `s.smashTarget` —— 那是我自己那条读条，跟对方没关系。
 * 除此之外两边走的是同一条路径：掉落用 `s.rng`（确定性），所以两端敲开同一个
 * 箱子会撒出**同一批**东西。
 */
export function breakOpen(s: GameState, obj: DestructibleObj, fromRemote = false): void {
  const def = destructibleDef(obj.kind);
  obj.progress = 1;
  // 状态先落定（`broken` 是唯一判据），残骸只是表现还剩几秒。
  obj.broken = true;
  obj.rubble = RUBBLE_SECONDS;
  obj.smashing = false;
  if (!fromRemote) {
    s.smash = null;
    s.smashTarget = null;
  }
  const names: string[] = [];
  for (let i = 0; i < def.drops; i += 1) {
    const loot = rollPool(def.lootPoolId, s.rng);
    if (loot === null) continue;
    // 撒成一小圈：不叠在同一个像素上，名字牌才不会挤成一列。
    const angle = (Math.PI * 2 * i) / Math.max(1, def.drops) - Math.PI / 2;
    const spot = nearestWalkable(
      s.world,
      obj.x + cos(angle) * 34,
      obj.y + sin(angle) * 22,
    );
    const damage = rollWeaponDamage(loot.itemId, s.rng);
    s.drops.push({
      uid: nextDropUid(s),
      x: spot.x,
      y: spot.y,
      kind: 'longsword',
      t: 0,
      itemId: loot.itemId,
      name: loot.name,
      quality: loot.quality,
      monsterId: `destructible:${def.id}`,
      ...(damage === null ? {} : { damage }),
      // 从箱子中心向外抛，`i` 决定次序 —— 一件接一件喷出来。
      flight: makeDropFlight(obj.x, obj.y, i),
    });
    names.push(`${loot.name}(${loot.quality})`);
  }
  burst(s, obj.x, obj.y - 20, '#e8e4d8', 26, 210);
  burst(s, obj.x, obj.y - 8, '#8a5a2b', 14, 150);
  const woke = wakeNoise(s, obj.x, obj.y, def.alarmRadius);
  const tail = woke > 0 ? ` · 又惊动了 ${woke} 只怪` : '';
  say(s, names.length > 0
    ? `砸开「${def.name}」· ${names.join(' / ')}${tail}`
    : `砸开「${def.name}」· 里面是空的 (pool=${def.lootPoolId})${tail}`);
}

/**
 * 共享的可破坏物表现复位：**每帧全局只跑一次**。
 *
 * 这段原来在 `updateDestructibles()` 里，而后者按玩家各跑一遍 —— N 个玩家
 * 就把 `rubble` 多减 N 次，还会把上一个玩家刚点亮的 `smashing` 反复清掉。
 * 残骸只衰减表现；`broken` 不会被它改回去（曾经就是这么"复活"的）。
 */
export function tickDestructibles(s: GameState, dt: number): void {
  for (const obj of s.destructibles) {
    if (obj.rubble > 0) obj.rubble = Math.max(0, obj.rubble - dt);
    obj.smashing = false;
  }
}

/**
 * **按玩家**的砸箱推进：到点起手、进度、打断、砸开。
 *
 * 排序位置在 `walk()` 之后、`updateSkeletons()` 之前（见 `simulation.ts`）：
 * 这一帧先决定「能不能砸」，再让怪打你 —— 同一帧挨打就同一帧断，
 * 和读条技能是一个时序。调用方用 `withPlayer()` 钉住当前玩家。
 */
export function updateDestructibles(s: GameState, dt: number): void {
  // 还没起手：走过去到了就自动起手（点击已经是明确的意图，不需要再点一次）。
  if (s.smash === null && s.smashTarget !== null) {
    const target = find(s, s.smashTarget);
    if (target === null || target.broken) {
      s.smashTarget = null;
    } else if (Math.sqrt((target.x - s.player.x) * (target.x - s.player.x) + (target.y - s.player.y) * (target.y - s.player.y)) <= SMASH_RANGE) {
      beginSmash(s, target);
    }
  }

  const smash = s.smash;
  if (smash === null) return;
  const obj = find(s, smash.uid);
  if (obj === null || obj.broken) {
    s.smash = null;
    return;
  }
  // 打断：挨打 / 闪避 / 走开（理论上被钉住走不开，但状态位移还能把人推出去）。
  if (s.player.hurt > 0) {
    cancelSmash(s, '受击打断了破坏 · 进度清空');
    return;
  }
  if (s.player.dodge > 0) {
    cancelSmash(s, '闪避打断了破坏 · 进度清空');
    return;
  }
  if (Math.sqrt((obj.x - s.player.x) * (obj.x - s.player.x) + (obj.y - s.player.y) * (obj.y - s.player.y)) > SMASH_RANGE * 1.5) {
    cancelSmash(s, '离开了可破坏物 · 进度清空');
    return;
  }

  pinPlayer(s);
  obj.smashing = true;
  smash.t = Math.min(smash.total, smash.t + dt);
  obj.progress = smash.total > 0 ? smash.t / smash.total : 1;

  // 挥砍动作：每 0.45 秒补一次，读起来就是「一直在砍这个箱子」。
  const swingAt = Math.floor(smash.t / SMASH_SWING_SECONDS);
  const swingPrev = Math.floor((smash.t - dt) / SMASH_SWING_SECONDS);
  if (swingAt > swingPrev) {
    s.player.attackFx = PLAYER_SWING_TIME;
    s.player.face = atan2(obj.y - s.player.y, obj.x - s.player.x);
    burst(s, obj.x, obj.y - 24, '#c9b48a', 5, 90);
  }

  if (smash.t >= smash.total) breakOpen(s, obj);
}

/** 小地图 / 验收用：还完好的可破坏物（**不看残骸倒计时**，只看 `broken`）。 */
export function intactDestructibles(s: GameState): DestructibleObj[] {
  return s.destructibles.filter((obj) => !obj.broken);
}
