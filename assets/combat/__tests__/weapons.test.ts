import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import { swingAtTarget } from '../attack.ts';
import { NO_MODIFIERS } from '../modifiers.ts';
import { addToBag } from '../../meta/inventory.ts';
import { weaponDamage } from '../run-inventory.ts';
import {
  activeWeapon, createState, reset, type GameState, type StepInput,
} from '../simulation.ts';
import { projection, step } from '../simulation.ts';
import { updateDrops } from '../weapons.ts';

const input = (over: Partial<StepInput> = {}): StepInput => ({
  mouse: undefined,
  pointerDown: false,
  pointerHeld: false,
  pointerUp: false,
  dodge: false,
  restart: false,
  ...over,
});

/** Explicitly order a pickup, then let updateDrops() resolve it on arrival. */
function collectSword(s: GameState): void {
  const uid = `test-drop-${s.carriedItems.length + 1}`;
  s.drops.push({ uid, x: s.player.x, y: s.player.y, kind: 'longsword', t: 0 });
  s.pickupTarget = uid;
  updateDrops(s, 1 / 60);
}

/** Both slots full -> the item must find a footprint in the RUN bag. */
function collectThirdSword(s: GameState): string {
  const uid = 'test-drop-3';
  s.drops.push({ uid, x: s.player.x, y: s.player.y, kind: 'longsword', t: 0 });
  s.pickupTarget = uid;
  updateDrops(s, 1 / 60);
  return uid;
}

