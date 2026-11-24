/**
 * 状态结算与反应链（设计文档 8.5 + 8.4 的运行时部分）。
 *
 * 分工：`status.ts` 只有数据和纯函数；**会掉血、会生成区域、会传导**的逻辑全在这里。
 * 这样 `attack.ts`（唯一伤害入口）可以 import `status.ts` 上状态，而不用反过来
 * import 本文件，避免「伤害入口 ↔ 反应结算」的环。
 *
 * 三条写死的规则：
 *
 * 1. **只认 8.5 的表**：6 元素、5 条反应，一条都不多。不做「任意两两组合」的 N² 判定。
 * 2. **反应消耗双方附着**：触发后两个元素状态都被清掉，所以一次反应不可能自己连爆。
 * 3. **一切伤害都走 `damageSkeleton()`**：DOT、引爆、传导、撞墙都算，否则击杀不计、
 *    掉落不滚、`lootLog` 与实际对不上（保护清单 / 不变量 29）。
 */

import { combat_rule } from '../resource/generated/combat_rule.ts';
import { damagePlayer, damageSkeleton } from './attack.ts';
import { sortedPlayers } from './players.ts';
import type { Player } from './state.ts';
import { burst, say } from './effects.ts';
import {
  DOT_TICK_SECONDS, REACTION_CHAIN_RADIUS, ZONE_RADIUS_MAX, ZONE_TICK_SECONDS,
  nextZoneUid, type ElementId, type GameState, type ReactionId, type StatusHost,
  type StatusId, type Zone,
} from './state.ts';
import { hurts, type DamageSource } from './source.ts';
import {
  ELEMENT_LABEL, ELEMENT_STATUS, STATUS, applyStatus, clearStatus, statusOf,
} from './status.ts';

/* --------------------------------------------------------------- 反应表 */

export interface ReactionDef {
  readonly id: ReactionId;
  readonly name: string;
  /** 两个元素，顺序无关。 */
  readonly elements: readonly [ElementId, ElementId];
  /** 一句话说明（toast / 文档）。 */
  readonly hint: string;
}

/**
 * 设计 8.5 的表，**一条不多**：
 * 水+冰 冻结 / 水+雷 麻痹传导 / 火+毒 引爆 / 风+火 火势蔓延 / 风+毒 毒雾扩散。
 *
 * 6 种元素、5 条反应 —— 这是刻意压出来的学习成本。加第 6 条之前先问：
 * 玩家能不能记住？记不住的组合等于不存在。
 */
export const REACTIONS: readonly ReactionDef[] = Object.freeze([
  Object.freeze({
    id: 'freeze', name: '冻结', elements: ['water', 'ice'] as const,
    hint: '水 + 冰 → 冻结：硬控 1.5 秒',
  }),
  Object.freeze({
    id: 'paralyze', name: '麻痹', elements: ['water', 'shock'] as const,
    hint: '水 + 雷 → 麻痹：硬控，并向附近敌人传导',
  }),
  Object.freeze({
    id: 'detonate', name: '引爆', elements: ['fire', 'poison'] as const,
    hint: '火 + 毒 → 引爆毒层：按层数瞬间掉血',
  }),
  Object.freeze({
    id: 'fireSpread', name: '火势蔓延', elements: ['wind', 'fire'] as const,
    hint: '风 + 火 → 火焰区域扩大',
  }),
  Object.freeze({
    id: 'poisonSpread', name: '毒雾扩散', elements: ['wind', 'poison'] as const,
    hint: '风 + 毒 → 中毒区域扩大',
  }),
]);

/** 命中这对元素有什么反应；没有就返回 null（正常情况，不做 N² 判定）。 */
export function reactionFor(a: ElementId, b: ElementId): ReactionDef | null {
  for (const def of REACTIONS) {
    const [x, y] = def.elements;
    if ((x === a && y === b) || (x === b && y === a)) return def;
  }
  return null;
}

/** 每个元素对应的「地面区域状态」（风没有地面区域，它只吹旺别人）。 */
const ZONE_STATUS: Partial<Record<ElementId, StatusId>> = {
  fire: 'burn',
  poison: 'poison',
  ice: 'slow',
  water: 'wet',
};

/* --------------------------------------------------------- 元素附着入口 */

/**
 * 给一只怪挂上元素附着（技能命中 / 区域续状态都走这里）。
 *
 * 顺序：先查身上已有的、与本元素成对的附着 → 有就触发反应并消耗双方 →
 * 没有就把这一层附着挂上去。**先反应、后挂载**，这样「引爆」读得到毒层数，
 * 而不会先被自己的新附着污染。
 */
export function applyElement(
  s: GameState,
  index: number,
  element: ElementId,
  options: {
    duration?: number; stacks?: number; dot?: number;
    /** 谁上的这个元素（技能 / 弹道 / 区域）。反应的伤害归属到它。 */
    source?: DamageSource;
  } = {},
): void {
  const sk = s.skeletons[index];
  if (sk === undefined || !sk.alive) return;
  const own = ELEMENT_STATUS[element];

  // 已经带着同一个元素：只续时长，不重复触发反应。
  const pair = findReactionPartner(sk, element);
  if (pair !== null) {
    runReaction(s, index, pair.def, pair.otherStatus, own, options.source);
    return;
  }
  applyStatus(sk, own, options);
}

