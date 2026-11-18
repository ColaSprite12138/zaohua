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
  /**
   * 装饰层：从 LDtk 的 Props 图层导出（院墙段 / 香炉 / 高台）。纯视觉，不参与碰撞。
   * 只有 LDtk 地图带这个字段；`arena-test.ts` 夹具没有，绘制层必须容忍 undefined。
   */
  readonly props?: readonly {
    readonly kind: string;
    readonly col: number;
    readonly row: number;
  }[];
  readonly monsters: readonly {
    readonly monsterId: string;
    readonly col: number;
    readonly row: number;
    readonly x: number;
    readonly y: number;
    readonly wave: number;
  }[];
  /**
   * 撤离传送门：**地图的一部分**，位置由 LDtk 的 Entities 层决定（编辑器里可拖动）。
   * 只有 LDtk 地图带这个字段；`arena-test.ts` 夹具没有 → `createPortals()` 回退到
   * 环带布点，所以自动验收仍能在夹具上走到门。
   */
  readonly portals?: readonly {
    readonly id: string;
    readonly col: number;
    readonly row: number;
    readonly x: number;
    readonly y: number;
  }[];
  /**
   * 可破坏物（设计 10.5）：位置同样是**地图的一部分**（LDtk 的 `Destructible`
   * 实体，编辑器里可拖动），`kind` 对应 `destructible.xlsx` 的行。
   * 没有这个字段的地图（夹具 / 旧图）就是「一张没有容器的图」，不是错误。
   */
  readonly destructibles?: readonly {
    readonly id: string;
    readonly kind: string;
    readonly col: number;
    readonly row: number;
    readonly x: number;
    readonly y: number;
  }[];
  /**
   * 分区（设计 11）：四块**不规则地块**，**每两个相邻区之间两条以上通道**。
   * 这里的矩形只是**包围盒**（大地图标签位置、粗筛）；真实形状是下面 `zoneGrid`
   * 逐格光栅。由 `arena_layout.py` 定义、`import_map.py` 导出并校验，运行时只有
   * 这一份权威：HUD 区域名、大地图、验收都读它。
   * 没有这个字段的地图（自动验收夹具）就是「一张没分区的图」。
   */
  readonly zones?: readonly {
    readonly id: string;
    readonly name: string;
    readonly col: number;
    readonly row: number;
    readonly cols: number;
    readonly rows: number;
  }[];
  /**
   * 逐格分区归属：每行 `cols` 个字符，`.` = 不属于任何区（崖 / 深林 / 区外走廊），
   * `0`–`9` = `zones` 里的下标。**这是真实形状** —— 四块地块不铺满地图。
   */
  readonly zoneGrid?: readonly string[];
  /**
   * 单局事件点（设计 10.2）：7–8 分钟的高价值物刷在这里。
   * 由 LDtk 的 `EventSite` 实体决定；没有就是「这张图不开事件」。
   */
  readonly eventSites?: readonly {
    readonly id: string;
    readonly col: number;
    readonly row: number;
    readonly x: number;
    readonly y: number;
  }[];
}

export interface World {
  readonly map: ArenaMap;
  readonly tiles: Uint8Array;
  readonly cols: number;
  readonly rows: number;
  readonly grid: number;
  /**
   * A* 的**复用缓冲**。地图 720×448 = 322560 格，每次点击都 `new Float64Array(n)`
   * 再 `fill(Infinity)` 是 2.6MB 分配 + 32 万次写 —— 玩家连点几次就能感到卡顿
   * （而且 GC 抖动比单次耗时更明显）。改成"一次分配 + 世代标记"，每次搜索只
   * 摸到真正访问过的格子。
   */
  readonly scratch: PathScratch;
}

export interface PathScratch {
  readonly g: Float64Array;
  readonly came: Int32Array;
  /** 每格的状态：`gen*4 + 1` 在开表里、`+2` 已关闭、其余 = 上次搜索的残留。 */
  readonly state: Uint32Array;
  gen: number;
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
  const n = map.cols * map.rows;
  return {
    map,
    tiles,
    cols: map.cols,
    rows: map.rows,
    grid: map.gridSize,
    scratch: {
      g: new Float64Array(n),
      came: new Int32Array(n),
      state: new Uint32Array(n),
      gen: 0,
    },
  };
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

/** 人物 / 怪物的默认碰撞半径（世界像素）。寻路拉直和移动共用这一个数。 */
export const BODY_RADIUS = 10;

/**
 * 一个身体能不能站在这里：中心 + 四个方向 `radius` 处都可走。
 *
 * 玩家和怪物共用这一份 —— 以前两边各写一份（玩家查四向，怪物只查左右），
 * 于是同样的墙对两种身体有不同答案，路径拉直时还会互相矛盾。
 */
export function canStandAt(w: World, x: number, y: number, radius: number): boolean {
  if (!walkable(w, x, y)) return false;
  if (radius <= 0) return true;
  return walkable(w, x - radius, y)
    && walkable(w, x + radius, y)
    && walkable(w, x, y - radius)
    && walkable(w, x, y + radius);
}

/**
 * 沿线段采样，检查一个半径 `radius` 的身体能不能一路站过去。
 * 每半格采一次：薄墙钻不过去，也不会因为采样太密把路径拉直算成天价。
 */
export function clearWalk(w: World, from: Vec, to: Vec, radius: number): boolean {
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(d / (w.grid / 2)));
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    if (!canStandAt(w, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, radius)) {
      return false;
    }
  }
  return true;
}

