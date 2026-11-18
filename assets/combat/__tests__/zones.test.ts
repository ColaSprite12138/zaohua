/**
 * 分区契约（设计文档 11：不规则地块、环形动线、每对相邻区两条通道、正中宝库、大地图）。
 *
 * 2026-11-18 第二轮：地图扩到 **840×544（26880×17408）**，四块地块各外移 120 格，
 * 正中新增第五区 `vault`（宝库，全图唯一的高价值战利品区，四区各有一条支线）。
 * 分区从"矩形铺满"改成"不规则地块 + 逐格光栅"。护栏有七层：
 *
 * 1. **尺寸与穿越目标**：从出生点走到最远点 ≥140 秒纯移动（走速 205px/s）。
 *    旧图实测 50 秒（用户原话"差不多一分钟就能走完"），要求是 2.5–3 分钟。
 * 2. **归属光栅自洽**：`zoneGrid` 行数 / 行长正确，字符合法，区外是 `.`。
 * 3. **每对相邻区 ≥2 条口子**（绕后 / 甩追 / 换路线的前提），**通往宝库各 ≥1 条**。
 *    口子按"跨区过渡边的连通分量"数，一条走廊正好一段 —— 不按矩形边扫。
 * 4. **每区都有内容**：至少一扇门、一只怪、一个可破坏物、一个事件点。
 * 5. **环形是通的**：从出生点能靠两条腿走到每个区（不是靠传送）。
 * 6. **没分区的图不能崩**：自动验收夹具没有 zones / zoneGrid，查询一律 null / 空。
 */

import { describe, expect, it } from 'vitest';
import { arena } from '../../resource/maps/arena.generated.ts';
import { testArena } from '../../resource/maps/arena-test.ts';
import { zoneAt, zoneIndexAt, zoneLinks, zoneRect, zonesOf } from '../zones.ts';
import { makeWorld, walkable, type ArenaMap } from '../world.ts';

/** 生成器 / import_map 的放行集合：0 地面、2 铺装。 */
const WALKABLE = new Set([0, 2]);

function walkableCell(map: ArenaMap, c: number, r: number): boolean {
  if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) return false;
  const line = map.terrain[r];
  if (line === undefined) return false;
  return WALKABLE.has(Number(line[c]));
}

/** 从某格出发的 4 邻接 BFS，返回每格步数（扁平数组，-1 = 不可达）。 */
function bfs(map: ArenaMap, start: { col: number; row: number }): Int32Array {
  const dist = new Int32Array(map.cols * map.rows).fill(-1);
  const queue = new Int32Array(map.cols * map.rows);
  let head = 0;
  let tail = 0;
  const s = start.row * map.cols + start.col;
  dist[s] = 0;
  queue[tail] = s;
  tail += 1;
  while (head < tail) {
    const idx = queue[head]!;
    head += 1;
    const c = idx % map.cols;
    const r = Math.floor(idx / map.cols);
    const d = dist[idx]!;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nc = c + dc;
      const nr = r + dr;
      if (!walkableCell(map, nc, nr)) continue;
      const ni = nr * map.cols + nc;
      if (dist[ni] >= 0) continue;
      dist[ni] = d + 1;
      queue[tail] = ni;
      tail += 1;
    }
  }
  return dist;
}

