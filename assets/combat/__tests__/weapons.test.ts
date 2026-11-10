import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import { swingAtTarget } from '../attack.ts';
import { NO_MODIFIERS } from '../modifiers.ts';
import { activeWeapon, createState, reset, type GameState, type StepInput } from '../simulation.ts';
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

/** Walk the player onto a dropped sword so updateDrops() collects it. */
function collectSword(s: GameState): void {
  s.drops.push({ x: s.player.x, y: s.player.y, kind: 'longsword', t: 0 });
  updateDrops(s, 1 / 60);
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

  it('a third sword converts to score when both slots are full', () => {
    const s = createState();
    collectSword(s);
    collectSword(s);
    const before = s.score;
    collectSword(s);
    expect(s.weaponSlots).toEqual(['longsword', 'longsword']);
    expect(s.score).toBe(before + 80);
    expect(s.drops).toHaveLength(0);
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
