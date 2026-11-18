#!/usr/bin/env python3
"""把布局画成 BMP + 打印量化指标（改地图时用眼睛和数字一起调）。

    python scripts/preview_map.py                 # out/map-terrain.bmp + out/map-zones.bmp
    python scripts/preview_map.py --no-bmp

指标口径（与设计 11 的验收一致）：
  - 可走率：每区 land 内可走格 / land 格（>72% 就是"平原"，<35% 就是"走廊游戏"）
  - 相邻区通道：跨区可走过渡的连续段数（每条走廊 1 段）
  - 东西横穿 / 最远点：BFS 最短路径长度（px），除 205px/s = 纯移动秒数
"""
from __future__ import annotations

import os
import struct
import sys
from collections import deque

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import arena_layout as L  # noqa: E402

OUT = os.path.join(os.path.dirname(HERE), 'out')
WALK = {L.FLOOR, L.PAVED}

COLORS = {
    L.VOID: (10, 14, 20),
    L.FLOOR: (74, 86, 94),
    L.WALL: (198, 208, 214),
    L.PAVED: (98, 134, 154),
}
ZONE_TINT = {
    'court': (120, 84, 40),
    'corridor': (40, 110, 84),
    'cavern': (96, 70, 120),
    'wateryard': (40, 86, 130),
    'vault': (130, 60, 60),
}


def write_bmp(path: str, pixels) -> None:
    h = len(pixels)
    w = len(pixels[0])
    row = (w * 3 + 3) & ~3
    pad = row - w * 3
    body = bytearray()
    for y in range(h - 1, -1, -1):
        for (r, g, b) in pixels[y]:
            body += bytes((b, g, r))
        body += b'\x00' * pad
    header = struct.pack('<2sIHHI', b'BM', 14 + 40 + len(body), 0, 0, 14 + 40)
    info = struct.pack('<IiiHHIIiiII', 40, w, h, 1, 24, 0, len(body), 2835, 2835, 0, 0)
    with open(path, 'wb') as fh:
        fh.write(header + info + bytes(body))


def render(g: L.Canvas, tinted: bool):
    rows = []
    for r in range(L.ROWS):
        line = []
        for c in range(L.COLS):
            rgb = COLORS[g.t[r][c]]
            if tinted and g.t[r][c] in WALK and g.zone[r][c] >= 0:
                name = L.ZONES[g.zone[r][c]][0]
                t = ZONE_TINT[name]
                rgb = tuple(min(255, int(rgb[i] * 0.55 + t[i] * 0.75)) for i in range(3))
            line.append(rgb)
        rows.append(line)
    return rows


def bfs_from(g: L.Canvas, starts):
    """多源 BFS（4 邻接），返回每个可走格的步数（-1 = 不可达）。"""
    n = L.COLS * L.ROWS
    dist = [-1] * n
    q = deque()
    for (c, r) in starts:
        idx = r * L.COLS + c
        if dist[idx] < 0:
            dist[idx] = 0
            q.append((c, r))
    while q:
        c, r = q.popleft()
        d = dist[r * L.COLS + c]
        for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nc, nr = c + dc, r + dr
            if not (0 <= nc < L.COLS and 0 <= nr < L.ROWS):
                continue
            ni = nr * L.COLS + nc
            if dist[ni] >= 0 or g.t[nr][nc] not in WALK:
                continue
            dist[ni] = d + 1
            q.append((nc, nr))
    return dist


