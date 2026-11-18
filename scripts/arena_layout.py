#!/usr/bin/env python3
"""arena 布局（设计 11）：地块 / 分区 / 建筑 / 实体点位。

2026-11-18 重做，用户给的三个问题与对应的改法：

1. **四区太规整、区内也太规整** → 分区不再按矩形铺满，每区是一块**不规则地块**
   （4 个错位矩形并集 + 大尺度噪声吃掉边界，角被磨掉、边上长出半岛）。
   区内的墙也不是等距柱阵 / 四面大墙：院墙按 5–9 格一段抖动 ±1 格，院子之间
   用带门的连接墙连成一片，长廊的墙带是阶梯斜墙。地块之外是 VOID（崖 / 深林），
   所以**地图外轮廓本身就是不规则的**。

2. **区块之间像大平原** → 区与区之间留 40–80 格 VOID 带，只靠 8 条**带墙走廊**
   连通（宽 7 格、有转折）。走廊两侧是 VOID，读起来是"甬道 / 石桥"。

3. **地图太小**（旧图 8192px，走速 205px/s，横穿实测 40 秒）→ 840×544 格
   = 26880×17408 px。目标：横穿 BFS 最短路径 2–2.5 分钟（实测 115 秒 / 23.6k px，
   玩家实际走更长）。由 `preview_map.py` 实测，不靠感觉。

2026-11-18 第二轮（用户四条反馈的第二轮）又加了两件事：

5. **正中新增第五区 `vault`（宝库）**：全图唯一的高价值战利品区，四块地块各外移
   120 格让出天井，四个区各有一条支线通进去。它也是唯一"填满再挖"的**库房群**
   （9 间房 + 3 格门洞 + 货架），怪与可破坏物的密度是四区的 5–6 倍。
6. **走廊改到最后挖**。以前先挖走廊、再建各区，东廊与石窟那种"整区填满墙"的
   地形会把走廊中段重填成 WALL —— 图上还留着路的样子，人走过去是死路。
   现在 `build_terrain()` 的顺序是 land → 各区 → 走廊，并且走廊端点会被吸附到
   **区内主连通块**（`_zone_main_block`），不会再停在墙里的一小块空地上。

每区的地形语言（这是战斗节奏，不是美术）：

    Ａ 院落 court      围合：11 个尺寸不一的院子用带门连接墙串成一片 + 窄巷 + 假山
                             → 卡门、绕后、被堵死
    Ｂ 东廊 corridor   线性：一条**蛇形**主廊（来回折返）+ 梳齿支廊 + 非等距柱列
                             → 横穿必须来回走，视线被切成一段一段
    Ｃ 石窟 cavern     有机：噪声岩体 + 蜿蜒洞道 + 大石柱   → 没有一条长直边
    Ｄ 水榭 wateryard  分割：不规则湖 + 三座桥 + 池心亭      → 桥是唯一咽喉

**确定性**：所有"随机"都是 (坐标, 盐) 的哈希，重跑逐字节一致，不依赖种子文件。
"""
from __future__ import annotations

import math
from collections import deque

# 840×544 格 @32px = 26880×17408 px。2026-11-18 第二轮扩图：为了在正中塞下
# 第五区「宝库」，四块地块各向外平移 120 格，中间留出 190×144 格的天井。
COLS, ROWS, GRID = 840, 544, 32
FLOOR, WALL, PAVED, VOID = 0, 1, 2, 3

# 分区（设计 11）。前 6 个字段与旧版一致：id / 名字 / col / row / cols / rows。
# 这里的矩形**只是包围盒**（大地图标签、zoneRect、粗筛），真实形状在 AREA 里，
# 逐格归属由 `build_land()` 光栅化成 `zone` 表导出。
#
# 第五区 `vault`（宝库）在正中：四块地块各平移 120 格让出来的天井里，
# **只有**四条走廊分别从四区通进来 —— 它是全图唯一的高价值战利品区。
ZONES = [
    ('court', '院落', 36, 24, 286, 190),
    ('corridor', '东廊', 516, 30, 307, 194),
    ('cavern', '石窟', 520, 370, 302, 174),
    ('wateryard', '水榭', 36, 368, 291, 172),
    ('vault', '宝库', 350, 244, 140, 102),
]
ZONE_INDEX = {z[0]: i for i, z in enumerate(ZONES)}

# 每区的地块 = **手工多边形轮廓**（扫描线填充 + 边界噪声抖动 ±8 格）。
# 为什么不用矩形并集：矩形再怎么拼，看过去仍是"圆角方块"；多边形才能做出
# 半岛、凹湾、斜切角 —— 也就是用户要的"现实里的地块边角不会那么整齐"。
OUTLINE = {
    'court': [
        (36, 74), (58, 40), (108, 26), (156, 40), (188, 24), (240, 36),
        (272, 22), (306, 48), (322, 92), (300, 120), (318, 150), (286, 176),
        (240, 168), (208, 196), (160, 188), (120, 206), (74, 190), (44, 166),
        (30, 120), (48, 100),
    ],
    'corridor': [
        (520, 40), (590, 28), (660, 40), (720, 26), (780, 44), (822, 80),
        (810, 120), (822, 150), (788, 176), (820, 200), (780, 224), (710, 210),
        (660, 224), (600, 206), (550, 220), (520, 190), (538, 150), (516, 120),
        (534, 90), (516, 64),
    ],
    'cavern': [
        (524, 382), (570, 368), (620, 384), (676, 370), (720, 388), (770, 374),
        (820, 400), (816, 450), (822, 500), (780, 520), (730, 508), (686, 532),
        (636, 516), (590, 538), (550, 516), (520, 490), (536, 450), (518, 420),
    ],
    'wateryard': [
        (38, 390), (76, 370), (130, 382), (170, 368), (220, 384), (268, 372),
        (310, 394), (326, 430), (306, 460), (322, 492), (296, 520), (250, 534),
        (206, 520), (160, 540), (112, 524), (66, 538), (38, 512), (46, 470),
        (32, 440), (50, 416),
    ],
    # 宝库：140×102 的不规则地块，四角各缺一块（四条走廊从缺角进来）。
    'vault': [
        (356, 268), (372, 250), (404, 246), (432, 252), (462, 244), (484, 258),
        (490, 286), (482, 310), (488, 332), (470, 344), (440, 338), (414, 346),
        (388, 338), (362, 336), (350, 314), (356, 292),
    ],
}

