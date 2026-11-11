#!/usr/bin/env python3
"""Rebuild the initial sample LDtk project: assets/resource/maps/arena.ldtk.

`arena.ldtk` is the AUTHORING source. Open it with LDtk 1.5.3, paint the
Terrain IntGrid layer and drag Monster entities, save, then run
`python scripts/import_map.py` to refresh the generated TS output.

This script only recreates the sample baseline. It is NOT part of the build
chain and must not be re-run after the map has been edited by hand.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import sys
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAPS = os.path.join(ROOT, 'assets', 'resource', 'maps')
OUT = os.path.join(MAPS, 'arena.ldtk')

GRID = 32
COLS, ROWS = 64, 48

FLOOR, WALL, ROAD, VOID = 0, 1, 2, 3
CHARS = {FLOOR: '.', WALL: '#', ROAD: '+', VOID: '~'}
WALKABLE = (FLOOR, ROAD)

# IntGrid values shown in LDtk (0 is always "empty cell").
INT_GRID_VALUES = [
    {'value': WALL, 'identifier': 'wall', 'color': '#73809A', 'tile': None, 'groupUid': 0},
    {'value': ROAD, 'identifier': 'road', 'color': '#C8A96A', 'tile': None, 'groupUid': 0},
    {'value': VOID, 'identifier': 'void', 'color': '#1B1B2E', 'tile': None, 'groupUid': 0},
]

# Internal chasms: unreachable pockets that also block line of sight.
POCKETS = [(26, 10, 29, 13), (46, 9, 50, 12), (7, 33, 12, 37), (35, 34, 39, 38)]
# Ruin walls: solid obstacles scattered off the road network.
BLOCKS = [
    (20, 9, 24, 12), (32, 12, 37, 15), (9, 27, 13, 31), (27, 28, 31, 32),
    (48, 26, 54, 30), (36, 19, 39, 21), (53, 13, 57, 16),
]

SPAWN = (8, 24)
MONSTERS = [
    ('sword_01', '100001', (20, 20), 1),
    ('sword_02', '100001', (30, 24), 1),
    ('sword_03', '100001', (12, 12), 2),
    ('sword_04', '100001', (38, 30), 2),
    ('archer_01', '200001', (48, 13), 1),
    ('archer_02', '200001', (50, 33), 2),
    ('archer_03', '200001', (26, 38), 3),
]


def in_rect(col, row, rects):
    return any(x0 <= col <= x1 and y0 <= row <= y1 for x0, y0, x1, y1 in rects)


def terrain_at(col, row):
    # Irregular (non-rectangular) outline: a wobbling ellipse.
    nx = (col + 0.5 - COLS / 2) / (COLS * 0.46)
    ny = (row + 0.5 - ROWS / 2) / (ROWS * 0.44)
    wobble = (0.09 * math.sin(col * 0.37) + 0.07 * math.cos(row * 0.43)
              + 0.05 * math.sin((col + row) * 0.19))
    r = nx * nx + ny * ny + wobble
    if r > 1.0:
        return VOID
    if r > 0.86:
        return WALL
    if in_rect(col, row, POCKETS):
        return VOID
    if in_rect(col, row, BLOCKS):
        return WALL
    # Road network is applied last so it always stays connected.
    if 23 <= row <= 24 and 5 <= col <= 58:
        return ROAD
    if 15 <= col <= 16 and 7 <= row <= 41:
        return ROAD
    if 43 <= col <= 44 and 7 <= row <= 41:
        return ROAD
    if 8 <= col <= 32 and abs((row - 8) - (col - 8) * 0.55) <= 0.8:
        return ROAD
    return FLOOR


def build_grid():
    return [[terrain_at(c, r) for c in range(COLS)] for r in range(ROWS)]


def reachable(grid, start):
    seen = {start}
    queue = [start]
    while queue:
        col, row = queue.pop(0)
        for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nc, nr = col + dc, row + dr
            if not (0 <= nc < COLS and 0 <= nr < ROWS):
                continue
            if (nc, nr) in seen or grid[nr][nc] not in WALKABLE:
                continue
            seen.add((nc, nr))
            queue.append((nc, nr))
    return seen


def validate(grid):
    problems = []
    if grid[SPAWN[1]][SPAWN[0]] not in WALKABLE:
        problems.append('spawn %s is not walkable' % (SPAWN,))
    for name, _mid, at, _wave in MONSTERS:
        if grid[at[1]][at[0]] not in WALKABLE:
            problems.append('monster %s at %s is not walkable' % (name, at))
    seen = reachable(grid, SPAWN)
    for name, _mid, at, _wave in MONSTERS:
        if at not in seen:
            problems.append('monster %s at %s is unreachable from spawn' % (name, at))
    return problems, seen


NS = uuid.UUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8')


def iid(name):
    return str(uuid.uuid5(NS, 'forgeax-arena/' + name))


def layer_def(uid, identifier, layer_type, int_grid_values):
    return {
        '__type': layer_type, 'identifier': identifier, 'type': layer_type, 'uid': uid,
        'doc': None, 'uiColor': '#E4A672' if layer_type == 'IntGrid' else '#0099DB',
        'gridSize': GRID, 'guideGridWid': 0, 'guideGridHei': 0,
        'displayOpacity': 1, 'inactiveOpacity': 1 if layer_type == 'IntGrid' else 0.45,
        'hideInList': False, 'hideFieldsWhenInactive': layer_type == 'IntGrid',
        'canSelectWhenInactive': True, 'renderInWorldView': True,
        'pxOffsetX': 0, 'pxOffsetY': 0, 'parallaxFactorX': 0, 'parallaxFactorY': 0,
        'parallaxScaling': True, 'requiredTags': [], 'excludedTags': [],
        'autoTilesKilledByOtherLayerUid': None, 'uiFilterTags': [], 'useAsyncRender': False,
        'intGridValues': int_grid_values, 'intGridValuesGroups': [], 'autoRuleGroups': [],
        'autoSourceLayerDefUid': None, 'tilesetDefUid': None, 'tilePivotX': 0,
        'tilePivotY': 0, 'biomeFieldUid': None,
    }


def field_def(uid, identifier, ftype, fcode, default):
    return {
        'identifier': identifier, 'doc': None, '__type': ftype, 'uid': uid, 'type': fcode,
        'isArray': False, 'canBeNull': False, 'arrayMinLength': None, 'arrayMaxLength': None,
        'editorDisplayMode': 'NameAndValue', 'editorDisplayScale': 1,
        'editorDisplayPos': 'Above', 'editorLinkStyle': 'CurvedArrow',
        'editorDisplayColor': None, 'editorAlwaysShow': False, 'editorShowInWorld': True,
        'editorCutLongValues': True, 'editorTextSuffix': None, 'editorTextPrefix': None,
        'useForSmartColor': False, 'exportToToc': False, 'searchable': False,
        'min': None, 'max': None, 'regex': None, 'acceptFileTypes': None,
        'defaultOverride': {'id': 'V_' + ftype, 'params': [default]},
        'textLanguageMode': None, 'symmetricalRef': False, 'autoChainRef': False,
        'allowOutOfLevelRef': True, 'allowedRefTags': [], 'allowedRefs': 'OnlySame',
        'allowedRefsEntityUid': None, 'tilesetUid': None,
    }


def entity_def(uid, identifier, color, field_defs, max_count):
    return {
        'identifier': identifier, 'uid': uid, 'tags': [], 'exportToToc': True,
        'allowOutOfBounds': False, 'doc': None, 'width': GRID, 'height': GRID,
        'resizableX': False, 'resizableY': False, 'minWidth': None, 'maxWidth': None,
        'minHeight': None, 'maxHeight': None, 'keepAspectRatio': False,
        'tileOpacity': 1, 'fillOpacity': 0.3, 'lineOpacity': 0.44, 'hollow': False,
        'color': color, 'renderMode': 'Rectangle', 'showName': True,
        'tilesetId': None, 'tileRenderMode': 'FitInside', 'tileRect': None,
        'uiTileRect': None, 'nineSliceBorders': [], 'maxCount': max_count,
        'limitScope': 'PerLevel', 'limitBehavior': 'MoveLastOne',
        'pivotX': 0.5, 'pivotY': 1, 'fieldDefs': field_defs,
    }


def field_instance(identifier, ftype, value, def_uid):
    return {
        '__identifier': identifier, '__type': ftype, '__value': value, '__tile': None,
        'defUid': def_uid,
        'realEditorValues': [{'id': 'V_' + ftype, 'params': [value]}],
    }


def entity_instance(identifier, def_uid, col, row, fields, color):
    return {
        '__grid': [col, row], '__identifier': identifier, '__pivot': [0.5, 1],
        '__smartColor': color, '__tags': [], '__tile': None, 'defUid': def_uid,
        'fieldInstances': fields, 'height': GRID, 'width': GRID,
        'iid': iid('entity/%s/%s/%s' % (identifier, col, row)),
        # pivot (0.5, 1): x is the horizontal centre, y is the bottom edge.
        'px': [col * GRID + GRID // 2, row * GRID + GRID],
    }


def layer_instance(layer_uid, identifier, layer_type, grid, entities):
    return {
        '__cWid': COLS, '__cHei': ROWS, '__gridSize': GRID,
        '__identifier': identifier, '__opacity': 1,
        '__pxTotalOffsetX': 0, '__pxTotalOffsetY': 0,
        '__tilesetDefUid': None, '__tilesetRelPath': None, '__type': layer_type,
        'autoLayerTiles': [],
        'entityInstances': entities if layer_type == 'Entities' else [],
        'gridTiles': [],
        'iid': iid('layer/' + identifier),
        'intGridCsv': [v for row in grid for v in row] if layer_type == 'IntGrid' else [],
        'layerDefUid': layer_uid, 'levelId': 0,
        'optionalRules': [], 'overrideTilesetUid': None,
        'pxOffsetX': 0, 'pxOffsetY': 0, 'seed': 98341, 'visible': True,
    }


def main():
    grid = build_grid()
    problems, seen = validate(grid)
    if problems:
        for p in problems:
            print('[INVALID] %s' % p)
        return 1

    entities = [entity_instance('PlayerSpawn', 20, SPAWN[0], SPAWN[1], [], '#B8DE4F')]
    for name, monster_id, (col, row), wave in MONSTERS:
        entities.append(entity_instance('Monster', 21, col, row, [
            field_instance('monsterId', 'String', monster_id, 22),
            field_instance('wave', 'Int', wave, 23),
        ], '#EF6B6B'))

    project = {
        '__header__': {
            'fileType': 'LDtk Project JSON', 'app': 'LDtk', 'doc': 'https://ldtk.io/json',
            'schema': 'https://ldtk.io/files/JSON_SCHEMA.json',
            'appAuthor': "Sebastien 'deepnight' Benard", 'appVersion': '1.5.3',
            'url': 'https://ldtk.io',
        },
        'iid': iid('project'),
        'jsonVersion': '1.5.3', 'appBuildId': 473702, 'nextUid': 24,
        'identifierStyle': 'Free', 'worldLayout': 'Free',
        'worldGridWidth': 256, 'worldGridHeight': 256,
        'defaultLevelWidth': COLS * GRID, 'defaultLevelHeight': ROWS * GRID,
        'defaultPivotX': 0.5, 'defaultPivotY': 1, 'defaultGridSize': GRID,
        'defaultEntityWidth': GRID, 'defaultEntityHeight': GRID,
        'bgColor': '#40465B', 'defaultLevelBgColor': '#1B1B2E',
        'minifyJson': False, 'externalLevels': False, 'exportTiled': False,
        'simplifiedExport': False, 'imageExportMode': 'None', 'exportLevelBg': True,
        'pngFilePattern': None, 'backupOnSave': True, 'backupLimit': 10,
        'backupRelPath': None, 'levelNamePattern': 'Level_%idx',
        'tutorialDesc': (
            'ForgeAX arena sample. Paint the Terrain IntGrid layer: 0 = floor (walkable), '
            '1 = wall, 2 = road (walkable), 3 = void. Drag exactly one PlayerSpawn and any '
            'number of Monster entities; monsterId must match an id in monster_loot.xlsx. '
            'After saving run: python scripts/import_map.py'
        ),
        'customCommands': [], 'flags': [], 'worlds': [],
        'dummyWorldIid': iid('world'), 'toc': [],
        'defs': {
            'layers': [
                layer_def(11, 'Entities', 'Entities', []),
                layer_def(10, 'Terrain', 'IntGrid', INT_GRID_VALUES),
            ],
            'entities': [
                entity_def(20, 'PlayerSpawn', '#B8DE4F', [], 1),
                entity_def(21, 'Monster', '#EF6B6B', [
                    field_def(22, 'monsterId', 'String', 'F_String', '100001'),
                    field_def(23, 'wave', 'Int', 'F_Int', 1),
                ], -1),
            ],
            'enums': [], 'externalEnums': [], 'levelFields': [], 'tilesets': [],
        },
        'levels': [{
            'identifier': 'Arena', 'iid': iid('level'), 'uid': 0,
            'worldX': 0, 'worldY': 0, 'worldDepth': 0,
            'pxWid': COLS * GRID, 'pxHei': ROWS * GRID,
            '__bgColor': '#1B1B2E', 'bgColor': None,
            'useAutoIdentifier': False, 'bgRelPath': None, 'bgPos': None,
            'bgPivotX': 0.5, 'bgPivotY': 0.5, '__smartColor': '#82828C',
            '__bgPos': None, 'externalRelPath': None,
            'fieldInstances': [], '__neighbours': [],
            'layerInstances': [
                layer_instance(11, 'Entities', 'Entities', grid, entities),
                layer_instance(10, 'Terrain', 'IntGrid', grid, []),
            ],
        }],
    }

    if not os.path.isdir(MAPS):
        os.makedirs(MAPS)
    text = json.dumps(project, ensure_ascii=False, indent=2) + '\n'
    with open(OUT, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(text)
    digest = hashlib.sha256(text.encode('utf-8')).hexdigest()
    print('[ok] %s' % OUT)
    print('     %d x %d cells @ %dpx = %d x %d world px' %
          (COLS, ROWS, GRID, COLS * GRID, ROWS * GRID))
    print('     %d entities, %d reachable cells, sha256=%s' %
          (len(entities), len(seen), digest[:12]))
    if '--report' in sys.argv[1:]:
        for row in grid:
            print(''.join(CHARS[v] for v in row))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError) as exc:
        print('FAILED: %s' % exc)
        sys.exit(1)
