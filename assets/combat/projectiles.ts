/**
 * Projectile runtime — pure flight / collision logic, no engine or GameState
 * coupling (the caller supplies targets and a terrain query).
 *
 * 两种远程攻击在同一套飞行体里表达（用户要求「指向性和非指向性都要考虑」）：
 *
 * - **指向性（lock-on）**：`targetId` 指向一个目标、`homing > 0`，飞行中每帧朝
 *   目标转向。点到的怪跑不掉 —— 这就是「锁住的那一只只挨这一发」的远程版。
 *   目标中途死了 / 不存在了不改行为，弹道只是继续直飞（不会凭空消失）。
 * - **非指向性（skillshot）**：`targetId = null`、`homing = 0`，朝起手那一瞬的角度
 *   直线飞。打空是合法结果 —— 走位能躲，这正是「用位移换伤害」的另一半。
 *
 * 数值全部由调用方从 `projectile.xlsx` 解析后传进来：本文件不知道表、不知道元素、
 * 不知道伤害怎么结算，只知道「往哪飞、撞到什么、什么时候停」。
 *
 * 销毁条件只有四个：命中（且穿透次数用完）/ 撞墙 / 出界 / 飞满射程。射程是
 * 表里的一列 —— 一支箭飞出 8000px 会让人觉得「游戏忘了删东西」，而不是「射得远」。
 */

import type { AttackOwner } from './attack-spec.ts';

export interface Projectile {
  readonly id: string;
  /** 弹道原型的 id（`projectile.xlsx` 的一行），调用方据此结算伤害 / 元素 / 溅射。 */
  readonly specId: string;
  readonly owner: AttackOwner;
  readonly damage: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  alive: boolean;
  /** 锁定目标 id；null = 非指向性（直线飞）。 */
  readonly targetId: string | null;
  /** 每秒最多转多少弧度；0 = 不追踪。 */
  readonly homing: number;
  /** 命中后还能穿过几个目标；0 = 一碰就停（穿透一次就减一）。 */
  pierce: number;
  /** 最大飞行距离（世界像素）。 */
  readonly range: number;
  /** 自身碰撞半径，命中判定时叠加在目标半径上。 */
  readonly hitRadius: number;
  /** 已经飞过的距离。 */
  travelled: number;
  /** 已经打过的目标 id（穿透时同一个目标不重复挨打）。 */
  struck: string[];
}

export interface CollisionQuery {
  /** True for walls / void / anything that blocks movement AND sight. */
  blocks(x: number, y: number): boolean;
  inBounds(x: number, y: number): boolean;
}

export const NO_COLLISION: CollisionQuery = Object.freeze({
  blocks: () => false,
  inBounds: () => true,
});

