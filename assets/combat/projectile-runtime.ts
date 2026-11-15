/**
 * 弹道运行时 —— 把纯飞行逻辑（`projectiles.ts`）接到战局状态上。
 *
 * **两类远程攻击在这里共用一条管道**（用户 2026-11-16 的要求）：
 *
 * | 形态 | 谁在用 | 行为 |
 * |:--|:--|:--|
 * | 指向性 `locked` | 玩家弓箭（点中的那一只） | 飞行中朝目标转向，目标跑不掉；撞墙才失手 |
 * | 非指向性 `directional` | 怪物弓手、火球 | 只认起手角度，之后不修正；走位能躲、打空是合法结果 |
 *
 * 「形态」与「弹道原型」是两件事：`attack-spec.ts` 决定 targeting，本模块按
 * `projectile.xlsx` 的一行决定 速度 / 射程 / 碰撞半径 / 溅射 / 穿透 / 追踪率 /
 * 元素 / 落地留什么。加一种弹（毒箭、冰锥、追踪飞弹）= 表里加一行 + 引用它的
 * 地方写一个 id，**不用改本文件**。
 *
 * 伤害仍然只有一个出口：打怪走 `damageSkeleton()`（击杀 / 掉落 / 撞墙 / 经验全在
 * 那一条路上），打人走 `damagePlayer()`（和怪物出刀、DOT 共用一套无敌帧与耐久）。
 */

import { projectile as projectileRows } from '../resource/generated/projectile.ts';
import type { AttackOwner } from './attack-spec.ts';
import { damagePlayer, damageSkeleton } from './attack.ts';
import { wearWeapon } from './durability.ts';
import { burst } from './effects.ts';
import {
  advanceProjectiles, makeProjectile,
  type CollisionQuery, type HitTarget, type Projectile, type ProjectileHit, type ProjectileImpact,
} from './projectiles.ts';
import { applyElement, spawnZone } from './reactions.ts';
import { applyStatus, ELEMENT_STATUS, STATUS } from './status.ts';
import { blocks, inBounds } from './world.ts';
import type { ElementId, GameState, StatusId } from './state.ts';

/**
 * 弹道在**躯干高度**飞，不在地上爬：`y` 用脚底坐标减掉这个抬升，
 * 所以一支箭看起来是「从弓上射出去」而不是「贴地面滑过去」。
 * 命中判定与绘制读的是同一个抬升，不会出现「画在身上、判定在脚下」。
 */
export const BODY_LIFT = 26;

/** 命中判定用的身体半径（目标半径 + 弹道自身 hit_radius 才是最终容错）。 */
const MONSTER_BODY_RADIUS = 18;
const PLAYER_BODY_RADIUS = 20;

export type ProjectileVisual = 'arrow' | 'orb';

/** 弹道原型（`projectile.xlsx` 一行 + 类型收窄）。 */
export interface ProjectileProfile {
  readonly id: string;
  readonly name: string;
  readonly speed: number;
  readonly range: number;
  readonly hitRadius: number;
  readonly splashRadius: number;
  readonly pierce: number;
  /** 每秒最大转向弧度；0 = 不追踪（非指向性）。 */
  readonly homing: number;
  readonly element: ElementId | null;
  readonly status: StatusId | null;
  readonly zoneRadius: number;
  readonly zoneLife: number;
  readonly visual: ProjectileVisual;
  readonly hint: string;
}

/**
 * 表 → 运行时的**唯一 join 点**。元素 / 状态写成表里的字符串，所以拼错不是
 * 「悄悄没有效果」，而是启动就抛错 —— 和 `skills.ts` / `status.ts` 同一套纪律。
 */
