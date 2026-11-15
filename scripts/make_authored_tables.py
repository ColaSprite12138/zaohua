#!/usr/bin/env python3
"""Author the tables this project added on top of the original loot data.

Why a script instead of hand-edited workbooks: this machine has no openpyxl and
the project forbids hand-writing OOXML parts (see tables/README.md). Run this
ONCE to create the initial data; afterwards edit the .xlsx in Excel -- rerunning
overwrites them (patches are idempotent: an existing column is left alone).

Creates / patches:

  level.xlsx           level -> xp_to_next + star_points          (NEW, 6.1)
  constellation.xlsx   8 constellations: color + requirement       (NEW, 6.3 v7)
  starmap.xlsx         23 nodes: constellation + affinity grants   (NEW, 6.3 v7)
  monster.xlsx      + xp                                           (6.1)
  combat_rule.xlsx  + mainline/explore star points                 (6.3)
                    + durability_dealt / durability_taken          (5.2 / 7.4)
                    + hp_potion_heal                               (8.3)
  weapon.xlsx       + durability                                   (5.2 / 7.4)
  item.xlsx         + 30002 红药 / 30003 蓝药                       (8.3)

    python scripts/make_authored_tables.py            write / patch
    python scripts/make_authored_tables.py --check    validate packages only
"""

import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TABLES = os.path.join(ROOT, 'assets', 'resource', 'tables')
sys.path.insert(0, HERE)

import export_tables  # noqa: E402  (same directory)

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>
"""

ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>
"""

WORKBOOK = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="data" sheetId="1" r:id="rId1"/></sheets>
</workbook>
"""

WORKBOOK_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>
"""

