import { describe, expect, it } from 'vitest';
import { projectile as projectileRows } from '../../resource/generated/projectile.ts';
import {
  NO_COLLISION, advanceProjectiles, makeProjectile,
  type CollisionQuery, type HitTarget, type Projectile,
} from '../projectiles.ts';

/**
 * 纯飞行逻辑：不碰 GameState、不碰表 —— 数值由调用方传进来。
 * 「哪种弹用哪一行」由 `projectile-runtime.test.ts` 守。
 */

function shot(overrides: Partial<Parameters<typeof makeProjectile>[0]> = {}): Projectile {
  return makeProjectile({
    id: 'p1', specId: 'arrow', owner: 'player',
    x: 0, y: 0, angle: 0, speed: 420, damage: 22,
    ...overrides,
  });
}

const BOW_ROW = projectileRows.find((row) => row.id === 'arrow')!;
const FIREBALL_ROW = projectileRows.find((row) => row.id === 'fireball')!;

describe('creating a projectile', () => {
  it('turns an angle + speed into a velocity and keeps the numbers it was given', () => {
    const p = makeProjectile({
      id: 'p1', specId: 'arrow', owner: 'player',
      x: 10, y: 20, angle: Math.PI / 2, speed: 300, damage: 34,
      targetId: 'm2', homing: 4, pierce: 2, range: 500, hitRadius: 12,
    });
    expect(p.vx).toBeCloseTo(0, 6);
    expect(p.vy).toBeCloseTo(300, 6);
    expect(p.x).toBe(10);
    expect(p.y).toBe(20);
    expect(p.damage).toBe(34);
    expect(p.targetId).toBe('m2');
    expect(p.homing).toBe(4);
    expect(p.pierce).toBe(2);
    expect(p.range).toBe(500);
    expect(p.hitRadius).toBe(12);
    expect(p.travelled).toBe(0);
    expect(p.alive).toBe(true);
  });

  it('defaults to a straight, non-piercing, unlimited-range shot', () => {
    const p = shot();
    expect(p.targetId).toBeNull();
    expect(p.homing).toBe(0);
    expect(p.pierce).toBe(0);
    expect(p.range).toBe(Infinity);
    expect(p.hitRadius).toBe(0);
  });
});

describe('projectile flight', () => {
  it('hits only the opposite side and is consumed on hit', () => {
    const targets: HitTarget[] = [
      { kind: 'player', id: 'self', x: 60, y: 0, radius: 20 },
      { kind: 'monster', id: 'enemy', x: 200, y: 0, radius: 20 },
    ];
    const frame = advanceProjectiles([shot()], 1, NO_COLLISION, targets);
    expect(frame.projectiles).toHaveLength(0);
    expect(frame.hits).toHaveLength(1);
    expect(frame.hits[0]!.target.id).toBe('enemy');
    // 命中点要能给溅射 / 地面残留用，所以必须上报坐标（子步 8px，落在目标边缘附近）。
    expect(frame.hits[0]!.x).toBeGreaterThan(180);
    expect(frame.hits[0]!.x).toBeLessThanOrEqual(200);
  });

  it('a monster projectile hits the player, never another monster', () => {
    const targets: HitTarget[] = [
      { kind: 'monster', id: 'other', x: 60, y: 0, radius: 20 },
      { kind: 'player', id: 'hero', x: 200, y: 0, radius: 20 },
    ];
    const frame = advanceProjectiles(
      [shot({ owner: 'monster', specId: 'monster_arrow' })], 1, NO_COLLISION, targets,
    );
    expect(frame.hits).toHaveLength(1);
    expect(frame.hits[0]!.target.id).toBe('hero');
  });

  it('is destroyed by terrain that blocks movement and sight', () => {
    const wall: CollisionQuery = { blocks: (x) => x >= 100, inBounds: () => true };
    const frame = advanceProjectiles([shot()], 1, wall, []);
    expect(frame.projectiles).toHaveLength(0);
    expect(frame.blocked).toBe(1);
    expect(frame.hits).toHaveLength(0);
    // 落点要上报：火球撞墙也要炸，不能凭空消失。
    expect(frame.impacts[0]!.reason).toBe('blocked');
    expect(frame.impacts[0]!.x).toBeGreaterThanOrEqual(100);
  });

  it('is destroyed when it leaves the world', () => {
    const bounded: CollisionQuery = { blocks: () => false, inBounds: (x) => x < 150 };
    const frame = advanceProjectiles([shot()], 1, bounded, []);
    expect(frame.projectiles).toHaveLength(0);
    expect(frame.outOfBounds).toBe(1);
    expect(frame.impacts[0]!.reason).toBe('outOfBounds');
  });

  it('fizzles at its own range instead of flying across the whole map', () => {
    const p = shot({ range: 200, speed: 400 });
    const first = advanceProjectiles([p], 0.2, NO_COLLISION, []);
    expect(first.projectiles).toHaveLength(1);
    expect(first.fizzled).toBe(0);
    const later = advanceProjectiles(first.projectiles, 0.4, NO_COLLISION, []);
    expect(later.projectiles).toHaveLength(0);
    expect(later.fizzled).toBe(1);
    expect(later.impacts[0]!.reason).toBe('range');
  });

  it('does not tunnel through a small target at full speed', () => {
    const targets: HitTarget[] = [{ kind: 'monster', id: 'thin', x: 300, y: 0, radius: 5 }];
    const frame = advanceProjectiles([shot()], 1, NO_COLLISION, targets);
    expect(frame.hits).toHaveLength(1);
    expect(frame.hits[0]!.target.id).toBe('thin');
  });

  it('adds the projectile`s own hit radius to the target radius', () => {
    // 半径 5 的目标 + 命中容错 12 = 17px：擦边而过的那一箭也算命中。
    const targets: HitTarget[] = [{ kind: 'monster', id: 'graze', x: 300, y: 16, radius: 5 }];
    const miss = advanceProjectiles([shot({ hitRadius: 0 })], 1, NO_COLLISION, targets);
    expect(miss.hits).toHaveLength(0);
    const hit = advanceProjectiles([shot({ hitRadius: 12 })], 1, NO_COLLISION, targets);
    expect(hit.hits).toHaveLength(1);
  });

  it('advancing never mutates the input projectiles', () => {
    const p = shot();
    const before = { x: p.x, y: p.y, travelled: p.travelled };
    advanceProjectiles([p], 0.2, NO_COLLISION, []);
    expect({ x: p.x, y: p.y, travelled: p.travelled }).toEqual(before);
  });
});

