// 路线规划：**在真实地图上走过去**的共享实现（`playthrough-worldmap` / `playthrough-monster-skill`）。
//
// 为什么脚本要自己算路线：引擎只能点**屏幕内**的地面，目标在屏幕外就点不到；而这张图
// （840×544 格 = 26880×17408px）里两点之间常常隔着十几堵墙。朝目标方向点屏幕边缘的落点
// 会反复吸附到同一处墙后死角 → `findPath()` 拿不到路就退回直线 → 玩家贴着墙原地打转
// （实测 160 轮、累计走 39.5k px，人还在出生点 660px 内）。
//
// 所以：读**打包进仓库的**地图源自己 BFS，点位全部落在可走格上 —— 这样被验的是
// "引擎能不能走通"，而不是"脚本猜方向准不准"。
//
// 拉直（string pulling）是必须的：噪声地块上的最短路有上百个转折且频繁横跳
// （A→B→A），"屏幕内最远的路点"会时不时落在刚走过的那条腿上 → 原地绕圈。
// 拉直之后每一段都是**身体能直线走过去的**（按 `BODY_RADIUS` 采样视线），推进单调。

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GRID = 32;
/** 与 `assets/combat/world.ts::BODY_RADIUS` 一致：拉直按"身体过不过得去"判。 */
export const BODY_RADIUS = 10;

/** play 脚本可能被 harness 从别处 import，两种解析都试一次。 */
function projectRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const up = path.resolve(here, '..', '..');
  const probe = path.join('assets', 'resource', 'maps', 'arena.ldtk');
  return existsSync(path.join(up, probe)) ? up : process.cwd();
}

/**
 * 读地图源的 Terrain IntGrid：0 地 / 1 墙 / 2 铺装 / 3 虚空，可走 = 0 和 2
 * —— 与 `assets/combat/world.ts` 的 `WALKABLE_TILES` 同一个判据。
 */
export function loadTerrain() {
  const file = path.join(projectRoot(), 'assets', 'resource', 'maps', 'arena.ldtk');
  const level = JSON.parse(readFileSync(file, 'utf8')).levels[0];
  const layer = level.layerInstances.find((l) => l.__identifier === 'Terrain');
  return {
    cols: Math.round(level.pxWid / GRID),
    rows: Math.round(level.pxHei / GRID),
    tiles: Uint8Array.from(layer.intGridCsv),
  };
}

export function walkableAt(m, col, row) {
  if (col < 0 || row < 0 || col >= m.cols || row >= m.rows) return false;
  const v = m.tiles[row * m.cols + col];
  return v === 0 || v === 2;
}

/** 离 (col,row) 最近的可走格（目的地可能正好落在墙 / 廊柱 / 怪身上）。 */
export function nearestWalkable(m, col, row) {
  for (let ring = 0; ring <= 8; ring += 1) {
    for (let dc = -ring; dc <= ring; dc += 1) {
      for (let dr = -ring; dr <= ring; dr += 1) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== ring) continue;
        if (walkableAt(m, col + dc, row + dr)) return { col: col + dc, row: row + dr };
      }
    }
  }
  return null;
}

/** 世界像素 → 格。 */
export const cellOfPoint = (p) => ({ col: Math.floor(p.x / GRID), row: Math.floor(p.y / GRID) });

/** 格 → 世界像素（格中心）。 */
const cellPoint = (m, idx) => {
  const col = idx % m.cols;
  const row = (idx - col) / m.cols;
  return { x: col * GRID + GRID / 2, y: row * GRID + GRID / 2 };
};

