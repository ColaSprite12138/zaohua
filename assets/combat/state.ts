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
import { createInventoryState, type InventoryState } from '../meta/inventory.ts';
import { makeRng } from './loot.ts';
import {
  cameraFor, makeWorld, nearestWalkable, type ArenaMap, type Vec, type World,
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
  /**
   * E（justPressed）：起手 / 取消传送门引导。按住不算 —— 引导是一次主动决定，
   * 再按一次 E 退出，否则「引导中禁止移动」会把玩家困在门口。
   */
  readonly extractChannel?: boolean;
  /**
   * True while the pointer sits on a HUD panel (the read-only minimap). Hover
   * feedback is pure presentation, so it must not light up under the pointer
   * when the pointer is not over the world.
   */
  readonly pointerOnHud?: boolean;
}

/**
 * A weapon slot now holds the AUTHORED item id (`item.xlsx`), not a visual
 * category. `projection()` still reports the legacy `'longsword'` category for
 * the playthrough contract, while `weaponDefIds` exposes the real ids.
 */
export type WeaponId = string;

export const DEFAULT_RUN_SEED = 0x5eed1234;

/** The single weapon currently in use; null = bare hands. */
export function activeWeapon(s: GameState): WeaponId | null {
  return s.weaponSlots[s.activeWeaponSlot];
}

/** Every weapon slot follows the run inventory; callers never hand-edit both. */
export function syncWeaponSlots(s: GameState): void {
  s.weaponSlots = [
    s.runInventory.equipped[0]?.defId ?? null,
    s.runInventory.equipped[1]?.defId ?? null,
  ];
  s.activeWeaponSlot = s.runInventory.activeWeaponSlot;
}

export const CLICK_DRAG_PIXELS = 12;
export const MELEE_RANGE_BARE = 140;
export const MELEE_RANGE_ARMED = 170;
/**
 * Screen pixels of ground travel per walk-cycle frame. Animation is advanced by
 * DISTANCE, not by time: a body that walks faster must step faster, and a body
 * that stands still must never tread in place. 22px lands a walking player at
 * ~2.3 steps per second -- a stride, not a shuffle.
 */
export const STRIDE_PIXELS = 22;
/** How long a monster's lunge (and the player's swing pose) lasts. */
export const MONSTER_SWING_TIME = 0.34;
/** Duration of the player's swing animation; `attackFx` counts it down. */
export const PLAYER_SWING_TIME = 0.26;

/** idle = no order; point = walking to a waypoint; follow = live cursor tracking. */
export type MoveMode = 'idle' | 'point' | 'follow';

/* ------------------------------------------------- 单局骨架（搜打撤，设计文档 10） */

/**
 * 关卡类型。三类共用同一套地图与战斗，差别只在「什么算结束、死了掉什么」：
 *
 * - `story`  主线：清怪即完成，失败不掉装备（剧情优先，不惩罚）
 * - `dungeon` 副本：必须撤离才算带走；死亡掉落留在原地（捡回一次待做）
 * - `pvpve`  搜打撤：必须撤离；死亡全部掉落
 *
 * 自动验收夹具默认 `story`，所以「清怪 → 通关」的旧链路一条都没变。
 */
export type RunKind = 'story' | 'dungeon' | 'pvpve';

/** explore 0–4 分 / fight 4–11 分 / extract 11–15 分；ended = 已结算。 */
export type RunPhase = 'explore' | 'fight' | 'extract' | 'ended';

/** 一局 15 分钟（设计文档 10.1）。 */
export const RUN_SECONDS = 900;
/** 4:00 进入交战阶段、11:00 进入撤离阶段（设计文档 10.2）。 */
export const PHASE_FIGHT_AT = 240;
export const PHASE_EXTRACT_AT = 660;
/**
 * 引导 8–12 秒，取区间下限 8 秒：搜打撤里「撤」要利索，站桩越久越像罚站。
 * 分 3 段给音效/光效（设计文档 10.6）。
 */
