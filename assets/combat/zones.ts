/**
 * 分区（设计文档 11：环形四区）。
 *
 * 分区**是地图数据**：矩形由 `gen_arena_map.py::ZONES` 定义，`import_map.py` 导出到
 * `ArenaMap.zones` 并校验「铺满 / 不重叠 / 每区 ≥2 条通道 / 每区有门」。
 * 这个文件只做**查询**，不写死任何坐标 —— 扩图或挪墙都不用改这里。
 *
 * 用途：HUD 的区域名、大地图的区块与标签、验收脚本判断「玩家现在在哪个区」。
 */

import { walkable, type ArenaMap, type World } from './world.ts';

export interface ArenaZone {
  readonly id: string;
  readonly name: string;
  /** 矩形（**格**坐标，左上角 + 尺寸）。 */
  readonly col: number;
  readonly row: number;
  readonly cols: number;
  readonly rows: number;
}

/** 地图的分区表；没分区的图（自动验收夹具）返回空数组。 */
export function zonesOf(map: ArenaMap): readonly ArenaZone[] {
  return map.zones ?? [];
}

/** 世界像素 → 所在分区。图外 / 没分区时为 null。 */
export function zoneAt(map: ArenaMap, x: number, y: number): ArenaZone | null {
  const col = Math.floor(x / map.gridSize);
  const row = Math.floor(y / map.gridSize);
  for (const zone of zonesOf(map)) {
    if (col >= zone.col && col < zone.col + zone.cols
      && row >= zone.row && row < zone.row + zone.rows) {
      return zone;
    }
  }
  return null;
}

/**
 * 数每个分区的**出入通道**：边界格可走 **且** 区外那一格也可走，连续一段算一条。
 *
 * 设计 11 要求「每区 2 条以上出入通道」（绕后 / 甩追 / 换路线全靠它）。
 * 构建期 `import_map.py` 有一份同样的检查并会拦住不合规的图；这里是运行时的
 * 第二份实现（单测跑它），两份独立算，改坏一份另一份会红。
 */
export function zoneChannels(map: ArenaMap, world: World): Record<string, number> {
  const walkableAt = (c: number, r: number): boolean => (
    c >= 0 && r >= 0 && c < world.cols && r < world.rows
      && walkable(world, c * world.grid + world.grid / 2, r * world.grid + world.grid / 2)
  );
  const out: Record<string, number> = {};
  for (const zone of zonesOf(map)) {
    const c0 = zone.col;
    const r0 = zone.row;
    const c1 = c0 + zone.cols - 1;
    const r1 = r0 + zone.rows - 1;
    const sides: { c: number; r: number; oc: number; or: number }[][] = [[], [], [], []];
    for (let c = c0; c <= c1; c += 1) {
      sides[0]!.push({ c, r: r0, oc: c, or: r0 - 1 });      // 北
      sides[1]!.push({ c, r: r1, oc: c, or: r1 + 1 });      // 南
    }
    for (let r = r0; r <= r1; r += 1) {
      sides[2]!.push({ c: c0, r, oc: c0 - 1, or: r });      // 西
      sides[3]!.push({ c: c1, r, oc: c1 + 1, or: r });      // 东
    }
    let runs = 0;
    for (const side of sides) {
      let inRun = false;
      for (const cell of side) {
        const gap = walkableAt(cell.c, cell.r) && walkableAt(cell.oc, cell.or);
        if (gap && !inRun) runs += 1;
        inRun = gap;
      }
    }
    out[zone.id] = runs;
  }
  return out;
}

/** 分区的像素矩形（大地图直接按它画块）。 */
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