# 区之间的走廊：(区 A, 区 B, 折线, 宽度)。每条都要落进两端的区里、中段穿过 VOID 带。
# `verify()` 校验「每对相邻区 ≥2 条（通往宝库的 ≥1 条）」。
#
# 2026-11-18 第二轮：四区各外移 120 格，走廊坐标整批重算；新增四条
# 「区 ↔ 宝库」的支线，全部从**区角**贴着天井边缘进入，不与区际走廊交叉
# （交叉会让两条路并成一个口子，"每对相邻区 2 条"就数不准了）。
CORRIDORS = [
    # 环形动线：院落 → 东廊 → 石窟 → 水榭 → 院落，每对 2 条
    ('court', 'corridor', [(300, 70), (400, 60), (520, 72)], 7),
    ('court', 'corridor', [(270, 160), (390, 178), (520, 168)], 7),
    ('corridor', 'cavern', [(780, 200), (812, 280), (780, 380)], 7),
    ('corridor', 'cavern', [(620, 205), (600, 290), (620, 375)], 7),
    ('cavern', 'wateryard', [(540, 510), (430, 520), (320, 500)], 7),
    ('cavern', 'wateryard', [(540, 420), (430, 430), (320, 420)], 7),
    ('wateryard', 'court', [(150, 380), (120, 290), (150, 200)], 7),
    ('wateryard', 'court', [(260, 378), (290, 290), (260, 200)], 7),
    # 支线：四个区各一条通往正中宝库（高价值区必须有路，但不能是大道）
    ('court', 'vault', [(230, 185), (300, 230), (360, 265)], 6),
    ('corridor', 'vault', [(540, 190), (500, 220), (470, 270)], 6),
    ('cavern', 'vault', [(540, 390), (500, 370), (470, 330)], 6),
    ('wateryard', 'vault', [(330, 380), (340, 360), (360, 330)], 6),
]

# ------------------------------------------------------------------ 哈希 / 噪声
#
# 64×64 的噪声表：vnoise 不再每次算 4 次哈希，大图（320k 格）生成时间从 ~8s 降到 ~2s。
_NOISE = None


def _h01(*parts) -> float:
    x = 0x811C9DC5
    for p in parts:
        if isinstance(p, str):
            for ch in p:
                x = ((x ^ ord(ch)) * 16777619) & 0xFFFFFFFF
        else:
            v = int(p) & 0xFFFFFFFF
            for _ in range(4):
                x = ((x ^ (v & 0xFF)) * 16777619) & 0xFFFFFFFF
                v >>= 8
    return x / 4294967296.0


def _noise_table():
    global _NOISE
    if _NOISE is None:
        _NOISE = [[_h01('n', i, j) for j in range(64)] for i in range(64)]
    return _NOISE


def vnoise(x: float, y: float, salt: int = 0) -> float:
    """值噪声（双线性 + smoothstep）。salt 换表偏移，避免各区纹理撞脸。"""
    tab = _noise_table()
    xi = math.floor(x)
    yi = math.floor(y)
    fx = x - xi
    fy = y - yi
    ox = (salt * 17) & 63
    oy = (salt * 31) & 63
    x0 = (xi + ox) & 63
    y0 = (yi + oy) & 63
    x1 = (x0 + 1) & 63
    y1 = (y0 + 1) & 63
    u = fx * fx * (3 - 2 * fx)
    v = fy * fy * (3 - 2 * fy)
    a = tab[x0][y0] * (1 - u) + tab[x1][y0] * u
    b = tab[x0][y1] * (1 - u) + tab[x1][y1] * u
    return a * (1 - v) + b * v


def fbm(x: float, y: float, salt: int = 0) -> float:
    """两层值噪声，归一化到 ~0..1（均值 0.5）。"""
    total = vnoise(x, y, salt) * 0.62
    total += vnoise(x * 2.07, y * 2.07, salt + 11) * 0.28
    return total / 0.90


# ------------------------------------------------------------------ 画布
class Canvas:
    """地形 + 地块 + 分区归属。四个表各自独立：

    - `t`    地形值（0 地 / 1 墙 / 2 铺装 / 3 虚空）—— 运行时的碰撞权威
    - `land` 地块（1 = 这块地在建筑群范围内，0 = 崖 / 深林）
    - `zone` 分区下标（-1 = 还没定）
    - `road` 通路（走廊 / 桥 / 甬道）。后画的岩体与水面**不许盖住它** ——
             B→C 的走廊曾经被石窟的噪声岩体重填成墙，图上是一条走不通的虚线。
    """

    __slots__ = ('t', 'land', 'zone', 'road')

    def __init__(self) -> None:
        self.t = [[VOID] * COLS for _ in range(ROWS)]
        self.land = [[0] * COLS for _ in range(ROWS)]
        self.zone = [[-1] * COLS for _ in range(ROWS)]
        self.road = [[0] * COLS for _ in range(ROWS)]

    def inside(self, c: int, r: int) -> bool:
        return 0 <= c < COLS and 0 <= r < ROWS

    def set(self, c: int, r: int, value: int) -> None:
        if self.inside(c, r):
            self.t[r][c] = value

    def wall(self, c: int, r: int) -> None:
        """只在有地、且不是通路的地方砌墙。

        地块边界把墙裁掉（不会伸进虚空），`road` 把墙挡开（走廊 / 桥 / 甬道
        不会被后画的院墙、假山、岩体堵死）。
        """
        if self.inside(c, r) and self.land[r][c] and not self.road[r][c]:
            self.t[r][c] = WALL

    def floor(self, c: int, r: int, value: int = FLOOR) -> None:
        if self.inside(c, r) and self.land[r][c]:
            self.t[r][c] = value

    def fill(self, c0: int, r0: int, c1: int, r1: int, value: int) -> None:
        for r in range(max(0, r0), min(ROWS - 1, r1) + 1):
            for c in range(max(0, c0), min(COLS - 1, c1) + 1):
                self.set(c, r, value)