export const PORTAL_GUIDE_SECONDS = 8;
export const PORTAL_STAGE_COUNT = 3;
/** 站在这个半径内才允许引导（世界像素，约 2 格）。 */
export const PORTAL_RADIUS = 64;
/** 每扇门可开启次数：每次只走 1 人，单人撤离即结束（为多人留口）。 */
export const PORTAL_USES = 3;
/** 门数量 > 同场人数：单人 5 扇。 */
export const PORTAL_COUNT = 5;

/**
 * 一扇传送门。`progress` 只在玩家主动引导时增长，受击 / 离开 / 闪避只把它
 * 清零 —— **不给硬直**（设计文档 10.6 v4 修正：清空进度本身就是惩罚）。
 */
export interface Portal {
  readonly id: number;
  x: number;
  y: number;
  /** 0..1 当前引导进度；`1` 的同一帧即开启并送走玩家。 */
  progress: number;
  /** 剩余开启次数；耗尽 = 永久关闭。 */
  uses: number;
  /** 已从这里撤离的人数。 */
  opened: number;
  state: 'armed' | 'spent';
  /** 本帧玩家是否站在门圈内（纯表现，不参与判定）。 */
  inRange: boolean;
}

/**
 * 传送门沿地图中心的椭圆环带均匀布点，再吸附到最近可走格。用固定几何而不是
 * LDtk 实体，是为了不让地图生成链（gen_arena_map / import_map）跟着改一版。
 * 吸附后距离过近的点沿角度错开重采，保证 5 扇门不会挤成一堆。
 */
export function createPortals(w: World, count = PORTAL_COUNT): Portal[] {
  const { pxWid, pxHei } = w.map;
  const cx = pxWid / 2;
  const cy = pxHei / 2;
  const rx = Math.max(w.grid * 2, pxWid * 0.34);
  const ry = Math.max(w.grid * 2, pxHei * 0.34);
  const spots: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    let picked: { x: number; y: number } | null = null;
    for (let attempt = 0; attempt < 8 && picked === null; attempt += 1) {
      const a = -Math.PI / 2 + (Math.PI * 2 * (i + attempt * 0.19)) / count;
      const spot = nearestWalkable(w, cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
      const clear = spots.every((q) => Math.hypot(q.x - spot.x, q.y - spot.y) >= w.grid * 2);
      if (clear) picked = spot;
    }
    // 八次都挤在一起也要留一扇门：宁可重叠，也不能让本局没有出口。
    const fallbackAngle = -Math.PI / 2 + (Math.PI * 2 * i) / count;
    const spot = picked ?? nearestWalkable(
      w, cx + Math.cos(fallbackAngle) * rx, cy + Math.sin(fallbackAngle) * ry,
    );
    spots.push(spot);
  }
  return spots.map((spot, index) => ({
    id: index,
    x: spot.x,
    y: spot.y,
    progress: 0,
    uses: PORTAL_USES,
    opened: 0,
    state: 'armed' as const,
    inRange: false,
  }));
}

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
  /**
   * Screen-space heading toward the player (radians, 0 = +x, +PI/2 = down).
   * The painter uses it to turn the body (front / back + mirror) instead of
   * sliding a always-facing-camera sprite across the floor.
   */
  face: number;
  /** Counts down from `SWING_TIME` after a landed blow; drives the lunge. */
  swing: number;
  /** Walk-cycle counter advanced only while the body actually moves. */
  stride: number;
  /** True while this monster is actually covering ground this frame. */
  moving: boolean;
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
  /**
   * Result of `layoutDrops()` for the CURRENT frame. `undefined` means "not
   * laid out yet" (a drop created this frame, or a unit-test fixture), which
   * falls back to the single-item anchor. `null` means "deliberately hidden by
   * the fan-out cap" -- such a drop has no plate and cannot be clicked by name.
   */
  label?: DropLabel | null;
}

/**
 * Ground loot is a TINY model plus a name plate, and the plate is the click
 * target. The old 26px radius around the item swallowed the whole monster
 * standing on it: a player aiming at the skeleton kept ordering a pickup.
 * Now a click only loots when it lands on the plate (or the small model), so
 * the same click on the body still attacks.
 */