function buildProfiles(): Record<string, ProjectileProfile> {
  const out: Record<string, ProjectileProfile> = {};
  for (const row of projectileRows) {
    const id = String(row.id);
    const element = row.element === '' ? null : (row.element as ElementId);
    if (element !== null && ELEMENT_STATUS[element] === undefined) {
      throw new Error(`projectile.xlsx::${id} 的 element=${row.element} 不是 6 元素之一`);
    }
    const status = row.status === '' ? null : (row.status as StatusId);
    if (status !== null && STATUS[status] === undefined) {
      throw new Error(`projectile.xlsx::${id} 的 status=${row.status} 不在 status.xlsx 里`);
    }
    const visual = row.visual === 'arrow' ? 'arrow' : 'orb';
    out[id] = Object.freeze({
      id,
      name: row.name,
      speed: row.speed,
      range: row.range,
      hitRadius: row.hit_radius,
      splashRadius: row.splash_radius,
      pierce: row.pierce,
      homing: row.homing,
      element,
      status,
      zoneRadius: row.zone_radius,
      zoneLife: row.zone_life,
      visual,
      hint: row.hint,
    });
  }
  return out;
}

export const PROJECTILES: Readonly<Record<string, ProjectileProfile>> = Object.freeze(buildProfiles());

export function projectileProfile(id: string): ProjectileProfile {
  const profile = PROJECTILES[id];
  if (profile === undefined) {
    throw new Error(`projectile.xlsx 里没有 id=${id}，弹道没有数值可用`);
  }
  return profile;
}

/* ------------------------------------------------------------ 发射 */

export interface FireOptions {
  readonly owner: AttackOwner;
  readonly projectileId: string;
  readonly damage: number;
  /** 出手点（脚底世界坐标；函数内部抬到躯干高度）。 */
  readonly from: { x: number; y: number };
  /** 指向性：锁定的怪物下标。null / 省略 = 非指向性。 */
  readonly targetIndex?: number | null;
  /** 非指向性：朝这个世界坐标飞。省略时用 `angle`。 */
  readonly aim?: { x: number; y: number } | null;
  /** 非指向性且没有 `aim` 时的角度（弧度）。 */
  readonly angle?: number;
  /**
   * 「在光标那一点就收」的飞行距离上限（世界像素）。
   *
   * 地面瞄准的弹道法术（火球）需要它：玩家点的是**落点**，不是方向。
   * 不给这个值时弹道飞到原型射程尽头才消散 —— 那是弓箭的行为（直着穿过去），
   * 不是「往那儿丢一颗球」。
   */
  readonly aimRange?: number;
  /** 来源标签（技能 id / 武器 id），只用于表现与投影。 */
  readonly sourceId: string;
}

/** 怪物在 `HitTarget` 里的 id 约定：`m<下标>`。玩家恒为 `player`。 */
export function monsterTargetId(index: number): string {
  return `m${index}`;
}

export function monsterIndexOf(id: string): number | null {
  if (!id.startsWith('m')) return null;
  const n = Number(id.slice(1));
  return Number.isInteger(n) ? n : null;
}

/**
 * 发射一发。指向性要求目标活着；目标已经死了就退化成「朝它最后的位置直飞」
 * （不凭空吞掉一次出手，玩家不会觉得「按了没反应」）。
 */
export function fireProjectile(s: GameState, options: FireOptions): Projectile | null {
  const profile = projectileProfile(options.projectileId);
  const from = { x: options.from.x, y: options.from.y - BODY_LIFT };

  let targetId: string | null = null;
  let angle = options.angle ?? 0;
  const index = options.targetIndex ?? null;
  const target = index === null ? undefined : s.skeletons[index];
  if (target !== undefined && target.alive) {
    targetId = monsterTargetId(index as number);
    angle = Math.atan2(target.y - BODY_LIFT - from.y, target.x - from.x);
  } else if (options.aim !== undefined && options.aim !== null) {
    angle = Math.atan2(options.aim.y - BODY_LIFT - from.y, options.aim.x - from.x);
  }

  s.projectileSeq += 1;
  const wanted = options.aimRange !== undefined && options.aimRange > 0
    ? options.aimRange
    : profile.range;
  const made = makeProjectile({
    id: `shot-${s.projectileSeq}`,
    specId: profile.id,
    owner: options.owner,
    x: from.x,
    y: from.y,
    angle,
    speed: profile.speed,
    damage: options.damage,
    targetId,
    homing: profile.homing,
    pierce: profile.pierce,
    range: Math.min(profile.range, wanted),
    hitRadius: profile.hitRadius,
  });
  s.projectiles.push(made);
  s.projectileStats.fired += 1;
  // 出手的一小簇火花：远程攻击必须「看得见从哪出去的」，否则读成凭空掉血。
  burst(s, from.x, from.y, profile.visual === 'orb' ? '#fb923c' : '#e8e4d8', 5, 80);
  return made;
}

