/**
 * Projectile runtime — pure logic, no engine / GameState coupling.
 *
 * The owner of a projectile decides which side it can hit; the attack KIND
 * is already resolved by `attack-spec.ts` before a projectile is created.
 * Range is deliberately unbounded: a projectile is destroyed only when it
 * hits a valid target, is blocked by terrain, or leaves the world.
 *
 * `CollisionQuery` is injected. `NO_COLLISION` keeps the legacy one-screen
 * arena behaviour intact; the LDtk map runtime will supply a real grid query
 * later without changing anything in this file.
 */

import {
  PROJECTILE_SPEED, type AttackOwner, type AttackRequest, type AttackSpec,
} from './attack-spec.ts';

export interface Projectile {
  readonly id: string;
  readonly specId: string;
  readonly owner: AttackOwner;
  readonly damage: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  alive: boolean;
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
}

export interface ProjectileFrame {
  readonly projectiles: Projectile[];
  readonly hits: ProjectileHit[];
  readonly blocked: number;
  readonly outOfBounds: number;
}

/** Sub-step length in world pixels; keeps fast projectiles from tunnelling. */
const SUB_STEP = 8;

export function createProjectile(
  req: AttackRequest, spec: AttackSpec, id: string,
): Projectile {
  if (spec.kind !== 'projectile') {
    throw new Error(`spec ${spec.id} is ${spec.kind}, not projectile`);
  }
  const dx = req.to.x - req.from.x;
  const dy = req.to.y - req.from.y;
  const d = Math.hypot(dx, dy) || 1;
  const speed = spec.projectileSpeed ?? PROJECTILE_SPEED;
  return {
    id, specId: spec.id, owner: req.owner, damage: spec.damage,
    x: req.from.x, y: req.from.y,
    vx: (dx / d) * speed, vy: (dy / d) * speed,
    alive: true,
  };
}

function hostileKind(owner: AttackOwner): HitTarget['kind'] {
  return owner === 'player' ? 'monster' : 'player';
}

/**
 * Advance every live projectile by `dt` seconds. Pure: the input array is
 * never mutated; the returned array contains only still-flying projectiles.
 */
export function advanceProjectiles(
  projectiles: readonly Projectile[],
  dt: number,
  query: CollisionQuery,
  targets: readonly HitTarget[],
): ProjectileFrame {
  const alive: Projectile[] = [];
  const hits: ProjectileHit[] = [];
  let blocked = 0;
  let outOfBounds = 0;

  for (const source of projectiles) {
    if (!source.alive) continue;
    const p: Projectile = { ...source };
    const speed = Math.hypot(p.vx, p.vy);
    const steps = Math.max(1, Math.ceil((speed * dt) / SUB_STEP));
    const stepDt = dt / steps;
    const hostile = hostileKind(p.owner);
    const validTargets = targets.filter((t) => t.kind === hostile);

    for (let step = 0; step < steps; step += 1) {
      p.x += p.vx * stepDt;
      p.y += p.vy * stepDt;
      if (!query.inBounds(p.x, p.y)) {
        p.alive = false;
        outOfBounds += 1;
        break;
      }
      if (query.blocks(p.x, p.y)) {
        p.alive = false;
        blocked += 1;
        break;
      }
      const hit = validTargets.find(
        (t) => Math.hypot(t.x - p.x, t.y - p.y) <= t.radius,
      );
      if (hit) {
        p.alive = false;
        hits.push({ projectile: p, target: hit });
        break;
      }
    }
    if (p.alive) alive.push(p);
  }
  return { projectiles: alive, hits, blocked, outOfBounds };
}