export const DROP_MODEL_RADIUS = 12;
/** Top of the tiny model above the ground point; the plate floats above it. */
export const DROP_MODEL_TOP = -26;
export const DROP_LABEL_H = 20;
export const DROP_LABEL_GAP = 8;
/**
 * Overlapping loot fans out into ONE vertical column per pile (the Diablo
 * "loot explosion" read): at most this many plates, best quality on top. The
 * rest stay on the ground unlabelled and surface as the upper ones are taken.
 */
export const DROP_LABEL_MAX = 5;
/** Vertical spacing of fanned-out plates: plate height + 4px breathing room. */
export const DROP_LABEL_STEP = DROP_LABEL_H + 4;
/**
 * Two plates "overlap" when their boxes would collide within this slack. Piles
 * are built from this, not from a fixed radius: a label only fans out when the
 * labels it would otherwise cover, which is exactly what the player sees.
 */
export const DROP_PILE_GAP = 6;

/** 白 < 绿 < 蓝 < 紫 < 橙; unknown qualities sort below 白. */
export function dropQualityRank(quality?: string): number {
  switch (quality) {
    case '白': return 1;
    case '绿': return 2;
    case '蓝': return 3;
    case '紫': return 4;
    case '橙': return 5;
    default: return 0;
  }
}

/** A laid-out plate: box + where it sits in the fan-out column. */
export interface DropLabel {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0 = top of the column (highest quality shown). */
  index: number;
  /** How many plates this column shows. */
  count: number;
  /** How many drops of this pile the cap suppressed. */
  hidden: number;
}

/** Display name of a drop; unlabelled debug drops still read as a sword. */
export function dropLabelName(drop: Drop): string {
  return drop.name !== undefined && drop.name.length > 0 ? drop.name : '长剑';
}

/** Plate width estimated from the name (CJK glyphs are ~1em at 12px). */
function labelWidth(name: string): number {
  return Math.max(44, Array.from(name).length * 13 + 20);
}

/**
 * The plate box a drop would get on its own. The column keeps this as its
 * bottom entry, so a single drop (or the last of a pile) looks exactly like it
 * always did.
 */
export function dropLabelAnchor(drop: Drop): { x: number; y: number; w: number; h: number } {
  const w = labelWidth(dropLabelName(drop));
  const bottom = drop.y + DROP_MODEL_TOP - DROP_LABEL_GAP;
  return { x: drop.x - w / 2, y: bottom - DROP_LABEL_H, w, h: DROP_LABEL_H };
}

/**
 * The plate's WORLD-space box. `attack.ts` uses it for hit testing and
 * `paint.ts` for drawing, so the visible highlight and the clickable area can
 * never disagree. Returns null when the fan-out cap hides this drop.
 */
