import { describe, expect, it } from 'vitest';
import { phaseAt, runFinished, updateRunClock } from '../extraction.ts';
import {
  PORTAL_COUNT, PORTAL_RADIUS, PORTAL_USES, RUN_SECONDS, createState, deployRun,
  type GameState, type StepInput,
} from '../simulation.ts';
import { step } from '../simulation.ts';
import { walkable } from '../world.ts';
import { checkCleared } from '../weapons.ts';

const input = (over: Partial<StepInput> = {}): StepInput => ({
  mouse: undefined,
  pointerDown: false,
  pointerHeld: false,
  pointerUp: false,
  dodge: false,
  restart: false,
  ...over,
});

/**
 * Advance `seconds` in small frames. `extractChannel` is a justPressed edge, so
 * it is only delivered on the FIRST frame unless the caller keeps asking.
 */
function tick(
  s: GameState,
  seconds: number,
  over: Partial<StepInput> = {},
  dt = 0.1,
): void {
  let left = seconds;
  let first = true;
  while (left > 1e-9) {
    const d = Math.min(dt, left);
    step(s, d, input(first ? over : { ...over, extractChannel: false }));
    first = false;
    left -= d;
  }
}

/** A quiet run: no monsters, so nothing interrupts the channel by accident. */
function quietRun(): GameState {
  const s = createState();
  s.skeletons = [];
  return s;
}

function standAtPortal(s: GameState, index = 0): void {
  const portal = s.portals[index]!;
  s.player.x = portal.x;
  s.player.y = portal.y;
}

describe('run clock and phases (search-and-extract skeleton)', () => {
  it('starts each run at 15:00 in the explore phase', () => {
    const s = createState();
    expect(s.runSeconds).toBe(RUN_SECONDS);
    expect(s.phase).toBe('explore');
    expect(s.runKind).toBe('story');
    expect(runFinished(s)).toBe(false);
  });

  it('moves explore -> fight -> extract at 4:00 and 11:00 elapsed', () => {
    const s = quietRun();
    tick(s, 235);
    expect(s.phase).toBe('explore');
    tick(s, 10);
    expect(s.phase).toBe('fight');
    tick(s, 410);
    expect(s.phase).toBe('fight');
    tick(s, 60);
    expect(s.phase).toBe('extract');
    expect(s.runSeconds).toBeGreaterThan(0);
  });

  it('phase boundaries are a pure function of the remaining seconds', () => {
    expect(phaseAt(RUN_SECONDS)).toBe('explore');
    expect(phaseAt(RUN_SECONDS - 240)).toBe('fight');
    expect(phaseAt(RUN_SECONDS - 660)).toBe('extract');
    expect(phaseAt(0)).toBe('extract');
  });

  it('running out of time fails the run and freezes it', () => {
    const s = quietRun();
    s.runSeconds = 0.05;
    step(s, 0.1, input());
    expect(s.timedOut).toBe(true);
    expect(s.phase).toBe('ended');
    expect(s.extracted).toBe(false);
    expect(runFinished(s)).toBe(true);
    // A finished run stops clocking and cannot be revived by stepping.
    const frozen = s.runSeconds;
    step(s, 5, input());
    expect(s.runSeconds).toBe(frozen);
  });

  it('the clock stops once the run is over', () => {
    const s = quietRun();
    s.extracted = true;
    const before = s.runSeconds;
    updateRunClock(s, 30);
    expect(s.runSeconds).toBe(before);
  });
});

