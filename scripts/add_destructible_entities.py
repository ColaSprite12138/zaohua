#!/usr/bin/env python3
"""Add the `Destructible` / `EventSite` entity types to arena.ldtk (one-off patch).

Why a patch script instead of re-running `gen_arena_map.py`: the .ldtk has been
hand-edited in LDtk since it was generated (player spawn and one portal were
moved), and re-running the generator would throw those edits away. This script
only ADDS two entity definitions plus their instances and touches nothing else.

    python scripts/add_destructible_entities.py            # patch + validate
    python scripts/add_destructible_entities.py --check    # validate only

Afterwards: `python scripts/import_map.py` to regenerate arena.generated.ts.

The SAME positions are mirrored in `gen_arena_map.py::layout()` so a future
regeneration keeps the boxes (that path re-creates the whole map, it does not
read this list).
"""
from __future__ import annotations

import json
import os
import sys
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MAPS = os.path.join(ROOT, 'assets', 'resource', 'maps')
SOURCE = os.path.join(MAPS, 'arena.ldtk')
sys.path.insert(0, HERE)

import gen_arena_map  # noqa: E402  (same directory: structure validator)

GRID = 32

DESTRUCTIBLE_UID = 106
EVENT_SITE_UID = 107
KIND_FIELD_UID = 108

# 三档可破坏物分布：两座厢房里各一只低/中价值物（绕路进去的奖励），
# 中庭散两只，两个高价值舍利匣都**故意**摆在怪的警戒圈里 —— 想开它就得先清场。
DESTRUCTIBLES = [
    ('crate', 16, 24),      # 西厢房内
    ('coffer', 28, 36),     # 西厢房内南
    ('crate', 100, 24),     # 东厢房内
    ('coffer', 110, 36),    # 东厢房内南
    ('crate', 58, 50),      # 中庭北
    ('coffer', 70, 58),     # 中庭中
    ('reliquary', 40, 44),  # 中庭西（(44,46) 有怪 → 有守卫）
    ('reliquary', 96, 44),  # 中庭东（(106,58) 有怪 → 有守卫）
]

# 事件点：第 7 分钟的高价值物刷在这里（设计 10.2）。两处，轮转使用。
EVENT_SITES = [
    (64, 32),    # 中庭北（高台台阶前）
    (100, 72),   # 中庭东南
]