def zone_links(g: L.Canvas) -> dict[str, int]:
    """数「口子」：相邻两个可走格属于不同区 → 一条边；共享格子的边属于同一个口子。

    （旧的实现按行/列各扫一遍再数连续段，同一条走廊会被算两次；
    这里按连通分量聚，一条走廊正好一段。）
    """
    edges: list[tuple[tuple[int, int], tuple[int, int], tuple[int, int]]] = []
    for r in range(L.ROWS):
        for c in range(L.COLS):
            if g.t[r][c] not in WALK:
                continue
            a = g.zone[r][c]
            if a < 0:
                continue
            for dc, dr in ((1, 0), (0, 1)):
                nc, nr = c + dc, r + dr
                if not (0 <= nc < L.COLS and 0 <= nr < L.ROWS):
                    continue
                if g.t[nr][nc] not in WALK:
                    continue
                b = g.zone[nr][nc]
                if b < 0 or b == a:
                    continue
                pair = tuple(sorted((a, b)))
                edges.append(((c, r), (nc, nr), pair))

    parent = list(range(len(edges)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x, y):
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[rx] = ry

    by_cell: dict[tuple[int, int], list[int]] = {}
    for i, (ca, cb, _p) in enumerate(edges):
        for cell in (ca, cb):
            by_cell.setdefault(cell, []).append(i)

    # 同一个口子的边**并不共享格子**：走廊横截面那一排是 ((c,r),(c+1,r))、
    # ((c,r+1),(c+1,r+1))…，两两不共格，只是端点在区内相邻。所以按「端点 4 邻接」
    # 合并 —— 只按共格合并会把一条走廊拆成 7 个"口子"（和 `zones.ts::zoneLinks`
    # 同一条规则，两边数出来的必须一致）。
    for i, (ca, cb, _p) in enumerate(edges):
        for c, r in (ca, cb):
            for other in ((c - 1, r), (c + 1, r), (c, r - 1), (c, r + 1), (c, r)):
                for j in by_cell.get(other, ()):
                    union(i, j)
    counts: dict[str, int] = {}
    seen: set[int] = set()
    for i, (_ca, _cb, pair) in enumerate(edges):
        root = find(i)
        if root in seen:
            continue
        seen.add(root)
        label = '%s|%s' % (L.ZONES[pair[0]][0], L.ZONES[pair[1]][0])
        counts[label] = counts.get(label, 0) + 1
    return counts


def measure(g: L.Canvas) -> list[str]:
    out = []
    walk_total = sum(1 for r in range(L.ROWS) for c in range(L.COLS)
                     if g.t[r][c] in WALK)
    land_total = sum(1 for r in range(L.ROWS) for c in range(L.COLS)
                     if g.land[r][c])
    out.append('地图 %dx%d 格 = %dx%d px' % (L.COLS, L.ROWS, L.COLS * L.GRID, L.ROWS * L.GRID))
    out.append('地块 %d 格，可走 %d 格（地块内可走率 %.1f%%）'
               % (land_total, walk_total, 100.0 * walk_total / max(1, land_total)))

    print_zone = []
    for zi, (zid, name, *_rest) in enumerate(L.ZONES):
        land = 0
        walk = 0
        for r in range(L.ROWS):
            for c in range(L.COLS):
                if g.land[r][c] and g.zone[r][c] == zi:
                    land += 1
                    if g.t[r][c] in WALK:
                        walk += 1
        pct = 100.0 * walk / max(1, land)
        flag = 'OK'
        if pct > 72:
            flag = '太开阔'
        elif pct < 35:
            flag = '太挤'
        print_zone.append('%s(%s) land %d 可走 %d = %.1f%% %s'
                          % (name, zid, land, walk, pct, flag))
    out.extend(print_zone)

    links = zone_links(g)
    out.append('相邻区口子：' + ', '.join('%s=%d' % (k, v) for k, v in sorted(links.items())))

    walk_cells = [(c, r) for r in range(L.ROWS) for c in range(L.COLS) if g.t[r][c] in WALK]
    left = [(c, r) for (c, r) in walk_cells if c < 60]
    right = [(c, r) for (c, r) in walk_cells if c > L.COLS - 60]
    if left and right:
        dist = bfs_from(g, left)
        best = min((dist[r * L.COLS + c] for (c, r) in right
                    if dist[r * L.COLS + c] >= 0), default=None)
        if best is not None:
            out.append('东西横穿最短 %d 格 = %d px = %.0f 秒'
                       % (best, best * L.GRID, best * L.GRID / 205.0))
        else:
            out.append('东西横穿：走不通（左带与右带不连通）')
    # 最远点（从 A 区出生点附近出发，实体定稿后换成真 spawn）
    # 最远点：用**真出生点**（`arena_layout.SPAWN` 吸附后的位置），
    # 不然量出来的是"从旧图某点出发"，和玩家实际的远征不是一回事。
    sp = L._snap_spawn(g, L.SPAWN)
    dist = bfs_from(g, [sp])
    best_idx = max(range(len(dist)), key=lambda i: dist[i])
    out.append('从 %s 走到最远 %s = %d 格 = %.0f 秒'
               % (sp, (best_idx % L.COLS, best_idx // L.COLS),
                  dist[best_idx], dist[best_idx] * L.GRID / 205.0))
    unreachable = sum(1 for i, d in enumerate(dist) if d < 0
                      and g.t[i // L.COLS][i % L.COLS] in WALK)
    out.append('从出生点走不到的可走格：%d（孤岛；只要实体不在上面就行）' % unreachable)
    return out


def main() -> int:
    if '--no-bmp' not in sys.argv:
        os.makedirs(OUT, exist_ok=True)
    g = L.build_terrain()
    for line in measure(g):
        print(line)
    if '--no-bmp' not in sys.argv:
        for name, tinted in (('map-terrain.bmp', False), ('map-zones.bmp', True)):
            write_bmp(os.path.join(OUT, name), render(g, tinted))
            print('[bmp] out/%s' % name)
    return 0


if __name__ == '__main__':
    sys.exit(main())
