import { describe, expect, it } from 'vitest';
import {
  createState, NO_MODIFIERS, step, type CombatModifiers, type StepInput,
} from '../simulation.ts';

const idle: StepInput = {
  mouse: undefined,
  pointerDown: false,
  pointerHeld: false,
  pointerUp: false,
  dodge: false,
  restart: false,
};

function queuedSwing(distance: number) {
  const s = createState();
  const sk = s.skeletons[0]!;
  sk.x = s.player.x + distance;
  sk.y = s.player.y;
  s.targetEnemy = 0;
  s.attackOrder = true;
  return { s, sk };
}

describe('talent-effect hook lives in combat', () => {
  it('NO_MODIFIERS reproduces the legacy bare-hand damage exactly', () => {
    const { s, sk } = queuedSwing(50);
    step(s, 0.016, idle, NO_MODIFIERS);
    expect(s.attacks).toBe(1);
    expect(sk.hp).toBe(66 - 22);
    expect(s.attackOrder).toBe(false);
  });

  it('a supplied modifier scales damage without touching combat code', () => {
    const double: CombatModifiers = {
      effectIds: ['test.damage-x2'],
      damageMultiplier: (base) => base * 2,
      meleeRangeBonus: () => 0,
    };
    const { s, sk } = queuedSwing(50);
    step(s, 0.016, idle, double);
    expect(sk.hp).toBe(66 - 44);
  });

  it('a range modifier lets a distant target be hit; default still approaches', () => {
    const reach: CombatModifiers = {
      effectIds: ['test.reach+100'],
      damageMultiplier: (base) => base,
      meleeRangeBonus: () => 100,
    };
    const extended = queuedSwing(200);
    step(extended.s, 0.016, idle, reach);
    expect(extended.s.attacks).toBe(1);

    const baseline = queuedSwing(200);
    step(baseline.s, 0.016, idle, NO_MODIFIERS);
    expect(baseline.s.attacks).toBe(0);
    expect(baseline.s.attackOrder).toBe(true);
  });
});