describe('portals (the only way out)', () => {
  it('puts five reachable portals on walkable ground', () => {
    const s = createState();
    expect(s.portals.length).toBe(PORTAL_COUNT);
    for (const portal of s.portals) {
      expect(portal.state).toBe('armed');
      expect(portal.uses).toBe(PORTAL_USES);
      expect(walkable(s.world, portal.x, portal.y)).toBe(true);
    }
  });

  it('channelling for the full guide time extracts and banks the run', () => {
    const s = quietRun();
    standAtPortal(s);
    const portal = s.portals[0]!;
    step(s, 0.1, input({ extractChannel: true }));
    expect(s.channel).toBe(portal.id);
    tick(s, 7.2);
    expect(s.extracted).toBe(false);
    expect(portal.progress).toBeGreaterThan(0.85);
    tick(s, 1);
    expect(s.extracted).toBe(true);
    expect(s.phase).toBe('ended');
    expect(s.channel).toBeNull();
    expect(portal.opened).toBe(1);
    expect(portal.uses).toBe(PORTAL_USES - 1);
  });

  it('pressing E far from any portal does nothing', () => {
    const s = quietRun();
    s.player.x = s.map.spawn.x;
    s.player.y = s.map.spawn.y;
    // Move every portal far away so the spawn point is out of every ring.
    for (const portal of s.portals) {
      portal.x = s.map.pxWid - 20;
      portal.y = s.map.pxHei - 20;
    }
    step(s, 0.1, input({ extractChannel: true }));
    expect(s.channel).toBeNull();
    expect(s.extracted).toBe(false);
  });

  it('taking a hit clears the progress without a stagger', () => {
    const s = quietRun();
    standAtPortal(s);
    const portal = s.portals[0]!;
    tick(s, 4, { extractChannel: true });
    expect(portal.progress).toBeGreaterThan(0.3);
    // Simulate a monster swing landing: `hurt` is what the enemy layer sets.
    s.player.hurt = 0.35;
    step(s, 0.1, input());
    expect(s.channel).toBeNull();
    expect(portal.progress).toBe(0);
    expect(s.extracted).toBe(false);
    // No stagger: the player may start again on the next frame.
    step(s, 0.1, input({ extractChannel: true }));
    expect(s.channel).toBe(portal.id);
  });

  it('walking out of the ring clears the progress', () => {
    const s = quietRun();
    standAtPortal(s);
    const portal = s.portals[0]!;
    tick(s, 3, { extractChannel: true });
    expect(portal.progress).toBeGreaterThan(0);
    s.player.x = portal.x + PORTAL_RADIUS + 30;
    step(s, 0.1, input());
    expect(s.channel).toBeNull();
    expect(portal.progress).toBe(0);
    expect(s.extracted).toBe(false);
  });

  it('pressing E a second time cancels instead of trapping the player', () => {
    const s = quietRun();
    standAtPortal(s);
    const portal = s.portals[0]!;
    step(s, 0.1, input({ extractChannel: true }));
    expect(s.channel).toBe(portal.id);
    step(s, 0.1, input({ extractChannel: true }));
    expect(s.channel).toBeNull();
    expect(portal.progress).toBe(0);
  });

  it('channelling pins the player: a click cannot walk them away mid-guide', () => {
    const s = quietRun();
    standAtPortal(s);
    const portal = s.portals[0]!;
    step(s, 0.1, input({ extractChannel: true }));
    const startX = s.player.x;
    tick(s, 2, { pointerDown: true, pointerUp: true, mouse: { x: portal.x + 300, y: portal.y } });
    expect(Math.abs(s.player.x - startX)).toBeLessThan(30);
    expect(s.channel).toBe(portal.id);
  });

  it('a spent portal is no longer an exit', () => {
    const s = quietRun();
    standAtPortal(s);
    const portal = s.portals[0]!;
    portal.state = 'spent';
    portal.uses = 0;
    step(s, 0.1, input({ extractChannel: true }));
    expect(s.channel).toBeNull();
    expect(s.extracted).toBe(false);
  });});

describe('run kind decides what "finished" means', () => {
  it('story clears when every monster is down', () => {
    const s = quietRun();
    s.weaponSlots = ['longsword', null];
    checkCleared(s);
    expect(s.cleared).toBe(true);
  });

  it('dungeon and pvpve never auto-clear: you must extract', () => {
    for (const kind of ['dungeon', 'pvpve'] as const) {
      const s = quietRun();
      s.runKind = kind;
      s.weaponSlots = ['longsword', null];
      checkCleared(s);
      expect(s.cleared).toBe(false);
    }
  });

  it('deployRun carries the kind into the run and starts a full clock', () => {
    const s = createState();
    deployRun(s, { kind: 'pvpve' });
    expect(s.runKind).toBe('pvpve');
    expect(s.runSeconds).toBe(RUN_SECONDS);
    expect(s.portals.length).toBe(PORTAL_COUNT);
    expect(runFinished(s)).toBe(false);
  });
});
