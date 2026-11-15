/**
 * 分区契约（设计文档 11：环形四区、每区两条以上通道、需要大地图）。
 *
 * 这一批把地图从 128×96 扩成 **256×160（8192×5120px）四区环形**：
 * 院落(A) → 东廊(B) → 石窟(C) → 水榭(D) → 院落(A)，一局只走其中约 1/3。
 *
 * 护栏分五层，任何一层被改坏都应该红：
 * 1. **分区铺满且不重叠**：面积之和 == 地图面积，任何一个格子只属于一个区。
 * 2. **每区 ≥2 条出入通道**（绕后 / 甩追 / 换路线的前提）。
 * 3. **每区都有内容**：至少一扇门（否则走到那儿就没有出口）、一只怪、一个可破坏物、一个事件点。
 * 4. **环形是通的**：从出生点能走到每个区的中心（不是靠传送，是靠腿）。
 * 5. **没分区的图不能崩**：自动验收夹具没有 `zones`，查询一律返回 null / 空数组。
 */

import { describe, expect, it } from 'vitest';
import { arena } from '../../resource/maps/arena.generated.ts';
import { testArena } from '../../resource/maps/arena-test.ts';
import { zoneAt, zoneChannels, zoneRect, zonesOf } from '../zones.ts';
import { makeWorld, walkable, type ArenaMap } from '../world.ts';

/** 生成器 / import_map 的放行集合：0 地面、2 铺装。 */
const WALKABLE = new Set([0, 2]);

function walkableCell(map: ArenaMap, c: number, r: number): boolean {
  const line = map.terrain[r];
  if (line === undefined) return false;
  return WALKABLE.has(Number(line[c]));
}

/** 从某格出发能走到的全部格子（4 邻接）。 */
function reachable(map: ArenaMap, start: { col: number; row: number }): Set<string> {
  const seen = new Set<string>([`${start.col},${start.row}`]);
  const queue: { col: number; row: number }[] = [start];
  while (queue.length > 0) {
    const at = queue.pop()!;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const c = at.col + dc;
      const r = at.row + dr;
      const key = `${c},${r}`;
      if (seen.has(key) || !walkableCell(map, c, r)) continue;
      seen.add(key);
      queue.push({ col: c, row: r });
    }
  }
  return seen;
}

describe('分区表（arena.generated 的 zones）', () => {
  it('四区、id 唯一、名字非空', () => {
    const zones = arena.zones;
    expect(zones).toHaveLength(4);
    expect(new Set(zones.map((z) => z.id)).size).toBe(4);
    for (const zone of zones) {
      expect(zone.name.length).toBeGreaterThan(0);
      expect(zone.cols).toBeGreaterThan(0);
      expect(zone.rows).toBeGreaterThan(0);
    }
    expect(zones.map((z) => z.id)).toEqual(['court', 'corridor', 'cavern', 'wateryard']);
  });

  it('铺满且不重叠（面积之和 == 地图面积，每格只属于一个区）', () => {
    const area = arena.zones.reduce((n, z) => n + z.cols * z.rows, 0);
    expect(area).toBe(arena.cols * arena.rows);
    // 逐格抽查：每格恰好命中一个区（矩形不重叠的等价观察）
    for (const [c, r] of [[0, 0], [127, 95], [128, 96], [255, 159], [200, 40], [40, 120]]) {
      const hits = arena.zones.filter((z) => (
        c >= z.col && c < z.col + z.cols && r >= z.row && r < z.row + z.rows
      ));
      expect(hits, `(${c},${r}) 应恰好属于一个区`).toHaveLength(1);
    }
  });

  it('世界尺寸是扩容后的 256×160（8192×5120px）', () => {
    expect(arena.cols).toBe(256);
    expect(arena.rows).toBe(160);
    expect(arena.pxWid).toBe(256 * 32);
    expect(arena.pxHei).toBe(160 * 32);
  });

  it('每区至少两条出入通道（设计 11 的硬要求）', () => {
    const world = makeWorld(arena);
    const channels = zoneChannels(arena, world);
    for (const zone of arena.zones) {
      expect(channels[zone.id], `${zone.name} 通道数`).toBeGreaterThanOrEqual(2);
    }
  });

  it('每区都有门 / 怪 / 可破坏物 / 事件点（走到那里得有东西可做）', () => {
    const inZone = (id: string) => (x: number, y: number) => {
      const zone = zoneAt(arena, x, y);
      return zone?.id === id;
    };
    for (const zone of arena.zones) {
      const hit = inZone(zone.id);
      expect(arena.portals?.some((p) => hit(p.x, p.y)), `${zone.name} 缺传送门`).toBe(true);
      expect(arena.monsters.some((m) => hit(m.x, m.y)), `${zone.name} 缺怪`).toBe(true);
      expect(arena.destructibles?.some((d) => hit(d.x, d.y)), `${zone.name} 缺可破坏物`).toBe(true);
      expect(arena.eventSites?.some((e) => hit(e.x, e.y)), `${zone.name} 缺事件点`).toBe(true);
    }
  });

  it('环形是通的：从出生点靠两条腿能走到每个区的中心', () => {
    const world = makeWorld(arena);
    const seen = reachable(arena, { col: arena.spawn.col, row: arena.spawn.row });
    for (const zone of arena.zones) {
      const r = zoneRect(zone, world.grid);
      const c = Math.floor((r.x + r.w / 2) / world.grid);
      const row = Math.floor((r.y + r.h / 2) / world.grid);
      expect(seen.has(`${c},${row}`), `${zone.name} 中心 (${c},${row}) 走不到`).toBe(true);
    }
    // 出生点在院落（原图原位，人工编辑过的 (69,20) 也在这里）
    expect(zoneAt(arena, arena.spawn.x, arena.spawn.y)?.id).toBe('court');
  });

  it('世界像素 → 分区的查询对图外坐标返回 null', () => {
    expect(zoneAt(arena, -100, 100)).toBeNull();
    expect(zoneAt(arena, arena.pxWid + 10, 100)).toBeNull();
    expect(zoneAt(arena, 100, 100)?.id).toBe('court');
  });
});

describe('没有分区的图（自动验收夹具）', () => {
  it('zonesOf 是空数组，zoneAt 恒为 null，不抛错', () => {
    expect(zonesOf(testArena)).toEqual([]);
    expect(zoneAt(testArena, 400, 470)).toBeNull();
    const world = makeWorld(testArena);
    expect(zoneChannels(testArena, world)).toEqual({});
    // 夹具本身仍然完全可走（22 行 = 704px，正好塞进 720 的视口）
    expect(walkable(world, 400, 470)).toBe(true);
  });
});