# ------------------------------------------------------------------ 地块
def _scanline_fill(g: Canvas, poly, index: int, wobble: float = 8.0, scale: float = 34.0) -> None:
    """多边形扫描线填充 + 边界抖动。

    每行求多边形与水平线的交点，排序后成对填区间 —— 凹多边形（本项目全是凹的）
    也正确。两侧边界各加一个 ±`wobble` 的低频噪声，于是边是弯的、有缺口和半岛。
    """
    edges = [(poly[i], poly[(i + 1) % len(poly)]) for i in range(len(poly))]
    ys = [p[1] for p in poly]
    r0 = max(0, int(min(ys)) - 2)
    r1 = min(ROWS - 1, int(max(ys)) + 2)
    for r in range(r0, r1 + 1):
        xs = []
        for (x0, y0), (x1, y1) in edges:
            if (y0 <= r < y1) or (y1 <= r < y0):
                t = (r - y0) / (y1 - y0)
                xs.append(x0 + t * (x1 - x0))
        if len(xs) < 2:
            continue
        xs.sort()
        for i in range(0, len(xs) - 1, 2):
            a = xs[i]
            b = xs[i + 1]
            # 左右边界各抖一下：同一行内部用连续噪声，行与行之间也连续。
            a += (fbm(r / scale, 11.0, index * 13) - 0.5) * 2.0 * wobble
            b += (fbm(r / scale, 29.0, index * 13) - 0.5) * 2.0 * wobble
            for c in range(max(0, int(round(a))), min(COLS - 1, int(round(b))) + 1):
                g.land[r][c] = 1
                g.zone[r][c] = index
                g.t[r][c] = FLOOR


def build_land(g: Canvas) -> None:
    """把每区的地块写进 land / zone，其余保持 VOID。"""
    for zone_id, index in ZONE_INDEX.items():
        _scanline_fill(g, OUTLINE[zone_id], index)


# ------------------------------------------------------------------ 走廊
def _sweep(points, width, salt, visit):
    """沿折线做圆形扫掠，每步回调 visit(c, r, radius)。"""
    radius = width / 2.0
    for i in range(len(points) - 1):
        x0, y0 = points[i]
        x1, y1 = points[i + 1]
        seg = max(1.0, math.hypot(x1 - x0, y1 - y0))
        steps = int(seg * 2)
        for s in range(steps + 1):
            t = s / steps
            cx = x0 + (x1 - x0) * t
            cy = y0 + (y1 - y0) * t
            rr = radius + (fbm(cx * 0.55, cy * 0.55, salt) - 0.5) * 1.6
            R = int(rr) + 1
            for dy in range(-R, R + 1):
                for dx in range(-R, R + 1):
                    if dx * dx + dy * dy > rr * rr:
                        continue
                    visit(int(round(cx)) + dx, int(round(cy)) + dy)


def carve_path(g: Canvas, points, width: int, value: int = FLOOR,
               force: bool = False) -> None:
    """挖一条走廊。

    `force=False`：只把 VOID / 地面改成 `value`，不铲平已有的墙（走廊穿过院内时
    不会把院墙一起推掉）。
    `force=True`：**填满再挖**模式 —— 先铺一片岩体、再用它挖出廊道（东廊就这么做）。
    两种情况都打 `road` 标记，保护它不被后续的岩体 / 水面覆盖。
    """
    def visit(c, r):
        if not g.inside(c, r):
            return
        g.land[r][c] = 1
        if force or g.t[r][c] in (VOID, FLOOR, PAVED):
            g.t[r][c] = value
        g.road[r][c] = 1
    _sweep(points, width, 3, visit)


def _zone_main_block(g: Canvas, zi: int) -> set[tuple[int, int]]:
    """本区可走格里的**最大连通块**（4 邻接，和运行时判定一致）。

    走廊端点必须落在这块上。落在别处时，走廊会停在一小撮被墙围住的坑里：
    图上看着"路画到了"，人走过去却是死路 —— 2026-11-18 右上↔右下不连通
    就是这么来的（东廊整区填满墙，走廊端点正好在墙里）。
    """
    walk = (FLOOR, PAVED)
    cells = {(c, r) for r in range(ROWS) for c in range(COLS)
             if g.zone[r][c] == zi and g.t[r][c] in walk}
    best: set[tuple[int, int]] = set()
    seen: set[tuple[int, int]] = set()
    for start in cells:
        if start in seen:
            continue
        comp = {start}
        q = deque([start])
        seen.add(start)
        while q:
            c, r = q.popleft()
            for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                n = (c + dc, r + dr)
                if n in cells and n not in comp:
                    comp.add(n)
                    seen.add(n)
                    q.append(n)
        if len(comp) > len(best):
            best = comp
    return best


def _snap_into(block: set[tuple[int, int]], p: tuple[int, int],
               radius: int = 48) -> tuple[int, int]:
    """把走廊端点吸附到 `block` 里离它最近的格子（限制半径，别把走廊拉进区中心）。"""
    if p in block:
        return p
    best = None
    best_d = None
    for d in range(1, radius + 1):
        for dr in range(-d, d + 1):
            for dc in range(-d, d + 1):
                if max(abs(dc), abs(dr)) != d:
                    continue
                q = (p[0] + dc, p[1] + dr)
                if q not in block:
                    continue
                dd = dc * dc + dr * dr
                if best_d is None or dd < best_d:
                    best_d = dd
                    best = q
        if best is not None:
            return best
    return p


def build_corridors(g: Canvas) -> None:
    """走廊的地形 + 分区归属。

    分区按「到两个端点的距离」分半 —— 分界线是两端点的**垂直平分线**，
    垂直于走廊走向。这样一条走廊在 `zoneChannels()` 里正好算一段过渡。
    已经属于某个区的格子（走廊伸进区里的那截）保留原分区。
    """
    blocks: dict[int, set[tuple[int, int]]] = {}
    for a, b, points, width in CORRIDORS:
        ia, ib = ZONE_INDEX[a], ZONE_INDEX[b]
        if ia not in blocks:
            blocks[ia] = _zone_main_block(g, ia)
        if ib not in blocks:
            blocks[ib] = _zone_main_block(g, ib)
        # 端点吸附进区内主连通块：不然走廊会停在墙里的一小块空地上。
        pts = [_snap_into(blocks[ia], points[0])] + list(points[1:-1]) \
            + [_snap_into(blocks[ib], points[-1])]
        ax, ay = pts[0]
        bx, by = pts[-1]
        fresh: list[tuple[int, int]] = []

        def visit(c, r, fresh=fresh):
            if not g.inside(c, r):
                return
            if not g.land[r][c]:
                fresh.append((c, r))
            g.land[r][c] = 1
            # 走廊**强制**挖通：它撞上院墙的地方就是门洞。第一版只改 VOID/地面，
            # 结果走廊撞在院墙上就停住 —— A↔D 的两条通道全是断头（不可达 6k 格）。
            g.t[r][c] = FLOOR
            g.road[r][c] = 1
        _sweep(pts, width, 3, visit)
        for c, r in fresh:
            da = (c - ax) ** 2 + (r - ay) ** 2
            db = (c - bx) ** 2 + (r - by) ** 2
            if g.zone[r][c] < 0:
                g.zone[r][c] = ia if da <= db else ib


