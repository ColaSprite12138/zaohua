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
MONSTER_TABLE = os.path.join(ROOT, 'assets', 'resource', 'generated', 'monster.ts')

VALID_TILES = {0, 1, 2, 3}
WALKABLE = {0, 2}
TERRAIN_LEGEND = '0123'


def fail(msg):
    print('FAILED: %s' % msg)
    sys.exit(1)


def load_monster_ids():
    if not os.path.isfile(MONSTER_TABLE):
        fail('missing %s (run python scripts/export_tables.py first)' % MONSTER_TABLE)
    with open(MONSTER_TABLE, 'r', encoding='utf-8') as fh:
        text = fh.read()
    ids = set(re.findall(r'\{\s*id:\s*"([^"]+)"', text))
    if not ids:
        fail('could not read any monster id from generated/monster.ts')
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
        entities.extend(layer.get('entityInstances') or [])
    return cols, rows, grid, entities


PROP_PREFIX = 'Prop_'
PROP_KINDS = {'wall_run', 'censer', 'terrace'}


def read_entities(entities, cols, rows, grid, grid_size, monster_ids):
    spawn = None
    monsters = []
    props = []
    seen_ids = set()
    for ent in entities:
        ident = ent.get('__identifier')
        cell = ent.get('__grid') or []
        if len(cell) != 2 or not all(isinstance(v, int) for v in cell):
            fail('entity %r has invalid __grid %r' % (ident, cell))
        col, row = cell
        if not (0 <= col < cols and 0 <= row < rows):
            fail('entity %r at (%d,%d) is outside the map' % (ident, col, row))
        fields = {}
        for fi in ent.get('fieldInstances') or []:
            fields[fi.get('__identifier')] = fi.get('__value')
        eid = '%s_%d_%d' % (str(ident).lower(), col, row)
        if ident.startswith(PROP_PREFIX):
            # Props 是纯装饰：不参与碰撞、不参与 --check 的唯一性约束之外的逻辑，
            # 只按落位顺序画，所以允许同一格叠放（香炉可以摆在墙脚）。
            kind = str(ident)[len(PROP_PREFIX):]
            if kind not in PROP_KINDS:
                fail('unknown prop kind %r (allowed: %s)' % (kind, ', '.join(sorted(PROP_KINDS))))
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
        else:
            fail('unknown entity type %r' % ident)

    if spawn is None:
        fail('level has no PlayerSpawn')
    return spawn, monsters, props


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


def render(project, level, digest, cols, rows, grid, grid_size, spawn, monsters, props):
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
    lines.extend(['  ],', '} as const;', '', 'export type ArenaMap = typeof arena;', ''])
    return '\n'.join(lines)


def main():
    check = '--check' in sys.argv[1:]
    monster_ids = load_monster_ids()
    project, level, digest = load_project()
    grid_size = project.get('defaultGridSize')
    if not isinstance(grid_size, int) or grid_size < 1:
        fail('invalid defaultGridSize %r' % grid_size)
    cols, rows, grid, entities = read_layers(level, grid_size)
    spawn, monsters, props = read_entities(entities, cols, rows, grid, grid_size, monster_ids)
    seen = reachability(grid, cols, rows, spawn)
    for m in monsters:
        if (m['col'], m['row']) not in seen:
            fail('Monster %s at (%d,%d) is unreachable from spawn' %
                 (m['id'], m['col'], m['row']))
    content = render(project, level, digest, cols, rows, grid, grid_size, spawn, monsters, props)

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
    print('     %d x %d cells, %d entities (%d monsters, %d props), sha256=%s' %
          (cols, rows, len(entities), len(monsters), len(props), digest[:12]))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print('FAILED: %s' % exc)
        sys.exit(1)
