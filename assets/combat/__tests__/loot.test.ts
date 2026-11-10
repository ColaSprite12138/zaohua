import { describe, expect, it } from 'vitest';
import {
  makeRng, poolEntries, rollLoot, theoreticalDistribution, itemRow, monsterRow,
} from '../loot.ts';
import { createState, DEFAULT_MONSTER_COUNT, spawnSkeletons } from '../state.ts';
import { deployRun, projection, step } from '../simulation.ts';
import { swingAtTarget } from '../attack.ts';
import { updateDrops } from '../weapons.ts';
import { NO_MODIFIERS } from '../modifiers.ts';

const tick = (s: ReturnType<typeof createState>, frames = 1) => {
  for (let i = 0; i < frames; i += 1) {
    step(s, 1 / 60, {
      pointerDown: false, pointerHeld: false, pointerUp: false,
      dodge: false, restart: false,
    }, NO_MODIFIERS);
  }
};

describe('authored tables are wired into combat', () => {
  it('resolves all 12 items and both monsters', () => {
    expect(itemRow('10001')?.name).toBe('巨剑');
    expect(itemRow('20006')?.name).toBe('射日');
    expect(itemRow('99999')).toBeUndefined();
    expect(monsterRow('100001')?.loot_pool_id).toBe(1);
    expect(monsterRow('200001')?.loot_pool_id).toBe(2);
  });

  it('both pools carry the 10/8/6/4/2/1 weight ladder', () => {
    for (const pool of [1, 2]) {
      expect(poolEntries(pool).map((e) => e.weight)).toEqual([10, 8, 6, 4, 2, 1]);
      const dist = theoreticalDistribution(pool);
      expect(Object.values(dist).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
      expect(dist[pool === 1 ? '10001' : '20001']).toBeCloseTo(10 / 31, 10);
      expect(dist[pool === 1 ? '10006' : '20006']).toBeCloseTo(1 / 31, 10);
    }
    expect(theoreticalDistribution(999)).toEqual({});
  });

  it('a seeded roll is reproducible and always returns an authored item', () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    for (let i = 0; i < 50; i += 1) expect(a()).toBe(b());
    const rng = makeRng(7);
    const items = new Set<string>();
    for (let i = 0; i < 400; i += 1) {
      const roll = rollLoot('100001', rng);
      expect(roll).not.toBeNull();
      expect(roll!.itemId).toMatch(/^1000[1-6]$/);
      expect(roll!.poolId).toBe(1);
      items.add(roll!.itemId);
    }
    // 400 draws must reach the rarest (1/31) tier too.
    expect(items.size).toBe(6);
  });

  it('monster type selects its own pool', () => {
    const rng = makeRng(99);
    for (let i = 0; i < 60; i += 1) {
      expect(rollLoot('100001', rng)!.itemId).toMatch(/^1000/);
      expect(rollLoot('200001', rng)!.itemId).toMatch(/^2000/);
    }
    expect(rollLoot('999999', rng)).toBeNull();
  });

  it('empirical distribution tracks the authored weights', () => {
    const rng = makeRng(0xc0ffee);
    const N = 31000;
    const counts: Record<string, number> = {};
    for (let i = 0; i < N; i += 1) {
      const id = rollLoot('100001', rng)!.itemId;
      counts[id] = (counts[id] ?? 0) + 1;
    }
    const theory = theoreticalDistribution(1);
    for (const [id, p] of Object.entries(theory)) {
      expect(Math.abs((counts[id] ?? 0) / N - p)).toBeLessThan(0.01);
    }
  });
});