export interface HitTarget {
  readonly kind: 'player' | 'monster';
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

export interface ProjectileHit {
  readonly projectile: Projectile;
  readonly target: HitTarget;
  /** 命中点（世界像素）：溅射与地面残留以它为中心。 */
  readonly x: number;
  readonly y: number;
}

/** 没有打中任何身体就结束的弹道（撞墙 / 出界 / 飞满射程）—— 落点要能给绘制与爆炸用。 */
export interface ProjectileImpact {
  readonly projectile: Projectile;
  readonly x: number;
  readonly y: number;
  readonly reason: 'blocked' | 'outOfBounds' | 'range';
}

export interface ProjectileFrame {
  readonly projectiles: Projectile[];
  readonly hits: ProjectileHit[];
  /** 撞墙 / 出界 / 飞满射程的落点，按发生顺序。 */
  readonly impacts: ProjectileImpact[];
  /** 撞墙销毁的数量。 */
  readonly blocked: number;
  /** 出界销毁的数量。 */
  readonly outOfBounds: number;
  /** 飞满射程消散的数量（既没打中也没撞墙）。 */
  readonly fizzled: number;
}

/** Sub-step length in world pixels; keeps fast projectiles from tunnelling. */
const SUB_STEP = 8;

export interface ProjectileInit {
  readonly id: string;
  readonly specId: string;
  readonly owner: AttackOwner;
  readonly x: number;
  readonly y: number;
  /** 起手角度（弧度）。 */
  readonly angle: number;
  readonly speed: number;
  readonly damage: number;
  readonly targetId?: string | null;
  readonly homing?: number;
  readonly pierce?: number;
  readonly range?: number;
  readonly hitRadius?: number;
}

export function makeProjectile(init: ProjectileInit): Projectile {
  return {
    id: init.id,
    specId: init.specId,
    owner: init.owner,
    damage: init.damage,
    x: init.x,
    y: init.y,
    vx: Math.cos(init.angle) * init.speed,
    vy: Math.sin(init.angle) * init.speed,
    alive: true,
    targetId: init.targetId ?? null,
    homing: Math.max(0, init.homing ?? 0),
    pierce: Math.max(0, Math.floor(init.pierce ?? 0)),
    range: init.range !== undefined && init.range > 0 ? init.range : Infinity,
    hitRadius: Math.max(0, init.hitRadius ?? 0),
    travelled: 0,
    struck: [],
  };
}

function hostileKind(owner: AttackOwner): HitTarget['kind'] {
  return owner === 'player' ? 'monster' : 'player';
}

/** 朝目标转一小步（弧度钳制，取最短弧），返回新的速度分量。 */
function steer(
  p: Projectile, towardX: number, towardY: number, maxTurn: number,
): { vx: number; vy: number } {
  const speed = Math.hypot(p.vx, p.vy) || 1;
  const current = Math.atan2(p.vy, p.vx);
  const wanted = Math.atan2(towardY - p.y, towardX - p.x);
  let delta = wanted - current;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  const turn = Math.max(-maxTurn, Math.min(maxTurn, delta));
  const angle = current + turn;
  return { vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed };
}

/**
 * Advance every live projectile by `dt` seconds. Pure: the input array is never
 * mutated; the returned array contains only still-flying projectiles.
 */
export function advanceProjectiles(
  projectiles: readonly Projectile[],
  dt: number,
  query: CollisionQuery,
  targets: readonly HitTarget[],
): ProjectileFrame {
  const alive: Projectile[] = [];
  const hits: ProjectileHit[] = [];
  const impacts: ProjectileImpact[] = [];
  let blocked = 0;
  let outOfBounds = 0;
  let fizzled = 0;
  if (dt <= 0) {
    return { projectiles: [...projectiles], hits, impacts, blocked, outOfBounds, fizzled };
  }

  for (const source of projectiles) {
    if (!source.alive) continue;
    const p: Projectile = { ...source, struck: [...source.struck] };
    const hostileTargets = targets.filter((t) => t.kind === hostileKind(p.owner));
    const speed = Math.hypot(p.vx, p.vy);
    const steps = Math.max(1, Math.ceil((speed * dt) / SUB_STEP));
    const stepDt = dt / steps;

    for (let step = 0; step < steps; step += 1) {
      // 追踪每子步都做：目标在小步之间也算「这一帧跑到哪了」，大转向率才追得上。
      if (p.homing > 0 && p.targetId !== null) {
        const mark = hostileTargets.find((t) => t.id === p.targetId);
        if (mark !== undefined) {
          const turned = steer(p, mark.x, mark.y, p.homing * stepDt);
          p.vx = turned.vx;
          p.vy = turned.vy;
        }
      }
      const moveX = p.vx * stepDt;
      const moveY = p.vy * stepDt;
      p.x += moveX;
      p.y += moveY;
      p.travelled += Math.hypot(moveX, moveY);

      if (!query.inBounds(p.x, p.y)) {
        p.alive = false;
        outOfBounds += 1;
        impacts.push({ projectile: p, x: p.x, y: p.y, reason: 'outOfBounds' });
        break;
      }
      if (query.blocks(p.x, p.y)) {
        p.alive = false;
        blocked += 1;
        impacts.push({ projectile: p, x: p.x, y: p.y, reason: 'blocked' });
        break;
      }
      const hit = hostileTargets.find(
        (t) => !p.struck.includes(t.id)
          && Math.hypot(t.x - p.x, t.y - p.y) <= t.radius + p.hitRadius,
      );
      if (hit !== undefined) {
        hits.push({ projectile: p, target: hit, x: p.x, y: p.y });
        p.struck.push(hit.id);
        if (p.pierce > 0) {
          p.pierce -= 1;
        } else {
          p.alive = false;
          break;
        }
      }
      if (p.travelled >= p.range) {
        p.alive = false;
        fizzled += 1;
        impacts.push({ projectile: p, x: p.x, y: p.y, reason: 'range' });
        break;
      }
    }
    if (p.alive) alive.push(p);
  }
  return { projectiles: alive, hits, impacts, blocked, outOfBounds, fizzled };
}
