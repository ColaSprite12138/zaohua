#!/usr/bin/env python3
"""Author the level / star-map tables (one-off generator, like make_sample_map.py).

Why a script instead of hand-edited workbooks: this machine has no openpyxl and
the project forbids hand-writing OOXML parts (see tables/README.md). Run this
ONCE to create the initial data; afterwards edit the .xlsx in Excel and do not
rerun -- it overwrites them.

It also patches two existing tables so the new economy has its sources:

  level.xlsx        level -> xp_to_next + star_points      (NEW)
  starmap.xlsx      16 nodes: id/requires/kind/effect/...  (NEW)
  monster.xlsx      + xp          (kills are the only XP source, design 6.1)
  combat_rule.xlsx  + mainline_star_points / explore_star_points (design 6.3)

    python scripts/make_starmap_tables.py            write / patch
    python scripts/make_starmap_tables.py --check    validate packages only
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
# kind: skill = 解锁主动技能 / attribute = 属性乘区 / passive = 大点
# effect: dmg_pct / hp_pct / mana_pct / range_px（combat/modifiers.ts 解释）
# 坐标是星图面板上的布局坐标（0..720 × 0..440），UI 直接读，不在前端写死。
CORE = 'star_core'
SKILLS = [
    ('cleave', '横扫', 60), ('charge', '冲锋', 160), ('ice_shard', '冰锥', 260),
    ('fire_wall', '火墙', 360), ('venom_pool', '毒池', 460),
    ('water_wave', '水浪', 560), ('thunder', '落雷', 660),
]
ATTRIBUTES = [
    ('might', '锋锐', 'cleave', 'dmg_pct', 0.08, 60, '横扫后的近身伤害 +8%'),
    ('tough', '铁骨', 'charge', 'hp_pct', 0.12, 160, '冲锋后的生命上限 +12%'),
    ('focus', '静心', 'ice_shard', 'mana_pct', 0.15, 260, '冰锥后的法力上限 +15%'),
    ('reach', '远袭', 'fire_wall', 'range_px', 18, 360, '火墙后的近战距离 +18px'),
    ('venom_edge', '蚀骨', 'venom_pool', 'dmg_pct', 0.06, 460, '毒池后的伤害 +6%'),
    ('tide', '潮涌', 'water_wave', 'mana_pct', 0.10, 560, '水浪后的法力上限 +10%'),
    ('storm', '雷引', 'thunder', 'range_px', 20, 660, '落雷后的近战距离 +20px'),
]
PASSIVES = [
    ('warlord', '战意', 'might,tough', 'dmg_pct', 0.12, 160, '伤害 +12%（需锋锐 + 铁骨）'),
    ('archmage', '奥能', 'focus,storm', 'mana_pct', 0.20, 560, '法力上限 +20%（需静心 + 雷引）'),
]


def starmap_rows():
    header = ['id', 'name', 'tier', 'requires', 'kind', 'effect', 'magnitude',
              'cost', 'x', 'y', 'skill_id', 'hint']
    rows = [['star_core', '星核', 0, '', 'attribute', 'dmg_pct', 0.05, 1, 360, 30,
             '', '一切星图的起点：伤害 +5%']]
    for skill_id, name, x in SKILLS:
        rows.append([skill_id, name, 1, CORE, 'skill', '', 0, 1, x, 130, skill_id,
                     '解锁主动技能「%s」（带进战局才用得上）' % name])
    for node_id, name, req, effect, magnitude, x, hint in ATTRIBUTES:
        rows.append([node_id, name, 2, req, 'attribute', effect, magnitude, 1, x, 240,
                     '', hint])
    for node_id, name, req, effect, magnitude, x, hint in PASSIVES:
        rows.append([node_id, name, 3, req, 'passive', effect, magnitude, 3, x, 350,
                     '', hint])
    return header, rows


def patch_table(name, extra_header, extra_values):
    """Append columns to an existing table, preserving every authored row."""
    path = os.path.join(TABLES, name + '.xlsx')
    fields, records = export_tables.parse_table(path)
    header = list(fields) + list(extra_header)
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
        for name in ('level', 'starmap', 'monster', 'combat_rule'):
            export_tables.validate_package(os.path.join(TABLES, name + '.xlsx'))
            print('[ OK ] %s.xlsx package is valid' % name)
        return 0

    write_xlsx(os.path.join(TABLES, 'level.xlsx'),
               ['id', 'level', 'xp_to_next', 'star_points'],
               [['lv%d' % lv, lv, xp, 1] for lv, xp in LEVELS])

    header, rows = starmap_rows()
    write_xlsx(os.path.join(TABLES, 'starmap.xlsx'), header, rows)

    # Kills are the only XP source (design 6.1). Values are dev tuning: 5-6
    # fixture kills reach level 2.
    patch_table('monster', ['xp'], lambda rec: [12 if rec['id'] == '100001' else 10])

    # 主线首通 / 探索事件各给多少星图点（设计 6.3 的三条来源之二）。
    patch_table('combat_rule', ['mainline_star_points', 'explore_star_points'],
                lambda rec: [2, 1])
    return 0


if __name__ == '__main__':
    sys.exit(main())
