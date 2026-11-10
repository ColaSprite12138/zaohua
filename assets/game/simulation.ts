/** Pure game simulation. No engine imports so it stays unit-testable. */

export const VIEW_W = 1280;
export const VIEW_H = 720;
export const GROUND_TOP = 208;

export interface Vec {
  x: number;
  y: number;
}

export interface StepInput {
  /** Pointer in logical canvas pixels (top-left origin). */
  readonly mouse?: Vec | undefined;
  /** Left-button press edge (justPressed). */
  readonly pointerDown: boolean;
  /** Left button held (button). */
  readonly pointerHeld: boolean;
  /** Left-button release edge (justReleased): settles a click command. */
  readonly pointerUp: boolean;
  readonly dodge: boolean;
  readonly restart: boolean;
}

/** A press held longer than this (or dragged) is a hold, not a click. */
export const CLICK_HOLD_SECONDS = 0.35;
export const CLICK_DRAG_PIXELS = 12;
export const MELEE_RANGE_BARE = 140;
export const MELEE_RANGE_ARMED = 170;

/**
 * idle  — standing still, hovering the mouse changes nothing.
 * point — walking to a waypoint set by a click; stops on arrival.
 * follow— button held, the waypoint tracks the live cursor every frame.
 */
export type MoveMode = 'idle' | 'point' | 'follow';

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
}

export interface Skeleton {
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  attackCd: number;
  hit: number;
  bob: number;
}

export interface Drop {
  x: number;
  y: number;
  kind: 'longsword';
  t: number;
}

export interface Player {
  x: number;
  y: number;
  vx: number;
  vy: number;
  face: number;
  invuln: number;
  dodge: number;
  dodgeCd: number;
  attackCd: number;
  attackFx: number;
  hurt: number;
  attackAim: number;
  trail: { x: number; y: number; life: number }[];
}

export interface GameState {
  t: number;
  attacks: number;
  hp: number;
  maxHp: number;
  score: number;
  kills: number;
  player: Player;
  target: Vec;
  moveMode: MoveMode;
  /** Index into `skeletons` locked by a click on an enemy. */
  targetEnemy: number | null;
  /** One pending melee swing on `targetEnemy`, fired once in range. */
  attackOrder: boolean;
  /** Active pointer press being classified as a click or a hold. */
  press: { x: number; y: number; elapsed: number; hold: boolean } | null;
  skeletons: Skeleton[];
  drops: Drop[];
  equipped: 'longsword' | null;
  gameOver: boolean;
  cleared: boolean;
  particles: Particle[];
  toast: { text: string; life: number } | null;
}

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export function createState(): GameState {
  const state: GameState = {
    t: 0,
    attacks: 0,
    hp: 100,
    maxHp: 100,
    score: 0,
    kills: 0,
    player: {
      x: 400,
      y: 470,
      vx: 0,
      vy: 0,
      face: 0,
      invuln: 0,
      dodge: 0,
      dodgeCd: 0,
      attackCd: 0,
      attackFx: 0,
      hurt: 0,
      attackAim: 0,
      trail: [],
    },
    target: { x: 400, y: 470 },
    moveMode: 'idle',
    targetEnemy: null,
    attackOrder: false,
    press: null,
    skeletons: [],
    drops: [],
    equipped: null,
    gameOver: false,
    cleared: false,
    particles: [],
    toast: null,
  };
  reset(state);
  return state;
}

export function reset(s: GameState): void {
  s.t = 0;
  s.attacks = 0;
  s.hp = s.maxHp;
  s.score = 0;
  s.kills = 0;
  s.equipped = null;
  s.gameOver = false;
  s.cleared = false;
  s.drops.length = 0;
  s.particles.length = 0;
  s.toast = { text: '单击地面移动 · 单击敌人攻击 · 长按跟随光标 · 空格闪避', life: 4.2 };
  s.moveMode = 'idle';
  s.targetEnemy = null;
  s.attackOrder = false;
  s.press = null;
  const p = s.player;
  p.x = 400;
  p.y = 470;
  p.vx = 0;
  p.vy = 0;
  p.face = 0;
  p.invuln = 0;
  p.dodge = 0;
  p.dodgeCd = 0;
  p.attackCd = 0;
  p.attackFx = 0;
  p.hurt = 0;
  p.attackAim = 0;
  p.trail.length = 0;
  s.target = { x: 400, y: 470 };
  s.skeletons = [
    { x: 880, y: 430, hp: 66, maxHp: 66, alive: true, attackCd: 0.8, hit: 0, bob: 0 },
    { x: 1010, y: 560, hp: 66, maxHp: 66, alive: true, attackCd: 1.6, hit: 0, bob: 1.4 },
  ];
}

