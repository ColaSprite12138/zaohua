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

COLS = 128
ROWS = 96
GRID = 32

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


def layout():
    t = blank()
    props = []

    # --- outer boundary -----------------------------------------------------
    # 1-tile wall ring; the gaps are gates (walkable, purely visual).
    # 北墙做 3 格厚：院墙模块高 96px（3 格），立在 row 2 上正好把顶端留在 y=0，
    # 否则相机 clamp 在 0 会把墙上半截裁掉。
    rect(t, 0, 0, COLS - 1, 2, WALL)
    for c in range(COLS):
        t[ROWS - 1][c] = WALL
    for r in range(ROWS):
        t[r][0] = WALL
        t[r][COLS - 1] = WALL
    # Gates: south (main), east, west. 北面被高台挡住，不开门。
    for c in range(60, 68):
        t[ROWS - 1][c] = PAVED
    for r in range(44, 52):
        t[r][0] = PAVED
        t[r][COLS - 1] = PAVED

    # --- north terrace (raised deck, blocked) -------------------------------
    # 浮空平台是 12x10 格；放在正中偏北，作为场地尽头的高台。
    TERRACE_C, TERRACE_R = 58, 4
    rect(t, TERRACE_C, TERRACE_R, TERRACE_C + 11, TERRACE_R + 9, WALL)
    props.append(('terrace', TERRACE_C, TERRACE_R))
    # 台前两段台阶用地砖表现，不阻挡（走上去＝视觉上的台阶）。
    rect(t, TERRACE_C, TERRACE_R + 10, TERRACE_C + 11, TERRACE_R + 11, PAVED)


    # --- west / east halls (hollow compounds with doors) ---------------------
    hollow(t, 10, 20, 34, 40, WALL, doors=((22, 40), (22, 20), (10, 30)))
    hollow(t, 93, 20, 117, 40, WALL, doors=((105, 40), (105, 20), (117, 30)))
    # 大厅内部的铺装地面（视觉与普通地面区分）。
    rect(t, 11, 21, 33, 39, PAVED)
    rect(t, 94, 21, 116, 39, PAVED)

    # --- ruined wall runs in the courtyard ----------------------------------
    # 全部对齐到 8 的倍数，才能无缝拼 8 格宽的院墙模块。
    runs = [
        (24, 56, 2),   # (col, row, modules)
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

    # 北/南边界也用模块立起来（8 格一段，正好铺满 128 格）。
    for c0 in range(0, COLS, WALL_RUN_TILES):
        if 48 <= c0 <= 72:      # 高台正面，留给台阶
            continue
        props.append(('wall_run', c0, 2))
    for c0 in range(0, COLS, WALL_RUN_TILES):
        if 56 <= c0 <= 64:      # 南门
            continue
        props.append(('wall_run', c0, ROWS - 1))

    # --- censers (decorative, walk-through) ---------------------------------
    for col, row in [(54, 16), (71, 16), (60, 82), (67, 82), (14, 18), (112, 18), (14, 42), (112, 42)]:
        props.append(('censer', col, row))

    # --- spawn + monsters ---------------------------------------------------
    spawn = (64, 84)
    monsters = [
        (30, 30, '100001', 1),
        (105, 30, '100001', 1),
        (22, 58, '200001', 2),
        (106, 58, '200001', 2),
        (44, 46, '100001', 2),
        (84, 46, '100001', 3),
        (64, 70, '200001', 3),
    ]
    return t, props, spawn, monsters


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

    terrain, props, spawn, monsters = layout()

    # --- defs: tileset + one entity def per prop kind ------------------------
    defs = project['defs']
    # 固定 uid，保证脚本幂等（重跑逐字节一致）。1-99 留给人工在 LDtk 里加的东西。
    next_uid = int(project.get('nextUid') or 24)
    next_uid = max(next_uid, 100)

    # 重跑时先清掉上一次生成的内容，保证幂等。
    defs['tilesets'] = [t for t in defs.get('tilesets', []) if t.get('identifier') != 'xianxia']
    defs['layers'] = [l for l in defs['layers'] if l.get('identifier') != 'Props']
    defs['entities'] = [e for e in defs['entities'] if not str(e.get('identifier', '')).startswith('Prop_')]

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
    return project, len(props), len(monsters)


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

    project, prop_count, monster_count = build()
    problems = validate(project)
    if problems:
        for problem in problems:
            print('[FAIL] %s' % problem)
        sys.exit(1)
    text = json.dumps(project, indent=1, ensure_ascii=False) + '\n'
    with open(SOURCE, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(text)
    print(f'[ OK ] arena.ldtk {COLS}x{ROWS} 格（{COLS * GRID}x{ROWS * GRID}px），'
          f'{prop_count} 个 props，{monster_count} 只怪')


if __name__ == '__main__':
    main()
