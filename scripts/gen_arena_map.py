#!/usr/bin/env python3
"""Generate the Xianxia courtyard arena (arena.ldtk) from the asset-library atlas.

    python scripts/gen_arena_map.py            # rewrite assets/resource/maps/arena.ldtk
    python scripts/gen_arena_map.py --check    # validate the current .ldtk (LDtk-openable?)

Why a generator: the map is 128x96 tiles (4096x3072 px) with a few thousand
IntGrid cells and ~50 props. Authoring it by hand in LDtk is fine ONCE it
exists - this script exists to make the initial layout reproducible and to keep
the prop/terrain alignment exact (wall modules are 8 tiles wide and must sit on
multiples of 8).

The output .ldtk stays the human-authored source afterwards: open it in LDtk,
edit, save. Re-running this script overwrites those edits, so only run it when
you actually want the generated layout back.

`--check` therefore does NOT compare against the generator output (a file edited
in LDtk would always differ). It asserts the invariants LDtk needs to load the
file at all - the ones that used to make the editor die with
"Cannot read properties of null (reading 'externalLevels')".

Layers written:
  Terrain  (IntGrid)  0 floor / 1 wall / 2 paved / 3 void   - collision authority
  Entities             PlayerSpawn + Monster instances
  Props    (Entities)  wall_run / censer / terrace instances, rendered with the
                       atlas tile in the LDtk editor (tileRect per entity def)

The floor itself is NOT a Tile layer: 12288 grid-tile entries would bloat the
JSON by megabytes. Floor variants are derived from (col,row) at runtime.
"""
from __future__ import annotations

import json
import os
import sys
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAPS = os.path.join(ROOT, 'assets', 'resource', 'maps')
SOURCE = os.path.join(MAPS, 'arena.ldtk')
ATLAS = os.path.join(MAPS, 'tilesets', 'xianxia.json')

COLS = 256
ROWS = 160
GRID = 32

# ------------------------------------------------------------------ 分区（设计 11）
# 四区环形：院落(A) → 东廊(B) → 石窟(C) → 水榭(D) → 院落(A)。
# 每区**两条以上**出入通道（import_map.py 会在导入时按地形数一遍通道并拦下不足的）。
# 分区是**地图数据**：`import_map.py` 直接读这张表并把它写进 `arena.generated.ts`，
# 所以运行时（大地图 / HUD 区域名 / 验收）只有一份权威。
#   id / 显示名 / col, row, cols, rows（格）
ZONES = [
    ('court', '院落', 0, 0, 128, 96),
    ('corridor', '东廊', 128, 0, 128, 96),
    ('cavern', '石窟', 128, 96, 128, 64),
    ('wateryard', '水榭', 0, 96, 128, 64),
]
ZONE_BY_ID = {z[0]: z for z in ZONES}

FLOOR, WALL, PAVED, VOID = 0, 1, 2, 3

# 墙段模块固定 8 格宽，所以所有墙段起点都必须是 8 的倍数。
WALL_RUN_TILES = 8


def load_atlas():
    with open(ATLAS, 'r', encoding='utf-8') as fh:
        return json.load(fh)


def blank():
    return [[FLOOR] * COLS for _ in range(ROWS)]


def rect(t, c0, r0, c1, r1, value):
    """Fill an inclusive tile rectangle."""
    for r in range(max(0, r0), min(ROWS - 1, r1) + 1):
        for c in range(max(0, c0), min(COLS - 1, c1) + 1):
            t[r][c] = value


def hollow(t, c0, r0, c1, r1, value, doors=()):
    """Rectangle outline with optional door gaps (list of (col,row) removed)."""
    for c in range(c0, c1 + 1):
        t[r0][c] = value
        t[r1][c] = value
    for r in range(r0, r1 + 1):
        t[r][c0] = value
        t[r][c1] = value
    for c, r in doors:
        t[r][c] = FLOOR


def pillars(t, c0, c1, r0, r1, step=8, size=2, skip=()):
    """柱阵：`size×size` 的实心块，按 `step` 铺开。柱子既挡视线也当掩护。"""
    for c in range(c0, c1 + 1, step):
        for r in range(r0, r1 + 1, step):
            if any(s(c, r) for s in skip):
                continue
            rect(t, c, r, c + size - 1, r + size - 1, WALL)