def fill_unclaimed(g: Canvas) -> None:
    """还没归属的陆地格（区的形状缝隙、走廊漏网）归最近的区。"""
    q = deque()
    for r in range(ROWS):
        for c in range(COLS):
            if g.land[r][c] and g.zone[r][c] >= 0:
                q.append((c, r))
    while q:
        c, r = q.popleft()
        z = g.zone[r][c]
        for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nc, nr = c + dc, r + dr
            if not g.inside(nc, nr) or not g.land[nr][nc] or g.zone[nr][nc] >= 0:
                continue
            g.zone[nr][nc] = z
            q.append((nc, nr))


# ------------------------------------------------------------------ 通用零件
def ragged_h(g: Canvas, c0: int, c1: int, row: int, thick: int, salt: str,
             seg: int = 7, jitter: int = 1, gap: tuple[int, int] | None = None) -> None:
    """一条**手砌感**的横墙：每 5–9 格换一次基线偏移，不出现 CAD 直线。"""
    c = c0
    k = 0
    while c <= c1:
        ln = seg + int(_h01(salt, 'len', k) * 3)
        off = int(_h01(salt, 'off', k) * (2 * jitter + 1)) - jitter
        for cc in range(c, min(c + ln, c1 + 1)):
            if gap is not None and gap[0] <= cc <= gap[1]:
                continue
            for t in range(thick):
                g.wall(cc, row + off + t)
        c += ln
        k += 1


def ragged_v(g: Canvas, r0: int, r1: int, col: int, thick: int, salt: str,
             seg: int = 7, jitter: int = 1, gap: tuple[int, int] | None = None) -> None:
    r = r0
    k = 0
    while r <= r1:
        ln = seg + int(_h01(salt, 'len', k) * 3)
        off = int(_h01(salt, 'off', k) * (2 * jitter + 1)) - jitter
        for rr in range(r, min(r + ln, r1 + 1)):
            if gap is not None and gap[0] <= rr <= gap[1]:
                continue
            for t in range(thick):
                g.wall(col + off + t, rr)
        r += ln
        k += 1


def slanted_wall(g: Canvas, x0: int, y0: int, x1: int, y1: int, thick: int,
                 salt: str, gaps=()) -> None:
    """阶梯斜墙。以网格为单位斜着走，读起来是"顺着地势砌的墙"，不是 CAD 直线。

    `gaps` 是 `t` 区间（0..1），落在里面的段留门洞。
    """
    n = int(max(abs(x1 - x0), abs(y1 - y0)))
    for i in range(n + 1):
        t = i / max(1, n)
        if any(a <= t <= b for a, b in gaps):
            continue
        cx = int(round(x0 + (x1 - x0) * t))
        cy = int(round(y0 + (y1 - y0) * t))
        wob = 1 if _h01(salt, i) < 0.25 else 0
        for d in range(thick + wob):
            g.wall(cx, cy + d)


def rock(g: Canvas, c: int, r: int, rad: float, salt: str = 'rock') -> None:
    """一块假山 / 石柱：圆形 + 噪声，边缘不规则。"""
    R = int(rad) + 2
    for dy in range(-R, R + 1):
        for dx in range(-R, R + 1):
            d = math.hypot(dx, dy)
            rr = rad + (fbm((c + dx) * 0.7, (r + dy) * 0.7, 5) - 0.5) * 2.2
            if d <= rr:
                g.wall(c + dx, r + dy)


# ------------------------------------------------------------------ Ａ 院落
# (c0, r0, w, h)：16 个院子。**四行，但行高不同、列宽差 3 倍、行首错位** ——
# 等列等距的"九宫格"是用户点名的问题，这里刻意让每行起点 38/44/46 不齐、
# 列宽从 26 到 86 不等，院子之间留 8–16 格巷子。
COURTS = [
    # 行 1（y 26–72）
    (44, 32, 44, 34), (94, 26, 72, 42), (174, 36, 40, 30), (222, 26, 86, 46),
    # 行 2（y 82–140）行首左移 6 格
    (38, 82, 64, 30), (110, 82, 42, 54), (158, 86, 56, 28), (222, 86, 46, 30),
    (276, 84, 36, 56),
    # 行 3（y 148–178）
    (44, 148, 36, 30), (88, 148, 70, 30), (166, 148, 44, 26), (218, 148, 62, 30),
    # 行 4（y 184–206）贴南边的一排矮院
    (46, 184, 56, 22), (108, 184, 68, 22), (184, 184, 78, 22),
]

# 院子之间的连接墙：把 11 个院子串成**一片建筑群**（而不是散落在空地上）。
# (x0, y0, x1, y1, 门洞 t 区间) —— 斜着连，别连成正交网格。
LINKS = [
    (96, 52, 108, 52, [(0.45, 0.75)]),
    (170, 58, 184, 56, [(0.2, 0.5)]),
    (236, 70, 252, 66, [(0.5, 0.8)]),
    (96, 120, 110, 118, [(0.1, 0.45)]),
    (180, 120, 196, 116, [(0.55, 0.9)]),
    (72, 76, 68, 92, [(0.3, 0.7)]),
    (232, 132, 232, 146, [(0.1, 0.5)]),
    (258, 92, 268, 96, [(0.4, 0.8)]),
    (118, 158, 132, 156, [(0.3, 0.7)]),
    (182, 176, 200, 170, [(0.2, 0.6)]),
    (140, 70, 140, 96, [(0.4, 0.8)]),
    (242, 78, 250, 90, []),
]