/** 身上有没有「与新元素成对」的附着；返回那对反应和对方的状态 id。 */
function findReactionPartner(
  host: StatusHost,
  element: ElementId,
): { def: ReactionDef; otherStatus: StatusId } | null {
  for (const st of host.statuses) {
    const other = STATUS[st.id].element;
    if (other === undefined || other === element) continue;
    const def = reactionFor(element, other);
    if (def !== null) return { def, otherStatus: st.id };
  }
  return null;
}

/**
 * 触发一条反应。**双方附着一起清掉**（设计 8.5 的组合是「一次性」的），
 * 然后按反应 id 结算。所有伤害都走 `damageSkeleton()`。
 */
function runReaction(
  s: GameState,
  index: number,
  def: ReactionDef,
  otherStatus: StatusId,
  ownStatus: StatusId,
  source: DamageSource | undefined,
): void {
  const sk = s.skeletons[index];
  if (sk === undefined) return;
  const color = def.id === 'detonate' ? '#fb923c' : def.id === 'freeze' ? '#8be9fd' : '#c084fc';
  // 引爆必须在清掉毒层之前读层数。
  const poisonStacks = def.id === 'detonate' ? (statusOf(sk, 'poison')?.stacks ?? 0) : 0;

  clearStatus(sk, otherStatus);
  clearStatus(sk, ownStatus);
  s.reactions.push({ id: def.id, x: sk.x, y: sk.y, t: s.t });
  if (s.reactions.length > 8) s.reactions.shift();
  burst(s, sk.x, sk.y - 24, color, 18, 210);
  say(s, `${def.name} · ${def.hint}`);

  switch (def.id) {
    case 'freeze':
      applyStatus(sk, 'freeze', { source });
      break;
    case 'paralyze': {
      applyStatus(sk, 'paralyze', { source });
      // 向附近敌人传导：半时长，且不连锁（传导只上麻痹，不再触发反应）。
      for (let i = 0; i < s.skeletons.length; i += 1) {
        if (i === index) continue;
        const other = s.skeletons[i];
        if (other === undefined || !other.alive) continue;
        if (Math.sqrt((other.x - sk.x) * (other.x - sk.x) + (other.y - sk.y) * (other.y - sk.y)) > REACTION_CHAIN_RADIUS) continue;
        applyStatus(other, 'paralyze', { duration: STATUS.paralyze.duration * 0.5, source });
        burst(s, other.x, other.y - 20, '#c084fc', 8, 140);
      }
      break;
    }
    case 'detonate': {
      // 每层毒的引爆伤害在 `tables/combat_rule.xlsx`：5 层满毒 ≈ 一发大招的量级。
      const rule = combat_rule[0];
      const damage = Math.max(rule.detonate_min, poisonStacks * rule.detonate_per_stack);
      damageSkeleton(s, index, damage, { knockback: 0, color: '#ffd166', source });
      break;
    }
    case 'fireSpread':
      growZones(s, sk.x, sk.y, ['fire']);
      break;
    case 'poisonSpread':
      growZones(s, sk.x, sk.y, ['poison']);
      break;
  }
}

/* ------------------------------------------------------------------ 区域 */

/** 放一片地面区域（火墙 / 毒池 / 冰面 / 水洼）。 */
export function spawnZone(
  s: GameState,
  element: ElementId,
  x: number,
  y: number,
  radius: number,
  life: number,
  source: DamageSource,
): Zone | null {
  const status = ZONE_STATUS[element];
  if (status === undefined) return null;
  const zone: Zone = {
    uid: nextZoneUid(s),
    element,
    status,
    x,
    y,
    radius,
    life,
    max: life,
    next: ZONE_TICK_SECONDS,
    source,
  };
  s.zones.push(zone);
  return zone;
}

/**
 * 风把同元素的地面区域吹大（设计 8.5：火势蔓延 / 毒雾扩散）。
 *
 * 只认 `elements` 里列出的元素，且只长半径 + 续命，不改伤害 ——
 * 否则「风一吹伤害翻倍」会变成第二个伤害来源。
 */
export function growZones(s: GameState, x: number, y: number, elements: readonly ElementId[]): number {
  let grown = 0;
  for (const zone of s.zones) {
    if (!elements.includes(zone.element)) continue;
    if (Math.sqrt((zone.x - x) * (zone.x - x) + (zone.y - y) * (zone.y - y)) > zone.radius + REACTION_CHAIN_RADIUS) continue;
    zone.radius = Math.min(ZONE_RADIUS_MAX, zone.radius * 1.5);
    zone.life = Math.min(zone.max * 2, zone.life + 1.2);
    grown += 1;
    burst(s, zone.x, zone.y, ELEMENT_LABEL[zone.element].color, 14, 130);
  }
  return grown;
}

