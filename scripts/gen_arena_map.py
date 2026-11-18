#!/usr/bin/env python3
"""Generate the arena (arena.ldtk) from the layout in `arena_layout.py`.

    python scripts/gen_arena_map.py            # rewrite assets/resource/maps/arena.ldtk
    python scripts/gen_arena_map.py --check    # validate the current .ldtk (LDtk-openable?)

**布局不在这里**：地块形状、分区轮廓、建筑、走廊、实体点位全在 `arena_layout.py`
（2026-11-18 重做：840×544 格 / 五个不规则地块（四区 + 正中宝库）/ 每区不同的地形语言）。
这个文件只负责把布局写进 LDtk 的 JSON 结构，以及"LDtk 能打开"的结构自检。

The output .ldtk stays the human-authored source afterwards: open it in LDtk,
edit, save. Re-running this script overwrites those edits, so only run it when
you actually want the generated layout back.

`--check` therefore does NOT compare against the generator output (a file edited
in LDtk would always differ). It asserts the invariants LDtk needs to load the
file at all - the ones that used to make the editor die with
"Cannot read properties of null (reading 'externalLevels')".

Layers written:
  Terrain  (IntGrid)  0 floor / 1 wall / 2 paved / 3 void   - collision authority
  Entities             PlayerSpawn + Monster + Portal + Destructible + EventSite
  Props    (Entities)  censer / terrace instances, rendered with the atlas tile
                       in the LDtk editor (tileRect per entity def)

The floor itself is NOT a Tile layer: 322560 grid-tile entries would bloat the
JSON by megabytes. Floor variants are derived from (col,row) at runtime.
"""
from __future__ import annotations

import json
import os
import sys
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import arena_layout as L  # noqa: E402

ROOT = os.path.dirname(HERE)
MAPS = os.path.join(ROOT, 'assets', 'resource', 'maps')
SOURCE = os.path.join(MAPS, 'arena.ldtk')
ATLAS = os.path.join(MAPS, 'tilesets', 'xianxia.json')

COLS = L.COLS
ROWS = L.ROWS
GRID = L.GRID
ZONES = L.ZONES
layout = L.layout


def load_atlas():
    with open(ATLAS, 'r', encoding='utf-8') as fh:
        return json.load(fh)


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
    _terrain, _props, spawn, monsters, portals, destructibles, event_sites = layout()
    layout_problems = L.verify(L.last_canvas(), spawn, monsters, portals,
                               destructibles, event_sites)
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
