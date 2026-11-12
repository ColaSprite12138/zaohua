import { describe, expect, it } from 'vitest';
import { addToBag, itemDef, type RunLoadout } from '../../meta/inventory.ts';
import {
  applyRunCommand, collectDrop, ensureItemCatalog, makeRunInventory,
  snapshotRun, weaponDamage,
} from '../run-inventory.ts';

const emptyLoadout = (): RunLoadout => ({
  bag: [],
  equipped: Array.from({ length: 10 }, () => null),
  activeWeaponSlot: 0,
});

const withWeapons = (): RunLoadout => ({
  bag: [{ uid: 'bag-a', defId: 'longsword', container: 'bag', col: 0, row: 0 }],
  equipped: [
    { uid: 'w0', defId: '10001' },
    { uid: 'w1', defId: '10006' },
    ...Array.from({ length: 8 }, () => null),
  ],
  activeWeaponSlot: 1,
});

describe('Worker-side run inventory', () => {
  it('registers the authored catalog in THIS heap', () => {
    ensureItemCatalog();
    expect(itemDef('10006').name).toBe('霜之哀伤');
    expect(itemDef('20001').name).toBe('弓');
    expect(itemDef('longsword').name).toBe('长剑');
  });

  it('weaponDamage comes from weapon.xlsx, unknown ids fall back to null', () => {
    expect(weaponDamage('10001')).toBe(12.5);
    expect(weaponDamage('10006')).toBe(325);
    expect(weaponDamage('30001')).toBe(15);
    expect(weaponDamage('longsword')).toBeNull();
    expect(weaponDamage('99999')).toBeNull();
  });

  it('makeRunInventory copies the loadout into a stash-free state', () => {
    const loadout = withWeapons();
    const run = makeRunInventory(loadout);
    expect(run.stash).toEqual([]);
    expect(run.bag).toHaveLength(1);
    expect(run.equipped).toHaveLength(10);
    expect(run.activeWeaponSlot).toBe(1);
    expect(run.bag[0]).not.toBe(loadout.bag[0]);
  });

  it('commands are applied inside the Worker and never touch a stash', () => {
    const run = makeRunInventory(emptyLoadout());
    expect(applyRunCommand(run, { action: 'place', uid: 'missing', col: 0, row: 0 })).toBe(false);
    expect(collectDrop(run, 'w0', '10001').where).toBe('weapon');
    expect(applyRunCommand(run, { action: 'active', slot: 1 })).toBe(true);
    expect(run.activeWeaponSlot).toBe(1);
    expect(run.stash).toEqual([]);
  });

  it('a displaced worn item returns to the BAG, never to a hidden stash', () => {
    const run = makeRunInventory(emptyLoadout());
    run.equipped[0] = { uid: 'w0', defId: 'longsword' };
    run.equipped[1] = { uid: 'w1', defId: '10006' };
    expect(applyRunCommand(run, { action: 'equip', uid: 'w1', slot: 0 })).toBe(true);
    expect(run.equipped[0]?.uid).toBe('w1');
    expect(run.bag.map((i) => i.uid)).toEqual(['w0']);
    expect(run.stash).toEqual([]);
  });

  it('a swap with no free bag cell is rejected and loses nothing', () => {
    const run = makeRunInventory(emptyLoadout());
    run.equipped[0] = { uid: 'w0', defId: 'longsword' };
    run.equipped[1] = { uid: 'w1', defId: '10006' };
    for (let i = 0; i < 4; i += 1) {
      expect(addToBag(run, `filler-${i}`, 'longsword')).not.toBeNull();
    }
    expect(applyRunCommand(run, { action: 'equip', uid: 'w1', slot: 0 })).toBe(false);
    expect(run.equipped[0]?.uid).toBe('w0');
    expect(run.equipped[1]?.uid).toBe('w1');
    expect(run.bag).toHaveLength(4);
    expect(run.stash).toEqual([]);
  });

  it('collectDrop prefers an empty weapon slot, then the bag, then reports full', () => {
    const run = makeRunInventory(emptyLoadout());
    expect(collectDrop(run, 'a', '10001')).toEqual({ where: 'weapon', slot: 0 });
    expect(collectDrop(run, 'b', '10006')).toEqual({ where: 'weapon', slot: 1 });
    expect(collectDrop(run, 'c', '20006')).toEqual({ where: 'bag' });
    for (let i = 0; i < 3; i += 1) {
      expect(collectDrop(run, `d${i}`, '10001').where).toBe('bag');
    }
    expect(collectDrop(run, 'e', '10001')).toEqual({ where: 'full' });
    expect(run.stash).toEqual([]);
  });

  it('snapshotRun is a detached copy suitable for the message channel', () => {
    const run = makeRunInventory(withWeapons());
    const snap = snapshotRun(run);
    expect(snap.equipped[0]).toEqual({ uid: 'w0', defId: '10001' });
    run.equipped[0] = null;
    expect(snap.equipped[0]).toEqual({ uid: 'w0', defId: '10001' });
    expect(snap.equipped).toHaveLength(10);
  });
});