/**
 * 区域每帧推进：给圈内的活体续状态，自己掉寿命。
 *
 * 只续状态、**不直接扣血** —— 伤害一律由 DOT 跳（两套伤害会互相打架，
 * 而且「站在火里就一直在烧」本身已经读得很清楚）。
 *
 * **阵营由 `source` 决定**（2026-11-16 修正）：自己的火墙不烧自己、怪铺的火墙不烧
 * 放火的怪，`world` 的（地图自带毒池）伤所有阵营。这里跳过同方宿主，所以不会出现
 * 「先挂上点燃、再由 DOT 扣血」的二次绕路 —— 状态都不该被续上。
 */
export function updateZones(s: GameState, dt: number): void {
  for (const zone of s.zones) {
    zone.life -= dt;
    zone.next -= dt;
    if (zone.next > 0) continue;
    zone.next += ZONE_TICK_SECONDS;
    // 状态被续成 2 跳的长度：走出区域后还会烧一小会儿，不会一离开就瞬停。
    const duration = ZONE_TICK_SECONDS * 2.4;
    for (let i = 0; i < s.skeletons.length; i += 1) {
      const sk = s.skeletons[i];
      if (sk === undefined || !sk.alive) continue;
      if (!hurts(zone.source, 'monster')) continue;
      if (Math.sqrt((sk.x - zone.x) * (sk.x - zone.x) + (sk.y - zone.y) * (sk.y - zone.y)) > zone.radius) continue;
      // 区域续状态是「附着」，也会触发反应（火区里踩进毒池 = 引爆）。
      // 来源一路带下去：反应伤害也算这片地的主人打的。
      applyElement(s, i, zone.element, { duration, source: zone.source });
    }
    // 圈内**每个玩家**都要各问一次 `hurts()`：判定从「玩家阵营」细化到
    // 「哪个玩家」，所以自己的火墙不烧自己、别人铺的会烧我（PVP 互砍）。
    // 只判一次 `s.player` 会让「B 站在 A 的火里」在 A 的机器上完全不发生 ——
    // 同一个 zone 一边续了状态一边没续，是典型的两端分叉。
    for (const p of sortedPlayers(s)) {
      if (!hurts(zone.source, 'player', p.id)) continue;
      if (Math.sqrt((p.x - zone.x) * (p.x - zone.x) + (p.y - zone.y) * (p.y - zone.y)) > zone.radius) continue;
      applyStatus(p, zone.status, { duration, source: zone.source });
    }
  }
  s.zones = s.zones.filter((zone) => zone.life > 0);
}

/* ------------------------------------------------------- DOT 与状态计时 */

/**
 * 全部状态的计时与 DOT 结算（每帧一次，唯一入口）。
 *
 * 顺序固定：推进计时 → DOT 跳伤（走 `damageSkeleton`）→ 到期移除。
 * 跳伤放在移除之前，所以「最后一跳」不会因为状态剩 0.01 秒而丢掉。
 */
export function tickStatuses(s: GameState, dt: number): void {
  for (let i = 0; i < s.skeletons.length; i += 1) {
    const sk = s.skeletons[i];
    if (sk === undefined || !sk.alive) continue;
    tickHost(sk, dt, (amount, color, source) => {
      damageSkeleton(s, i, amount, { knockback: 0, color, source });
    });
  }
  // DOT 挂在**每个玩家自己的 statuses** 上，谁挂着谁掉血。
  // 只 tick `s.player` 会让「怪给 B 上的点燃」在 A 的机器上永远不结算。
  for (const p of sortedPlayers(s)) {
    tickHost(p, dt, (amount, color, source) => {
      hurtPlayer(s, amount, color, source, p);
    });
  }
}

/** 单个宿主的计时 + DOT。`hit` 由调用方注入（怪走 damageSkeleton，玩家走 hurtPlayer）。 */
function tickHost(
  host: StatusHost,
  dt: number,
  hit: (amount: number, color: string, source: DamageSource | undefined) => void,
): void {
  for (const st of host.statuses) {
    st.left -= dt;
    const def = STATUS[st.id];
    if (def.dot === undefined) continue;
    st.next -= dt;
    if (st.next > 0) continue;
    st.next += DOT_TICK_SECONDS;
    // 每跳伤害 = 定义值 × 层数 × 跳间隔（数值按「每秒」配，跳间隔换算一次）。
    // 状态记住的 `source` 一起交出去：自己的火墙给的点燃不会扣自己的血。
    hit(st.dot * st.stacks * DOT_TICK_SECONDS, def.color, st.source);
  }
  const alive = host.statuses.filter((st) => st.left > 0);
  host.statuses.length = 0;
  host.statuses.push(...alive);
}

/** 玩家掉血：走 `attack.ts::damagePlayer()`，和怪物出刀 / 弹道共用同一条路。 */
function hurtPlayer(
  s: GameState, amount: number, color: string, source: DamageSource | undefined,
  target: Player,
): void {
  damagePlayer(s, amount, {
    color,
    source,
    invuln: false,     // DOT 不吃无敌帧：站在火里翻滚不该免疫灼烧
    deathText: '你被持续伤害击倒了',
  }, target);
}