def build_court(g: Canvas) -> None:
    """院子 = 2–3 格厚的院墙环 + 1 个门洞 + 院内铺装；再用连接墙串成一片。"""
    for k, (c0, r0, w, h) in enumerate(COURTS):
        c1, r1 = c0 + w, r0 + h
        thick = 2 + (k % 2)
        sides = ['n', 's', 'w', 'e']
        door_side = sides[int(_h01('court', k, 'side') * 4) % 4]
        # **相对的两条边各开一个门**：单门院子一旦门被家具/院墙错位堵住，
        # 整座院子就变成封闭盒子（第一版有 4.6k 格不可达，就是这么来的）；
        # 而且单门在搜打撤里等于一个必死走廊，本区要的是"绕后"。
        door_sides = {door_side, sides[(sides.index(door_side) + 2) % 4]}
        door_pos = 0.25 + _h01('court', k, 'pos') * 0.5
        span_h = (c0 + 2, c1 - 2)
        span_v = (r0 + 2, r1 - 2)

        def gap_for(side: str, span: tuple[int, int]) -> tuple[int, int] | None:
            if side not in door_sides:
                return None
            a = int(span[0] + (span[1] - span[0]) * door_pos) - 1
            return (a, a + 3)

        ragged_h(g, c0, c1, r0, thick, 'courtn%d' % k, seg=6, gap=gap_for('n', span_h))
        ragged_h(g, c0, c1, r1 - thick + 1, thick, 'courts%d' % k, seg=6, gap=gap_for('s', span_h))
        ragged_v(g, r0, r1, c0, thick, 'courtw%d' % k, seg=6, gap=gap_for('w', span_v))
        ragged_v(g, r0, r1, c1 - thick + 1, thick, 'courte%d' % k, seg=6, gap=gap_for('e', span_v))
        for r in range(r0 + thick, r1 - thick + 1):
            for c in range(c0 + thick, c1 - thick + 1):
                g.floor(c, r, PAVED)

        # 院内的家具（假山 / 老树 / 石桌）：**只放院内**，不放巷子里 ——
        # 巷子堵死一个点，整片院子就变成一个封闭盒子（第一版就是这样，
        # 出生点可达面积只有 14 格）。院内是玩家战斗的场地，摆东西正好切视线。
        for j in range(3):
            fx = c0 + 8 + int(_h01('yard', k, j, 'x') * max(1, w - 16))
            fy = r0 + 8 + int(_h01('yard', k, j, 'y') * max(1, h - 16))
            rock(g, fx, fy, 4.6 + _h01('yard', k, j, 'r') * 2.6, 'courtrock')

    for k, (x0, y0, x1, y1, gaps) in enumerate(LINKS):
        slanted_wall(g, x0, y0, x1, y1, 2, 'link%d' % k, gaps)

    # 几块巷口地标（小半径，只切视线不堵路）。
    for c, r, rad in ((100, 78, 4.5), (168, 138, 5.0), (300, 108, 4.0),
                      (70, 200, 4.0), (262, 76, 4.5)):
        rock(g, c, r, rad, 'courtrock')


# ------------------------------------------------------------------ Ｂ 东廊
def build_gallery(g: Canvas) -> None:
    """**填满再挖**：整区先砌成实心建筑群，再抠出一条**蛇形**主廊 + 梳齿支廊。

    为什么这样：第一版是"空地上画几条墙带"，量出来 95% 可走 —— 那是广场，不是廊。
    填满之后墙上只剩廊道，横穿必须走完一整趟再折回来，这才是"东廊"，
    也才是横穿时间的主要来源。
    """
    zi = ZONE_INDEX['corridor']
    for r in range(ROWS):
        for c in range(COLS):
            if g.zone[r][c] == zi and g.land[r][c] and not g.road[r][c]:
                g.t[r][c] = WALL

    main = [(530, 58), (806, 66), (806, 118), (536, 128), (536, 180), (804, 188), (804, 212)]
    carve_path(g, main, 19, PAVED, force=True)

    # 梳齿：从主廊**向外**伸的短死路（上层只向上、下层只向下、中层不超过层间距
    # 的一半）—— 齿一旦穿过层间墙，蛇形就被抄近路，横穿时间立刻掉一半。
    teeth = [
        (556, 62, 'n', 26), (594, 68, 'n', 38), (632, 72, 'n', 24),
        (672, 76, 'n', 34), (714, 80, 'n', 22), (756, 84, 'n', 30),
        (566, 136, 's', 26), (606, 142, 's', 34), (648, 146, 's', 22),
        (690, 152, 's', 30), (732, 156, 's', 24), (776, 160, 's', 26),
        (622, 126, 'n', 18), (724, 128, 's', 18), (672, 130, 'n', 16),
    ]
    for k, (c, r, up, ln) in enumerate(teeth):
        dy = -1 if up == 'n' else 1
        bend = int(_h01('tooth', k, 'bend') * 9) - 4
        pts = [(c, r), (c + bend, r + dy * ln * 0.55), (c - bend, r + dy * ln)]
        carve_path(g, pts, 8 + (k % 3), FLOOR, force=True)

    # 廊柱：贴主廊两侧的半柱（不占中间通道），位置全哈希 —— 不排成栅栏。
    for k in range(18):
        c = 538 + int(_h01('col', k, 'c') * 254)
        lane = (58, 124, 186)[int(_h01('col', k, 'lane') * 3)]
        off = -8 if _h01('col', k, 'side') < 0.5 else 8
        r = lane + off + int(_h01('col', k, 'dy') * 5) - 2
        size = 2 if _h01('col', k, 's') < 0.72 else 3
        for dr in range(size):
            for dc in range(size):
                g.wall(c + dc, r + dr)

    # 两间侧室：靠东段墙角，门朝主廊。
    for k, (c0, r0) in enumerate(((720, 34), (720, 140))):
        ragged_h(g, c0, c0 + 30, r0, 3, 'roomv%d' % k)
        ragged_h(g, c0, c0 + 30, r0 + 18, 3, 'roomw%d' % k)
        ragged_v(g, r0, r0 + 18, c0, 3, 'roomn%d' % k)
        ragged_v(g, r0, r0 + 18, c0 + 30, 3, 'roome%d' % k)
        for r in range(r0 + 3, r0 + 18):
            for c in range(c0 + 3, c0 + 30):
                g.floor(c, r, PAVED)
        carve_path(g, [(c0 + 14, r0 + 18), (c0 + 14, r0)], 4, FLOOR, force=True)


# ------------------------------------------------------------------ Ｃ 石窟
def build_cavern(g: Canvas) -> None:
    """噪声岩体：`fbm > 阈值` 的地方是石头，剩下的天然是蜿蜒洞道。

    阈值从 0.56 往下试，直到主连通块占可走格 ≥ 80%。
    """
    zi = ZONE_INDEX['cavern']
    cells = [(c, r) for r in range(ROWS) for c in range(COLS)
             if g.land[r][c] and g.zone[r][c] == zi]
    if not cells:
        return
    best = None
    for attempt, threshold in enumerate((0.56, 0.545, 0.53, 0.515, 0.50, 0.485)):
        for c, r in cells:
            if g.road[r][c]:
                continue        # 走廊不许被岩体重填（会变成走不通的虚线）
            g.t[r][c] = WALL if fbm(c / 15.0, r / 15.0, 21) > threshold else FLOOR
        for k in range(26):
            c = 530 + int(_h01('crock', attempt, k, 'c') * 280)
            r = 382 + int(_h01('crock', attempt, k, 'r') * 150)
            rock(g, c, r, 2.5 + _h01('crock', k, 'rad') * 4.5, 'cavernrock')
        ratio = _main_share(g, cells)
        if best is None or ratio > best[1]:
            best = (threshold, ratio)
        if ratio >= 0.80:
            return
    threshold = best[0]
    for c, r in cells:
        if g.road[r][c]:
            continue
        g.t[r][c] = WALL if fbm(c / 15.0, r / 15.0, 21) > threshold else FLOOR


