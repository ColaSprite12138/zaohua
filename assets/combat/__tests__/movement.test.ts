import { describe, expect, it } from 'vitest';
import {
  createState,
  step,
  type GameState,
  type StepInput,
} from '../simulation.ts';

const input = (over: Partial<StepInput> = {}): StepInput => ({
  mouse: undefined,
  pointerDown: false,
  pointerHeld: false,
  pointerUp: false,
  dodge: false,
  restart: false,
  ...over,
});

function frames(s: GameState, n: number, over: Partial<StepInput> = {}): void {
  for (let i = 0; i < n; i += 1) step(s, 1 / 60, input(over));
}

/** One short click: down, three held frames (~67 ms), then release. */
function click(s: GameState, x: number, y: number): void {
  const mouse = { x, y };
  step(s, 1 / 60, input({ mouse, pointerDown: true, pointerHeld: true }));
  frames(s, 3, { mouse, pointerHeld: true });
  step(s, 1 / 60, input({ mouse, pointerUp: true }));
}

/** Press and keep holding long enough to be classified as a hold. */
function hold(s: GameState, x: number, y: number, seconds = 0.4): void {
  const mouse = { x, y };
  step(s, 1 / 60, input({ mouse, pointerDown: true, pointerHeld: true }));
  frames(s, Math.round(seconds * 60), { mouse, pointerHeld: true });
}

function release(s: GameState, x: number, y: number): void {
  step(s, 1 / 60, input({ mouse: { x, y }, pointerUp: true }));
}

describe('click-to-move / held-cursor movement contract', () => {
  it('hovering the pointer never moves the player', () => {
    const s = createState();
    const x = s.player.x;
    const y = s.player.y;
    frames(s, 90, { mouse: { x: 100, y: 300 } });
    expect(s.player.x).toBe(x);
    expect(s.player.y).toBe(y);
    expect(s.moveMode).toBe('idle');
  });

  it('a click on the ground moves there, stops, and never attacks', () => {
    const s = createState();
    const dest = { x: 700, y: 400 };
    click(s, dest.x, dest.y);
    expect(s.attackOrder).toBe(false);
    expect(s.targetEnemy).toBe(null);

    frames(s, 240, { mouse: dest });
    expect(Math.hypot(s.player.x - dest.x, s.player.y - dest.y)).toBeLessThan(7);
    expect(s.moveMode).toBe('idle');
    expect(s.attacks).toBe(0);

    const x = s.player.x;
    const y = s.player.y;
    frames(s, 90, { mouse: { x: 1200, y: 650 } });
    expect(s.player.x).toBe(x);
    expect(s.player.y).toBe(y);
    expect(s.moveMode).toBe('idle');
  });

  it('clicking any quadrant walks the matching direction', () => {
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const s = createState();
      const dest = { x: s.player.x + sx * 190, y: s.player.y + sy * 100 };
      click(s, dest.x, dest.y);
      frames(s, 24, { mouse: dest });
      expect((s.player.x - 400) * sx).toBeGreaterThan(0);
      expect((s.player.y - 470) * sy).toBeGreaterThan(0);
    }
  });

  it('a held left button follows the live cursor; release freezes the waypoint', () => {
    const s = createState();
    const startX = s.player.x;
    hold(s, 900, 400, 0.45);
    expect(s.moveMode).toBe('follow');
    frames(s, 20, { mouse: { x: 900, y: 400 }, pointerHeld: true });
    expect(s.player.x).toBeGreaterThan(startX);

    frames(s, 40, { mouse: { x: 200, y: 600 }, pointerHeld: true });
    expect(s.target.x).toBe(200);
    expect(s.target.y).toBe(600);
    expect(s.moveMode).toBe('follow');

    release(s, 200, 600);
    expect(s.moveMode).toBe('point');
    frames(s, 10, { mouse: { x: 1200, y: 300 } });
    expect(s.target.x).toBe(200);
    expect(s.target.y).toBe(600);
    expect(s.moveMode).toBe('point');
  });

  it('a dodge keeps its own waypoint even while the cursor is held elsewhere', () => {
    const s = createState();
    click(s, 700, 400);
    frames(s, 30, { mouse: { x: 700, y: 400 } });
    const before = s.player.x;

    step(s, 1 / 60, input({ mouse: { x: 200, y: 300 }, pointerHeld: true, dodge: true }));
    expect(s.target.x).toBeGreaterThan(before);
    frames(s, 10, { mouse: { x: 200, y: 300 }, pointerHeld: true });
    expect(s.player.x).toBeGreaterThan(before);
    expect(s.target.x).toBeGreaterThan(before);
  });
});

