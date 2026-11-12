/**
 * World-space map runtime: tile queries, A* pathing, camera and coordinate
 * conversion. Pure helpers with no gameplay state and no imports outside
 * `shared/`. The map data itself is injected by the engine layer so this
 * module never depends on a specific arena.
 */

import { VIEW_H, VIEW_W, clamp } from '../shared/constants.ts';

export interface Vec {
  readonly x: number;
  readonly y: number;
}

/** Structural shape shared by arena.generated.ts and the acceptance fixture. */
export interface ArenaMap {
  readonly id: string;
  readonly gridSize: number;
  readonly cols: number;
  readonly rows: number;
  readonly pxWid: number;
  readonly pxHei: number;
  readonly terrain: readonly string[];
  readonly spawn: {
    readonly col: number;
    readonly row: number;
    readonly x: number;
    readonly y: number;
  };
  readonly monsters: readonly {
    readonly monsterId: string;
    readonly col: number;
    readonly row: number;
    readonly x: number;
    readonly y: number;
    readonly wave: number;
  }[];
}

export interface World {
  readonly map: ArenaMap;
  readonly tiles: Uint8Array;
  readonly cols: number;
  readonly rows: number;
  readonly grid: number;
}

/** IntGrid values that can be walked on: 0 floor, 2 road. */
const WALKABLE_TILES = new Set<number>([0, 2]);

export function makeWorld(map: ArenaMap): World {
  const tiles = new Uint8Array(map.cols * map.rows);
  for (let r = 0; r < map.rows; r += 1) {
    const line = map.terrain[r] ?? '';
    for (let c = 0; c < map.cols; c += 1) {
      const n = Number(line[c]);
      tiles[r * map.cols + c] = Number.isFinite(n) && n >= 0 && n <= 3 ? n : 1;
    }
  }
  return { map, tiles, cols: map.cols, rows: map.rows, grid: map.gridSize };
}

export function cellOf(w: World, x: number, y: number): { col: number; row: number } {
  return { col: Math.floor(x / w.grid), row: Math.floor(y / w.grid) };
}

export function tileAt(w: World, x: number, y: number): number {
  const { col, row } = cellOf(w, x, y);
  if (col < 0 || row < 0 || col >= w.cols || row >= w.rows) return 1;
  return w.tiles[row * w.cols + col] ?? 1;
}

export function inBounds(w: World, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < w.map.pxWid && y < w.map.pxHei;
}

export function walkable(w: World, x: number, y: number): boolean {
  return WALKABLE_TILES.has(tileAt(w, x, y));
}

/** Wall / void block both movement and sight. Out of bounds is blocked too. */
export function blocks(w: World, x: number, y: number): boolean {
  return !walkable(w, x, y);
}

/** Snap an unwalkable waypoint to the closest walkable cell centre. */
export function nearestWalkable(w: World, x: number, y: number): Vec {
  if (walkable(w, x, y)) return { x, y };
  const { col, row } = cellOf(w, x, y);
  for (let radius = 1; radius <= 12; radius += 1) {
    let best: Vec | null = null;
    let bestD = Infinity;
    for (let dr = -radius; dr <= radius; dr += 1) {
      for (let dc = -radius; dc <= radius; dc += 1) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== radius) continue;
        const c = col + dc;
        const r = row + dr;
        if (c < 0 || r < 0 || c >= w.cols || r >= w.rows) continue;
        if (!WALKABLE_TILES.has(w.tiles[r * w.cols + c] ?? 1)) continue;
        const px = c * w.grid + w.grid / 2;
        const py = r * w.grid + w.grid / 2;
        const d = (px - x) ** 2 + (py - y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { x: px, y: py };
        }
      }
    }
    if (best !== null) return best;
  }
  return { x: w.map.spawn.x, y: w.map.spawn.y };
}

/** Camera centres on the player but never shows outside the world. */
export function cameraFor(w: World, px: number, py: number): Vec {
  return {
    x: clamp(px - VIEW_W / 2, 0, Math.max(0, w.map.pxWid - VIEW_W)),
    y: clamp(py - VIEW_H / 2, 0, Math.max(0, w.map.pxHei - VIEW_H)),
  };
}

export function screenToWorld(cam: Vec, sx: number, sy: number): Vec {
  return { x: cam.x + sx, y: cam.y + sy };
}

export function worldToScreen(cam: Vec, wx: number, wy: number): Vec {
  return { x: wx - cam.x, y: wy - cam.y };
}

interface HeapItem {
  idx: number;
  f: number;
}