def layout():
    """整张图的**唯一手写布局**：四区 + 环形通道 + 全部实体点位。

    改动这里会重写整张 .ldtk（人工在 LDtk 里的编辑会被覆盖）；
    只想加点位就用 `add_destructible_entities.py` 那种"只追加"的脚本。
    """
    t = blank()
    props = []

    # ======================= A 院落（原图原位，一砖未动） =======================
    # 北墙 3 格厚：院墙模块高 96px（3 格），立在 row 2 上正好把顶端留在 y=0。
    # 院墙一律 **3 格厚**：院墙模块（wall_run）是 96px 高，只压 1 格墙会读成"栅栏"。
    rect(t, 0, 0, 127, 2, WALL)
    for r in range(0, 96):
        for c in (0, 1, 2):
            t[r][c] = WALL
        for c in (125, 126, 127):
            t[r][c] = WALL
    for c in range(0, 128):
        for r in (93, 94, 95):
            t[r][c] = WALL
    # 三门：南（主，通水榭）、东（通东廊）、西（贴地图边界，纯视觉）
    for c in range(60, 68):
        for r in (93, 94, 95):
            t[r][c] = PAVED
    for r in range(44, 52):
        for c in (0, 1, 2, 125, 126, 127):
            t[r][c] = PAVED

    # 北侧高台（12x10），台前两格台阶
    TERRACE_C, TERRACE_R = 58, 4
    rect(t, TERRACE_C, TERRACE_R, TERRACE_C + 11, TERRACE_R + 9, WALL)
    props.append(('terrace', TERRACE_C, TERRACE_R))
    rect(t, TERRACE_C, TERRACE_R + 10, TERRACE_C + 11, TERRACE_R + 11, PAVED)

    # 东西厢房（中空 + 门）
    hollow(t, 10, 20, 34, 40, WALL, doors=((22, 40), (22, 20), (10, 30)))
    hollow(t, 93, 20, 117, 40, WALL, doors=((105, 40), (105, 20), (117, 30)))
    rect(t, 11, 21, 33, 39, PAVED)
    rect(t, 94, 21, 116, 39, PAVED)

    # 中庭断墙（对齐 8 的倍数才拼得上院墙模块）
    runs = [
        (24, 56, 2),
        (88, 56, 2),
        (40, 68, 1),
        (80, 68, 1),
        (52, 76, 1),
        (68, 76, 1),
    ]
    for col, row, modules in runs:
        for i in range(modules):
            c0 = col + i * WALL_RUN_TILES
            rect(t, c0, row, c0 + WALL_RUN_TILES - 1, row, WALL)
            props.append(('wall_run', c0, row))

    for c0 in range(0, 128, WALL_RUN_TILES):
        if 48 <= c0 <= 72:      # 高台正面，留给台阶
            continue
        props.append(('wall_run', c0, 2))
    for c0 in range(0, 128, WALL_RUN_TILES):
        if 56 <= c0 <= 64:      # 南门
            continue
        props.append(('wall_run', c0, 95))

    for col, row in [(54, 16), (71, 16), (60, 82), (67, 82),
                     (14, 18), (112, 18), (14, 42), (112, 42)]:
        props.append(('censer', col, row))

    # ======================= B 东廊（柱阵长厅 + 两间偏房） =======================
    # 外墙：北 0..2 / 东 255 / 西 128（与院落共墙，在 44..51 开门）
    rect(t, 128, 0, 255, 2, WALL)
    for r in range(0, 96):
        for c in (253, 254, 255):
            t[r][c] = WALL
    for c in range(128, 256):
        for r in (93, 94, 95):
            t[r][c] = WALL
    for r in range(44, 52):
        t[r][128] = PAVED        # 西：接院落东门（院墙那 3 格已开）
    for c in range(176, 184):
        for r in (93, 94, 95):
            t[r][c] = PAVED      # 南：接石窟北门

    # 主路：一条东西向长廊 + 一条南北向支路（环形动线的两条主轴）
    rect(t, 129, 44, 254, 51, PAVED)
    rect(t, 186, 3, 193, 94, PAVED)

    # 两间偏房（进门要绕一步，给绕后留空间）
    hollow(t, 140, 12, 166, 36, WALL, doors=((153, 36), (140, 24)))
    hollow(t, 208, 12, 234, 36, WALL, doors=((221, 36), (234, 24)))
    rect(t, 141, 13, 165, 35, PAVED)
    rect(t, 209, 13, 233, 35, PAVED)

    # 竹林柱阵：只铺在南半场，避开两条主路与南门
    def south_gate(c, r):
        return 174 <= c <= 185 and r >= 88

    pillars(t, 136, 248, 60, 88, step=8, size=2, skip=(south_gate,))
    # 地面保持**土色**（FLOOR）：整片铺装会把柱阵读成"停车场"。
    # 断墙给长廊一点剪影，同时不挡两条主路与南门。
    for c0, row in [(136, 60), (200, 60), (216, 76)]:
        rect(t, c0, row, c0 + WALL_RUN_TILES - 1, row, WALL)
        props.append(('wall_run', c0, row))

    for c0 in range(128, 256, WALL_RUN_TILES):
        if 174 <= c0 <= 184:
            continue
        props.append(('wall_run', c0, 2))
    for c0 in range(128, 256, WALL_RUN_TILES):
        if 174 <= c0 <= 184:
            continue
        props.append(('wall_run', c0, 95))
    for col, row in [(172, 20), (200, 40), (150, 58), (230, 66)]:
        props.append(('censer', col, row))

    # ======================= C 石窟（柱林斗场 + 两间石室） =======================
    for r in range(96, 160):
        for c in (128, 129, 130):
            t[r][c] = WALL
        for c in (253, 254, 255):
            t[r][c] = WALL
    for c in range(128, 256):
        for r in (157, 158, 159):
            t[r][c] = WALL
    for r in range(120, 128):
        for c in (128, 129, 130):
            t[r][c] = PAVED      # 西：接水榭东门
    # 北面与东廊共墙（row 95），门在 176..183 已经开好

    pillars(t, 144, 248, 108, 152, step=8, size=2,
            skip=(lambda c, r: 172 <= c <= 186 and r <= 104,
                  lambda c, r: c <= 142 and 112 <= r <= 132))
    # 两间石室
    hollow(t, 132, 100, 156, 118, WALL, doors=((144, 118), (132, 110)))
    hollow(t, 230, 138, 252, 156, WALL, doors=((240, 138), (252, 148)))
    rect(t, 133, 101, 155, 117, PAVED)
    rect(t, 231, 139, 251, 155, PAVED)

    for c0, row in [(152, 104), (208, 136)]:
        rect(t, c0, row, c0 + WALL_RUN_TILES - 1, row, WALL)
        props.append(('wall_run', c0, row))
    for c0 in range(128, 256, WALL_RUN_TILES):
        if 174 <= c0 <= 184:
            continue
        props.append(('wall_run', c0, 159))
    for col, row in [(140, 140), (200, 104), (244, 128), (168, 148)]:
        props.append(('censer', col, row))

    # ======================= D 水榭（水塘 + 石桥 + 环廊） =======================
    for r in range(96, 160):
        for c in (0, 1, 2):
            t[r][c] = WALL
        for c in (125, 126, 127):
            t[r][c] = WALL
    for c in range(0, 128):
        for r in (157, 158, 159):
            t[r][c] = WALL
    for r in range(120, 128):
        for c in (125, 126, 127):
            t[r][c] = PAVED      # 东：接石窟西门
    # 北面与院落共墙（row 95），门在 60..67 已经开好

    # 水塘：VOID（不可走）。没有水体图块，深色 void 就是"水"的读法。
    rect(t, 32, 110, 92, 150, VOID)
    # 石桥：横向一道，把水塘切成南北两半（桥上是唯一的近路）
    rect(t, 28, 128, 96, 134, PAVED)
    # 池心亭：站在水里的一块台基（纯地标，走不上去）
    rect(t, 56, 116, 68, 124, WALL)
    props.append(('terrace', 56, 116))

    # 环塘走廊两侧的偏房
    hollow(t, 8, 102, 26, 118, WALL, doors=((26, 110), (8, 108)))
    hollow(t, 100, 138, 122, 156, WALL, doors=((100, 148), (122, 146)))
    rect(t, 9, 103, 25, 117, PAVED)
    rect(t, 101, 139, 121, 155, PAVED)

    for c0, row in [(16, 120), (96, 150)]:
        rect(t, c0, row, c0 + WALL_RUN_TILES - 1, row, WALL)
        props.append(('wall_run', c0, row))
    for c0 in range(0, 128, WALL_RUN_TILES):
        if 56 <= c0 <= 64:      # 北门（与院落共用）
            continue
        props.append(('wall_run', c0, 159))
    for col, row in [(20, 100), (110, 132), (40, 156), (80, 100)]:
        props.append(('censer', col, row))

    # ============================ 实体点位 ============================
    # 出生点：**用户在 LDtk 里挪到 (69,20)**，这里跟着保留（扩图不覆盖人工编辑）。
    spawn = (69, 20)

    monsters = [
        # A 院落（原点位不变）
        (30, 30, '100001', 1),
        (105, 30, '100001', 1),
        (22, 58, '200001', 2),
        (106, 58, '200001', 2),
        (44, 46, '100001', 2),
        (84, 46, '100001', 3),
        (64, 70, '200001', 3),
        # B 东廊（长廊两端 + 偏房里）
        (150, 30, '100001', 1),
        (222, 30, '100001', 2),
        (170, 48, '200001', 2),
        (196, 66, '200001', 3),
        (244, 80, '100001', 3),
        # C 石窟（柱林里打伏击）
        (146, 106, '100001', 2),
        (204, 132, '200001', 3),
        (242, 148, '100001', 3),
        (160, 152, '200001', 3),
        # D 水榭（桥头与环廊）
        (20, 110, '100001', 2),
        (44, 156, '200001', 3),
        (110, 132, '100001', 3),
        (60, 100, '200001', 3),
    ]

    # 门（地图的一部分，LDtk 里可拖动）。环形动线上每区都有出口：
    # 一局只走 1/3 张图，无论走哪条路线都能找到门。
    portals = [
        # A 院落（含用户在 LDtk 里挪过的那扇 (58,30)）
        (22, 30),
        (58, 30),
        (105, 34),
        (64, 17),
        (38, 86),
        (86, 62),
        # B 东廊
        (135, 20),
        (250, 48),
        # C 石窟
        (140, 155),
        (250, 110),
        # D 水榭
        (10, 155),
        (120, 108),
    ]

    # 可破坏物（设计 10.5）：每区都有，高价值的舍利匣仍摆在怪的警戒圈里。
    destructibles = [
        ('crate', 16, 24), ('coffer', 28, 36),
        ('crate', 100, 24), ('coffer', 110, 36),
        ('crate', 58, 50), ('coffer', 70, 58),
        ('reliquary', 40, 44), ('reliquary', 96, 44),
        # B 东廊
        ('crate', 152, 30), ('coffer', 196, 78), ('reliquary', 240, 88),
        # C 石窟
        ('crate', 146, 124), ('coffer', 210, 120), ('reliquary', 250, 152),
        # D 水榭
        ('crate', 16, 104), ('coffer', 100, 120), ('reliquary', 56, 152),
    ]

    # 单局事件点（设计 10.2）：四区各一处，第 7 分钟按轮转刷在其中一个
    # 四区各一处：第 7 分钟的高价值物按顺序轮转刷在不同区（一局只走 1/3 张图）。
    event_sites = [(64, 32), (196, 60), (200, 145), (44, 130)]   # 院落 / 东廊 / 石窟 / 水榭桥头

    return t, props, spawn, monsters, portals, destructibles, event_sites