function burst(s: GameState, x: number, y: number, color: string, count: number, power: number): void {
  for (let i = 0; i < count; i += 1) {
    const a = (Math.PI * 2 * i) / count + Math.random() * 0.5;
    const speed = power * (0.55 + Math.random() * 0.7);
    s.particles.push({
      x,
      y,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed - 30,
      life: 0.45 + Math.random() * 0.35,
      max: 0.8,
      size: 2 + Math.random() * 3,
      color,
    });
  }
}

function say(s: GameState, text: string): void {
  s.toast = { text, life: 2.4 };
}

function setTarget(s: GameState, x: number, y: number): void {
  s.target.x = clamp(x, 46, VIEW_W - 46);
  s.target.y = clamp(y, GROUND_TOP + 26, VIEW_H - 46);
}

/** Clickable body box of a living skeleton (art spans about [-21,21] x [-57,0]). */
function hitTestEnemy(s: GameState, x: number, y: number): number | null {
  let hit: number | null = null;
  let best = Infinity;
  for (let i = 0; i < s.skeletons.length; i += 1) {
    const sk = s.skeletons[i];
    if (sk === undefined || !sk.alive) continue;
    if (Math.abs(x - sk.x) > 30 || y < sk.y - 70 || y > sk.y + 12) continue;
    const d = Math.hypot(x - sk.x, y - (sk.y - 30));
    if (d < best) {
      best = d;
      hit = i;
    }
  }
  return hit;
}

/** Drops win the click over enemies so a sword under a skeleton stays lootable. */
function hitTestDrop(s: GameState, x: number, y: number): boolean {
  return s.drops.some((drop) => Math.hypot(x - drop.x, y - drop.y) <= 26);
}

function clearAttackOrder(s: GameState): void {
  s.attackOrder = false;
  s.targetEnemy = null;
}

/** Melee resolves against exactly one locked enemy; no cone, no splash. */
function swingAtTarget(s: GameState, index: number): void {
  const sk = s.skeletons[index];
  if (sk === undefined || !sk.alive) return;
  const p = s.player;
  const ddx = sk.x - p.x;
  const ddy = sk.y - p.y;
  const d = Math.hypot(ddx, ddy) || 1;
  const armed = s.equipped === 'longsword';
  const aim = Math.atan2(ddy, ddx);

  p.attackCd = 0.4;
  p.attackFx = 0.26;
  p.face = aim;
  p.attackAim = aim;
  s.attacks += 1;
  s.score += 5;

  sk.hp -= armed ? 46 : 22;
  sk.hit = 0.24;
  sk.x += (ddx / d) * 16;
  sk.y += (ddy / d) * 12;
  burst(s, sk.x, sk.y - 26, armed ? '#ffd166' : '#ffb454', 9, 165);
  burst(s, p.x + Math.cos(aim) * 52, p.y + Math.sin(aim) * 52 - 22, '#cfe8ff', 5, 90);

  if (sk.hp <= 0) {
    sk.alive = false;
    s.kills += 1;
    s.score += 100;
    s.drops.push({ x: sk.x, y: sk.y, kind: 'longsword', t: 0 });
    burst(s, sk.x, sk.y - 24, '#e8e4d8', 22, 210);
    say(s, '骷髅被击杀 · 掉落「长剑」');
  }
}