describe('分区表（arena.generated 的 zones / zoneGrid）', () => {
  it('五区、id 唯一、名字非空、包围盒不重叠', () => {
    const zones = arena.zones;
    expect(zones).toHaveLength(5);
    expect(new Set(zones.map((z) => z.id)).size).toBe(5);
    for (const zone of zones) {
      expect(zone.name.length).toBeGreaterThan(0);
      expect(zone.cols).toBeGreaterThan(0);
      expect(zone.rows).toBeGreaterThan(0);
    }
    expect(zones.map((z) => z.id)).toEqual(['court', 'corridor', 'cavern', 'wateryard', 'vault']);
    for (let i = 0; i < zones.length; i += 1) {
      for (let j = i + 1; j < zones.length; j += 1) {
        const a = zones[i]!;
        const b = zones[j]!;
        const overlap = a.col < b.col + b.cols && b.col < a.col + a.cols
          && a.row < b.row + b.rows && b.row < a.row + a.rows;
        expect(overlap, `${a.name} 与 ${b.name} 的包围盒不该重叠`).toBe(false);
      }
    }
  });

  it('世界尺寸是 840×544（26880×17408px，四区外移 120 格给宝库腾位置）', () => {
    expect(arena.cols).toBe(840);
    expect(arena.rows).toBe(544);
    expect(arena.pxWid).toBe(840 * 32);
    expect(arena.pxHei).toBe(544 * 32);
  });

  it('归属光栅：行数 / 行长正确，字符只有 `.` 与 0–4', () => {
    const grid = arena.zoneGrid;
    expect(grid).toBeDefined();
    expect(grid!.length).toBe(arena.rows);
    for (let r = 0; r < arena.rows; r += 1) {
      const line = grid![r]!;
      expect(line.length, `第 ${r} 行长度`).toBe(arena.cols);
      expect(/^[.0-4]+$/.test(line), `第 ${r} 行有非法字符`).toBe(true);
    }
    // 区外（VOID）没有归属：四条边至少各有一片"无主"的格子。
    expect(grid![0]!.includes('.')).toBe(true);
    expect(grid![arena.rows - 1]!.includes('.')).toBe(true);
  });

  it('每对相邻区至少两条口子，通往宝库至少一条（设计 11 的硬要求）', () => {
    const world = makeWorld(arena);
    const links = zoneLinks(arena, world);
    // 环形动线的四对相邻区
    for (const key of ['cavern|wateryard', 'corridor|cavern', 'court|corridor', 'court|wateryard']) {
      expect(links[key], `${key} 的口子数`).toBeGreaterThanOrEqual(2);
    }
    // 宝库是这一版新增的战利品中心：四个区各必须有一条支线（不然进不去）
    for (const key of ['cavern|vault', 'corridor|vault', 'court|vault', 'wateryard|vault']) {
      expect(links[key], `${key} 的口子数`).toBeGreaterThanOrEqual(1);
    }
    // 四条走廊 ×2 不可能出现"六七个口子"：那说明分区边界在走廊里来回锯齿。
    for (const [key, count] of Object.entries(links)) {
      expect(count, `${key} 口子太多，边界可能锯齿`).toBeLessThanOrEqual(6);
    }
  });

  it('每区都有门 / 怪 / 可破坏物 / 事件点（走到那里得有东西可做）', () => {
    for (const zone of arena.zones) {
      const hit = (x: number, y: number) => zoneAt(arena, x, y)?.id === zone.id;
      expect(arena.portals?.some((p) => hit(p.x, p.y)), `${zone.name} 缺传送门`).toBe(true);
      expect(arena.monsters.some((m) => hit(m.x, m.y)), `${zone.name} 缺怪`).toBe(true);
      expect(arena.destructibles?.some((d) => hit(d.x, d.y)), `${zone.name} 缺可破坏物`).toBe(true);
      expect(arena.eventSites?.some((e) => hit(e.x, e.y)), `${zone.name} 缺事件点`).toBe(true);
    }
  });

  it('环形是通的：从出生点能走到每个区（包围盒中心附近的可走格）', () => {
    const world = makeWorld(arena);
    const dist = bfs(arena, { col: arena.spawn.col, row: arena.spawn.row });
    for (const zone of arena.zones) {
      const r = zoneRect(zone, world.grid);
      const c0 = Math.floor((r.x + r.w / 2) / world.grid);
      const row0 = Math.floor((r.y + r.h / 2) / world.grid);
      let reached = false;
      for (let dr = -14; dr <= 14 && !reached; dr += 1) {
        for (let dc = -14; dc <= 14 && !reached; dc += 1) {
          const c = c0 + dc;
          const row = row0 + dr;
          if (dist[row * arena.cols + c] >= 0) reached = true;
        }
      }
      expect(reached, `${zone.name} 从出生点走不到`).toBe(true);
    }
    expect(zoneAt(arena, arena.spawn.x, arena.spawn.y)?.id).toBe('court');
  });

  it('穿越时间：从出生点到最远点 ≥140 秒纯移动（设计 11：2.5–3 分钟）', () => {
    const dist = bfs(arena, { col: arena.spawn.col, row: arena.spawn.row });
    let far = 0;
    for (let i = 0; i < dist.length; i += 1) {
      if (dist[i]! > far) far = dist[i]!;
    }
    const seconds = (far * arena.gridSize) / 205;   // 走速 205px/s（movement.ts）
    expect(seconds, `最远 ${far} 格 = ${seconds.toFixed(0)} 秒；旧图 50 秒，要求 150–180`)
      .toBeGreaterThanOrEqual(140);
  });

  it('世界像素 → 分区的查询：图外与虚空返回 null', () => {
    expect(zoneAt(arena, -100, 100)).toBeNull();
    expect(zoneAt(arena, arena.pxWid + 10, 100)).toBeNull();
    expect(zoneIndexAt(arena, -1, 5)).toBe(-1);
    // 地块之外是 VOID，没有归属
    expect(zoneIndexAt(arena, 10, 10)).toBe(-1);
  });
});

describe('没有分区的图（自动验收夹具）', () => {
  it('zonesOf 是空数组，zoneAt 恒为 null，不抛错', () => {
    expect(zonesOf(testArena)).toEqual([]);
    expect(zoneAt(testArena, 400, 470)).toBeNull();
    const world = makeWorld(testArena);
    expect(zoneLinks(testArena, world)).toEqual({});
    // 夹具本身仍然完全可走（22 行 = 704px，正好塞进 720 的视口）
    expect(walkable(world, 400, 470)).toBe(true);
  });
});