export function dropLabelRect(drop: Drop): DropLabel | null {
  if (drop.label !== undefined) return drop.label;
  return { ...dropLabelAnchor(drop), index: 0, count: 1, hidden: 0 };
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
  /**
   * Walk-cycle counter, advanced by ground DISTANCE (see `STRIDE_PIXELS`), so
   * the step rate always matches the speed the body is actually moving.
   */
  stride: number;
  invuln: number;
  dodge: number;
  dodgeCd: number;
  attackCd: number;
  attackFx: number;
  hurt: number;
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
  /**
   * Enemy index under the free cursor this frame, using the SAME hit test as a
   * click. Pure feedback: the painter rings it and the page turns the pointer
   * into a sword. It never orders anything and is never part of the input
   * classification.
   */
  hoverEnemy: number | null;
  /**
   * Drop uid whose NAME PLATE (or tiny model) is under the free cursor. When
   * set, `hoverEnemy` is NULL: the plate wins the pointer so the page shows the
   * move cursor, not the sword, even though a monster stands on the same spot.
   */
  hoverDrop: string | null;
  attackOrder: boolean;
  /**
   * The button currently down. `vx/vy` are the press point in VIEW space (used
   * to tell a click from a drag, camera-independent); `wx/wy` are the same
   * point in world space, kept only as a fallback when a release arrives
   * without a pointer position. `hold` flips only when the pointer has
   * actually travelled past `CLICK_DRAG_PIXELS` on screen.
   */
  press: {
    vx: number;
    vy: number;
    wx: number;
    wy: number;
    hold: boolean;
  } | null;
  skeletons: Skeleton[];
  drops: Drop[];
  /**
   * The COMPLETE in-run inventory lives in this Worker's heap: bag + all ten
   * equipment slots, `stash` always empty. The main window holds a separate
   * lobby InventoryState; neither heap can read the other's object.
   */
  runInventory: InventoryState;
  /** Derived from `runInventory.equipped[0/1]`; only the active one hits. */
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
  /* ---------------------------------------------------- 单局骨架（搜打撤） */
  /** 关卡类型；只影响「什么算结束 / 死了掉什么」，不改变战斗。 */
  runKind: RunKind;
  /** 本局剩余秒数，900 → 0。归零 = 超时未撤离，全部丢失。 */
  runSeconds: number;
  phase: RunPhase;
  /** 本图的全部传送门（固定几何，`reset()` 重建）。 */
  portals: Portal[];
  /** 正在引导的传送门 id；null = 没在引导。 */
  channel: number | null;
  /** 已从传送门撤离：本局成功，整份带回。 */
  extracted: boolean;
  /** 时间耗尽没撤离：本局失败，整份丢失。 */
  timedOut: boolean;
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
      x, y, vx: 0, vy: 0, face: 0, stride: 0,
      invuln: 0, dodge: 0, dodgeCd: 0, attackCd: 0,
      attackFx: 0, hurt: 0, trail: [],
    },
    target: { x, y },
    moveMode: 'idle',
    targetEnemy: null,
    hoverEnemy: null,
    hoverDrop: null,
    attackOrder: false,
    press: null,
    skeletons: [],
    drops: [],
    // No run has been deployed yet: the acceptance fixture starts empty and
    // `deployRun()` replaces this with the lobby's loadout.
    runInventory: createInventoryState(0),
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
    runKind: 'story',
    runSeconds: RUN_SECONDS,
    phase: 'explore',
    portals: [],
    channel: null,
    extracted: false,
    timedOut: false,
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
    face: Math.PI / 2,
    swing: 0,
    stride: i % 4,
    moving: false,
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
  // A restart replays THIS run: the brought-in equipment and everything picked
  // up so far stay in `runInventory`. Nothing is silently borrowed or returned.
  syncWeaponSlots(s);
  s.gameOver = false;
  s.cleared = false;
  s.drops.length = 0;
  s.particles.length = 0;
  // A run restart must reproduce the same loot sequence for the same seed.
  s.rng = makeRng(s.runSeed);
  s.lootLog.length = 0;
  s.carriedItems.length = 0;
  s.pickupTarget = null;
  s.toast = { text: '单击地面移动 · 单击掉落物拾取 · 单击敌人攻击 · 长按跟随光标 · 空格闪避', life: 4.2 };
  // 单局骨架：计时归零、门重建（次数是「本局」资源，重开一局就恢复）。
  s.runSeconds = RUN_SECONDS;
  s.phase = 'explore';
  s.portals = createPortals(s.world);
  s.channel = null;
  s.extracted = false;
  s.timedOut = false;
  s.moveMode = 'idle';
  s.targetEnemy = null;
  s.hoverEnemy = null;
  s.hoverDrop = null;
  s.attackOrder = false;
  s.press = null;
  const p = s.player;
  p.x = s.map.spawn.x;
  p.y = s.map.spawn.y;
  p.vx = 0;
  p.vy = 0;
  p.face = 0;
  p.stride = 0;
  p.invuln = 0;
  p.dodge = 0;
  p.dodgeCd = 0;
  p.attackCd = 0;
  p.attackFx = 0;
  p.hurt = 0;
  p.trail.length = 0;
  s.target = { x: p.x, y: p.y };
  s.path = [];
  s.camera = cameraFor(s.world, p.x, p.y);
  s.skeletons = spawnFromMap(s.map);
}

// Re-exported so combat render/engine code keeps a single source for the view box.
export { VIEW_H, VIEW_W };