/** Advance one frame. `dt` is seconds, already clamped by the caller. */
export function step(s: GameState, dt: number, input: StepInput): void {
  if (input.restart) {
    reset(s);
    return;
  }
  if (s.gameOver) return;

  s.t += dt;
  const p = s.player;
  p.invuln = Math.max(0, p.invuln - dt);
  p.dodge = Math.max(0, p.dodge - dt);
  p.dodgeCd = Math.max(0, p.dodgeCd - dt);
  p.attackCd = Math.max(0, p.attackCd - dt);
  p.attackFx = Math.max(0, p.attackFx - dt);
  p.hurt = Math.max(0, p.hurt - dt);

  if (s.toast) {
    s.toast.life -= dt;
    if (s.toast.life <= 0) s.toast = null;
  }

  // Classify each pointer press. A short, stationary press is a click; a press
  // held past CLICK_HOLD_SECONDS (or dragged) is a hold-to-follow. Only a click
  // issues an order (move to ground / attack one enemy); holding never attacks
  // and is the only source of continuous cursor following. A dodge owns the
  // waypoint for its whole duration, so input cannot cancel the burst.
  if (p.dodge <= 0) {
    if (input.pointerDown && input.mouse) {
      s.press = { x: input.mouse.x, y: input.mouse.y, elapsed: 0, hold: false };
    }
    if (s.press) {
      s.press.elapsed += dt;
      if (input.mouse) {
        const drag = Math.hypot(input.mouse.x - s.press.x, input.mouse.y - s.press.y);
        if (s.press.elapsed >= CLICK_HOLD_SECONDS || drag > CLICK_DRAG_PIXELS) s.press.hold = true;
      }
      if (input.pointerHeld && s.press.hold) {
        clearAttackOrder(s);
        if (input.mouse) setTarget(s, input.mouse.x, input.mouse.y);
        s.moveMode = 'follow';
      } else if (s.moveMode === 'follow') {
        // Follow ends on release: keep the last cursor position as a waypoint
        // so the walk finishes instead of stopping mid-stride.
        s.moveMode = 'point';
      }
      if (input.pointerUp) {
        if (!s.press.hold) {
          const onDrop = hitTestDrop(s, s.press.x, s.press.y);
          const enemy = onDrop ? null : hitTestEnemy(s, s.press.x, s.press.y);
          clearAttackOrder(s);
          if (enemy !== null) {
            s.targetEnemy = enemy;
            s.attackOrder = true;
            const sk = s.skeletons[enemy];
            if (sk) setTarget(s, sk.x, sk.y);
          } else {
            setTarget(s, s.press.x, s.press.y);
          }
          s.moveMode = 'point';
        }
        s.press = null;
      }
    } else if (s.moveMode === 'follow') {
      s.moveMode = 'point';
    }
  }

  // Dodge: short invulnerable burst along the current facing.
  if (input.dodge && p.dodgeCd <= 0) {
    p.dodge = 0.24;
    p.invuln = 0.36;
    p.dodgeCd = 1.25;
    const dir = Math.hypot(p.vx, p.vy) > 4 ? Math.atan2(p.vy, p.vx) : p.face;
    setTarget(s, p.x + Math.cos(dir) * 185, p.y + Math.sin(dir) * 130);
    s.moveMode = 'point';
    p.trail.push({ x: p.x, y: p.y, life: 0.42 });
    burst(s, p.x, p.y, '#67e8f9', 12, 130);
  }

  // Walk only when an order exists; reaching the waypoint clears it.
  const dx = s.target.x - p.x;
  const dy = s.target.y - p.y;
  const dist = Math.hypot(dx, dy);
  const speed = p.dodge > 0 ? 560 : 205;
  if (s.moveMode !== 'idle' && dist > 6) {
    const nx = dx / dist;
    const ny = dy / dist;
    p.vx = nx * speed;
    p.vy = ny * speed;
    p.face = Math.atan2(ny, nx);
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  } else {
    p.vx *= 0.72;
    p.vy *= 0.72;
    if (s.moveMode === 'point') s.moveMode = 'idle';
  }
  for (const mark of p.trail) mark.life -= dt;
  p.trail = p.trail.filter((mark) => mark.life > 0);
  if (p.dodge > 0 && Math.random() < 0.5) p.trail.push({ x: p.x, y: p.y, life: 0.32 });

  // Attack order: only a click on an enemy can queue a swing, and it fires
  // exactly once when the player reaches melee range. Damage is dealt to that
  // one locked enemy only -- no cone, no soft lock, no splash. A dodge takes
  // priority over the order for its whole duration.
  if (p.dodge <= 0 && s.attackOrder && s.targetEnemy !== null) {
    const index = s.targetEnemy;
    const sk = s.skeletons[index];
    if (sk === undefined || !sk.alive) {
      clearAttackOrder(s);
    } else {
      const range = s.equipped === 'longsword' ? MELEE_RANGE_ARMED : MELEE_RANGE_BARE;
      const d = Math.hypot(sk.x - p.x, sk.y - p.y);
      if (d > range - 8) {
        // Out of range: walk toward the living target, tracking its movement.
        setTarget(s, sk.x, sk.y);
        s.moveMode = 'point';
      } else if (p.attackCd <= 0) {
        swingAtTarget(s, index);
        clearAttackOrder(s);
        setTarget(s, p.x, p.y);
        s.moveMode = 'idle';
      } else {
        // In range but cooling down: stand still and wait for the swing.
        setTarget(s, p.x, p.y);
        s.moveMode = 'point';
      }
    }
  }

  // Skeletons chase and strike.
  for (const sk of s.skeletons) {
    if (!sk.alive) continue;
    sk.attackCd = Math.max(0, sk.attackCd - dt);
    sk.hit = Math.max(0, sk.hit - dt);
    sk.bob += dt * 3.4;
    const sdx = p.x - sk.x;
    const sdy = p.y - sk.y;
    const sd = Math.hypot(sdx, sdy);
    if (sd > 40) {
      sk.x += (sdx / sd) * 62 * dt;
      sk.y += (sdy / sd) * 62 * dt;
    } else if (sk.attackCd <= 0) {
      sk.attackCd = 1.15;
      if (p.invuln <= 0) {
        s.hp = Math.max(0, s.hp - 6);
        p.hurt = 0.35;
        p.invuln = 0.7;
        burst(s, p.x, p.y - 26, '#ff6b6b', 8, 120);
        if (s.hp <= 0) {
          s.gameOver = true;
          say(s, '你被击倒了 · 按 R 重新开始');
        }
      }
    }
  }

  // Drops: walk over one to equip the main weapon.
  for (let i = s.drops.length - 1; i >= 0; i -= 1) {
    const drop = s.drops[i];
    if (!drop) continue;
    drop.t += dt;
    if (Math.hypot(drop.x - p.x, drop.y - p.y) < 50) {
      s.drops.splice(i, 1);
      if (s.equipped === null) {
        s.equipped = 'longsword';
        s.score += 60;
        say(s, '已装备主武器：长剑 · 攻击范围与伤害提升');
        burst(s, p.x, p.y - 30, '#ffd166', 20, 175);
      } else {
        s.score += 80;
        say(s, '主武器槽已满 · 长剑转化为 80 分');
      }
    }
  }

  if (!s.cleared && s.equipped && s.skeletons.every((sk) => !sk.alive)) {
    s.cleared = true;
    say(s, '试炼完成 · 按 R 再来一次');
  }

  for (const part of s.particles) {
    part.life -= dt;
    part.x += part.vx * dt;
    part.y += part.vy * dt;
    part.vy += 300 * dt;
  }
  s.particles = s.particles.filter((part) => part.life > 0);
}

