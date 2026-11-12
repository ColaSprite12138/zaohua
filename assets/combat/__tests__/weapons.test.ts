import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import { swingAtTarget } from '../attack.ts';
import { NO_MODIFIERS } from '../modifiers.ts';
import { activeWeapon, createState, reset, type GameState, type StepInput } from '../simulation.ts';
import { projection, step } from '../simulation.ts';
import { resolvePickupAck, updateDrops } from '../weapons.ts';

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

/** Both slots full -> the drop must wait for the main window's bag decision. */
function queueThirdSword(s: GameState): string {
  const uid = 'test-drop-3';
  s.drops.push({ uid, x: s.player.x, y: s.player.y, kind: 'longsword', t: 0 });
  s.pickupTarget = uid;
  updateDrops(s, 1 / 60);
  return uid;
}

describe('two weapon slots', () => {
  it('starts with two empty slots on slot 1, bare-handed', () => {
    const s = createState();
    expect(s.weaponSlots).toEqual([null, null]);
    expect(s.activeWeaponSlot).toBe(0);
    expect(activeWeapon(s)).toBeNull();
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
  });

  it('a third sword waits for a bag decision; there is no score at all', () => {
    const s = createState();
    collectSword(s);
    collectSword(s);
    const uid = queueThirdSword(s);
    expect(s.weaponSlots).toEqual(['longsword', 'longsword']);
    expect(s.pendingPickup?.uid).toBe(uid);
    expect(s.drops).toHaveLength(1);
    expect('score' in s).toBe(false);
  });

  it('a rejected bag pickup leaves the drop on the ground', () => {
    const s = createState();
    collectSword(s);
    collectSword(s);
    const uid = queueThirdSword(s);
    resolvePickupAck(s, false, uid);
    expect(s.drops).toHaveLength(1);
    expect(s.runBagUids).toEqual([]);
    expect(s.pendingPickup).toBeNull();
    expect(s.carriedItems).toHaveLength(2);
  });

  it('an accepted bag pickup removes the drop and records its uid', () => {
    const s = createState();
    collectSword(s);
    collectSword(s);
    const uid = queueThirdSword(s);
    resolvePickupAck(s, true, uid);
    expect(s.drops).toHaveLength(0);
    expect(s.runBagUids).toEqual([uid]);
    expect(s.carriedItems).toHaveLength(3);
    expect(s.pendingPickup).toBeNull();
  });

  it('Digit1 / Digit2 switch the active slot without moving items', () => {
    const s = createState();
    collectSword(s);
    collectSword(s);
    step(s, 1 / 60, input({ switchWeapon: 1 }));
    expect(s.activeWeaponSlot).toBe(1);
    expect(s.weaponSlots).toEqual(['longsword', 'longsword']);
    step(s, 1 / 60, input({ switchWeapon: 0 }));
    expect(s.activeWeaponSlot).toBe(0);
    assert.equal(s.attacks, 0, 'switching must not attack');
  });

  it('switching to an empty slot means bare hands in melee', () => {
    const s = createState();
    collectSword(s); // only slot 1 has a sword
    expect(activeWeapon(s)).toBe('longsword');
    step(s, 1 / 60, input({ switchWeapon: 1 }));
    expect(activeWeapon(s)).toBeNull();
    expect(projection(s).equippedWeapon).toBeNull();
    const hp = s.skeletons[0]!.hp;
    swingAtTarget(s, 0, NO_MODIFIERS);
    assert.equal(hp - s.skeletons[0]!.hp, 22, 'bare hands deal 22');
  });

  it('only the active slot decides melee damage and range', () => {
    const s = createState();
    collectSword(s);
    const hp = s.skeletons[0]!.hp;
    swingAtTarget(s, 0, NO_MODIFIERS);
    assert.equal(hp - s.skeletons[0]!.hp, 46, 'armed deals 46');
  });

  it('reset clears both slots and returns to slot 1', () => {
    const s = createState();
    collectSword(s);
    collectSword(s);
    step(s, 1 / 60, input({ switchWeapon: 1 }));
    reset(s);
    expect(s.weaponSlots).toEqual([null, null]);
    expect(s.activeWeaponSlot).toBe(0);
    expect(projection(s).equippedWeapon).toBeNull();
  });
});