describe('targeting modes', () => {
  it('a locked shot curves into a target that walked sideways', () => {
    // 朝 +x 直线射出，目标在 240px 外、偏了 120px：不追踪一定打空。
    const targets: HitTarget[] = [{ kind: 'monster', id: 'm0', x: 240, y: 120, radius: 18 }];
    const straight = advanceProjectiles([shot({ speed: 300 })], 1.2, NO_COLLISION, targets);
    expect(straight.hits).toHaveLength(0);

    const homing = advanceProjectiles(
      [shot({ speed: 300, homing: 6, targetId: 'm0' })], 1.2, NO_COLLISION, targets,
    );
    expect(homing.hits).toHaveLength(1);
    expect(homing.hits[0]!.target.id).toBe('m0');
  });

  it('a locked shot keeps flying straight when its target is already gone', () => {
    const frame = advanceProjectiles(
      [shot({ speed: 300, homing: 6, targetId: 'm9' })], 0.3, NO_COLLISION, [],
    );
    expect(frame.projectiles).toHaveLength(1);
    expect(frame.hits).toHaveLength(0);
    expect(frame.projectiles[0]!.vy).toBeCloseTo(0, 6);
  });

  it('a directional shot can miss: that is the whole point of the mode', () => {
    const targets: HitTarget[] = [{ kind: 'monster', id: 'm0', x: 200, y: 90, radius: 18 }];
    const frame = advanceProjectiles(
      [shot({ speed: FIREBALL_ROW.speed, range: 400, hitRadius: FIREBALL_ROW.hit_radius })],
      1.5, NO_COLLISION, targets,
    );
    expect(frame.hits).toHaveLength(0);
  });
});

describe('pierce', () => {
  it('passes through the number of extra targets it was given', () => {
    const targets: HitTarget[] = [
      { kind: 'monster', id: 'a', x: 100, y: 0, radius: 18 },
      { kind: 'monster', id: 'b', x: 200, y: 0, radius: 18 },
      { kind: 'monster', id: 'c', x: 300, y: 0, radius: 18 },
    ];
    const frame = advanceProjectiles([shot({ pierce: 1 })], 1.2, NO_COLLISION, targets);
    expect(frame.hits.map((h) => h.target.id)).toEqual(['a', 'b']);
    expect(frame.projectiles).toHaveLength(0);
  });

  it('never hits the same body twice', () => {
    const targets: HitTarget[] = [{ kind: 'monster', id: 'a', x: 100, y: 0, radius: 40 }];
    const frame = advanceProjectiles([shot({ pierce: 3 })], 1.2, NO_COLLISION, targets);
    expect(frame.hits).toHaveLength(1);
    expect(frame.projectiles).toHaveLength(1);
  });
});

describe('the authored table stays inside sane bounds', () => {
  it('every row describes something that can actually fly', () => {
    expect(projectileRows.length).toBeGreaterThan(0);
    for (const row of projectileRows) {
      expect(row.speed, `${row.id} 没配速度`).toBeGreaterThan(0);
      expect(row.range, `${row.id} 没配射程`).toBeGreaterThan(0);
      expect(row.hit_radius, `${row.id} 没配命中容错`).toBeGreaterThan(0);
      expect(row.pierce).toBeGreaterThanOrEqual(0);
      expect(row.homing).toBeGreaterThanOrEqual(0);
    }
  });

  it('the two modes are both present: one homing row, one straight row', () => {
    expect(BOW_ROW.homing).toBeGreaterThan(0);          // 指向性
    expect(FIREBALL_ROW.homing).toBe(0);                // 非指向性
    expect(FIREBALL_ROW.splash_radius).toBeGreaterThan(0);
  });
});
