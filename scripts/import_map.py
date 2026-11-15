#!/usr/bin/env python3
"""Export assets/resource/maps/arena.ldtk -> maps/arena.generated.ts.

The .ldtk project is the human-authored source (LDtk 1.5.3). The Terrain
IntGrid layer becomes a per-row terrain string, the Entities layer becomes a
typed spawn/monster list. Nothing in here invents gameplay numbers: monsterId
must already exist in generated/monster.ts.

    python scripts/import_map.py            # regenerate
    python scripts/import_map.py --check   # fail if the generated file is stale

The output deliberately lives in maps/, NOT generated/: export_tables.py
removes every file in generated/ that is not backed by an .xlsx source table.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAPS = os.path.join(ROOT, 'assets', 'resource', 'maps')
SOURCE = os.path.join(MAPS, 'arena.ldtk')
OUTPUT = os.path.join(MAPS, 'arena.generated.ts')
ATLAS_PROPS = os.path.join(MAPS, 'tilesets', 'xianxia.json')
MONSTER_TABLE = os.path.join(ROOT, 'assets', 'resource', 'generated', 'monster.ts')
DESTRUCTIBLE_TABLE = os.path.join(ROOT, 'assets', 'resource', 'generated', 'destructible.ts')

VALID_TILES = {0, 1, 2, 3}
WALKABLE = {0, 2}
TERRAIN_LEGEND = '0123'


def fail(msg):
    print('FAILED: %s' % msg)
    sys.exit(1)


def load_monster_ids():
    return load_ids(MONSTER_TABLE, 'monster')


def load_destructible_ids():
    return load_ids(DESTRUCTIBLE_TABLE, 'destructible (run export_tables.py first)')


def load_ids(path, label):
    if not os.path.isfile(path):
        fail('missing %s (%s)' % (path, label))
    with open(path, 'r', encoding='utf-8') as fh:
        text = fh.read()
    ids = set(re.findall(r'\{\s*id:\s*"([^"]+)"', text))
    if not ids:
        fail('could not read any id from %s' % path)
    return ids


def load_project():
    if not os.path.isfile(SOURCE):
        fail('missing authoring source %s' % SOURCE)
    with open(SOURCE, 'rb') as fh:
        raw = fh.read()
    digest = hashlib.sha256(raw).hexdigest()
    try:
        project = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, ValueError) as exc:
        fail('arena.ldtk is not valid UTF-8 JSON: %s' % exc)
    if not str(project.get('jsonVersion', '')).startswith('1.5.'):
        fail('unsupported LDtk jsonVersion %r (expected 1.5.x)' % project.get('jsonVersion'))
    if project.get('externalLevels') is not False:
        fail('set "Save levels separately" to OFF; externalLevels must be false')
    levels = project.get('levels') or []
    if len(levels) != 1:
        fail('expected exactly one level, found %d' % len(levels))
    return project, levels[0], digest


def read_layers(level, grid_size):
    layers = level.get('layerInstances')
    if not layers:
        fail('level has no layerInstances')
    int_layers = [li for li in layers if li.get('__type') == 'IntGrid']
    entity_layers = [li for li in layers if li.get('__type') == 'Entities']
    if len(int_layers) != 1:
        fail('expected exactly one IntGrid layer, found %d' % len(int_layers))
    terrain_layer = int_layers[0]
    cols = terrain_layer.get('__cWid')
    rows = terrain_layer.get('__cHei')
    if not isinstance(cols, int) or not isinstance(rows, int) or cols < 1 or rows < 1:
        fail('invalid IntGrid dimensions %r x %r' % (cols, rows))
    if terrain_layer.get('__gridSize') != grid_size:
        fail('IntGrid gridSize %r != project defaultGridSize %r' %
             (terrain_layer.get('__gridSize'), grid_size))
    if level.get('pxWid') != cols * grid_size or level.get('pxHei') != rows * grid_size:
        fail('level px size %r x %r does not match %d x %d cells @ %dpx' %
             (level.get('pxWid'), level.get('pxHei'), cols, rows, grid_size))

    csv = terrain_layer.get('intGridCsv') or []
    if len(csv) != cols * rows:
        fail('intGridCsv has %d cells, expected %d' % (len(csv), cols * rows))
    bad = sorted({v for v in csv if v not in VALID_TILES})
    if bad:
        fail('intGridCsv contains unsupported values %s (allowed 0/1/2/3)' % bad)
    grid = [csv[r * cols:(r + 1) * cols] for r in range(rows)]

    entities = []
    for layer in entity_layers:
        for inst in layer.get('entityInstances') or []:
            # Remember which layer an instance came from: a Portal dragged into
            # the Props layer still works, but it is almost always a mis-drop.
            entities.append({**inst, '__layer': layer.get('__identifier')})
    return cols, rows, grid, entities


PROP_PREFIX = 'Prop_'
PROP_KINDS = {'wall_run', 'censer', 'terrace'}


def load_prop_footprints():
    """Occupied cells per prop kind, from the same atlas the game paints with."""
    with open(ATLAS_PROPS, 'r', encoding='utf-8') as fh:
        atlas = json.load(fh)
    out = {}
    for kind, rect in (atlas.get('props') or {}).items():
        out[kind] = (int(rect.get('footprintW', 1)), int(rect.get('footprintH', 1)))
    return out


def read_entities(entities, cols, rows, grid, grid_size, monster_ids, destructible_ids):
    spawn = None
    monsters = []
    props = []
    portals = []
    destructibles = []
    event_sites = []
    footprints = load_prop_footprints()
    seen_ids = set()
    for ent in entities:
        ident = ent.get('__identifier')
        is_prop = str(ident).startswith(PROP_PREFIX)
        kind = str(ident)[len(PROP_PREFIX):] if is_prop else ''
        if is_prop and kind not in PROP_KINDS:
            fail('unknown prop kind %r (allowed: %s)' % (kind, ', '.join(sorted(PROP_KINDS))))
        # `__grid` is LDtk's own idea of where the entity sits, and it CHANGES
        # when LDtk re-saves the file: for a prop it becomes the pivot cell, not
        # the top-left of the footprint (a 8-wide wall run jumped 4 cells right,
        # the 12-wide terrace 6). Re-running the importer after any LDtk save
        # therefore used to shift every prop. The world pixel anchor (`px`) is
        # stable, so derive the cell from it instead.
        span = footprints.get(kind, (1, 1)) if is_prop else (1, 1)
        pixel = ent.get('px') or []
        if len(pixel) == 2 and all(isinstance(v, (int, float)) for v in pixel):
            col = int(round(pixel[0] / grid_size - span[0] / 2))
            row = int(round(pixel[1] / grid_size - span[1]))
        else:
            cell = ent.get('__grid') or []
            if len(cell) != 2 or not all(isinstance(v, int) for v in cell):
                fail('entity %r has neither a usable px nor __grid' % (ident,))
            col, row = cell
        if not (0 <= col < cols and 0 <= row < rows):
            fail('entity %r at (%d,%d) is outside the map' % (ident, col, row))
        fields = {}
        for fi in ent.get('fieldInstances') or []:
            fields[fi.get('__identifier')] = fi.get('__value')
        eid = '%s_%d_%d' % (str(ident).lower(), col, row)
        if is_prop:
            # Props 是纯装饰：不参与碰撞、不参与 --check 的唯一性约束之外的逻辑，
            # 只按落位顺序画，所以允许同一格叠放（香炉可以摆在墙脚）。
            props.append({'kind': kind, 'col': col, 'row': row})
            continue
        if eid in seen_ids:
            fail('duplicate entity at (%d,%d)' % (col, row))
        seen_ids.add(eid)
        x = col * grid_size + grid_size // 2
        y = row * grid_size + grid_size // 2

        if ident == 'PlayerSpawn':
            if spawn is not None:
                fail('more than one PlayerSpawn')
            if grid[row][col] not in WALKABLE:
                fail('PlayerSpawn at (%d,%d) is not walkable' % (col, row))
            spawn = {'id': eid, 'col': col, 'row': row, 'x': x, 'y': y}
        elif ident == 'Monster':
            mid = fields.get('monsterId')
            if not isinstance(mid, str) or mid not in monster_ids:
                fail('Monster at (%d,%d) has monsterId %r; add it to '
                     'tables/monster.xlsx then run export_tables.py' % (col, row, mid))
            if grid[row][col] not in WALKABLE:
                fail('Monster at (%d,%d) is not walkable' % (col, row))
            wave = fields.get('wave', 1)
            if not isinstance(wave, int) or isinstance(wave, bool):
                fail('Monster at (%d,%d) has non-integer wave %r' % (col, row, wave))
            monsters.append({
                'id': eid, 'monsterId': mid, 'col': col, 'row': row,
                'x': x, 'y': y, 'wave': wave,
            })
        elif ident == 'Portal':
            # 传送门是地图的一部分（需求 2026-11-14）：位置在这里读，运行时不再猜。
            if grid[row][col] not in WALKABLE:
                fail('Portal at (%d,%d) is not walkable' % (col, row))
            if ent.get('__layer') not in (None, 'Entities'):
                # 不是错误：拖门时图层没切对，门照样生效。但要让人知道它放错层了。
                print('[warn] Portal at (%d,%d) sits in layer %r; Entities is the '
                      'intended layer' % (col, row, ent.get('__layer')), file=sys.stderr)
            portals.append({'id': eid, 'col': col, 'row': row, 'x': x, 'y': y})
        elif ident == 'Destructible':
            # 可破坏物（设计 10.5）：位置是地图的一部分，kind 必须是表里的行。
            kind = fields.get('kind')
            if not isinstance(kind, str) or kind not in destructible_ids:
                fail('Destructible at (%d,%d) has kind %r; add it to '
                     'tables/destructible.xlsx then run export_tables.py'
                     % (col, row, kind))
            if grid[row][col] not in WALKABLE:
                fail('Destructible at (%d,%d) is not walkable' % (col, row))
            destructibles.append({
                'id': eid, 'kind': kind, 'col': col, 'row': row, 'x': x, 'y': y,
            })
        elif ident == 'EventSite':
            # 单局事件点（设计 10.2）：第 7 分钟的高价值物刷在这里。
            if grid[row][col] not in WALKABLE:
                fail('EventSite at (%d,%d) is not walkable' % (col, row))
            event_sites.append({'id': eid, 'col': col, 'row': row, 'x': x, 'y': y})
        else:
            fail('unknown entity type %r' % ident)

    if spawn is None:
        fail('level has no PlayerSpawn')
    if not portals:
        fail('level has no Portal: a run would have no way out')
    return spawn, monsters, props, portals, destructibles, event_sites


def reachability(grid, cols, rows, spawn):
    seen = {(spawn['col'], spawn['row'])}
    queue = [(spawn['col'], spawn['row'])]
    while queue:
        col, row = queue.pop(0)
        for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nc, nr = col + dc, row + dr
            if not (0 <= nc < cols and 0 <= nr < rows):
                continue
            if (nc, nr) in seen or grid[nr][nc] not in WALKABLE:
                continue
            seen.add((nc, nr))
            queue.append((nc, nr))
    return seen


def render(project, level, digest, cols, rows, grid, grid_size, spawn, monsters, props, portals,
           destructibles, event_sites):
    lines = [
        '/* GENERATED by scripts/import_map.py - DO NOT EDIT.',
        ' * source: maps/arena.ldtk',
        ' * sha256: %s' % digest,
        ' */',
        '// Terrain chars: 0 floor (walkable), 1 wall (blocks move + sight),',
        '// 2 road (walkable), 3 void (blocks move + sight).',
        'export const arena = {',
        '  id: %s,' % json.dumps(level.get('identifier', 'arena')),
        '  gridSize: %d,' % grid_size,
        '  cols: %d,' % cols,
        '  rows: %d,' % rows,
        '  pxWid: %d,' % (cols * grid_size),
        '  pxHei: %d,' % (rows * grid_size),
        '  terrain: [',
    ]
    for row in grid:
        lines.append('    %s,' % json.dumps(''.join(TERRAIN_LEGEND[v] for v in row)))
    lines.extend([
        '  ],',
        '  spawn: { id: %s, col: %d, row: %d, x: %d, y: %d },' %
        (json.dumps(spawn['id']), spawn['col'], spawn['row'], spawn['x'], spawn['y']),
        '  monsters: [',
    ])
    for m in monsters:
        lines.append('    { id: %s, monsterId: %s, col: %d, row: %d, x: %d, y: %d, wave: %d },' %
                     (json.dumps(m['id']), json.dumps(m['monsterId']), m['col'], m['row'],
                      m['x'], m['y'], m['wave']))
    lines.extend(['  ],', '  // 装饰层：像素矩形与锚点在 maps/tileset.generated.ts 的 ATLAS_PROPS 里，',
                  '  // 这里只记"放什么、放哪格"，深度排序用 (row + footprintH)。', '  props: ['])
    for p in props:
        lines.append('    { kind: %s, col: %d, row: %d },' %
                     (json.dumps(p['kind']), p['col'], p['row']))
    lines.extend(['  ],',
                  '  // 撤离传送门：位置由 LDtk 的 Entities 层决定（编辑器里可拖动），',
                  '  // 运行时 `createPortals()` 只做吸附与去重，不再自己布点。',
                  '  portals: ['])
    for p in portals:
        lines.append('    { id: %s, col: %d, row: %d, x: %d, y: %d },' %
                     (json.dumps(p['id']), p['col'], p['row'], p['x'], p['y']))
    lines.extend(['  ],',
                  '  // 可破坏物（设计 10.5）：位置是地图的一部分，kind 是',
                  '  // tables/destructible.xlsx 的行（砸开秒数 / 声响 / 守卫门槛 / 产出池）。',
                  '  destructibles: ['])
    for d in destructibles:
        lines.append('    { id: %s, kind: %s, col: %d, row: %d, x: %d, y: %d },' %
                     (json.dumps(d['id']), json.dumps(d['kind']), d['col'], d['row'],
                      d['x'], d['y']))
    lines.extend(['  ],',
                  '  // 单局事件点（设计 10.2）：第 7 分钟的高价值物刷在这里。',
                  '  eventSites: ['])
    for e in event_sites:
        lines.append('    { id: %s, col: %d, row: %d, x: %d, y: %d },' %
                     (json.dumps(e['id']), e['col'], e['row'], e['x'], e['y']))
    lines.extend(['  ],', '} as const;', '', 'export type ArenaMap = typeof arena;', ''])
    return '\n'.join(lines)


def main():
    check = '--check' in sys.argv[1:]
    monster_ids = load_monster_ids()
    destructible_ids = load_destructible_ids()
    project, level, digest = load_project()
    grid_size = project.get('defaultGridSize')
    if not isinstance(grid_size, int) or grid_size < 1:
        fail('invalid defaultGridSize %r' % grid_size)
    cols, rows, grid, entities = read_layers(level, grid_size)
    spawn, monsters, props, portals, destructibles, event_sites = read_entities(
        entities, cols, rows, grid, grid_size, monster_ids, destructible_ids)
    seen = reachability(grid, cols, rows, spawn)
    for m in monsters:
        if (m['col'], m['row']) not in seen:
            fail('Monster %s at (%d,%d) is unreachable from spawn' %
                 (m['id'], m['col'], m['row']))
    for p in portals:
        if (p['col'], p['row']) not in seen:
            fail('Portal %s at (%d,%d) is unreachable from spawn' %
                 (p['id'], p['col'], p['row']))
    for d in destructibles:
        if (d['col'], d['row']) not in seen:
            fail('Destructible %s at (%d,%d) is unreachable from spawn' %
                 (d['id'], d['col'], d['row']))
    for e in event_sites:
        if (e['col'], e['row']) not in seen:
            fail('EventSite %s at (%d,%d) is unreachable from spawn' %
                 (e['id'], e['col'], e['row']))
    content = render(project, level, digest, cols, rows, grid, grid_size,
                     spawn, monsters, props, portals, destructibles, event_sites)

    if check:
        have = None
        if os.path.isfile(OUTPUT):
            with open(OUTPUT, 'r', encoding='utf-8') as fh:
                have = fh.read()
        if have != content:
            fail('maps/arena.generated.ts is stale; run python scripts/import_map.py')
        print('OK: maps/arena.generated.ts matches arena.ldtk (sha256=%s)' % digest[:12])
        return 0

    with open(OUTPUT, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(content)
    print('[ok] %s' % OUTPUT)
    print('     %d x %d cells, %d entities (%d monsters, %d props, %d portals, '
          '%d destructibles, %d event sites), sha256=%s' %
          (cols, rows, len(entities), len(monsters), len(props), len(portals),
           len(destructibles), len(event_sites), digest[:12]))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print('FAILED: %s' % exc)
        sys.exit(1)
