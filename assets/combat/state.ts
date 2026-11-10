/**
 * Combat state: the authoritative in-run state shape and its construction.
 *
 * No other combat file is imported here (only `shared/`), so every combat
 * subsystem can import these types without a cycle.
 */

import { GROUND_TOP, VIEW_H, VIEW_W } from '../shared/constants.ts';

export interface StepInput {
  /** Pointer in logical canvas pixels (top-left origin). */
  readonly mouse?: { x: number; y: number } | undefined;
  readonly pointerDown: boolean;
  readonly pointerHeld: boolean;
  readonly pointerUp: boolean;
  readonly dodge: boolean;
  readonly restart: boolean;
}

export const CLICK_HOLD_SECONDS = 0.35;
export const CLICK_DRAG_PIXELS = 12;
export const MELEE_RANGE_BARE = 140;
export const MELEE_RANGE_ARMED = 170;

/** idle = no order; point = walking to a waypoint; follow = live cursor tracking. */
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
  target: { x: number; y: number };
  moveMode: MoveMode;
  targetEnemy: number | null;
  attackOrder: boolean;
  press: { x: number; y: number; elapsed: number; hold: boolean } | null;
  skeletons: Skeleton[];
  drops: Drop[];
  equipped: 'longsword' | null;
  gameOver: boolean;
  cleared: boolean;
  particles: Particle[];
  toast: { text: string; life: number } | null;
}

export function createState(): GameState {
  const state: GameState = {
    t: 0,
    attacks: 0,
    hp: 100,
    maxHp: 100,
    score: 0,
    kills: 0,
    player: {
      x: 400, y: 470, vx: 0, vy: 0, face: 0,
      invuln: 0, dodge: 0, dodgeCd: 0, attackCd: 0,
      attackFx: 0, hurt: 0, attackAim: 0, trail: [],
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

/** Monster design lives here for now: two skeletons, 66 HP each. */
export function spawnSkeletons(): Skeleton[] {
  return [
    { x: 880, y: 430, hp: 66, maxHp: 66, alive: true, attackCd: 0.8, hit: 0, bob: 0 },
    { x: 1010, y: 560, hp: 66, maxHp: 66, alive: true, attackCd: 1.6, hit: 0, bob: 1.4 },
  ];
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
  s.skeletons = spawnSkeletons();
}

// Re-exported so combat render/engine code keeps a single source for the view box.
export { GROUND_TOP, VIEW_H, VIEW_W };