def _main_share(g: Canvas, cells) -> float:
    """可走格里，最大连通块占比。"""
    walk = {(c, r) for c, r in cells if g.t[r][c] in (FLOOR, PAVED)}
    if not walk:
        return 0.0
    seen: set[tuple[int, int]] = set()
    best = 0
    for start in walk:
        if start in seen:
            continue
        comp = {start}
        q = deque([start])
        seen.add(start)
        while q:
            c, r = q.popleft()
            for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                n = (c + dc, r + dr)
                if n in walk and n not in comp:
                    comp.add(n)
                    seen.add(n)
                    q.append(n)
        best = max(best, len(comp))
    return best / len(walk)


# ------------------------------------------------------------------ Ｄ 水榭
def build_wateryard(g: Canvas) -> None:
    """不规则湖 + 三座桥 + 池心亭。桥是唯一近路，绕湖要多走 40–90 秒。"""
    zi = ZONE_INDEX['wateryard']
    cx, cy, rx, ry = 160.0, 456.0, 104.0, 48.0
    for r in range(372, ROWS):
        for c in range(38, 330):
            if g.zone[r][c] != zi or not g.land[r][c] or g.road[r][c]:
                continue
            dx = (c - cx) / rx
            dy = (r - cy) / ry
            edge = dx * dx + dy * dy
            wobble = (fbm(c / 22.0, r / 22.0, 31) - 0.5) * 0.55
            if edge + wobble < 1.0:
                g.t[r][c] = VOID

    # 池心亭：湖里的一块台基（走不上去，纯地标）。
    for r in range(446, 462):
        for c in range(144, 160):
            if g.zone[r][c] == zi:
                g.t[r][c] = WALL

    bridges = [
        ([(112, 398), (118, 442), (110, 518)], 5),
        ([(54, 460), (110, 442), (176, 464), (256, 446)], 5),
        ([(210, 406), (186, 442), (216, 504)], 5),
    ]
    for points, width in bridges:
        carve_path(g, points, width, PAVED)

    # 湖岸小院：三个，尺寸不同，门朝水。
    for k, (c0, r0, w, h) in enumerate(((44, 382, 28, 22), (238, 384, 32, 24), (44, 500, 30, 22))):
        ragged_h(g, c0, c0 + w, r0, 3, 'wy%d' % k)
        ragged_h(g, c0, c0 + w, r0 + h, 3, 'wyb%d' % k)
        ragged_v(g, r0, r0 + h, c0, 3, 'wyv%d' % k)
        ragged_v(g, r0, r0 + h, c0 + w, 3, 'wyv2%d' % k)
        for r in range(r0 + 3, r0 + h):
            for c in range(c0 + 3, c0 + w):
                g.floor(c, r, PAVED)
        dc = c0 + w if c0 < 140 else c0
        for r in range(r0 + 9, r0 + 13):
            for c in range(dc, dc + 3):
                if g.land[r][c]:
                    g.t[r][c] = FLOOR

    # 湖里的碎岛：给"水面不空"的读法，不可达也没关系。
    for k in range(11):
        c = 60 + int(_h01('islet', k, 'c') * 200)
        r = 408 + int(_h01('islet', k, 'r') * 100)
        for dy in range(-2, 3):
            for dx in range(-3, 4):
                cc, rr = c + dx, r + dy
                if math.hypot(dx / 3.0, dy / 2.0) <= 1.0 and g.inside(cc, rr):
                    if g.t[rr][cc] == VOID and not g.road[rr][cc]:
                        g.t[rr][cc] = WALL


# ------------------------------------------------------------------ Ｅ 宝库
# 正中的第五区：**全图唯一的高价值战利品区**。地形语言是"库房"——
# 整区先砌成实心建筑群，再挖出 9 间大小不一的库房，房与房之间只靠 3 格宽的门洞
# 相连，房内再摆货架。所以这里的交战永远是"推门 → 两三只怪贴脸"，
# 和四区那种开阔院子完全两种压力（这也是"高价值"的代价）。
VAULT_ROOMS = [
    (354, 248, 396, 274), (400, 248, 440, 274), (444, 248, 486, 274),
    (354, 278, 396, 316), (400, 278, 440, 316), (444, 278, 486, 316),
    (354, 320, 396, 342), (400, 320, 440, 342), (444, 320, 486, 342),
]
# 每道门洞都是 3 格宽的一条短扫掠：(起点, 终点)。
VAULT_DOORS = [
    ((394, 261), (403, 261)), ((438, 261), (447, 261)),
    ((394, 297), (403, 297)), ((438, 297), (447, 297)),
    ((394, 331), (403, 331)), ((438, 331), (447, 331)),
    ((375, 272), (375, 281)), ((420, 272), (420, 281)), ((465, 272), (465, 281)),
    ((375, 314), (375, 323)), ((420, 314), (420, 323)), ((465, 314), (465, 323)),
]


def build_vault(g: Canvas) -> None:
    """库房群：整区填实 → 挖 9 间房 → 每间配 2–3 个门洞 → 房内摆货架。"""
    zi = ZONE_INDEX['vault']
    for r in range(ROWS):
        for c in range(COLS):
            if g.zone[r][c] == zi and g.land[r][c] and not g.road[r][c]:
                g.t[r][c] = WALL

    for c0, r0, c1, r1 in VAULT_ROOMS:
        for r in range(r0 + 3, r1 - 2):
            for c in range(c0 + 3, c1 - 2):
                g.floor(c, r, PAVED)

    for a, b in VAULT_DOORS:
        carve_path(g, [a, b], 4, PAVED, force=True)

    # 房内货架：2 格厚的长条，横竖混排 —— 每一排都切断一次视线，
    # 没有"一眼看穿整间库房"的机会。
    for k in range(13):
        c = 360 + int(_h01('shelf', k, 'c') * 116)
        r = 254 + int(_h01('shelf', k, 'r') * 78)
        ln = 5 + int(_h01('shelf', k, 'len') * 8)
        horiz = _h01('shelf', k, 'dir') < 0.5
        for i in range(ln):
            for t in range(2):
                if horiz:
                    g.wall(c + i, r + t)
                else:
                    g.wall(c + t, r + i)

    # 中央那间（R5）的石台：库房的视觉中心，也是唯一的高台。
    rock(g, 420, 297, 5.5, 'vaultrock')