/** Binary min-heap over f-scores; A* on a 64x48 grid runs every click. */
class MinHeap {
  private readonly items: HeapItem[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: HeapItem): void {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent]!.f <= a[i]!.f) break;
      [a[parent], a[i]] = [a[i]!, a[parent]!];
      i = parent;
    }
  }

  pop(): HeapItem | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < a.length && a[l]!.f < a[smallest]!.f) smallest = l;
        if (r < a.length && a[r]!.f < a[smallest]!.f) smallest = r;
        if (smallest === i) break;
        [a[smallest], a[i]] = [a[i]!, a[smallest]!];
        i = smallest;
      }
    }
    return top;
  }
}

const NEIGHBOURS: readonly (readonly [number, number, number])[] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

/**
 * A* over tile centres, 8 neighbours, diagonal corner cutting forbidden.
 * Returns world-pixel waypoints (excluding the start cell); the final entry is
 * the snapped target. An unreachable target falls back to a direct line so the
 * movement layer can still slide along a wall instead of freezing.
 */
export function findPath(w: World, from: Vec, to: Vec): Vec[] {
  const goal = nearestWalkable(w, to.x, to.y);
  const startPoint = walkable(w, from.x, from.y)
    ? from
    : nearestWalkable(w, from.x, from.y);
  const s = cellOf(w, startPoint.x, startPoint.y);
  const g = cellOf(w, goal.x, goal.y);
  const n = w.cols * w.rows;
  const start = s.row * w.cols + s.col;
  const target = g.row * w.cols + g.col;
  if (start === target) return [{ x: goal.x, y: goal.y }];
  if (start < 0 || start >= n || target < 0 || target >= n) {
    return [{ x: goal.x, y: goal.y }];
  }

  const gScore = new Float64Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const open = new MinHeap();
  gScore[start] = 0;
  open.push({ idx: start, f: 0 });

  const heuristic = (idx: number): number => {
    const c = idx % w.cols;
    const r = Math.floor(idx / w.cols);
    const dc = Math.abs(c - g.col);
    const dr = Math.abs(r - g.row);
    // Octile distance, admissible for 8-neighbour movement.
    return (dc + dr) + (Math.SQRT2 - 2) * Math.min(dc, dr);
  };

  let found = false;
  while (open.size > 0) {
    const cur = open.pop()!;
    if (closed[cur.idx] === 1) continue;
    if (cur.idx === target) {
      found = true;
      break;
    }
    closed[cur.idx] = 1;
    const cc = cur.idx % w.cols;
    const cr = Math.floor(cur.idx / w.cols);
    for (const [dc, dr, cost] of NEIGHBOURS) {
      const nc = cc + dc;
      const nr = cr + dr;
      if (nc < 0 || nr < 0 || nc >= w.cols || nr >= w.rows) continue;
      const ni = nr * w.cols + nc;
      if (!WALKABLE_TILES.has(w.tiles[ni] ?? 1) || closed[ni] === 1) continue;
      // Diagonal moves may not cut through two blocked orthogonal neighbours.
      if (dc !== 0 && dr !== 0) {
        const sideA = cr * w.cols + nc;
        const sideB = nr * w.cols + cc;
        if (!WALKABLE_TILES.has(w.tiles[sideA] ?? 1)
          || !WALKABLE_TILES.has(w.tiles[sideB] ?? 1)) continue;
      }
      const tentative = gScore[cur.idx]! + cost;
      if (tentative >= gScore[ni]!) continue;
      came[ni] = cur.idx;
      gScore[ni] = tentative;
      open.push({ idx: ni, f: tentative + heuristic(ni) });
    }
  }

  if (!found) return [{ x: goal.x, y: goal.y }];

  const cells: number[] = [];
  let at = target;
  while (at !== -1 && at !== start) {
    cells.push(at);
    at = came[at]!;
  }
  cells.reverse();
  const path: Vec[] = cells.map((idx) => ({
    x: (idx % w.cols) * w.grid + w.grid / 2,
    y: Math.floor(idx / w.cols) * w.grid + w.grid / 2,
  }));
  if (path.length > 0) path[path.length - 1] = { x: goal.x, y: goal.y };
  else path.push({ x: goal.x, y: goal.y });
  return path;
}

/**
 * Grid visibility used by the next batch (projectiles / melee LOS). Blocks on
 * wall and void; samples every half tile so a thin wall cannot be tunnelled.
 */
export function lineOfSight(w: World, from: Vec, to: Vec): boolean {
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(d / (w.grid / 2)));
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    if (blocks(w, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t)) {
      return false;
    }
  }
  return true;
}