# A minimal but COMPLETE style sheet: export_tables.py::validate_package() only
# proves every part parses, Excel additionally wants every referenced style part
# present. Keep it minimal -- no colours, the data is what matters.
STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>
"""


def col_name(index):
    name = ''
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        name = chr(65 + rem) + name
    return name


def xml_text(value):
    return (str(value).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))


def sheet_xml(header, rows):
    out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
           '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>']
    data = [header] + rows
    for ri, row in enumerate(data, start=1):
        cells = []
        for ci, value in enumerate(row):
            ref = '%s%d' % (col_name(ci), ri)
            if isinstance(value, bool):
                cells.append('<c r="%s" t="b"><v>%d</v></c>' % (ref, 1 if value else 0))
            elif isinstance(value, (int, float)):
                cells.append('<c r="%s"><v>%s</v></c>' % (ref, value))
            elif value in ('', None):
                continue
            else:
                cells.append('<c r="%s" t="inlineStr"><is><t>%s</t></is></c>'
                             % (ref, xml_text(value)))
        out.append('<row r="%d">%s</row>' % (ri, ''.join(cells)))
    out.append('</sheetData></worksheet>')
    return ''.join(out)


def write_xlsx(path, header, rows):
    parts = {
        '[Content_Types].xml': CONTENT_TYPES,
        '_rels/.rels': ROOT_RELS,
        'xl/workbook.xml': WORKBOOK,
        'xl/_rels/workbook.xml.rels': WORKBOOK_RELS,
        'xl/styles.xml': STYLES,
        'xl/worksheets/sheet1.xml': sheet_xml(header, rows),
    }
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, text in parts.items():
            z.writestr(name, text.encode('utf-8'))
    export_tables.validate_package(path)
    print('[ OK ] wrote %s (%d data rows)' % (os.path.relpath(path, ROOT), len(rows)))


# --------------------------------------------------------------- level curve
# 18 级 = 上限。xp_to_next 递增；最后一行 0 表示「到顶了，不再升级」。
# 星级点 1 点/级（设计 6.3 的「等级提升是稳定可预期的日常成长」）。
LEVELS = [(1, 60), (2, 90), (3, 120), (4, 170), (5, 220), (6, 280),
          (7, 350), (8, 430), (9, 520), (10, 620), (11, 730), (12, 860),
          (13, 1000), (14, 1160), (15, 1340), (16, 1540), (17, 1760), (18, 0)]

# --------------------------------------------------------------- star map
#
# 设计 6.3（v7 重做，2026-11-15）：**亲和（affinity）是唯一门槛**，对标 Grim Dawn 星座。
#   * 每个节点给「亲和」，亲和**只累积不消耗**；
#   * 星座按自己的颜色亲和开锁（`requirement`），**没有节点间的连线 / 前置**；
#   * 想开高阶星座，就得先在不那么想要的星座里拿够亲和 —— 这是取舍的来源；
#   * 被动一律是通用乘区（伤害 / 生命 / 法力 / 距离），**不为某个主动技能加成**。
#
# 六种亲和＝六种元素（combat 的 ElementId），技能节点给本色 2 点，被动给本色 1 点 + 邻色 1 点。
# 邻色是设计的核心：跨色产出让「绕路」有意义，否则每个星座只能开自己。
CONSTELLATIONS = [
    # id, name, color, requirement, x, y, hint
    ('ember', '余烬', 'fire', 0, 90, 60, '火。起点星座，不需要亲和'),
    ('frost', '霜牙', 'ice', 0, 330, 60, '冰。起点星座，不需要亲和'),
    ('tide', '潮汐', 'water', 2, 570, 60, '水。需要 2 点水亲和'),
    ('venom', '腐沼', 'poison', 2, 810, 60, '毒。需要 2 点毒亲和'),
    ('gale', '疾风', 'wind', 3, 210, 275, '风。需要 3 点风亲和'),
    ('storm', '怒雷', 'shock', 3, 560, 275, '雷。需要 3 点雷亲和'),
    ('warlord', '战意', 'fire', 5, 260, 450, '火之巅。需要 5 点火亲和'),
    ('archon', '奥能', 'shock', 5, 640, 450, '雷之巅。需要 5 点雷亲和'),
]

# id, constellation, name, kind, effect, magnitude, cost, (affinities), skill_id, hint
# affinities 用 dict：{'fire': 2} 之类；缺省色为 0。
NODES = [
    # 技能节点：本色 2 点 + 邻色 1 点（技能本身也产出亲和，这是 GD 的核心手感：
    # 你想开的那条线，往往要靠「顺手点的一个技能」把颜色推上去）。
    ('ember_wall', 'ember', '火墙', 'skill', '', 0, 1, {'fire': 2, 'poison': 1}, 'fire_wall',
     '解锁主动技能「火墙」'),
    ('ember_dmg', 'ember', '燎原', 'attribute', 'dmg_pct', 0.05, 1, {'fire': 1, 'poison': 1},
     '', '所有伤害 +5%'),
    ('ember_hp', 'ember', '炭壳', 'attribute', 'hp_pct', 0.06, 1, {'fire': 1, 'wind': 1},
     '', '生命上限 +6%'),

    ('frost_shard', 'frost', '冰锥', 'skill', '', 0, 1, {'ice': 2, 'water': 1}, 'ice_shard',
     '解锁主动技能「冰锥」'),
    ('frost_mana', 'frost', '静流', 'attribute', 'mana_pct', 0.10, 1, {'ice': 1, 'water': 1},
     '', '法力上限 +10%'),
    ('frost_dmg', 'frost', '砭骨', 'attribute', 'dmg_pct', 0.04, 1, {'ice': 1, 'shock': 1},
     '', '所有伤害 +4%'),

    ('tide_wave', 'tide', '水浪', 'skill', '', 0, 1, {'water': 2, 'shock': 1}, 'water_wave',
     '解锁主动技能「水浪」'),
    ('tide_hp', 'tide', '潮息', 'attribute', 'hp_pct', 0.10, 1, {'water': 1, 'wind': 1},
     '', '生命上限 +10%'),
    ('tide_mana', 'tide', '深潭', 'attribute', 'mana_pct', 0.08, 1, {'water': 1, 'poison': 1},
     '', '法力上限 +8%'),

    ('venom_pool', 'venom', '毒池', 'skill', '', 0, 1, {'poison': 2, 'wind': 1}, 'venom_pool',
     '解锁主动技能「毒池」'),
    ('venom_dmg', 'venom', '蚀骨', 'attribute', 'dmg_pct', 0.06, 1, {'poison': 1, 'wind': 1},
     '', '所有伤害 +6%'),
    ('venom_range', 'venom', '蔓延', 'attribute', 'range_px', 12, 1, {'poison': 1, 'shock': 1},
     '', '近战距离 +12px'),

    ('gale_charge', 'gale', '冲锋', 'skill', '', 0, 1, {'wind': 2, 'fire': 1}, 'charge',
     '解锁主动技能「冲锋」'),
    ('gale_cleave', 'gale', '横扫', 'skill', '', 0, 1, {'wind': 2, 'ice': 1}, 'cleave',
     '解锁主动技能「横扫」'),
    ('gale_range', 'gale', '疾行', 'attribute', 'range_px', 16, 1, {'wind': 1, 'fire': 1},
     '', '近战距离 +16px'),
    ('gale_dmg', 'gale', '割裂', 'attribute', 'dmg_pct', 0.05, 1, {'wind': 1, 'shock': 1},
     '', '所有伤害 +5%'),

    ('storm_thunder', 'storm', '落雷', 'skill', '', 0, 1, {'shock': 2, 'fire': 1}, 'thunder',
     '解锁主动技能「落雷」'),
    ('storm_mana', 'storm', '雷鸣', 'attribute', 'mana_pct', 0.15, 1, {'shock': 1, 'fire': 1},
     '', '法力上限 +15%'),
    ('storm_dmg', 'storm', '电弧', 'attribute', 'dmg_pct', 0.08, 1, {'shock': 1, 'wind': 1},
     '', '所有伤害 +8%'),

    ('warlord_dmg', 'warlord', '破军', 'passive', 'dmg_pct', 0.12, 2, {'fire': 1},
     '', '所有伤害 +12%（大点）'),
    ('warlord_hp', 'warlord', '铁壁', 'passive', 'hp_pct', 0.15, 2, {'fire': 1},
     '', '生命上限 +15%（大点）'),

    ('archon_mana', 'archon', '洪流', 'passive', 'mana_pct', 0.20, 2, {'shock': 1},
     '', '法力上限 +20%（大点）'),
    ('archon_range', 'archon', '远见', 'passive', 'range_px', 20, 2, {'shock': 1},
     '', '近战距离 +20px（大点）'),
]

AFFINITIES = ('fire', 'ice', 'water', 'poison', 'shock', 'wind')


def constellation_rows():
    return (['id', 'name', 'color', 'requirement', 'x', 'y', 'hint'],
            [list(row) for row in CONSTELLATIONS])


def starmap_rows():
    header = ['id', 'constellation', 'name', 'kind', 'effect', 'magnitude', 'cost']
    header += ['aff_' + color for color in AFFINITIES]
    header += ['skill_id', 'hint']
    rows = []
    for node_id, constellation, name, kind, effect, magnitude, cost, aff, skill_id, hint in NODES:
        row = [node_id, constellation, name, kind, effect, magnitude, cost]
        row += [aff.get(color, 0) for color in AFFINITIES]
        row += [skill_id, hint]
        rows.append(row)
    return header, rows


def patch_table(name, extra_header, extra_values):
    """Append columns to an existing table, preserving every authored row.

    Idempotent: if the column is already there the table is left alone, so this
    script can be re-run after a partial failure without duplicating headers.
    """
    path = os.path.join(TABLES, name + '.xlsx')
    fields, records = export_tables.parse_table(path)
    if all(field in fields for field in extra_header):
        print('[skip] %s already has %s' % (name, ', '.join(extra_header)))
        return None
    missing = [field for field in extra_header if field not in fields]
    header = list(fields) + missing
    rows = []
    for rec in records:
        row = [rec[f] for f in fields]
        row.extend(extra_values(rec))
        rows.append(row)
    write_xlsx(path, header, rows)
    return rows


def main():
    check = '--check' in sys.argv[1:]
    if check:
        for name in ('level', 'starmap', 'constellation', 'monster', 'combat_rule',
                     'weapon', 'item'):
            export_tables.validate_package(os.path.join(TABLES, name + '.xlsx'))
            print('[ OK ] %s.xlsx package is valid' % name)
        return 0

    write_xlsx(os.path.join(TABLES, 'level.xlsx'),
               ['id', 'level', 'xp_to_next', 'star_points'],
               [['lv%d' % lv, lv, xp, 1] for lv, xp in LEVELS])

    header, rows = constellation_rows()
    write_xlsx(os.path.join(TABLES, 'constellation.xlsx'), header, rows)

    header, rows = starmap_rows()
    write_xlsx(os.path.join(TABLES, 'starmap.xlsx'), header, rows)

    # Kills are the only XP source (design 6.1). Values are dev tuning: 5-6
    # fixture kills reach level 2.
    patch_table('monster', ['xp'], lambda rec: [12 if rec['id'] == '100001' else 10])

    # 主线首通 / 探索事件各给多少星图点（设计 6.3 的三条来源之二）。
    patch_table('combat_rule', ['mainline_star_points', 'explore_star_points'],
                lambda rec: [2, 1])

    # 耐久（设计 5.2 / 7.4）：三类武器都有耐久，**按造成 / 承受伤害扣**，
    # 承受 : 造成 ≈ 7 : 3。这里只放"每点伤害扣多少耐久"，上限在 weapon.xlsx。
    patch_table('combat_rule', ['durability_dealt', 'durability_taken', 'hp_potion_heal'],
                lambda rec: [0.04, 0.16, 45])

    # 武器耐久上限：巨剑（1xxxx）比弓（2xxxx）更耐用 —— 近战贴身挨打多。
    patch_table('weapon', ['durability'],
                lambda rec: [160 if str(rec['id']).startswith('1') else 110])

    add_consumables()
    add_loot_potions()
    return 0


def add_loot_potions():
    """把红药 / 蓝药放进两个掉落池（5.2：消耗品要在局内真的搜得到）。

    权重刻意不低：药是"每局都要消耗"的东西，掉率太低就等于没有这条系统。
    """
    path = os.path.join(TABLES, 'loot_pool.xlsx')
    fields, records = export_tables.parse_table(path)
    have = {(str(rec['loot_pool_id']), str(rec['item_id'])) for rec in records}
    header = list(fields)
    rows = [[rec[f] for f in fields] for rec in records]
    added = 0
    for pool, suffix in ((1, 1), (2, 2)):
        for item_id, weight, tag in (('30002', 5, 'hp'), ('30003', 6, 'mp')):
            if (str(pool), item_id) in have:
                continue
            rows.append(['%d_potion_%s' % (pool, tag), pool, item_id, weight])
            added += 1
    if added == 0:
        print('[skip] loot_pool already has potions')
        return
    write_xlsx(path, header, rows)


def add_consumables():
    """红药 / 蓝药进 item.xlsx（设计 8.3：消耗品是局内资源，不是免费配额）。

    蓝药以前是「每局免费发 3 瓶」的计数器，现在改成背包物品：带多少用多少，
    死亡一起丢 —— 这才是 5.2「消耗品」这条抗通胀出口。
    """
    path = os.path.join(TABLES, 'item.xlsx')
    fields, records = export_tables.parse_table(path)
    have = {str(rec['id']) for rec in records}
    added = []
    for row in (('30002', '红药', '消耗品', 5), ('30003', '蓝药', '消耗品', 5)):
        if row[0] not in have:
            added.append(row)
    if not added:
        print('[skip] item already has 红药 / 蓝药')
        return
    header = list(fields)
    rows = [[rec[f] for f in fields] for rec in records]
    for row in added:
        rows.append([row[0], row[1], row[2], row[3]])
    write_xlsx(path, header, rows)


if __name__ == '__main__':
    sys.exit(main())
