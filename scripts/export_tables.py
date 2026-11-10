#!/usr/bin/env python3
"""Export assets/resource/tables/*.xlsx -> assets/resource/generated/*.ts.

Pure standard library (works on Python 3.7+). No openpyxl / node deps.

    python scripts/export_tables.py            regenerate
    python scripts/export_tables.py --check    fail if generated/ is stale

Contract (see assets/resource/CONTEXT.md):
  * first Sheet is the data sheet; first row is snake_case field names
  * first column is a unique string primary key named `id`
  * cells are int / float / string / bool only; formulas are rejected
  * generated/*.ts is machine-owned, never hand-edited
"""

import hashlib
import json
import os
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TABLES = os.path.join(ROOT, 'assets', 'resource', 'tables')
GENERATED = os.path.join(ROOT, 'assets', 'resource', 'generated')

MAIN = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
REL = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
PKG_REL = '{http://schemas.openxmlformats.org/package/2006/relationships}'
FIELD = re.compile(r'^[a-z][a-z0-9_]*$')


def fail(msg):
    raise ValueError(msg)


def col_index(ref):
    m = re.match(r'([A-Z]+)(\d+)', ref or '')
    if not m:
        return 0, 0
    n = 0
    for ch in m.group(1):
        n = n * 26 + (ord(ch) - 64)
    return n - 1, int(m.group(2))


def read_sheet(path):
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        shared = []
        if 'xl/sharedStrings.xml' in names:
            sroot = ET.fromstring(z.read('xl/sharedStrings.xml'))
            for si in sroot.findall(MAIN + 'si'):
                shared.append(''.join(t.text or '' for t in si.iter(MAIN + 't')))

        wb = ET.fromstring(z.read('xl/workbook.xml'))
        sheets = wb.find(MAIN + 'sheets')
        if sheets is None or len(sheets) == 0:
            fail('%s: workbook has no sheets' % path)
        rid = sheets[0].get(REL + 'id')
        target = None
        if 'xl/_rels/workbook.xml.rels' in names:
            rroot = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
            for rel in rroot.findall(PKG_REL + 'Relationship'):
                if rel.get('Id') == rid:
                    target = rel.get('Target')
        if not target:
            fail('%s: cannot resolve first sheet relationship' % path)
        target = target.lstrip('/')
        if not target.startswith('xl/'):
            target = 'xl/' + target
        if target not in names:
            fail('%s: missing sheet part %s' % (path, target))

        root = ET.fromstring(z.read(target))
        rows = {}
        for r in root.iter(MAIN + 'row'):
            for c in r.findall(MAIN + 'c'):
                ci, ri = col_index(c.get('r'))
                t = c.get('t')
                v = c.find(MAIN + 'v')
                inline = c.find(MAIN + 'is')
                if t == 'f' or c.find(MAIN + 'f') is not None:
                    fail('%s: formulas are not allowed' % path)
                if t == 's' and v is not None:
                    idx = int(v.text)
                    val = shared[idx] if idx < len(shared) else ''
                elif t == 'inlineStr' and inline is not None:
                    val = ''.join(x.text or '' for x in inline.iter(MAIN + 't'))
                elif t == 'b' and v is not None:
                    val = v.text == '1'
                elif v is not None and v.text is not None:
                    raw = v.text
                    try:
                        val = int(raw)
                    except ValueError:
                        try:
                            val = float(raw)
                        except ValueError:
                            val = raw
                else:
                    continue
                rows.setdefault(ri, {})[ci] = val
        return rows


def parse_table(path):
    rows = read_sheet(path)
    if not rows:
        fail('%s: empty sheet' % path)
    header = rows[min(rows)]
    fields = []
    for ci in range(max(header) + 1):
        name = header.get(ci, '')
        if not isinstance(name, str) or not FIELD.match(name):
            fail('%s: column %d header %r is not snake_case' % (path, ci + 1, name))
        fields.append(name)
    if not fields or fields[0] != 'id':
        fail('%s: first column must be primary key `id`' % path)
    if len(set(fields)) != len(fields):
        fail('%s: duplicate field names' % path)

    records = []
    seen = set()
    for ri in sorted(rows):
        if ri == min(rows):
            continue
        row = rows[ri]
        if not any(v not in ('', None) for v in row.values()):
            continue
        rec = {}
        for ci, field in enumerate(fields):
            val = row.get(ci, '')
            if field == 'id':
                val = str(val)
            rec[field] = val
        key = rec['id']
        if key in ('', 'None'):
            fail('%s: empty id at row %d' % (path, ri))
        if key in seen:
            fail('%s: duplicate id %r' % (path, key))
        seen.add(key)
        records.append(rec)
    return fields, records


def pascal(name):
    return ''.join(p.capitalize() for p in name.split('_'))


def render(name, fields, records, digest):
    lines = [
        '/* GENERATED by scripts/export_tables.py - DO NOT EDIT.',
        ' * source: tables/%s.xlsx' % name,
        ' * sha256: %s' % digest,
        ' */',
        'export const %s = [' % name,
    ]
    for rec in records:
        pairs = ', '.join('%s: %s' % (f, json.dumps(rec[f], ensure_ascii=False)) for f in fields)
        lines.append('  { %s },' % pairs)
    lines.append('] as const;')
    lines.append('')
    lines.append('export type %sRow = typeof %s[number];' % (pascal(name), name))
    lines.append('')
    return '\n'.join(lines)


def main():
    check = '--check' in sys.argv[1:]
    if not os.path.isdir(TABLES):
        fail('missing tables dir: %s' % TABLES)
    sources = sorted(f for f in os.listdir(TABLES)
                     if f.endswith('.xlsx') and not f.startswith('~$'))
    if not sources:
        fail('no .xlsx source tables found')

    expected = {}
    for src in sources:
        name = src[:-5]
        path = os.path.join(TABLES, src)
        with open(path, 'rb') as fh:
            digest = hashlib.sha256(fh.read()).hexdigest()
        fields, records = parse_table(path)
        expected[name + '.ts'] = render(name, fields, records, digest)
        print('[ok] %-16s %2d rows  sha256=%s' % (src, len(records), digest[:12]))

    stale = []
    existing = set(os.listdir(GENERATED)) if os.path.isdir(GENERATED) else set()
    for fname in sorted(set(expected) | existing):
        target = os.path.join(GENERATED, fname)
        want = expected.get(fname)
        have = None
        if os.path.isfile(target):
            with open(target, 'r', encoding='utf-8') as fh:
                have = fh.read()
        if want is None:
            stale.append('%s (orphan: no source table)' % fname)
        elif have != want:
            stale.append('%s (%s)' % (fname, 'missing' if have is None else 'out of date'))

    if check:
        if stale:
            for item in stale:
                print('[DRIFT] %s' % item)
            print('FAILED: generated/ is stale; run python scripts/export_tables.py')
            return 1
        print('OK: generated/ matches all source tables')
        return 0

    if not os.path.isdir(GENERATED):
        os.makedirs(GENERATED)
    for fname, content in expected.items():
        with open(os.path.join(GENERATED, fname), 'w', encoding='utf-8', newline='\n') as fh:
            fh.write(content)
    # Remove orphaned generated files so the source table contract always holds.
    for fname in existing - set(expected):
        os.remove(os.path.join(GENERATED, fname))
        print('[rm] orphan %s' % fname)
    print('Wrote %d generated files to %s' % (len(expected), GENERATED))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except ValueError as exc:
        print('ERROR: %s' % exc, file=sys.stderr)
        sys.exit(1)