/* ------------------------------------------------------------ 推进 */

function terrainQuery(s: GameState): CollisionQuery {
  const w = s.world;
  return {
    blocks: (x, y) => blocks(w, x, y),
    inBounds: (x, y) => inBounds(w, x, y),
  };
}

/** 本帧可被命中的身体：玩家 + 全部活着的怪（都在躯干高度）。 */
function collectTargets(s: GameState): HitTarget[] {
  const targets: HitTarget[] = [{
    kind: 'player', id: 'player',
    x: s.player.x, y: s.player.y - BODY_LIFT, radius: PLAYER_BODY_RADIUS,
  }];
  for (let i = 0; i < s.skeletons.length; i += 1) {
    const sk = s.skeletons[i];
    if (sk === undefined || !sk.alive) continue;
    targets.push({
      kind: 'monster', id: monsterTargetId(i),
      x: sk.x, y: sk.y - BODY_LIFT, radius: MONSTER_BODY_RADIUS,
    });
  }
  return targets;
}

/** 每帧推进全部飞行体，并结算命中 / 落地。 */
export function updateProjectiles(s: GameState, dt: number): void {
  if (s.projectiles.length === 0) return;
  const frame = advanceProjectiles(s.projectiles, dt, terrainQuery(s), collectTargets(s));
  s.projectiles = frame.projectiles;
  s.projectileStats.hits += frame.hits.length;
  s.projectileStats.blocked += frame.blocked;
  s.projectileStats.outOfBounds += frame.outOfBounds;
  s.projectileStats.fizzled += frame.fizzled;
  for (const hit of frame.hits) resolveHit(s, hit);
  for (const impact of frame.impacts) resolveImpact(s, impact);
}

function resolveHit(s: GameState, hit: ProjectileHit): void {
  const profile = projectileProfile(hit.projectile.specId);
  const damage = hit.projectile.damage;
  if (hit.target.kind === 'monster') {
    const index = monsterIndexOf(hit.target.id);
    if (index !== null) damageMonster(s, index, damage, hit.projectile, profile, 1);
  } else {
    // 无敌帧（闪避 / 受击硬直）在这里生效：翻滚躲开一支箭是设计允许的答案。
    damagePlayer(s, damage, { color: '#ff6b6b', source: profile.name });
    s.projectileStats.playerHits += 1;
  }
  explode(s, profile, hit.projectile, hit.x, hit.y, hit.target.kind === 'monster' ? monsterIndexOf(hit.target.id) : null);
}

function resolveImpact(s: GameState, impact: ProjectileImpact): void {
  const profile = projectileProfile(impact.projectile.specId);
  if (profile.zoneRadius > 0 || profile.splashRadius > 0) {
    explode(s, profile, impact.projectile, impact.x, impact.y, null);
    return;
  }
  // 一支箭钉在墙上 / 飞满射程：只有一点点碎屑，不需要保留。
  burst(s, impact.x, impact.y, '#9fb3c8', 4, 70);
}

/**
 * 命中一个怪 + 元素 / 状态附着。顺序是刻意的：先扣血（可能在 `damageSkeleton`
 * 里触发撞墙 / 石化碎裂 / 睡眠加伤），再上状态 —— 被这一发打死的怪不该再挂点燃，
 * 否则尸体带着 DOT 继续跳伤害，击杀数会莫名其妙地涨。
 */
