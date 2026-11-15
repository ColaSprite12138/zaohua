#!/usr/bin/env python3
"""Author the destructible / run-event tables (one-off generator).

Same rule as `make_starmap_tables.py`: this machine has no openpyxl and the
project forbids hand-writing OOXML parts, so the first version of a new table is
written by a script. Run it ONCE; afterwards edit the .xlsx in Excel and do not
rerun (it overwrites the authored cells).

    python scripts/make_destructible_tables.py            # write / patch
    python scripts/make_destructible_tables.py --check    # validate packages

What it writes:

  destructible.xlsx  id / name / smash_seconds / loot_pool_id / drops /
                     alarm_radius / guard_radius / hint   (NEW, design 10.5)
  event.xlsx         id / name / at_seconds / kind / count / alarm_radius /
                     beacon_seconds / hint                 (NEW, design 10.2)
  monster.xlsx       + sense_radius  (aggro: 「破坏会惊醒周围的怪」的前提)
  combat_rule.xlsx   + monster_converge_px （撤离阶段怪向门聚集的判定距离）
  loot_pool.xlsx     + pool 3 / 4     （可破坏物的产出池）

The 3D shape / colour of a crate is CODE (`game/voxel.ts`), the numbers are here.
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


# ------------------------------------------------------------- destructibles
# 设计 10.5：**持续攻击 2–4 秒**、期间站桩、破坏会惊醒周围的怪、最高价值物需要
# 「机关」（先清掉守卫）。三档刚好覆盖这三条：
#
#   crate      2 秒 / 声响 260px / 无门槛    —— 填线的收益，顺手砸
#   coffer     3 秒 / 声响 320px / 无门槛    —— 值得为它站 3 秒
#   reliquary  4 秒 / 声响 380px / 240px 守卫 —— 必须先把守卫清掉，窗口最长
#
# `drops` 是抽几次战利品（不是物品数）：高价值物「多抽」而不是「换更肥的池」，
# 到词条批次再拆成独立池。
DESTRUCTIBLES = [
    ('crate', '木箱', 2.0, 3, 1, 260, 0, '低价值 · 砸开有响动'),
    ('coffer', '铜箱', 3.0, 3, 2, 320, 0, '中价值 · 值得为它站 3 秒'),
    ('reliquary', '舍利匣', 4.0, 4, 2, 380, 240, '高价值 · 先清掉 240px 内的守卫'),
]

# ------------------------------------------------------------------- events
# 设计 10.2：0–4 探索 / 4–11 交战（**7–8 分钟高价值事件刷新**）/ 11–15 撤离。
# 900 秒的一局里 420 秒 = 第 7 分钟，落在交战阶段中线；声音 + 光柱是「抢或收手」
# 那个决定的提示，`alarm_radius` 顺手把附近的怪也拉过来。
EVENTS = [
    ('high_value', '高价值事件', 420, 'reliquary', 1, 560, 25,
     '第 7 分钟：舍利匣刷新，声音与光柱全图可见'),
]

# 产出池（可破坏物专用）。比怪物池更偏「值钱」：木箱/铜箱给耗材与蓝装，
# 舍利匣才有资格抽出紫装 / 橙装 / 名字武器。
POOLS = {
    3: [('10001', 6), ('20001', 6), ('30002', 8), ('30003', 8), ('10003', 3), ('20003', 3)],
    4: [('10004', 3), ('20004', 3), ('10005', 1), ('20005', 1),
        ('10006', 1), ('20006', 1), ('30002', 4), ('30003', 4)],
}


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


def append_pool_rows():
    path = os.path.join(TABLES, 'loot_pool.xlsx')
    fields, records = export_tables.parse_table(path)
    existing = {rec['id'] for rec in records}
    rows = [[rec[f] for f in fields] for rec in records]
    for pool_id, entries in POOLS.items():
        for item_id, weight in entries:
            rid = '%d_%s' % (pool_id, item_id)
            if rid in existing:
                continue
            row = []
            for field in fields:
                if field == 'id':
                    row.append(rid)
                elif field == 'loot_pool_id':
                    row.append(pool_id)
                elif field == 'item_id':
                    row.append(item_id)
                elif field == 'weight':
                    row.append(weight)
                else:
                    row.append('')
            rows.append(row)
    write_xlsx(path, fields, rows)


def main():
    check = '--check' in sys.argv[1:]
    if check:
        for name in ('destructible', 'event', 'monster', 'combat_rule', 'loot_pool'):
            export_tables.validate_package(os.path.join(TABLES, name + '.xlsx'))
            print('[ OK ] %s.xlsx package is valid' % name)
        return 0

    write_xlsx(
        os.path.join(TABLES, 'destructible.xlsx'),
        ['id', 'name', 'smash_seconds', 'loot_pool_id', 'drops',
         'alarm_radius', 'guard_radius', 'hint'],
        [list(row) for row in DESTRUCTIBLES],
    )
    write_xlsx(
        os.path.join(TABLES, 'event.xlsx'),
        ['id', 'name', 'at_seconds', 'kind', 'count', 'alarm_radius',
         'beacon_seconds', 'hint'],
        [list(row) for row in EVENTS],
    )

    # 惊醒模型：感知半径是**每只怪**的手感，不是全局常量。
    # 700 / 760 是开发期取值 —— 自动验收夹具的两只怪分别在 482 / 617px，
    # 开局就该醒来，否则既有的「等它走过来」步骤会全部超时。
    patch_table('monster', ['sense_radius'],
                lambda rec: [700 if rec['id'] == '100001' else 760])

    # 撤离阶段「怪向门聚集」的判定距离：离玩家超过它才去守门，否则照常追人。
    patch_table('combat_rule', ['monster_converge_px'], lambda rec: [320])

    append_pool_rows()
    return 0


if __name__ == '__main__':
    sys.exit(main())
