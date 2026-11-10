/**
 * Combat state: the authoritative in-run state shape and its construction.
 *
 * No other combat file is imported here (only `shared/`), so every combat
 * subsystem can import these types without a cycle.
 */

import { GROUND_TOP, VIEW_H, VIEW_W } from '../shared/constants.ts';
import { makeRng } from './loot.ts';

export interface StepInput {
  /** Pointer in logical canvas pixels (top-left origin). */
  readonly mouse?: { x: number; y: number } | undefined;
  readonly pointerDown: boolean;
  readonly pointerHeld: boolean;
  readonly pointerUp: boolean;
  readonly dodge: boolean;
  /** Digit1 / Digit2 select which of the two weapon slots is in use. */
  readonly switchWeapon?: 0 | 1 | null;
  readonly restart: boolean;
}

/**
 * Runtime "armed vs bare" category. Authored item identity (the 12 item ids in
 * `item.xlsx`) travels in `Drop.itemId` / `GameState.carriedItems` instead, so
 * the existing melee range / damage contract and all playthrough assertions
 * keep working while loot can resolve to any authored item.
 */
export type WeaponId = 'longsword';

/** Default arena population. Overridable per run via `createState`. */
export const DEFAULT_MONSTER_COUNT = 2;
export const DEFAULT_RUN_SEED = 0x5eed1234;

/** The single weapon currently in use; null = bare hands. */
export function activeWeapon(s: GameState): WeaponId | null {
  return s.weaponSlots[s.activeWeaponSlot];
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
  /** Authored monster id from `monster_loot.xlsx`; drives the loot pool. */
  monsterId: string;
}

export interface Drop {
  x: number;
  y: number;
  /** Visual / compatibility category: every weapon drop is drawn as a sword. */
  kind: 'longsword';
  t: number;
  /** Authored item id, present when this drop came from a weighted loot roll. */
  itemId?: string;
  name?: string;
  quality?: string;
  monsterId?: string;
}

/** One weighted loot roll, recorded for the run report and settlement. */
export interface LootRecord {
  monsterId: string;
  itemId: string;
  name: string;
  quality: string;
  damageMin: number;
  damageMax: number;
  poolId: number;
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
  /** Two equippable weapon slots; only `activeWeaponSlot` is used in melee. */
  weaponSlots: [WeaponId | null, WeaponId | null];
  activeWeaponSlot: 0 | 1;
  gameOver: boolean;
  cleared: boolean;
  particles: Particle[];
  toast: { text: string; life: number } | null;
  /** Arena population for this run (overridable at deployment). */
  monsterCount: number;
  /** Deterministic seed: identical seed + identical kills = identical loot. */
  runSeed: number;
  /** Seeded PRNG, rebuilt on reset. Not projected (functions are not JSON). */
  rng: () => number;
  /** Every weighted roll this run, in order. Drives the loot report. */
  lootLog: LootRecord[];
  /** Authored item ids actually walked over and picked up (run settlement). */
  carriedItems: string[];
}

export interface RunConfig {
  readonly monsterCount?: number;
  readonly seed?: number;
}

export function createState(config: RunConfig = {}): GameState {
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
    weaponSlots: [null, null],
    activeWeaponSlot: 0,
    gameOver: false,
    cleared: false,
    particles: [],
    toast: null,
    monsterCount: Math.max(1, Math.floor(config.monsterCount ?? DEFAULT_MONSTER_COUNT)),
    runSeed: config.seed ?? DEFAULT_RUN_SEED,
    rng: makeRng(config.seed ?? DEFAULT_RUN_SEED),
    lootLog: [],
    carriedItems: [],
  };
  reset(state);
  return state;
}

/**
 * Spawn `count` skeletons. The first two keep the original coordinates so all
 * existing playthrough steps (which click the first living skeleton) stay
 * valid. Extra monsters form a loose grid on the right half of the arena.
 * Monster ids alternate between the two authored types so a mixed pack
 * exercises both loot pools.
 */
export function spawnSkeletons(count = DEFAULT_MONSTER_COUNT): Skeleton[] {
  const fixed: readonly [number, number][] = [[880, 430], [1010, 560]];
  const out: Skeleton[] = [];
  const n = Math.max(1, Math.floor(count));
  for (let i = 0; i < n; i += 1) {
    const extra = i - fixed.length;
    const col = extra % 3;
    const row = Math.floor(extra / 3);
    const x = i < fixed.length ? fixed[i]![0] : 700 + col * 175;
    const y = i < fixed.length ? fixed[i]![1] : 320 + row * 130;
    out.push({
      x, y,
      hp: 66, maxHp: 66, alive: true,
      attackCd: 0.8 + (i % 4) * 0.25,
      hit: 0,
      bob: (i % 3) * 1.4,
      monsterId: i % 2 === 0 ? '100001' : '200001',
    });
  }
  return out;
}

export function reset(s: GameState): void {
  s.t = 0;
  s.attacks = 0;
  s.hp = s.maxHp;
  s.score = 0;
  s.kills = 0;
  s.weaponSlots = [null, null];
  s.activeWeaponSlot = 0;
  s.gameOver = false;
  s.cleared = false;
  s.drops.length = 0;
  s.particles.length = 0;
  // A run restart must reproduce the same loot sequence for the same seed,
  // while keeping the configured monster count (R does not change deployment).
  s.rng = makeRng(s.runSeed);
  s.lootLog.length = 0;
  s.carriedItems.length = 0;
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
  s.skeletons = spawnSkeletons(s.monsterCount);
}

// Re-exported so combat render/engine code keeps a single source for the view box.
export { GROUND_TOP, VIEW_H, VIEW_W };