/** 8 邻接 BFS（禁切角），返回格序号数组；不连通返回 null。 */
export function routeCells(m, from, to) {
  const n = m.cols * m.rows;
  const came = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const start = from.row * m.cols + from.col;
  const goal = to.row * m.cols + to.col;
  if (!walkableAt(m, from.col, from.row) || !walkableAt(m, to.col, to.row)) return null;
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  came[start] = start;
  while (head < tail) {
    const cur = queue[head++];
    if (cur === goal) break;
    const c = cur % m.cols;
    const r = (cur - c) / m.cols;
    for (let dc = -1; dc <= 1; dc += 1) {
      for (let dr = -1; dr <= 1; dr += 1) {
        if (dc === 0 && dr === 0) continue;
        const nc = c + dc;
        const nr = r + dr;
        if (!walkableAt(m, nc, nr)) continue;
        // 禁切角：斜着走要求两个正交邻格都能站，否则会从墙角"挤过去"。
        if (dc !== 0 && dr !== 0 && !(walkableAt(m, c + dc, r) && walkableAt(m, c, r + dr))) continue;
        const ni = nr * m.cols + nc;
        if (came[ni] !== -1) continue;
        came[ni] = cur;
        queue[tail++] = ni;
      }
    }
  }
  if (came[goal] === -1) return null;
  const cells = [];
  for (let i = goal; i !== start; i = came[i]) cells.push(i);
  cells.push(start);
  return cells.reverse();
}

/** 与 `world.ts` 的 `canStandAt` 同判据：中心 + 四向 radius 都站得住。 */
export function standsAt(m, x, y, radius) {
  const c = Math.floor(x / GRID);
  const r = Math.floor(y / GRID);
  return walkableAt(m, c, r)
    && walkableAt(m, Math.floor((x - radius) / GRID), r)
    && walkableAt(m, Math.floor((x + radius) / GRID), r)
    && walkableAt(m, c, Math.floor((y - radius) / GRID))
    && walkableAt(m, c, Math.floor((y + radius) / GRID));
}

/** 这条直线一个半径 radius 的身体能不能一路站过去（8px 采样）。 */
export function clearLine(m, a, b, radius = BODY_RADIUS) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(len / 8));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    if (!standsAt(m, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, radius)) return false;
  }
  return true;
}

/** 拉直：把一格一拐的锯齿路压成几段长直线。 */
export function simplify(m, points, radius = BODY_RADIUS, window = 60) {
  const out = [points[0]];
  let i = 0;
  while (i < points.length - 1) {
    let j = Math.min(i + window, points.length - 1);
    for (; j > i + 1; j -= 1) {
      if (clearLine(m, points[i], points[j], radius)) break;
    }
    out.push(points[j]);
    i = j;
  }
  return out;
}

/**
 * 从 `from` 世界坐标走到 `to` 世界坐标的拉直路线（世界像素点列，含起点）。
 * 不连通 / 起终点不可站时返回 null。
 */
export function planRoute(m, from, to) {
  const a = nearestWalkable(m, cellOfPoint(from).col, cellOfPoint(from).row);
  const b = nearestWalkable(m, cellOfPoint(to).col, cellOfPoint(to).row);
  if (a === null || b === null) return null;
  const cells = routeCells(m, a, b);
  if (cells === null) return null;
  const points = simplify(m, cells.map((idx) => cellPoint(m, idx)));
  return {
    points,
    length: points.reduce((sum, p, i) => (
      i === 0 ? 0 : sum + Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y)
    ), 0),
  };
}

/**
 * 沿路线走一步：返回**这一次该点的世界坐标**，以及推进后的路点下标。
 *
 * 每轮只点"这一段直线上往前 `reach` 的那一点"——拉直保证了这一段直线身体过得去，
 * 所以点它一定走得动，方向也一定朝前（不会回头绕圈）。
 */
export function stepAlong(route, cursor, player, reach = 380) {
  let i = Math.max(1, cursor);
  const points = route.points;
  // 走到当前路点 90px 内就翻页。
  while (i < points.length - 1 && Math.hypot(points[i].x - player.x, points[i].y - player.y) < 90) i += 1;
  const t = points[i];
  const dx = t.x - player.x;
  const dy = t.y - player.y;
  const d = Math.hypot(dx, dy) || 1;
  const step = Math.min(d, reach);
  return {
    click: { x: player.x + (dx / d) * step, y: player.y + (dy / d) * step },
    cursor: i,
    arrived: i >= points.length - 1 && d < 90,
  };
}