describe('two weapon slots (Worker-owned run inventory)', () => {
  it('starts with two empty slots on slot 1, bare-handed', () => {
    const s = createState();
    expect(s.weaponSlots).toEqual([null, null]);
    expect(s.activeWeaponSlot).toBe(0);
    expect(activeWeapon(s)).toBeNull();
    expect(s.runInventory.stash).toEqual([]);
    expect(projection(s).weaponSlots).toEqual([null, null]);
    expect(projection(s).equippedWeapon).toBeNull();
  });

  it('picking up swords fills slot 1 then slot 2', () => {
    const s = createState();
    collectSword(s);
    expect(s.weaponSlots).toEqual(['longsword', null]);
    expect(activeWeapon(s)).toBe('longsword');
    collectSword(s);
    expect(s.weaponSlots).toEqual(['longsword', 'longsword']);
    expect(s.runInventory.equipped[0]?.defId).toBe('longsword');
    expect(s.runInventory.equipped[1]?.defId).toBe('longsword');
  });

  it('authored loot keeps its REAL defId in the Worker state', () => {
    const s = createState();
    s.drops.push({
      uid: 'loot-a', x: s.player.x, y: s.player.y,
      kind: 'longsword', t: 0, itemId: '10006',
    });
    s.pickupTarget = 'loot-a';
    updateDrops(s, 1 / 60);
    s.drops.push({
      uid: 'loot-b', x: s.player.x, y: s.player.y,
      kind: 'longsword', t: 0, itemId: '20006',
    });
    s.pickupTarget = 'loot-b';
    updateDrops(s, 1 / 60);
    expect(s.runInventory.equipped[0]).toEqual({ uid: 'loot-a', defId: '10006' });
    expect(s.runInventory.equipped[1]).toEqual({ uid: 'loot-b', defId: '20006' });
    expect('weaponLootEvents' in s).toBe(false);
    expect('pendingPickup' in s).toBe(false);
    expect(s.weaponSlots).toEqual(['10006', '20006']);
    // The legacy projection still reports the visual CATEGORY for playthrough.
    expect(projection(s).weaponSlots).toEqual(['longsword', 'longsword']);
    expect(projection(s).weaponDefIds).toEqual(['10006', '20006']);
    expect(projection(s).runInventory.equipped[0]).toEqual({ uid: 'loot-a', defId: '10006' });
    expect(s.carriedItems).toEqual(['10006', '20006']);
  });

  it('a third sword goes into the run bag INSIDE the Worker', () => {
    const s = createState();
    collectSword(s);
    collectSword(s);
    const uid = collectThirdSword(s);
    expect(s.weaponSlots).toEqual(['longsword', 'longsword']);
    expect(s.drops).toHaveLength(0);
    expect(s.runInventory.bag.map((i) => i.uid)).toEqual([uid]);
    expect(s.runInventory.bag[0]?.container).toBe('bag');
    expect('score' in s).toBe(false);
    expect('pendingPickup' in s).toBe(false);
  });

  it('a full run bag leaves the drop on the ground', () => {
    const s = createState();
    collectSword(s);
    collectSword(s);
    // 5x8 bag, 2x3 footprint -> exactly four longswords fill it.
    for (let i = 0; i < 4; i += 1) {
      expect(addToBag(s.runInventory, `filler-${i}`, 'longsword')).not.toBeNull();
    }
    const uid = collectThirdSword(s);
    expect(s.drops.map((d) => d.uid)).toEqual([uid]);
    expect(s.runInventory.bag).toHaveLength(4);
    expect(s.carriedItems).toHaveLength(2);
    expect(s.pickupTarget).toBeNull();
  });

  it('reset replays THIS run: brought-in and picked-up items stay', () => {
    const s = createState();
    collectSword(s);
    collectSword(s);
    step(s, 1 / 60, input({ switchWeapon: 1 }));
    reset(s);
    // The chosen active slot is part of the run state too: replaying the run
    // must not silently switch the player back to weapon slot 1.
    expect(s.activeWeaponSlot).toBe(1);
    expect(s.weaponSlots).toEqual(['longsword', 'longsword']);
    expect(s.runInventory.equipped.filter(Boolean)).toHaveLength(2);
    expect(projection(s).equippedWeapon).toBe('longsword');
  });

  it('Digit1 / Digit2 switch the active slot without moving items', () => {
    const s = createState();
    collectSword(s);
    collectSword(s);
    step(s, 1 / 60, input({ switchWeapon: 1 }));
    expect(s.activeWeaponSlot).toBe(1);
    expect(s.runInventory.activeWeaponSlot).toBe(1);
    expect(s.weaponSlots).toEqual(['longsword', 'longsword']);
    step(s, 1 / 60, input({ switchWeapon: 0 }));
    expect(s.activeWeaponSlot).toBe(0);
    assert.equal(s.attacks, 0, 'switching must not attack');
  });

  it('switching to an empty slot means bare hands in melee', () => {
    const s = createState();
    collectSword(s);
    expect(activeWeapon(s)).toBe('longsword');
    step(s, 1 / 60, input({ switchWeapon: 1 }));
    expect(activeWeapon(s)).toBeNull();
    expect(projection(s).equippedWeapon).toBeNull();
    const hp = s.skeletons[0]!.hp;
    swingAtTarget(s, 0, NO_MODIFIERS);
    assert.equal(hp - s.skeletons[0]!.hp, 22, 'bare hands deal 22');
  });

  it('the demo longsword (no table row) keeps the legacy 46 baseline', () => {
    const s = createState();
    collectSword(s);
    expect(weaponDamage('longsword')).toBeNull();
    const hp = s.skeletons[0]!.hp;
    swingAtTarget(s, 0, NO_MODIFIERS);
    assert.equal(hp - s.skeletons[0]!.hp, 46, 'armed deals 46');
  });

  it('an authored weapon deals the weapon.xlsx midpoint damage', () => {
    const s = createState();
    s.drops.push({
      uid: 'authored', x: s.player.x, y: s.player.y,
      kind: 'longsword', t: 0, itemId: '10006',
    });
    s.pickupTarget = 'authored';
    updateDrops(s, 1 / 60);
    expect(weaponDamage('10006')).toBe(325);
    const hp = s.skeletons[0]!.hp;
    swingAtTarget(s, 0, NO_MODIFIERS);
    assert.equal(hp - s.skeletons[0]!.hp, 325, 'damage comes from the table');
  });
});