# ------------------------------------------------------------------ 实体布点
SPAWN = (66, 48)
# 出生点周围不放怪的半径（曼哈顿格数）。36 格 ≈ 1150px ≈ 两个多屏幕宽，
# 比任何怪的感知半径都大：开局有一段时间可以看清地形，而不是先挨一刀。
SAFE_SPAWN_CELLS = 36


def _reachable(g: Canvas, start: tuple[int, int]) -> set[tuple[int, int]]:
    walk = (FLOOR, PAVED)
    seen = {start}
    q = deque([start])
    while q:
        c, r = q.popleft()
        for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nc, nr = c + dc, r + dr
            n = (nc, nr)
            if n in seen or not (0 <= nc < COLS and 0 <= nr < ROWS):
                continue
            if g.t[nr][nc] not in walk:
                continue
            seen.add(n)
            q.append(n)
    return seen


def _open_cells(g: Canvas, zi: int, reach: set[tuple[int, int]]) -> list[tuple[int, int]]:
    """本区里"四周一圈都能站"且从出生点走得到的格子 —— 实体只往这些格上放。"""
    out = []
    for r in range(1, ROWS - 1):
        for c in range(1, COLS - 1):
            if g.zone[r][c] != zi or g.t[r][c] not in (FLOOR, PAVED):
                continue
            if (c, r) not in reach:
                continue
            if all(g.t[r + dr][c + dc] in (FLOOR, PAVED)
                   for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1), (0, 0))):
                out.append((c, r))
    return out


def _scatter(g: Canvas, zi: int, count: int, gap: int, salt: str,
             taken: list[tuple[int, int]], reach: set[tuple[int, int]],
             hard_gap: int = 0) -> list[tuple[int, int]]:
    """确定性撒点：从"可站格"里按哈希挑，要求彼此间距 ≥ gap、离 taken 的已有实体
    ≥ hard_gap。挑不满就少放（宁可少一只怪，也不要把两只叠在一格里）。"""
    cells = _open_cells(g, zi, reach)
    if not cells:
        return []
    out: list[tuple[int, int]] = []
    for k in range(count * 260):
        if len(out) >= count:
            break
        idx = int(_h01(salt, k, 'p') * len(cells)) % len(cells)
        c, r = cells[idx]
        if any(abs(c - tc) + abs(r - tr) < gap for tc, tr in out):
            continue
        if any(abs(c - tc) + abs(r - tr) < hard_gap for tc, tr in taken):
            continue
        out.append((c, r))
    return out


# 每区的实体配额：(门, 怪, 可破坏物, 事件点)。
# 四区刻意稀疏（单局 15 分钟只走 1–3 个区，铺满就变成割草）；宝库是
# **全图唯一的高价值区**，密度按可走面积算是四区的 5–6 倍 —— 推一扇门就有
# 两三只贴脸，这是"值不值得进去"的赌注。
SPAWNS = {
    'court': (5, 15, 15, 2),
    'corridor': (5, 15, 15, 2),
    'cavern': (5, 15, 15, 2),
    'wateryard': (5, 15, 15, 2),
    'vault': (3, 20, 22, 2),
}


def place_entities(g: Canvas, spawn):
    """门 / 怪 / 可破坏物 / 事件点，按 `SPAWNS` 的配额逐区撒。"""
    portals: list[tuple[int, int]] = []
    reach = _reachable(g, spawn)
    for zi, (zid, _name, *_bb) in enumerate(ZONES):
        portals += _scatter(g, zi, SPAWNS[zid][0], 42, 'portal%s' % zid,
                            [spawn], reach, hard_gap=60)

    # 出生点周围留一圈**安全落脚区**。以前怪离出生点只隔 7 格（曼哈顿 224px）——
    # 开局还没看清画面就有一只剑士贴身，7 分钟事件那类"站着等"的验收也必死。
    # 睡着的怪不会主动过来，所以这一圈留够（36 格 ≈ 1150px）就等于开局给一个
    # 观察窗口；出圈之后该多凶还是多凶。
    monster_spots: list[tuple[int, int]] = []
    for zi, (zid, _name, *_bb) in enumerate(ZONES):
        monster_spots += _scatter(g, zi, SPAWNS[zid][1], 7, 'monster%s' % zid,
                                  [spawn] + portals, reach, hard_gap=SAFE_SPAWN_CELLS)

    monsters = []
    for k, (c, r) in enumerate(monster_spots):
        roll = _h01('mid', c, r)
        mid = '100001' if roll < 0.46 else '200001' if roll < 0.80 else '100002'
        wave = 1 + int(_h01('wave', c, r) * 3)
        monsters.append((c, r, mid, min(3, wave)))

    chest_spots: list[tuple[int, int]] = []
    for zi, (zid, _name, *_bb) in enumerate(ZONES):
        chest_spots += _scatter(g, zi, SPAWNS[zid][2], 6, 'chest%s' % zid,
                                [spawn] + portals + monster_spots, reach, hard_gap=4)
    kinds = ('crate', 'coffer', 'reliquary')
    vault_zi = ZONE_INDEX['vault']
    destructibles = []
    for k, (c, r) in enumerate(chest_spots):
        if g.zone[r][c] == vault_zi:
            # 宝库里不要破木箱：库房囤的是匣与舍利匣。
            kind = 'reliquary' if _h01('ckind', c, r) < 0.62 else 'coffer'
        else:
            kind = kinds[k % 3] if _h01('ckind', c, r) < 0.55 else kinds[(k + 1) % 3]
        destructibles.append((kind, c, r))

    event_sites: list[tuple[int, int]] = []
    for zi, (zid, _name, *_bb) in enumerate(ZONES):
        event_sites += _scatter(g, zi, SPAWNS[zid][3], 70, 'event%s' % zid,
                                [spawn] + portals + monster_spots, reach, hard_gap=25)

    return portals, monsters, destructibles, event_sites


def place_props(g: Canvas, portals, monsters) -> list[tuple[str, int, int]]:
    """装饰：香炉撒在可走格上（不挡路），高台只放固定地标。"""
    props = []
    reach = _reachable(g, _snap_spawn(g, SPAWN))
    for k in range(34):
        zi = k % len(ZONES)
        cells = _open_cells(g, zi, reach)
        if not cells:
            continue
        c, r = cells[int(_h01('censer', k, 'p') * len(cells)) % len(cells)]
        props.append(('censer', c, r))
    for c, r in ((168, 100), (590, 420), (120, 450)):
        if g.inside(c, r) and g.land[r][c]:
            props.append(('terrace', c, r))
    return props