/**
 * 把 A* 的格子折线**拉直成任意角度的线段**（string pulling）。
 *
 * 为什么要这一步：A* 跑在格子图上、8 邻接，返回的每个点都是**格中心**，
 * 所以不管玩家点哪，实际轨迹只能是 0°/45°/90° 这八个方向 —— 这就是
 * 「人物移动只有八方向、玩法不灵活」的真正原因（和朝向渲染无关）。
 *
 * 做法：从当前位置贪心找**最远的、可以直线走过去的**路径点，跳掉中间那些
 * 只为绕过拐角而存在的格子中心。地图空旷时路径会塌成一段直线，走路方向
 * 就是玩家点的那个角度；绕柱子时只在真正需要的拐点转弯。
 *
 * 注意：这里只改「怎么走」，不改「能不能走」—— 可达性仍然由 A* 判定，
 * 拉直只在 A* 已经证明可达的走廊里取捷径，所以不会把怪引到墙里。
 */
export function straightenPath(
  w: World,
  from: Vec,
  points: readonly Vec[],
  radius: number,
): Vec[] {
  if (points.length <= 1) return [...points];
  const out: Vec[] = [];
  let cur = from;
  let i = 0;
  while (i < points.length) {
    // 从最远的点往回试：能直达就跳过去，跳不过就退到次远的。
    let best = i;
    for (let j = points.length - 1; j > i; j -= 1) {
      const target = points[j]!;
      if (clearWalk(w, cur, target, radius)) {
        best = j;
        break;
      }
    }
    const next = points[best]!;
    out.push(next);
    cur = next;
    i = best + 1;
  }
  return out;
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
 *
 * **返回前会拉直**（`straightenPath`）：A* 的折线本身只有八个方向，直接交给
 * 移动层就是「八方向移动」。拉直之后每一段都是任意角度，玩家点哪就走哪。
 * `radius` 是这个身体的实际碰撞半径 —— 拉直必须用它判"这条直线过不过得去"，
 * 用 0 会切到墙角上。
 */
export function findPath(w: World, from: Vec, to: Vec, radius = 10): Vec[] {
  const goal = nearestWalkable(w, to.x, to.y);
  const startPoint = walkable(w, from.x, from.y)
    ? from
    : nearestWalkable(w, from.x, from.y);
  const s = cellOf(w, startPoint.x, startPoint.y);
  const g = cellOf(w, goal.x, goal.y);
  const start = s.row * w.cols + s.col;
  const target = g.row * w.cols + g.col;
  const n = w.cols * w.rows;
  if (start === target) return [{ x: goal.x, y: goal.y }];
  if (start < 0 || start >= n || target < 0 || target >= n) {
    return [{ x: goal.x, y: goal.y }];
  }

  // 复用缓冲 + 世代标记：不清空数组，只把"这一代"的标记写进去。
  const scratch = w.scratch;
  if (scratch.gen >= 0x3FFFFFFF) {
    scratch.state.fill(0);
    scratch.gen = 0;
  }
  scratch.gen += 1;
  const tag = scratch.gen * 4;
  const gScore = scratch.g;
  const came = scratch.came;
  const state = scratch.state;
  const open = new MinHeap();
  gScore[start] = 0;
  came[start] = -1;
  state[start] = tag + 1;
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
    if (state[cur.idx] === tag + 2) continue;
    if (cur.idx === target) {
      found = true;
      break;
    }
    state[cur.idx] = tag + 2;
    const cc = cur.idx % w.cols;
    const cr = Math.floor(cur.idx / w.cols);
    for (const [dc, dr, cost] of NEIGHBOURS) {
      const nc = cc + dc;
      const nr = cr + dr;
      if (nc < 0 || nr < 0 || nc >= w.cols || nr >= w.rows) continue;
      const ni = nr * w.cols + nc;
      if (!WALKABLE_TILES.has(w.tiles[ni] ?? 1) || state[ni] === tag + 2) continue;
      // Diagonal moves may not cut through two blocked orthogonal neighbours.
      if (dc !== 0 && dr !== 0) {
        const sideA = cr * w.cols + nc;
        const sideB = nr * w.cols + cc;
        if (!WALKABLE_TILES.has(w.tiles[sideA] ?? 1)
          || !WALKABLE_TILES.has(w.tiles[sideB] ?? 1)) continue;
      }
      const tentative = gScore[cur.idx]! + cost;
      if (state[ni] === tag + 1 && tentative >= gScore[ni]!) continue;
      came[ni] = cur.idx;
      gScore[ni] = tentative;
      state[ni] = tag + 1;
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
  // 格子折线 → 任意角度的线段。没有这一步就是"八方向移动"。
  return straightenPath(w, startPoint, path, radius);
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