def validate_layout(t, spawn, monsters, portals, destructibles, event_sites):
    """点位自检：可走 + 从出生点可达。

    扩图时最容易犯的错就是「实体压在柱子上」或「新区的门没接通」——
    等症状在 import_map / 浏览器里出现，已经很难看出是哪一格的问题。
    """
    walkable = {FLOOR, PAVED}

    def walk(c, r):
        return 0 <= c < COLS and 0 <= r < ROWS and t[r][c] in walkable

    seen = {spawn}
    queue = [spawn]
    while queue:
        c, r = queue.pop()
        for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nxt = (c + dc, r + dr)
            if nxt not in seen and walk(*nxt):
                seen.add(nxt)
                queue.append(nxt)

    problems = []
    points = ([('Monster', m[0], m[1]) for m in monsters]
              + [('Portal', p[0], p[1]) for p in portals]
              + [('Destructible', d[1], d[2]) for d in destructibles]
              + [('EventSite', e[0], e[1]) for e in event_sites])
    for label, c, r in points:
        if not walk(c, r):
            problems.append('%s (%d,%d) 不可走' % (label, c, r))
        elif (c, r) not in seen:
            problems.append('%s (%d,%d) 从出生点走不到（通道没接通？）' % (label, c, r))
    return problems


def build():
    with open(SOURCE, 'r', encoding='utf-8') as fh:
        project = json.load(fh)
    atlas = load_atlas()

    project['defaultLevelWidth'] = COLS * GRID
    project['defaultLevelHeight'] = ROWS * GRID
    project['worlds'] = project.get('worlds', [])
    level = project['levels'][0]
    level['pxWid'] = COLS * GRID
    level['pxHei'] = ROWS * GRID

    terrain, props, spawn, monsters, portals, destructibles, event_sites = layout()

    # --- defs: tileset + one entity def per prop kind ------------------------
    defs = project['defs']
    # 固定 uid，保证脚本幂等（重跑逐字节一致）。1-99 留给人工在 LDtk 里加的东西。
    next_uid = int(project.get('nextUid') or 24)
    next_uid = max(next_uid, 100)

    # 重跑时先清掉上一次生成的内容，保证幂等。
    defs['tilesets'] = [t for t in defs.get('tilesets', []) if t.get('identifier') != 'xianxia']
    defs['layers'] = [l for l in defs['layers'] if l.get('identifier') != 'Props']
    defs['entities'] = [e for e in defs['entities']
                        if not str(e.get('identifier', '')).startswith('Prop_')
                        and e.get('identifier') not in ('Portal', 'Destructible', 'EventSite')]

    tileset_uid = 100
    next_uid = max(next_uid, tileset_uid + 1)
    defs['tilesets'] = defs['tilesets'] + [{
        'identifier': 'xianxia',
        'uid': tileset_uid,
        'relPath': 'tilesets/xianxia.png',
        'embedAtlas': None,
        'pxWid': atlas['width'],
        'pxHei': atlas['height'],
        'tileGridSize': atlas['tileGrid'],
        'spacing': 0,
        'padding': 0,
        'tags': [],
        'tagsSourceEnumUid': None,
        'enumTags': [],
        'customData': [],
        'savedSelections': [],
        'cachedPixelData': None,
    }]

    prop_layer_uid = 101
    next_uid = max(next_uid, prop_layer_uid + 1)
    # 以 Entities 图层定义为模板（不是 defs['layers'][0]：重排后第 0 个可能是 Terrain）。
    entities_layer_def = next(l for l in defs['layers'] if l['identifier'] == 'Entities')
    prop_layer = dict(entities_layer_def)
    prop_layer.update({
        '__type': 'Entities',
        'identifier': 'Props',
        'type': 'Entities',
        'uid': prop_layer_uid,
        'uiColor': '#C084FC',
        'gridSize': GRID,
        'intGridValues': [],
        'tilesetDefUid': None,
    })
    defs['layers'] = defs['layers'] + [prop_layer]
    # LDtk 的 defs.layers 是「由下往上」排列，layerInstances 必须同序；
    # 否则编辑器一打开就 tidy 重排，保存后文件大改。这里直接按绘制顺序写好。
    layer_order = {'Terrain': 0, 'Entities': 1, 'Props': 2}
    defs['layers'].sort(key=lambda l: layer_order.get(l['identifier'], 99))


    entity_uids = {}
    for index, kind in enumerate(('wall_run', 'censer', 'terrace')):
        uid = 102 + index
        next_uid = max(next_uid, uid + 1)
        rect_px = atlas['props'][kind]
        entity_uids[kind] = uid
        defs['entities'].append({
            'identifier': 'Prop_' + kind,
            'uid': uid,
            'tags': [],
            'exportToToc': True,
            'allowOutOfBounds': True,
            'doc': 'Rendered from the asset-library atlas (tilesets/xianxia.png).',
            'width': rect_px['w'],
            'height': rect_px['h'],
            'resizableX': False,
            'resizableY': False,
            'minWidth': None,
            'maxWidth': None,
            'minHeight': None,
            'maxHeight': None,
            'keepAspectRatio': True,
            'tileOpacity': 1,
            'fillOpacity': 0,
            'lineOpacity': 0,
            'hollow': False,
            'color': '#C084FC',
            'renderMode': 'Tile',
            'showName': False,
            'tilesetId': tileset_uid,
            'tileRenderMode': 'FitInside',
            'tileRect': {'tilesetUid': tileset_uid, 'x': rect_px['x'], 'y': rect_px['y'],
                         'w': rect_px['w'], 'h': rect_px['h']},
            'uiTileRect': None,
            'nineSliceBorders': [],
            'maxCount': -1,
            'limitScope': 'PerLevel',
            'limitBehavior': 'MoveLastOne',
            'pivotX': 0.5,
            'pivotY': 1,
            'fieldDefs': [],
        })

    project['nextUid'] = next_uid

    # --- Portal entity def (extraction) -------------------------------------
    # 复用 Monster 的 def 形状（Rectangle 渲染、pivot 底部中心），只换颜色与字段。
    # uid 固定 105，保证脚本幂等；重跑时上面已把旧 Portal def 清掉。
    portal_uid = 105
    next_uid = max(next_uid, portal_uid + 1)
    monster_def = next(e for e in defs['entities'] if e['identifier'] == 'Monster')
    portal_def = dict(monster_def)
    portal_def.update({
        'identifier': 'Portal',
        'uid': portal_uid,
        'fieldDefs': [],
        'color': '#67E8F9',
        'showName': True,
        'doc': 'Extraction portal. Placed in this layer: the run reads these '
               'instances directly, so move/add/remove them here.',
    })
    defs['entities'].append(portal_def)
    project['nextUid'] = max(project.get('nextUid') or 0, next_uid)

    # --- Destructible / EventSite defs (设计 10.2 / 10.5) -------------------
    # 和 Portal 同一个套路：复用 Monster 的 def 形状，只换颜色与字段。
    # uid 与 `add_destructible_entities.py` 对齐（106 / 107 / 108），
    # 这样「重新生成」与「在已有文件上追加」得到同一份数据。
    kind_field_uid = 108
    next_uid = max(next_uid, kind_field_uid + 1)
    monster_field_template = dict(
        next(e for e in defs['entities'] if e['identifier'] == 'Monster')['fieldDefs'][0])
    kind_field = dict(monster_field_template)
    kind_field.update({
        'identifier': 'kind',
        'uid': kind_field_uid,
        'defaultOverride': {'id': 'V_String', 'params': ['crate']},
    })
    destructible_def = dict(monster_def)
    destructible_def.update({
        'identifier': 'Destructible',
        'uid': 106,
        'color': '#F59E0B',
        'showName': True,
        'fieldDefs': [kind_field],
        'doc': '可破坏物（设计 10.5）：站在旁边按左键砸开。kind 必须是 '
               'tables/destructible.xlsx 的行。',
    })
    event_site_def = dict(monster_def)
    event_site_def.update({
        'identifier': 'EventSite',
        'uid': 107,
        'color': '#FCD34D',
        'showName': True,
        'fieldDefs': [],
        'doc': '单局事件点（设计 10.2）：第 7 分钟的高价值物刷在这里。',
    })
    defs['entities'].append(destructible_def)
    defs['entities'].append(event_site_def)
    project['nextUid'] = max(project.get('nextUid') or 0, next_uid)

    # --- layer instances ----------------------------------------------------
    # 按 __identifier 取，不按数组下标：本脚本重跑后图层顺序会变，下标会取错层。
    def find_layer(name):
        for layer in level['layerInstances']:
            if layer.get('__identifier') == name:
                return dict(layer)
        return None

    terrain_inst = find_layer('Terrain')
    entities_inst = find_layer('Entities')
    if terrain_inst is None or entities_inst is None:
        raise SystemExit('arena.ldtk 缺少 Terrain / Entities 图层，先 git checkout 恢复基线')

    terrain_inst.update({
        '__cWid': COLS,
        '__cHei': ROWS,
        'intGridCsv': [terrain[r][c] for r in range(ROWS) for c in range(COLS)],
        'autoLayerTiles': [],
        'gridTiles': [],
        'entityInstances': [],
    })

    def entity(identifier, uid, col, row, width, height, px, fields=(), tile=None):
        iid = str(uuid.uuid5(uuid.NAMESPACE_URL, f'arena/{identifier}/{col}/{row}/{len(fields)}'))
        return {
            '__grid': [col, row],
            '__identifier': identifier,
            '__pivot': [0.5, 1],
            '__smartColor': '#C084FC',
            '__tags': [],
            # 实体的图块：LDtk 保存时会写上，缺了编辑器可能不画图集贴图。
            '__tile': tile,
            'defUid': uid,
            'fieldInstances': list(fields),
            'height': height,
            'width': width,
            'iid': iid,
            'px': px,
        }

    spawn_uid = next(e['uid'] for e in defs['entities'] if e['identifier'] == 'PlayerSpawn')
    monster_uid = next(e['uid'] for e in defs['entities'] if e['identifier'] == 'Monster')
    # 字段实例必须带真实的 defUid，且值只认 realEditorValues 的 {id, params} 形式；
    # __value 只是导出给人看的，LDtk 编辑器读的是 realEditorValues。
    monster_field_uids = {
        fd['identifier']: fd['uid']
        for fd in next(e for e in defs['entities'] if e['identifier'] == 'Monster')['fieldDefs']
    }

    def monster_field(mid, wave):
        return [
            {'__identifier': 'monsterId', '__type': 'String', '__value': mid, '__tile': None,
             'defUid': monster_field_uids['monsterId'],
             'realEditorValues': [{'id': 'V_String', 'params': [mid]}]},
            {'__identifier': 'wave', '__type': 'Int', '__value': wave, '__tile': None,
             'defUid': monster_field_uids['wave'],
             'realEditorValues': [{'id': 'V_Int', 'params': [wave]}]},
        ]

    spawns = [entity('PlayerSpawn', spawn_uid, spawn[0], spawn[1], GRID, GRID,
                     [spawn[0] * GRID + GRID // 2, (spawn[1] + 1) * GRID])]
    for col, row, mid, wave in monsters:
        spawns.append(entity('Monster', monster_uid, col, row, GRID, GRID,
                             [col * GRID + GRID // 2, (row + 1) * GRID],
                             monster_field(mid, wave)))
    # 传送门实例与出生点 / 怪同层：一次遍历就能读到本局的全部「点位」。
    for col, row in portals:
        spawns.append(entity('Portal', portal_uid, col, row, GRID, GRID,
                             [col * GRID + GRID // 2, (row + 1) * GRID]))
    destructible_uid = 106
    event_site_uid = 107
    kind_def_uid = 108
    for kind, col, row in destructibles:
        field = {
            '__identifier': 'kind', '__type': 'String', '__value': kind, '__tile': None,
            'defUid': kind_def_uid,
            'realEditorValues': [{'id': 'V_String', 'params': [kind]}],
        }
        spawns.append(entity('Destructible', destructible_uid, col, row, GRID, GRID,
                             [col * GRID + GRID // 2, (row + 1) * GRID], [field]))
    for col, row in event_sites:
        spawns.append(entity('EventSite', event_site_uid, col, row, GRID, GRID,
                             [col * GRID + GRID // 2, (row + 1) * GRID]))
    entities_inst.update({'entityInstances': spawns})

    prop_instances = []
    for kind, col, row in props:
        rect_px = atlas['props'][kind]
        prop_instances.append(entity(
            'Prop_' + kind, entity_uids[kind], col, row,
            rect_px['w'], rect_px['h'],
            [col * GRID + (rect_px.get('footprintW', 1) * GRID) // 2,
             (row + rect_px.get('footprintH', 1)) * GRID],
            tile={'tilesetUid': tileset_uid, 'x': rect_px['x'], 'y': rect_px['y'],
                  'w': rect_px['w'], 'h': rect_px['h']},
        ))
    # 图层实例必须是「实例」，不能把图层定义的键（uiColor / autoRuleGroups …）混进来：
    # LDtk 反序列化后按 def 指针读，混进来的 uid 会覆盖 layerDefUid 造成错层。
    level_uid = level['uid']
    props_inst = {
        '__identifier': 'Props',
        '__type': 'Entities',
        '__cWid': COLS,
        '__cHei': ROWS,
        '__gridSize': GRID,
        '__opacity': 1,
        '__pxTotalOffsetX': 0,
        '__pxTotalOffsetY': 0,
        '__tilesetDefUid': None,
        '__tilesetRelPath': None,
        'iid': str(uuid.uuid5(uuid.NAMESPACE_URL, 'arena/layer/Props')),
        'levelId': level_uid,
        'layerDefUid': prop_layer_uid,
        'pxOffsetX': 0,
        'pxOffsetY': 0,
        'visible': True,
        'optionalRules': [],
        'intGridCsv': [],
        'autoLayerTiles': [],
        'seed': 0,
        'overrideTilesetUid': None,
        'gridTiles': [],
        'entityInstances': prop_instances,
    }

    # 与 defs.layers 同序（由下往上）：Terrain -> Entities -> Props。
    level['layerInstances'] = [terrain_inst, entities_inst, props_inst]
    return project, len(props), len(monsters), len(portals)


def validate(project):
    """LDtk 能打开这个文件所需的不变量。返回问题列表（空表示通过）。

    这些不是风格问题，是「LDtk 反序列化阶段就会 throw」的硬约束：
      - layerInstances 必须与 defs.layers 同序同 uid（否则 tidy 重排 + 编辑器错层）
      - 图层实例必须有 iid
      - IntGrid 值数量 = __cWid * __cHei
      - 实体/字段实例的 defUid 必须指向真实定义（NULL 会让 LDtk 读 fi.def.type 时崩）
      - 实体的 tileRect 必须自带 tilesetUid（JsonTools.readTileRect 会直接 throw）
      - 图集文件必须存在
    """
    problems = []
    defs = project.get('defs') or {}
    layer_defs = defs.get('layers') or []
    tilesets = {t['uid']: t for t in defs.get('tilesets') or []}
    entity_defs = {e['uid']: e for e in defs.get('entities') or []}
    levels = project.get('levels') or []

    if len(levels) != 1:
        problems.append('levels 数量应为 1，实际 %d' % len(levels))
    if not levels:
        return problems

    level = levels[0]
    for edef in entity_defs.values():
        rect = edef.get('tileRect')
        if rect is not None and rect.get('tilesetUid') not in tilesets:
            problems.append('实体定义 %s 的 tileRect 没有合法 tilesetUid（LDtk 会拒绝打开）'
                            % edef.get('identifier'))

    for tileset in tilesets.values():
        path = os.path.join(os.path.dirname(SOURCE), tileset['relPath'])
        if not os.path.isfile(path):
            problems.append('图集文件不存在：%s' % path)

    instances = level.get('layerInstances') or []
    if len(instances) != len(layer_defs):
        problems.append('layerInstances 数量 %d 与 defs.layers 数量 %d 不一致'
                        % (len(instances), len(layer_defs)))
    for index, layer_def in enumerate(layer_defs):
        if index >= len(instances):
            break
        inst = instances[index]
        if inst.get('layerDefUid') != layer_def['uid']:
            problems.append('layerInstances[%d] 的 layerDefUid=%r，应为 %r（顺序必须与 defs.layers 一致）'
                            % (index, inst.get('layerDefUid'), layer_def['uid']))
        if not inst.get('iid'):
            problems.append('layerInstances[%d]（%s）缺 iid'
                            % (index, inst.get('__identifier')))
        if layer_def.get('type') == 'IntGrid':
            want = int(inst.get('__cWid') or 0) * int(inst.get('__cHei') or 0)
            got = len(inst.get('intGridCsv') or [])
            if want and got != want:
                problems.append('%s 的 intGridCsv 有 %d 个值，应为 %d'
                                % (layer_def['identifier'], got, want))
        for ei in inst.get('entityInstances') or []:
            edef = entity_defs.get(ei.get('defUid'))
            if edef is None:
                problems.append('实体 %s 的 defUid=%r 在 defs.entities 中不存在'
                                % (ei.get('__identifier'), ei.get('defUid')))
                continue
            field_uids = {fd['uid'] for fd in edef.get('fieldDefs') or []}
            for fi in ei.get('fieldInstances') or []:
                if fi.get('defUid') not in field_uids:
                    problems.append('实体 %s 的字段 %s 的 defUid=%r 不是该实体的字段定义'
                                    % (ei.get('__identifier'), fi.get('__identifier'),
                                       fi.get('defUid')))
                elif not fi.get('realEditorValues') and fi.get('__value') not in (None, ''):
                    problems.append('实体 %s 的字段 %s 有 __value 但 realEditorValues 为空，'
                                    'LDtk 里会显示成空值'
                                    % (ei.get('__identifier'), fi.get('__identifier')))
            tile = ei.get('__tile')
            if tile is not None and tile.get('tilesetUid') not in tilesets:
                problems.append('实体 %s 的 __tile 指向不存在的图集 %r'
                                % (ei.get('__identifier'), tile.get('tilesetUid')))

    return problems


def main():
    check = '--check' in sys.argv
    if check:
        with open(SOURCE, 'r', encoding='utf-8') as fh:
            current = json.load(fh)
        problems = validate(current)
        for problem in problems:
            print('[FAIL] %s' % problem)
        if problems:
            print('[FAIL] arena.ldtk 结构自检未通过（%d 项），LDtk 可能打不开' % len(problems))
            sys.exit(1)
        print('[ OK ] arena.ldtk 结构自检通过（LDtk 可打开）')
        return

    project, prop_count, monster_count, portal_count = build()
    terrain, _props, spawn, monsters, portals, destructibles, event_sites = layout()
    layout_problems = validate_layout(
        terrain, spawn, monsters, portals, destructibles, event_sites)
    if layout_problems:
        for problem in layout_problems:
            print('[FAIL] %s' % problem)
        sys.exit(1)
    problems = validate(project)
    if problems:
        for problem in problems:
            print('[FAIL] %s' % problem)
        sys.exit(1)
    text = json.dumps(project, indent=1, ensure_ascii=False) + '\n'
    with open(SOURCE, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(text)
    print(f'[ OK ] arena.ldtk {COLS}x{ROWS} 格（{COLS * GRID}x{ROWS * GRID}px），'
          f'{prop_count} 个 props，{monster_count} 只怪，{portal_count} 扇传送门')


if __name__ == '__main__':
    main()