def entity_instance(identifier, def_uid, col, row, fields=()):
    iid = str(uuid.uuid5(uuid.NAMESPACE_URL, 'arena/%s/%d/%d' % (identifier, col, row)))
    return {
        '__grid': [col, row],
        '__identifier': identifier,
        '__pivot': [0.5, 1],
        '__smartColor': '#C084FC',
        '__tags': [],
        '__tile': None,
        'defUid': def_uid,
        'fieldInstances': list(fields),
        'height': GRID,
        'width': GRID,
        'iid': iid,
        'px': [col * GRID + GRID // 2, (row + 1) * GRID],
    }


def kind_field(kind):
    """`realEditorValues` 才是 LDtk 编辑器读的那一份，`__value` 只给人看。"""
    return {
        '__identifier': 'kind',
        '__type': 'String',
        '__value': kind,
        '__tile': None,
        'defUid': KIND_FIELD_UID,
        'realEditorValues': [{'id': 'V_String', 'params': [kind]}],
    }


def build_def(base, identifier, uid, color, doc, field_defs=()):
    clone = json.loads(json.dumps(base))
    clone.update({
        'identifier': identifier,
        'uid': uid,
        'color': color,
        'showName': True,
        'doc': doc,
        'fieldDefs': list(field_defs),
    })
    return clone


def patch(project):
    defs = project['defs']
    entities = defs['entities']

    monster = next(e for e in entities if e['identifier'] == 'Monster')
    kind_def = json.loads(json.dumps(monster['fieldDefs'][0]))   # String, copy of monsterId
    kind_def['identifier'] = 'kind'
    kind_def['uid'] = KIND_FIELD_UID
    kind_def['defaultOverride'] = {'id': 'V_String', 'params': ['crate']}

    # 重跑幂等：先按 identifier 清掉旧定义，再追加。
    entities[:] = [e for e in entities
                   if e['identifier'] not in ('Destructible', 'EventSite')]
    entities.append(build_def(
        monster, 'Destructible', DESTRUCTIBLE_UID, '#F59E0B',
        '可破坏物（设计 10.5）：站在旁边按左键砸开，站桩 2–4 秒，'
        '会惊醒周围的怪。kind 必须是 tables/destructible.xlsx 的行。',
        [kind_def],
    ))
    entities.append(build_def(
        monster, 'EventSite', EVENT_SITE_UID, '#FCD34D',
        '单局事件点（设计 10.2）：第 7 分钟的高价值物刷在这里。',
        [],
    ))

    level = project['levels'][0]
    layer = next(li for li in level['layerInstances'] if li['__identifier'] == 'Entities')
    kept = [ei for ei in layer['entityInstances']
            if ei['__identifier'] not in ('Destructible', 'EventSite')]
    for kind, col, row in DESTRUCTIBLES:
        kept.append(entity_instance('Destructible', DESTRUCTIBLE_UID, col, row,
                                    [kind_field(kind)]))
    for col, row in EVENT_SITES:
        kept.append(entity_instance('EventSite', EVENT_SITE_UID, col, row))
    layer['entityInstances'] = kept

    project['nextUid'] = max(int(project.get('nextUid') or 0), KIND_FIELD_UID + 1)
    return project


def terrain_of(project):
    cols = project['levels'][0]
    layer = next(li for li in cols['layerInstances'] if li['__type'] == 'IntGrid')
    return layer['__cWid'], layer['__cHei'], layer['intGridCsv']


def check_placement(project):
    cols, rows, csv = terrain_of(project)
    walkable = {0, 2}
    problems = []
    seen = set()
    spawn = None
    for ei in project['levels'][0]['layerInstances']:
        if ei['__identifier'] != 'Entities':
            continue
        for inst in ei['entityInstances']:
            if inst['__identifier'] == 'PlayerSpawn':
                spawn = tuple(inst['__grid'])
    for kind, col, row in DESTRUCTIBLES + [('site', c, r) for c, r in EVENT_SITES]:
        if not (0 <= col < cols and 0 <= row < rows):
            problems.append('%s (%d,%d) 在地图外' % (kind, col, row))
            continue
        if csv[row * cols + col] not in walkable:
            problems.append('%s (%d,%d) 不可走（地形=%d）'
                            % (kind, col, row, csv[row * cols + col]))
        if (col, row) in seen:
            problems.append('%s (%d,%d) 与别的点位重合' % (kind, col, row))
        seen.add((col, row))
        if spawn is None:
            continue
        if not reachable(csv, cols, rows, spawn, (col, row)):
            problems.append('%s (%d,%d) 从出生点走不到' % (kind, col, row))
    return problems


def reachable(csv, cols, rows, start, goal):
    seen = {start}
    queue = [start]
    walkable = {0, 2}
    while queue:
        col, row = queue.pop(0)
        if (col, row) == goal:
            return True
        for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nc, nr = col + dc, row + dr
            if not (0 <= nc < cols and 0 <= nr < rows):
                continue
            if (nc, nr) in seen or csv[nr * cols + nc] not in walkable:
                continue
            seen.add((nc, nr))
            queue.append((nc, nr))
    return False


def main():
    check = '--check' in sys.argv[1:]
    with open(SOURCE, 'r', encoding='utf-8') as fh:
        project = json.load(fh)
    if not check:
        project = patch(project)
    problems = gen_arena_map.validate(project) + check_placement(project)
    if problems:
        for problem in problems:
            print('[FAIL] %s' % problem)
        return 1
    if check:
        print('[ OK ] destructible / event-site placement is valid')
        return 0
    text = json.dumps(project, indent=1, ensure_ascii=False) + '\n'
    with open(SOURCE, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(text)
    print('[ OK ] arena.ldtk: %d destructibles, %d event sites'
          % (len(DESTRUCTIBLES), len(EVENT_SITES)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
