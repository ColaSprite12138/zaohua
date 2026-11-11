import { describe, expect, it } from 'vitest';
import {
  MELEE_WEAPON, PROJECTILE_SPEED, RANGED_WEAPON, monsterSpec,
  type AttackRequest,
} from '../attack-spec.ts';
import {
  NO_COLLISION, advanceProjectiles, createProjectile,
  type CollisionQuery, type HitTarget,
} from '../projectiles.ts';

const playerShot: AttackRequest = {
  owner: 'player', from: { x: 0, y: 0 }, to: { x: 200, y: 0 },
};
const monsterShot: AttackRequest = {
  owner: 'monster', from: { x: 0, y: 0 }, to: { x: 200, y: 0 },
};

describe('creating a projectile', () => {
  it('normalises direction and takes its speed from the spec', () => {
    const p = createProjectile(playerShot, RANGED_WEAPON, 'p1');
    expect(p.owner).toBe('player');
    expect(p.damage).toBe(RANGED_WEAPON.damage);
    expect(p.vx).toBe(PROJECTILE_SPEED);
    expect(p.vy).toBe(0);
    expect(p.alive).toBe(true);
  });

  it('refuses a melee spec instead of silently firing nothing', () => {
    expect(() => createProjectile(playerShot, MELEE_WEAPON, 'bad')).toThrow(/not projectile/);
  });

  it('a monster uses the same creation path', () => {
    const p = createProjectile(monsterShot, monsterSpec('200001'), 'p2');
    expect(p.owner).toBe('monster');
    expect(p.vx).toBe(PROJECTILE_SPEED);
  });
});

describe('projectile flight', () => {
  it('has no range limit: it keeps flying far beyond any viewport', () => {
    let flying = [createProjectile(playerShot, RANGED_WEAPON, 'p1')];
    for (let i = 0; i < 40; i += 1) {
      flying = advanceProjectiles(flying, 0.5, NO_COLLISION, []).projectiles;
    }
    expect(flying).toHaveLength(1);
    expect(flying[0]!.x).toBeGreaterThan(8000);
    expect(flying[0]!.alive).toBe(true);
  });

  it('hits only the opposite side and is consumed on hit', () => {
    const targets: HitTarget[] = [
      { kind: 'player', id: 'self', x: 60, y: 0, radius: 20 },
      { kind: 'monster', id: 'enemy', x: 200, y: 0, radius: 20 },
    ];
    const frame = advanceProjectiles(
      [createProjectile(playerShot, RANGED_WEAPON, 'p1')],
      1, NO_COLLISION, targets,
    );
    expect(frame.projectiles).toHaveLength(0);
    expect(frame.hits).toHaveLength(1);
    expect(frame.hits[0]!.target.id).toBe('enemy');
  });

  it('a monster projectile hits the player, never another monster', () => {
    const targets: HitTarget[] = [
      { kind: 'monster', id: 'other', x: 60, y: 0, radius: 20 },
      { kind: 'player', id: 'hero', x: 200, y: 0, radius: 20 },
    ];
    const frame = advanceProjectiles(
      [createProjectile(monsterShot, monsterSpec('200001'), 'p2')],
      1, NO_COLLISION, targets,
    );
    expect(frame.hits).toHaveLength(1);
    expect(frame.hits[0]!.target.id).toBe('hero');
  });

  it('is destroyed by terrain that blocks movement and sight', () => {
    const wall: CollisionQuery = {
      blocks: (x) => x >= 100,
      inBounds: () => true,
    };
    const frame = advanceProjectiles(
      [createProjectile(playerShot, RANGED_WEAPON, 'p1')], 1, wall, [],
    );
    expect(frame.projectiles).toHaveLength(0);
    expect(frame.blocked).toBe(1);
    expect(frame.hits).toHaveLength(0);
  });

  it('is destroyed when it leaves the world', () => {
    const bounded: CollisionQuery = {
      blocks: () => false,
      inBounds: (x) => x < 150,
    };
    const frame = advanceProjectiles(
      [createProjectile(playerShot, RANGED_WEAPON, 'p1')], 1, bounded, [],
    );
    expect(frame.projectiles).toHaveLength(0);
    expect(frame.outOfBounds).toBe(1);
  });

  it('does not tunnel through a small target at full speed', () => {
    const targets: HitTarget[] = [
      { kind: 'monster', id: 'thin', x: 300, y: 0, radius: 5 },
    ];
    const frame = advanceProjectiles(
      [createProjectile(playerShot, RANGED_WEAPON, 'p1')], 1, NO_COLLISION, targets,
    );
    expect(frame.hits).toHaveLength(1);
    expect(frame.hits[0]!.target.id).toBe('thin');
  });

  it('advancing never mutates the input projectiles', () => {
    const p = createProjectile(playerShot, RANGED_WEAPON, 'p1');
    const before = { x: p.x, y: p.y };
    advanceProjectiles([p], 0.2, NO_COLLISION, []);
    expect({ x: p.x, y: p.y }).toEqual(before);
  });
});
