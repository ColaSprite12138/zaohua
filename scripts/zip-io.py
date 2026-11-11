#!/usr/bin/env python3
"""ZIP container helpers for scripts/package-with-shell.mjs.

The engine's Web ZIP is a plain archive, but Node has no built-in ZIP reader.
This module only moves bytes in and out of the container; every content
decision (shell injection, manifest hashing) stays in the Node script so there
is a single source of truth.

    python scripts/zip-io.py extract <archive.zip> <target-dir>
    python scripts/zip-io.py pack    <archive.zip> <source-dir>
"""

import os
import sys
import zipfile

# The engine writes reproducible 1980-01-01 timestamps; keep them on repack.
FIXED_TIME = (1980, 1, 1, 0, 0, 0)


def extract(archive, target):
    os.makedirs(target, exist_ok=True)
    root = os.path.realpath(target)
    with zipfile.ZipFile(archive, "r") as zf:
        for info in zf.infolist():
            dest = os.path.realpath(os.path.join(root, info.filename))
            if os.path.commonpath([root, dest]) != root:
                raise ValueError("unsafe entry in archive: %s" % info.filename)
            if info.is_dir():
                os.makedirs(dest, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with zf.open(info) as src, open(dest, "wb") as out:
                out.write(src.read())


def pack(archive, source):
    root = os.path.realpath(source)
    parent = os.path.dirname(os.path.abspath(archive))
    if parent:
        os.makedirs(parent, exist_ok=True)
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames.sort()
            for name in sorted(filenames):
                full = os.path.join(dirpath, name)
                rel = os.path.relpath(full, root).replace(os.sep, "/")
                info = zipfile.ZipInfo(rel, date_time=FIXED_TIME)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                with open(full, "rb") as src:
                    zf.writestr(info, src.read())


def main():
    if len(sys.argv) != 4 or sys.argv[1] not in ("extract", "pack"):
        print("usage: zip-io.py extract|pack <archive.zip> <directory>", file=sys.stderr)
        return 2
    action, archive, directory = sys.argv[1], sys.argv[2], sys.argv[3]
    if action == "extract":
        extract(archive, directory)
    else:
        pack(archive, directory)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