describe('targeted melee contract', () => {
  it('a ground click near, but not on, an enemy never attacks', () => {
    const s = createState();
    const sk = s.skeletons[0];
    expect(sk).toBeDefined();
    click(s, sk!.x, sk!.y - 120);
    frames(s, 30);
    expect(s.attacks).toBe(0);
    expect(s.attackOrder).toBe(false);
  });

  it('clicking an enemy in range swings once and damages only that enemy', () => {
    const s = createState();
    const target = s.skeletons[0]!;
    const bystanderHp = s.skeletons[1]!.hp;
    s.player.x = target.x - 80;
    s.player.y = target.y;
    const hpBefore = target.hp;

    click(s, target.x, target.y - 30);
    expect(s.attacks).toBe(1);
    expect(target.hp).toBe(hpBefore - 22);
    expect(s.skeletons[1]!.hp).toBe(bystanderHp);
    expect(s.attackOrder).toBe(false);
    expect(s.targetEnemy).toBe(null);

    // One click = one swing; no auto-repeat.
    frames(s, 60, { mouse: { x: target.x, y: target.y - 30 } });
    expect(s.attacks).toBe(1);
  });

  it('clicking a distant enemy approaches first and swings only in range', () => {
    const s = createState();
    const target = s.skeletons[0]!;
    const bystanderHp = s.skeletons[1]!.hp;
    const hpBefore = target.hp;

    click(s, target.x, target.y - 30);
    expect(s.attackOrder).toBe(true);
    expect(s.targetEnemy).toBe(0);
    expect(s.attacks).toBe(0);

    frames(s, 240, { mouse: { x: target.x, y: target.y - 30 } });
    expect(s.attacks).toBe(1);
    expect(target.hp).toBeLessThan(hpBefore);
    expect(s.skeletons[1]!.hp).toBe(bystanderHp);
    expect(s.attackOrder).toBe(false);
  });

  it('clicking a drop that sits under an enemy walks to loot, not to attack', () => {
    const s = createState();
    // Snapshot the position: the skeleton chases the player during stepping.
    const dropX = s.skeletons[0]!.x;
    const dropY = s.skeletons[0]!.y;
    s.drops.push({ x: dropX, y: dropY, kind: 'longsword', t: 0 });
    s.player.x = dropX - 80;
    s.player.y = dropY;

    click(s, dropX, dropY);
    expect(s.attackOrder).toBe(false);
    expect(s.attacks).toBe(0);
    expect(s.moveMode).toBe('point');
    expect(s.target.x).toBe(dropX);
  });

  it('a body-centre click still attacks the enemy even with a drop at its feet', () => {
    const s = createState();
    const sx = s.skeletons[0]!.x;
    const sy = s.skeletons[0]!.y;
    s.drops.push({ x: sx, y: sy, kind: 'longsword', t: 0 });
    s.player.x = sx - 80;
    s.player.y = sy;

    click(s, sx, sy - 30);
    expect(s.attacks).toBe(1);
    expect(s.skeletons[0]!.hp).toBeLessThan(66);
  });

  it('a long hold cancels a pending attack order and never attacks', () => {
    const s = createState();
    const target = s.skeletons[0]!;
    click(s, target.x, target.y - 30);
    expect(s.attackOrder).toBe(true);

    hold(s, 300, 300, 0.4);
    expect(s.moveMode).toBe('follow');
    expect(s.attackOrder).toBe(false);
    expect(s.targetEnemy).toBe(null);
    expect(s.attacks).toBe(0);
  });
});
