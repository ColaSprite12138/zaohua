import { describe, expect, it } from 'vitest';
import { hitTestEnemy } from '../attack.ts';
import {
  createState,
  DROP_LABEL_MAX,
  DROP_LABEL_STEP,
  dropLabelAnchor,
  dropLabelRect,
  step,
  type GameState,
  type StepInput,
} from '../simulation.ts';
import { VIEW_H, VIEW_W } from '../../shared/constants.ts';
import { cameraFor, nearestWalkable } from '../world.ts';
import { arena } from '../../resource/maps/arena.generated.ts';

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

/**
 * Press and DRAG: following is a distance decision now, so a hold that never
 * moves the pointer stays a click (and would attack on release).
 */
function hold(s: GameState, x: number, y: number, seconds = 0.4): void {
  step(s, 1 / 60, input({ mouse: { x, y }, pointerDown: true, pointerHeld: true }));
  frames(s, Math.round(seconds * 60), { mouse: { x: x + 40, y }, pointerHeld: true });
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
    s.drops.push({ uid: 'test-drop-a', x: dropX, y: dropY, kind: 'longsword', t: 0 });
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
    s.drops.push({ uid: 'test-drop-b', x: sx, y: sy, kind: 'longsword', t: 0 });
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

describe('ground loot: tiny model + clickable name plate', () => {
  /**
   * The bug this guards: loot used to claim a 26px circle around the item, so a
   * monster standing on a drop could not be attacked -- every click near its
   * feet ordered a pickup. Loot now owns only its name plate (+ the small
   * model), which is what the player deliberately aims at.
   */
  it('hovering a drop name plate reports the drop and suppresses the sword', () => {
    const s = createState();
    const sk = s.skeletons[0]!;
    // Inside the monster's hold range, so it does not walk off during the test.
    s.player.x = sk.x - 30;
    s.player.y = sk.y;
    s.drops.push({
      uid: 'plate-hover', x: sk.x, y: sk.y, kind: 'longsword', t: 0, name: '霜之哀伤',
    });
    const rect = dropLabelRect(s.drops[0]!)!;

    step(s, 1 / 60, input({ mouse: { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 } }));
    expect(s.hoverDrop).toBe('plate-hover');
    expect(s.hoverEnemy).toBe(null);

    // The same monster a few pixels above the plate is still a sword target.
    const live = s.skeletons[0]!;
    step(s, 1 / 60, input({ mouse: { x: live.x, y: live.y - 30 } }));
    expect(s.hoverDrop).toBe(null);
    expect(s.hoverEnemy).toBe(0);
  });

  it('clicking the name plate loots even with a monster standing on the drop', () => {
    const s = createState();
    const sk = s.skeletons[0]!;
    // Out of pickup range (50px): the order must survive the release frame.
    s.player.x = sk.x - 80;
    s.player.y = sk.y;
    const dropX = sk.x;
    const dropY = sk.y;
    s.drops.push({
      uid: 'plate-click', x: dropX, y: dropY, kind: 'longsword', t: 0, name: '霜之哀伤',
    });
    const rect = dropLabelRect(s.drops[0]!)!;

    click(s, rect.x + rect.w / 2, rect.y + rect.h / 2);
    expect(s.attackOrder).toBe(false);
    expect(s.attacks).toBe(0);
    expect(s.pickupTarget).toBe('plate-click');
    expect(s.moveMode).toBe('point');
    // The waypoint is the ITEM, not the plate floating 40px above it.
    expect(s.target.x).toBeCloseTo(dropX, 5);
    expect(s.target.y).toBeCloseTo(dropY, 5);
  });

  it('a click beside the tiny model is a plain move, not a pickup', () => {
    const s = createState();
    const dropX = s.player.x + 200;
    const dropY = s.player.y;
    s.drops.push({ uid: 'plate-far', x: dropX, y: dropY, kind: 'longsword', t: 0, name: '巨剑' });

    // 40px away: outside the model radius, outside the plate, no monster near.
    click(s, dropX + 40, dropY);
    expect(s.pickupTarget).toBe(null);
    expect(s.attacks).toBe(0);
    expect(s.moveMode).toBe('point');
    expect(s.target.x).toBe(dropX + 40);
  });
});

describe('overlapping loot fans out into one quality-ranked column', () => {
  /** A drop whose plate is 46px wide (two CJK glyphs). */
  const loot = (uid: string, quality: string, x: number, y: number) => ({
    uid, x, y, kind: 'longsword' as const, t: 0, name: '巨剑', quality,
  });

  it('stacks plates vertically, best quality on top, capped at DROP_LABEL_MAX', () => {
    const s = createState();
    // Six drops in one pile: 白 绿 蓝 紫 橙 + one more 白 that the cap must hide.
    const tiers = ['白', '绿', '蓝', '紫', '橙', '白'];
    tiers.forEach((quality, i) => s.drops.push(loot(`q${i}`, quality, 700, 300)));
    step(s, 1 / 60, input({ mouse: { x: 100, y: 100 } }));

    const plates = s.drops
      .map((drop) => ({ uid: drop.uid, rect: dropLabelRect(drop) }))
      .filter((entry) => entry.rect !== null)
      // Top of the column first.
      .sort((a, b) => a.rect!.y - b.rect!.y);
    // 橙 紫 蓝 绿 白 -- the sixth (a second 白, later in the pile) is capped.
    expect(plates.map((p) => p.uid)).toEqual(['q4', 'q3', 'q2', 'q1', 'q0']);
    expect(plates).toHaveLength(DROP_LABEL_MAX);

    // One vertical column, fixed spacing, no two plates share a row.
    for (let i = 1; i < plates.length; i += 1) {
      expect(plates[i]!.rect!.y - plates[i - 1]!.rect!.y).toBe(DROP_LABEL_STEP);
    }
    // The bottom plate sits exactly where a lone drop's plate would be.
    const anchor = dropLabelAnchor(s.drops[0]!);
    expect(plates.at(-1)!.rect!.y).toBe(anchor.y);
    expect(plates[0]!.rect!.y).toBeLessThan(anchor.y);
    expect(plates[0]!.rect!.hidden).toBe(1);
    // The capped drop has no plate at all.
    expect(dropLabelRect(s.drops[5]!)).toBe(null);
  });

  it('a click on a lower plate picks that item, not the top one', () => {
    const s = createState();
    s.drops.push(loot('low', '白', 700, 300));
    s.drops.push(loot('high', '橙', 700, 300));
    step(s, 1 / 60, input({ mouse: { x: 100, y: 100 } }));

    const low = dropLabelRect(s.drops[0]!)!;
    expect(low.index).toBe(1);
    click(s, low.x + low.w / 2, low.y + low.h / 2);
    expect(s.pickupTarget).toBe('low');
    expect(s.attackOrder).toBe(false);
    expect(s.attacks).toBe(0);
  });

  it('a capped drop is still reachable through its own tiny model', () => {
    const s = createState();
    const tiers = ['白', '绿', '蓝', '紫', '橙', '白'];
    // The capped one stands 40px aside: inside the pile, outside every plate.
    tiers.forEach((quality, i) => s.drops.push(
      loot(`q${i}`, quality, i === 5 ? 740 : 700, 300),
    ));
    step(s, 1 / 60, input({ mouse: { x: 100, y: 100 } }));
    expect(dropLabelRect(s.drops[5]!)).toBe(null);

    click(s, 740, 300);
    expect(s.pickupTarget).toBe('q5');
    expect(s.attacks).toBe(0);
  });
});

describe('hover feedback (sword cursor + ring)', () => {
  it('the skeleton under the free cursor is reported, nothing else is', () => {
    const s = createState();
    const sk = s.skeletons[0]!;
    step(s, 1 / 60, input({ mouse: { x: sk.x, y: sk.y - 30 } }));
    expect(s.hoverEnemy).toBe(0);

    const before = s.hoverEnemy;
    step(s, 1 / 60, input({ mouse: { x: 120, y: 120 } }));
    expect(before).toBe(0);
    expect(s.hoverEnemy).toBe(null);
  });

  it('hover is suppressed while the pointer is on the HUD minimap', () => {
    const s = createState();
    const sk = s.skeletons[0]!;
    step(s, 1 / 60, input({ mouse: { x: sk.x, y: sk.y - 30 }, pointerOnHud: true }));
    expect(s.hoverEnemy).toBe(null);
  });

  it('hover never moves the player or orders an attack', () => {
    const s = createState();
    const sk = s.skeletons[0]!;
    const x = s.player.x;
    const y = s.player.y;
    for (let i = 0; i < 40; i += 1) {
      step(s, 1 / 60, input({ mouse: { x: sk.x, y: sk.y - 30 } }));
    }
    expect(s.player.x).toBe(x);
    expect(s.player.y).toBe(y);
    expect(s.attackOrder).toBe(false);
    expect(s.attacks).toBe(0);
  });

  it('a click that just misses the body box still targets that skeleton', () => {
    const s = createState();
    const sk = s.skeletons[0]!;
    // Body centre is clickable, and a 33px sideways miss is inside the assist
    // radius around the torso (a chasing skeleton is hard to pin exactly).
    expect(hitTestEnemy(s, sk.x, sk.y - 30)).toBe(0);
    expect(hitTestEnemy(s, sk.x + 33, sk.y - 30)).toBe(0);
    // Far away, or high above the skull, there is nothing to target.
    expect(hitTestEnemy(s, sk.x + 80, sk.y - 30)).toBe(null);
    expect(hitTestEnemy(s, sk.x, sk.y - 120)).toBe(null);
  });
});

describe('body vs body collision', () => {
  it('the player cannot walk through a monster', () => {
    const s = createState();
    const sk = s.skeletons[0]!;
    s.player.x = sk.x - 160;
    s.player.y = sk.y;

    // Click 60px PAST the monster: the order is a ground move, not an attack.
    const dest = { x: sk.x + 60, y: sk.y };
    click(s, dest.x, dest.y);
    expect(s.attackOrder).toBe(false);

    frames(s, 200, { mouse: dest });
    const gap = Math.hypot(s.player.x - sk.x, s.player.y - sk.y);
    expect(gap).toBeGreaterThan(21);
    expect(s.player.x).toBeLessThan(sk.x + 60);
  });

  it('two monsters never share one footprint', () => {
    const s = createState();
    const [a, b] = s.skeletons;
    // Stack them on purpose: the frame must untangle them.
    b!.x = a!.x + 3;
    b!.y = a!.y;
    frames(s, 30);
    const gap = Math.hypot(a!.x - b!.x, a!.y - b!.y);
    expect(gap).toBeGreaterThan(19);
  });

  it('separation never pushes a body into a wall', () => {
    const s = createState();
    const sk = s.skeletons[0]!;
    // Wall the pair into the top-right corner, where x is clamped by the map.
    const cols = s.world.cols;
    const rows = s.world.rows;
    const grid = s.world.grid;
    sk.x = cols * grid - 12;
    sk.y = 12;
    s.player.x = sk.x - 4;
    s.player.y = sk.y;
    frames(s, 4);
    expect(s.player.x).toBeGreaterThanOrEqual(0);
    expect(s.player.y).toBeGreaterThanOrEqual(0);
    expect(s.player.x).toBeLessThanOrEqual(cols * grid);
    expect(s.player.y).toBeLessThanOrEqual(rows * grid);
  });
});

describe('click duration must not change the action', () => {
  it('a slow but stationary press still attacks the enemy under the cursor', () => {
    const s = createState();
    const sk = s.skeletons[0]!;
    // Stand close enough that the skeleton holds still (it only chases beyond 40px).
    s.player.x = sk.x - 30;
    s.player.y = sk.y;
    const m = { x: sk.x, y: sk.y - 30 };

    step(s, 1 / 60, input({ mouse: m, pointerDown: true, pointerHeld: true }));
    // A deliberate click can easily take 600 ms; the pointer never moves.
    frames(s, 36, { mouse: m, pointerHeld: true });
    expect(s.attacks).toBe(0); // nothing happens while the button is merely down
    expect(s.moveMode).toBe('idle'); // a stationary press is not a follow

    step(s, 1 / 60, input({ mouse: m, pointerUp: true }));
    expect(s.attacks).toBe(1); // the release still attacks
  });

  it('a slow but stationary press on the ground is a plain move order', () => {
    const s = createState();
    const dest = { x: 700, y: 400 };
    step(s, 1 / 60, input({ mouse: dest, pointerDown: true, pointerHeld: true }));
    frames(s, 36, { mouse: dest, pointerHeld: true });
    expect(s.moveMode).toBe('idle');
    step(s, 1 / 60, input({ mouse: dest, pointerUp: true }));
    expect(s.moveMode).toBe('point');
    expect(s.target.x).toBe(dest.x);
    expect(s.attacks).toBe(0);
  });

  it('dragging while the button is down follows the cursor and never attacks', () => {
    const s = createState();
    const sk = s.skeletons[0]!;
    s.player.x = sk.x - 30;
    s.player.y = sk.y;
    const start = { x: sk.x, y: sk.y - 30 };
    step(s, 1 / 60, input({ mouse: start, pointerDown: true, pointerHeld: true }));
    frames(s, 12, { mouse: { x: start.x + 40, y: start.y }, pointerHeld: true });
    expect(s.moveMode).toBe('follow');
    step(s, 1 / 60, input({ mouse: { x: start.x + 40, y: start.y }, pointerUp: true }));
    expect(s.attacks).toBe(0);
    expect(s.attackOrder).toBe(false);
  });
});

describe('a moving camera must not change what a click means', () => {
  /**
   * The bug this guards: `press` used to be stored in WORLD space, so while the
   * player walked (camera scrolling) a perfectly still cursor kept changing its
   * world position. After ~12 px of camera travel the "did the pointer move?"
   * test fired, the click became a follow, and clicking an enemy issued a move.
   */
  it('a still cursor stays a click while the camera scrolls beneath it', () => {
    const s = createState({ map: arena });
    // Map centre: the camera only leaves (0,0) once the player is far enough
    // from the world edge, and that is exactly the case being guarded here.
    const spot = nearestWalkable(s.world, s.map.pxWid / 2, s.map.pxHei / 2);
    s.player.x = spot.x;
    s.player.y = spot.y;
    s.camera = cameraFor(s.world, s.player.x, s.player.y);
    expect(s.camera.x).toBeGreaterThan(0);

    // Exactly what the engine feeds the simulation: the world point under the
    // cursor, recomputed every frame from the CURRENT camera.
    const view = { x: VIEW_W * 0.72, y: VIEW_H * 0.4 };
    const at = () => ({ x: s.camera.x + view.x, y: s.camera.y + view.y });

    step(s, 1 / 60, input({ mouse: at(), pointerDown: true, pointerHeld: true }));
    const camStart = s.camera.x;

    // Walk right: the camera follows, so the world point under the cursor moves
    // by tens of pixels even though the pointer never moved on screen.
    for (let i = 0; i < 12; i += 1) {
      s.player.x += 4;
      step(s, 1 / 60, input({ mouse: at(), pointerHeld: true }));
    }
    expect(Math.abs(s.camera.x - camStart)).toBeGreaterThan(12);
    expect(s.press?.hold).toBe(false);
    expect(s.moveMode).toBe('idle');

    step(s, 1 / 60, input({ mouse: at(), pointerUp: true }));
    expect(s.attackOrder).toBe(false);
    expect(s.moveMode).toBe('point');
    // The waypoint is the ground the player aimed at WHEN PRESSING. It must NOT
    // be the world point that has since scrolled under the cursor: that one has
    // drifted by the whole camera delta and would send the character off course.
    expect(Math.abs(s.target.x - (s.camera.x + view.x))).toBeGreaterThan(20);
  });

  it('a real drag still becomes a follow while the camera scrolls', () => {
    const s = createState({ map: arena });
    const spot = nearestWalkable(s.world, s.map.pxWid / 2, s.map.pxHei / 2);
    s.player.x = spot.x;
    s.player.y = spot.y;
    s.camera = cameraFor(s.world, s.player.x, s.player.y);

    const view = { x: VIEW_W * 0.5, y: VIEW_H * 0.5 };
    const at = (dx = 0) => ({ x: s.camera.x + view.x + dx, y: s.camera.y + view.y });
    step(s, 1 / 60, input({ mouse: at(), pointerDown: true, pointerHeld: true }));
    s.player.x += 4;
    step(s, 1 / 60, input({ mouse: at(40), pointerHeld: true }));
    expect(s.moveMode).toBe('follow');
  });
});