describe('arena population and loot settlement', () => {
  it('defaults to two skeletons with alternating monster ids', () => {
    const s = createState();
    expect(s.monsterCount).toBe(DEFAULT_MONSTER_COUNT);
    expect(s.skeletons).toHaveLength(2);
    expect(s.skeletons[0]!.monsterId).toBe('100001');
    expect(s.skeletons[1]!.monsterId).toBe('200001');
  });

  it('can deploy 8 monsters; first two keep the legacy coordinates', () => {
    const s = createState({ monsterCount: 8 });
    expect(s.skeletons).toHaveLength(8);
    expect(s.skeletons[0]!.x).toBe(880);
    expect(s.skeletons[0]!.y).toBe(430);
    expect(s.skeletons[1]!.x).toBe(1010);
    expect(s.skeletons[1]!.y).toBe(560);
    expect(new Set(s.skeletons.map((sk) => `${sk.x},${sk.y}`)).size).toBe(8);
    expect(new Set(s.skeletons.map((sk) => sk.monsterId)).size).toBe(2);
    expect(spawnSkeletons(1)).toHaveLength(1);
  });

  it('a kill rolls loot, labels the drop, and records it in lootLog', () => {
    const s = createState();
    s.skeletons[0]!.hp = 1;
    swingAtTarget(s, 0, NO_MODIFIERS);
    expect(s.kills).toBe(1);
    expect(s.lootLog).toHaveLength(1);
    expect(s.drops).toHaveLength(1);
    const drop = s.drops[0]!;
    expect(drop.kind).toBe('longsword');
    expect(drop.itemId).toBe(s.lootLog[0]!.itemId);
    expect(drop.name).toBe(s.lootLog[0]!.name);
    expect(drop.quality).toBeTruthy();
    expect(drop.monsterId).toBe('100001');
  });

  it('the same seed reproduces the same loot sequence across a restart', () => {
    const run = () => {
      const s = createState({ seed: 4242 });
      for (const sk of s.skeletons) sk.hp = 1;
      swingAtTarget(s, 0, NO_MODIFIERS);
      swingAtTarget(s, 1, NO_MODIFIERS);
      return s.lootLog.map((r) => r.itemId);
    };
    expect(run()).toEqual(run());
    const s = createState({ seed: 4242 });
    for (const sk of s.skeletons) sk.hp = 1;
    swingAtTarget(s, 0, NO_MODIFIERS);
    swingAtTarget(s, 1, NO_MODIFIERS);
    const before = s.lootLog.map((r) => r.itemId);
    step(s, 1 / 60, {
      pointerDown: false, pointerHeld: false, pointerUp: false,
      dodge: false, restart: true,
    });
    expect(s.lootLog).toHaveLength(0);
    expect(s.monsterCount).toBe(2);
    for (const sk of s.skeletons) sk.hp = 1;
    swingAtTarget(s, 0, NO_MODIFIERS);
    swingAtTarget(s, 1, NO_MODIFIERS);
    expect(s.lootLog.map((r) => r.itemId)).toEqual(before);
  });

  it('walking over a drop carries its authored item id to settlement', () => {
    const s = createState({ seed: 777 });
    s.skeletons[0]!.hp = 1;
    swingAtTarget(s, 0, NO_MODIFIERS);
    const expected = s.lootLog[0]!.itemId;
    // Move the player onto the drop and let one frame resolve the pickup.
    const drop = s.drops[0]!;
    s.player.x = drop.x;
    s.player.y = drop.y;
    updateDrops(s, 1 / 60);
    expect(s.drops).toHaveLength(0);
    expect(s.carriedItems).toEqual([expected]);
    expect(s.weaponSlots[0]).toBe('longsword');
  });

  it('deployRun injects monster count, seed and borrowed weapons', () => {
    const s = createState();
    deployRun(s, { monsterCount: 8, seed: 909, armedWeapons: 2, activeWeaponSlot: 1 });
    expect(s.monsterCount).toBe(8);
    expect(s.skeletons).toHaveLength(8);
    expect(s.runSeed).toBe(909);
    expect(s.weaponSlots).toEqual(['longsword', 'longsword']);
    expect(s.activeWeaponSlot).toBe(1);
    expect(s.lootLog).toHaveLength(0);
    expect(s.carriedItems).toHaveLength(0);
    expect(s.kills).toBe(0);
  });

  it('deployRun with no weapons resets to bare hands', () => {
    const s = createState({ monsterCount: 6 });
    deployRun(s, { armedWeapons: 0 });
    expect(s.weaponSlots).toEqual([null, null]);
    expect(s.skeletons).toHaveLength(6);
  });

  it('projection exposes loot data without breaking legacy fields', () => {
    const s = createState({ monsterCount: 6, seed: 31337 });
    tick(s);
    const p = projection(s);
    expect(p.equippedWeapon).toBeNull();
    expect(p.skeletonsAlive).toBe(6);
    expect(p.monsterCount).toBe(6);
    expect(p.runSeed).toBe(31337);
    expect(p.lootLog).toEqual([]);
    expect(p.carriedItems).toEqual([]);
    expect(p.dropItems).toEqual([]);
  });
});
