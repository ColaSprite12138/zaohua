/**
 * 分区（设计文档 11：四块不规则地块 + 环形动线）。
 *
 * 2026-11-18 重做：分区**不再是矩形铺满**。每区是一块不规则地块（有半岛、凹湾、
 * 磨掉的角），区外是 VOID（崖 / 深林），区与区之间只靠走廊连通。
 * 所以归属查的是**逐格光栅** `ArenaMap.zoneGrid`，`zones` 里的矩形只是包围盒
 * （大地图标签压在这里）。
 *
 * 数据来自 `arena_layout.py`（唯一手写布局）→ `import_map.py` 导出。
 * 这个文件只做**查询**，不写死任何坐标 —— 改图不用改这里。
 *
 * 用途：HUD 的区域名、大地图的色块与标签、验收脚本判断「玩家现在在哪个区」、
 * 护栏「每对相邻区 ≥2 条通道」。
 */

import { walkable, type ArenaMap, type World } from './world.ts';

export interface ArenaZone {
  readonly id: string;
  readonly name: string;
  /** **包围盒**（格坐标）：真实形状见 `zoneGrid`，这里只用于标签位置与粗筛。 */
  readonly col: number;
  readonly row: number;
  readonly cols: number;
  readonly rows: number;
}

/** 地图的分区表；没分区的图（自动验收夹具）返回空数组。 */
export function zonesOf(map: ArenaMap): readonly ArenaZone[] {
  return map.zones ?? [];
}

/**
 * 一格属于哪个区（下标，-1 = 不属于任何区）。
 *
 * 有 `zoneGrid` 就查光栅（O(1)）；没有（夹具 / 旧图）就退回归属矩形 ——
 * 老地图的矩形是铺满的，两种读法在那张图上等价。
 */
export function zoneIndexAt(map: ArenaMap, col: number, row: number): number {
  if (col < 0 || row < 0 || col >= map.cols || row >= map.rows) return -1;
  const grid = map.zoneGrid;
  if (grid !== undefined) {
    const line = grid[row];
    if (line === undefined) return -1;
    const ch = line[col];
    if (ch === undefined || ch === '.') return -1;
    const index = ch.charCodeAt(0) - 48;
    return index >= 0 && index < zonesOf(map).length ? index : -1;
  }
  const zones = zonesOf(map);
  for (let i = 0; i < zones.length; i += 1) {
    const zone = zones[i]!;
    if (col >= zone.col && col < zone.col + zone.cols
      && row >= zone.row && row < zone.row + zone.rows) {
      return i;
    }
  }
  return -1;
}

/** 世界像素 → 所在分区。图外 / 没分区时为 null。 */
export function zoneAt(map: ArenaMap, x: number, y: number): ArenaZone | null {
  const index = zoneIndexAt(map, Math.floor(x / map.gridSize), Math.floor(y / map.gridSize));
  return index < 0 ? null : zonesOf(map)[index] ?? null;
}

/**
 * 数**每对相邻区之间的通道条数**。
 *
 * 定义：两格都走得到、分属不同区 → 一条"过渡边"；共享格子的过渡边属于同一个
 * 口子（并查集聚类）。一条走廊在它的横截面上正好一段，所以每个数 = 一条通道。
 *
 * 设计 11 要求每对相邻区 ≥2 条（绕后 / 甩追 / 换路线全靠它）。
 * 构建期 `arena_layout.verify()` 另有一份基于 `CORRIDORS` 声明的检查，
 * 两份独立算 —— 改坏一份另一份会红。
 *
 * 键是 `"a|b"`，a、b 是分区表中下标较小的 / 较大的 id。
 */