function damageMonster(
  s: GameState,
  index: number,
  damage: number,
  source: Projectile,
  profile: ProjectileProfile,
  knockback: number,
): void {
  const sk = s.skeletons[index];
  if (sk === undefined || !sk.alive) return;
  const speed = Math.hypot(source.vx, source.vy) || 1;
  const aliveBefore = sk.alive;
  damageSkeleton(s, index, damage, {
    dirX: source.vx / speed,
    dirY: source.vy / speed,
    knockback,
    color: profile.element === 'fire' ? '#fb923c' : '#ffd166',
  });
  // 造成伤害才磨武器（设计 7.4）：打空只丢一支箭，不额外扣耐久。
  if (aliveBefore && source.owner === 'player') wearWeapon(s, damage);
  const after = s.skeletons[index];
  if (after === undefined || !after.alive) return;
  if (profile.status !== null) applyStatus(after, profile.status);
  if (profile.element !== null) applyElement(s, index, profile.element);
}

/**
 * 爆炸 / 落地的统一收尾：溅射（同一份伤害，不衰减）+ 地面区域 + 表现。
 *
 * `skipIndex` 是刚刚被直击的那一只 —— 它已经吃过一次，溅射不能再打它，
 * 否则「命中 + 溅射」会变成双倍伤害而没人看得出来。
 */
function explode(
  s: GameState,
  profile: ProjectileProfile,
  source: Projectile,
  x: number,
  y: number,
  skipIndex: number | null,
): void {
  if (profile.splashRadius > 0) {
    for (let i = 0; i < s.skeletons.length; i += 1) {
      if (i === skipIndex) continue;
      const sk = s.skeletons[i];
      if (sk === undefined || !sk.alive) continue;
      if (Math.hypot(sk.x - x, (sk.y - BODY_LIFT) - y) > profile.splashRadius) continue;
      damageMonster(s, i, source.damage, source, profile, 1.4);
    }
    s.projectileStats.splashes += 1;
    burst(s, x, y, profile.element === 'fire' ? '#fb923c' : '#cfe8ff', 18, 220);
  }
  if (profile.zoneRadius > 0 && profile.element !== null) {
    spawnZone(
      s, profile.element, x, y + BODY_LIFT * 0.6,
      profile.zoneRadius, profile.zoneLife, `${profile.id}:${source.id}`,
    );
  }
}

/* ------------------------------------------------------------ 弹药 */

/** 背包里的弹药数量（弹药和药一样是**物品**，不是计数器）。 */
export function ammoCount(s: GameState, ammoId: string): number {
  let total = 0;
  for (const item of s.runInventory.bag) if (item.defId === ammoId) total += 1;
  return total;
}

/** 取走一件弹药。没有就返回 false，状态不变。 */
export function takeAmmo(s: GameState, ammoId: string): boolean {
  const item = s.runInventory.bag.find((it) => it.defId === ammoId);
  if (item === undefined) return false;
  const index = s.runInventory.bag.findIndex((it) => it.uid === item.uid);
  if (index < 0) return false;
  s.runInventory.bag.splice(index, 1);
  return true;
}

/** 当前武器是不是「按发数打」的远程武器（HUD 与出手前检查共用）。 */
export function needsAmmo(spec: { ammoId?: string }): boolean {
  return spec.ammoId !== undefined;
}

/** 投影用：飞行体的屏幕无关事实（世界坐标，绘制与验收共用）。 */
export function projectileSnapshot(s: GameState): {
  id: string; specId: string; owner: AttackOwner; x: number; y: number;
  angle: number; travelled: number; locked: boolean;
}[] {
  return s.projectiles.map((p) => ({
    id: p.id,
    specId: p.specId,
    owner: p.owner,
    x: p.x,
    y: p.y,
    angle: Math.atan2(p.vy, p.vx),
    travelled: Math.round(p.travelled),
    locked: p.targetId !== null,
  }));
}