# ------------------------------------------------------------------ 组装
def build_terrain() -> Canvas:
    g = Canvas()
    build_land(g)
    fill_unclaimed(g)
    build_court(g)
    build_gallery(g)
    build_cavern(g)
    build_wateryard(g)
    build_vault(g)
    # **走廊必须最后挖**。各区建筑会（有意地）把整区砌满墙 —— 先挖的走廊会被
    # 后来的"填满再挖"重填成 WALL，图上还留着路的样子。2026-11-18 用户报的
    # 「右上和右下画了路但不连通」就是这个：东廊↔石窟的两条中段已经是实心墙。
    build_corridors(g)
    return g


def _snap_spawn(g: Canvas, want: tuple[int, int]) -> tuple[int, int]:
    """出生点吸附到最近的"能站人"的格子（院内假山正好压在脚本坐标上时别报错）。"""
    for radius in range(0, 24):
        for dr in range(-radius, radius + 1):
            for dc in range(-radius, radius + 1):
                c, r = want[0] + dc, want[1] + dr
                if not (1 <= c < COLS - 1 and 1 <= r < ROWS - 1):
                    continue
                if all(g.t[r + ddr][c + ddc] in (FLOOR, PAVED)
                       for ddr, ddc in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1))):
                    return (c, r)
    return want


_CACHE: dict[str, object] = {}


def layout():
    """与旧版 `gen_arena_map.layout()` 同签名：地形 / props / spawn / 实体点位。

    结果缓存：`gen_arena_map.py` 先 build() 再 verify()，两次别各生成一遍（3 秒）。
    """
    if 'v' not in _CACHE:
        g = build_terrain()
        spawn = _snap_spawn(g, SPAWN)
        portals, monsters, destructibles, event_sites = place_entities(g, spawn)
        props = place_props(g, portals, monsters)
        _CACHE['v'] = (g, props, spawn, monsters, portals, destructibles, event_sites)
    g, props, spawn, monsters, portals, destructibles, event_sites = _CACHE['v']
    return (g.t, props, spawn, monsters, portals, destructibles, event_sites)


def last_canvas() -> Canvas:
    """`layout()` 生成的那份画布（verify 用，避免重跑）。"""
    layout()
    return _CACHE['v'][0]


# ------------------------------------------------------------------ 自检
def verify(g: Canvas, spawn, monsters, portals, destructibles, event_sites) -> list[str]:
    """生成期自检。返回问题列表（空 = 通过）。这些是**会让人白跑一局**的问题。"""
    problems = []
    walk = {FLOOR, PAVED}

    def walkable(c, r):
        return 0 <= c < COLS and 0 <= r < ROWS and g.t[r][c] in walk

    if not walkable(*spawn):
        problems.append('出生点 %s 不可走' % (spawn,))

    # 出生点可达性（4 邻接）
    seen = {spawn}
    q = deque([spawn])
    while q:
        c, r = q.popleft()
        for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            n = (c + dc, r + dr)
            if n in seen or not walkable(*n):
                continue
            seen.add(n)
            q.append(n)

    pts = ([('Monster', c, r) for c, r, _m, _w in monsters]
           + [('Portal', c, r) for c, r in portals]
           + [('Destructible', c, r) for _k, c, r in destructibles]
           + [('EventSite', c, r) for c, r in event_sites])
    for label, c, r in pts:
        if not walkable(c, r):
            problems.append('%s (%d,%d) 不可走' % (label, c, r))
        elif (c, r) not in seen:
            problems.append('%s (%d,%d) 从出生点走不到' % (label, c, r))

    # 每区必须有门 / 怪 / 可破坏物 / 事件点（走到那儿得有东西做）
    for zi, (zid, name, *_rest) in enumerate(ZONES):
        def in_zone(c, r):
            return g.zone[r][c] == zi
        if not any(in_zone(c, r) for c, r in portals):
            problems.append('分区 %s 没有传送门' % name)
        if not any(in_zone(c, r) for c, r, _m, _w in monsters):
            problems.append('分区 %s 没有怪' % name)
        if not any(in_zone(c, r) for _k, c, r in destructibles):
            problems.append('分区 %s 没有可破坏物' % name)
        if not any(in_zone(c, r) for c, r in event_sites):
            problems.append('分区 %s 没有事件点' % name)

    # 相邻区通道：环形四对每对 ≥2 条，通往宝库每区 ≥1 条
    # （走廊条数，生成器自己知道，不用像素反推）
    pair_count: dict[tuple[int, int], int] = {}
    for a, b, _pts, _w in CORRIDORS:
        key = tuple(sorted((ZONE_INDEX[a], ZONE_INDEX[b])))
        pair_count[key] = pair_count.get(key, 0) + 1
    for (a, b), n in sorted(pair_count.items()):
        need = 1 if 'vault' in (ZONES[a][0], ZONES[b][0]) else 2
        if n < need:
            problems.append('分区 %s 与 %s 只有 %d 条通道（设计要求 ≥%d）'
                            % (ZONES[a][1], ZONES[b][1], n, need))

    # 宝库必须与**每一个**区都连通（它是这一版新增的战利品中心）
    vault = ZONE_INDEX['vault']
    for zi, (zid, name, *_rest) in enumerate(ZONES):
        if zi == vault:
            continue
        key = tuple(sorted((zi, vault)))
        if pair_count.get(key, 0) < 1:
            problems.append('分区 %s 没有通往宝库的通道' % name)

    # 尺寸与穿越目标（设计 11：单局 15 分钟，横穿 2.5–3 分钟纯移动）
    dist = [-1] * (COLS * ROWS)
    dist[spawn[1] * COLS + spawn[0]] = 0
    q = deque([spawn])
    while q:
        c, r = q.popleft()
        d = dist[r * COLS + c]
        for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nc, nr = c + dc, r + dr
            if not (0 <= nc < COLS and 0 <= nr < ROWS):
                continue
            ni = nr * COLS + nc
            if dist[ni] >= 0 or g.t[nr][nc] not in walk:
                continue
            dist[ni] = d + 1
            q.append((nc, nr))
    far = max(dist)
    seconds = far * GRID / 205.0
    if seconds < 140:
        problems.append('从出生点到最远点只有 %.0f 秒（设计要求 2.5–3 分钟 = 150–180 秒）'
                        % seconds)
    return problems