export function zoneLinks(map: ArenaMap, world: World): Record<string, number> {
  const zones = zonesOf(map);
  if (zones.length === 0) return {};
  const zoneOf = (c: number, r: number): number => (
    c < 0 || r < 0 || c >= world.cols || r >= world.rows
      ? -1
      : zoneIndexAt(map, c, r)
  );
  const walkAt = (c: number, r: number): boolean => (
    c >= 0 && r >= 0 && c < world.cols && r < world.rows
      && walkable(world, c * world.grid + world.grid / 2, r * world.grid + world.grid / 2)
  );

  // 过渡边：(格 A, 格 B, 区对键)。只扫东 / 南两个方向，避免每条边数两遍。
  const edges: { a: number; b: number; pair: number }[] = [];
  const pairIds = new Map<number, number>();
  for (let r = 0; r < world.rows; r += 1) {
    for (let c = 0; c < world.cols; c += 1) {
      if (!walkAt(c, r)) continue;
      const here = zoneOf(c, r);
      if (here < 0) continue;
      for (const [dc, dr] of [[1, 0], [0, 1]] as const) {
        const nc = c + dc;
        const nr = r + dr;
        if (!walkAt(nc, nr)) continue;
        const there = zoneOf(nc, nr);
        if (there < 0 || there === here) continue;
        const lo = Math.min(here, there);
        const hi = Math.max(here, there);
        const key = lo * 100 + hi;
        let pair = pairIds.get(key);
        if (pair === undefined) {
          pair = pairIds.size;
          pairIds.set(key, pair);
        }
        edges.push({ a: r * world.cols + c, b: nr * world.cols + nc, pair });
      }
    }
  }

  // 并查集：共享格子的过渡边属于同一个口子。
  const parent = new Array<number>(edges.length);
  for (let i = 0; i < edges.length; i += 1) parent[i] = i;
  const find = (x: number): number => {
    let i = x;
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (x: number, y: number): void => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent[rx] = ry;
  };
  const byCell = new Map<number, number[]>();
  for (let i = 0; i < edges.length; i += 1) {
    for (const cell of [edges[i]!.a, edges[i]!.b]) {
      const list = byCell.get(cell);
      if (list === undefined) byCell.set(cell, [i]);
      else list.push(i);
    }
  }
  // 同一个口子的边**并不共享格子**：走廊横截面上那一排是 ((c,r),(c+1,r))、
  // ((c,r+1),(c+1,r+1))…，两两不共格，只是端点在区内相邻。所以按"端点相邻"
  // 合并 —— 只按共格合并会把一条走廊拆成 7 个"口子"（第一版就是这么错的）。
  const cols = world.cols;
  for (let i = 0; i < edges.length; i += 1) {
    for (const cell of [edges[i]!.a, edges[i]!.b]) {
      const c = cell % cols;
      const r = Math.floor(cell / cols);
      const around = [cell - cols, cell + cols];
      if (c > 0) around.push(cell - 1);
      if (c < cols - 1) around.push(cell + 1);
      for (const other of around) {
        if (other < 0 || other >= cols * world.rows) continue;
        for (const j of byCell.get(other) ?? []) union(i, j);
      }
      for (const j of byCell.get(cell) ?? []) union(i, j);
      void r;
    }
  }

  const out: Record<string, number> = {};
  // 按 pair 汇总（键来自原始分区下标：小区在前，和大图上的顺序一致）。
  const pairToKey = new Map<number, string>();
  for (const [key, pair] of pairIds) {
    const lo = Math.floor(key / 100);
    const hi = key % 100;
    pairToKey.set(pair, `${zones[lo]!.id}|${zones[hi]!.id}`);
  }
  const roots = new Map<number, number>();   // root -> 该口子第一次出现的 pair
  for (let i = 0; i < edges.length; i += 1) {
    const root = find(i);
    if (roots.has(root)) continue;
    roots.set(root, edges[i]!.pair);
    const key = pairToKey.get(edges[i]!.pair)!;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** 分区的像素**包围盒**（大地图标签用）。真实形状请用 `zoneGrid` 上色。 */
export function zoneRect(
  zone: ArenaZone, grid: number,
): { x: number; y: number; w: number; h: number } {
  return {
    x: zone.col * grid,
    y: zone.row * grid,
    w: zone.cols * grid,
    h: zone.rows * grid,
  };
}
