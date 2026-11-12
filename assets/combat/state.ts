/**
 * Combat state: the authoritative in-run state shape and its construction.
 *
 * No other combat file is imported here (only `shared/` + pure world helpers),
 * so every combat subsystem can import these types without a cycle.
 *
 * Coordinates are WORLD pixels. The engine layer converts screen pixels with
 * `screenToWorld(state.camera, ...)` before calling `step()`, and `projection()`
 * converts back with `worldToScreen(...)` so the automated acceptance scripts
 * keep their screen-normalised contract.
 */

import { VIEW_H, VIEW_W } from '../shared/constants.ts';
import { testArena } from '../resource/maps/arena-test.ts';
import { makeRng } from './loot.ts';
import {
  cameraFor, makeWorld, type ArenaMap, type Vec, type World,
} from './world.ts';

export interface StepInput {
  /** Pointer in WORLD pixels (already converted from screen by the engine). */
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
  /** Authored monster id from `monster.xlsx`; drives the loot pool. */
  monsterId: string;
  /** Cached A* route to the player, recomputed on a timer. */
  path: Vec[];
  repath: number;
}

export interface Drop {
  /** Stable identity for an explicit pickup order / cross-window request. */
  uid: string;
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

export interface PendingPickup {
  readonly uid: string;
  readonly itemId: string;
  readonly name: string;
}

/**
 * A loot item that was just equipped into an empty in-run weapon slot.
 * `combat` is pure logic, so the Engine Worker drains this queue each frame
 * and forwards it to the main window's InventoryState (character panel).
 */
export interface WeaponLootEvent {
  readonly uid: string;
  readonly itemId: string;
  readonly slot: 0 | 1;
}

let dropUidCounter = 0;
/** Monotonic across runs so a bag uid never collides with a previous run. */
export function nextDropUid(): string {
  dropUidCounter += 1;
  return `drop-${dropUidCounter}`;
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
  /** Active map. The acceptance fixture by default, arena.ldtk after deploy. */
  map: ArenaMap;
  /** Precomputed tile grid / collision queries for `map`. */
  world: World;
  /** Camera top-left in WORLD pixels; the single authority for input + paint. */
  camera: { x: number; y: number };
  /** A* waypoints in world pixels for the current move order. */
  path: Vec[];
  /** Deterministic seed: identical seed + identical kills = identical loot. */
  runSeed: number;
  /** Seeded PRNG, rebuilt on reset. Not projected (functions are not JSON). */
  rng: () => number;
  /** Every weighted roll this run, in order. Drives the loot report. */
  lootLog: LootRecord[];
  /** Authored item ids explicitly picked up this run (run report). */
  carriedItems: string[];
  /** Drop uid the player clicked; null = no pickup order. */
  pickupTarget: string | null;
  /** Request waiting for the main window to find a bag cell. */
  pendingPickup: PendingPickup | null;
  /** Uids placed into the bag during this run (lost on death). */
  runBagUids: string[];
  /** Authored ids equipped into weapon slots (brought home on clear). */
  slotLootItemIds: string[];
  /** Drained by the Engine Worker to sync the in-run character panel. */
  weaponLootEvents: WeaponLootEvent[];
}

export interface RunConfig {
  readonly seed?: number;
  readonly map?: ArenaMap;
}

export function createState(config: RunConfig = {}): GameState {
  const map: ArenaMap = config.map ?? testArena;
  const world = makeWorld(map);
  const { x, y } = map.spawn;
  const state: GameState = {
    t: 0,
    attacks: 0,
    hp: 100,
    maxHp: 100,
    kills: 0,
    player: {
      x, y, vx: 0, vy: 0, face: 0,
      invuln: 0, dodge: 0, dodgeCd: 0, attackCd: 0,
      attackFx: 0, hurt: 0, attackAim: 0, trail: [],
    },
    target: { x, y },
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
    map,
    world,
    camera: cameraFor(world, x, y),
    path: [],
    runSeed: config.seed ?? DEFAULT_RUN_SEED,
    rng: makeRng(config.seed ?? DEFAULT_RUN_SEED),
    lootLog: [],
    carriedItems: [],
    pickupTarget: null,
    pendingPickup: null,
    runBagUids: [],
    slotLootItemIds: [],
    weaponLootEvents: [],
  };
  reset(state);
  return state;
}

/**
 * Every skeleton comes from the LDtk entity layer. There is NO default spawn
 * count and NO hard-coded coordinate: `map.monsters` is the only authority.
 */
export function spawnFromMap(map: ArenaMap): Skeleton[] {
  return map.monsters.map((m, i) => ({
    x: m.x,
    y: m.y,
    hp: 66,
    maxHp: 66,
    alive: true,
    attackCd: 0.8 + (i % 4) * 0.25,
    hit: 0,
    bob: (i % 3) * 1.4,
    monsterId: m.monsterId,
    path: [],
    repath: 0,
  }));
}

/** Switch the active arena (called on `deploy`) and rebuild the run. */
export function setArena(s: GameState, map: ArenaMap): void {
  s.map = map;
  s.world = makeWorld(map);
  reset(s);
}

export function reset(s: GameState): void {
  s.t = 0;
  s.attacks = 0;
  s.hp = s.maxHp;
  s.kills = 0;
  s.weaponSlots = [null, null];
  s.activeWeaponSlot = 0;
  s.gameOver = false;
  s.cleared = false;
  s.drops.length = 0;
  s.particles.length = 0;
  // A run restart must reproduce the same loot sequence for the same seed.
  s.rng = makeRng(s.runSeed);
  s.lootLog.length = 0;
  s.carriedItems.length = 0;
  s.pickupTarget = null;
  s.pendingPickup = null;
  s.runBagUids.length = 0;
  s.slotLootItemIds.length = 0;
  s.weaponLootEvents.length = 0;
  s.toast = { text: '单击地面移动 · 单击掉落物拾取 · 单击敌人攻击 · 长按跟随光标 · 空格闪避', life: 4.2 };
  s.moveMode = 'idle';
  s.targetEnemy = null;
  s.attackOrder = false;
  s.press = null;
  const p = s.player;
  p.x = s.map.spawn.x;
  p.y = s.map.spawn.y;
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
  s.target = { x: p.x, y: p.y };
  s.path = [];
  s.camera = cameraFor(s.world, p.x, p.y);
  s.skeletons = spawnFromMap(s.map);
}

// Re-exported so combat render/engine code keeps a single source for the view box.
export { VIEW_H, VIEW_W };