/** Stable read projection consumed by the playthrough assertions. */
export function projection(s: GameState) {
  const first = s.drops[0];
  return {
    hp: s.hp,
    maxHp: s.maxHp,
    score: s.score,
    kills: s.kills,
    attacks: s.attacks,
    skeletonsAlive: s.skeletons.filter((sk) => sk.alive).length,
    skeletons: s.skeletons.map((sk) => ({
      x: sk.x / VIEW_W,
      y: sk.y / VIEW_H,
      hp: sk.hp,
      alive: sk.alive,
    })),
    attackTarget: s.targetEnemy,
    attackOrder: s.attackOrder,
    drops: s.drops.map((drop) => drop.kind),
    dropAt: first ? { x: first.x / VIEW_W, y: first.y / VIEW_H } : null,
    equippedWeapon: s.equipped,
    player: { x: s.player.x / VIEW_W, y: s.player.y / VIEW_H },
    moveMode: s.moveMode,
    followingPointer: s.moveMode === 'follow',
    target: { x: s.target.x / VIEW_W, y: s.target.y / VIEW_H },
    dodging: s.player.dodge > 0,
    attackCooldown: s.player.attackCd,
    dodgeCooldown: s.player.dodgeCd,
    gameOver: s.gameOver,
    cleared: s.cleared,
  };
}
