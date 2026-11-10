#!/usr/bin/env python3
"""Create a restorable, source-only baseline of this project.

Why this exists: the project has no .git. A fresh AI session can overwrite
game logic with no way back. This zip is the rollback point. It deliberately
excludes node_modules/, dist/, browser profiles and probe artifacts.

Usage (from anywhere):
    python scripts/make-source-baseline.py
    python scripts/make-source-baseline.py --date 2026-11-10

Writes:
    release/forgeax-game-source-baseline-<date>.zip
    release/forgeax-game-source-baseline-<date>.zip.sha256
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RELEASE = ROOT / "release"
STEM = "forgeax-game-source-baseline"

# Everything needed to rebuild the project from scratch, including the
# assertion suites (they are the real anti-regression guard) and the local
# vendor SDK that package.json refers to with `file:./vendor/...`.
INCLUDE_DIRS = ("assets", "scripts", "docs", "skills", "vendor", ".game-builder")
INCLUDE_FILES = (
    "README.md",
    "AGENTS.md",
    "HANDOFF.md",
    "forge.json",
    "template.json",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    ".gitignore",
    ".gitattributes",
    "open-2.5d-game.bat",
)
SKIP_NAMES = {"__pycache__", ".DS_Store", "Thumbs.db"}
SKIP_SUFFIXES = (".pyc", ".pyo", ".log", ".tmp")


def collect() -> list[Path]:
    found: set[Path] = set()
    for rel in INCLUDE_FILES:
        path = ROOT / rel
        if path.is_file():
            found.add(path)
        else:
            print(f"WARN: missing expected file {rel}")
    for dirname in INCLUDE_DIRS:
        base = ROOT / dirname
        if not base.is_dir():
            print(f"WARN: missing expected dir {dirname}")
            continue
        for path in base.rglob("*"):
            if not path.is_file():
                continue
            if any(part in SKIP_NAMES for part in path.parts):
                continue
            if path.suffix.lower() in SKIP_SUFFIXES:
                continue
            found.add(path)
    return sorted(found, key=lambda p: p.relative_to(ROOT).as_posix())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", default=dt.date.today().isoformat(),
                        help="baseline date tag, default: today")
    args = parser.parse_args()

    RELEASE.mkdir(parents=True, exist_ok=True)
    zip_path = RELEASE / f"{STEM}-{args.date}.zip"
    sha_path = Path(str(zip_path) + ".sha256")
    files = collect()

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in files:
            zf.write(path, path.relative_to(ROOT).as_posix())

    digest = hashlib.sha256(zip_path.read_bytes()).hexdigest()
    # write_bytes (not write_text): on Windows text mode would turn the LF into
    # CRLF, and sha256sum -c would then look for a filename ending in "\r".
    sha_path.write_bytes(f"{digest}  {zip_path.name}\n".encode("ascii"))

    print(f"baseline : {zip_path}")
    print(f"entries  : {len(files)}")
    print(f"bytes    : {zip_path.stat().st_size}")
    print(f"sha256   : {digest}")
    print(f"verify   : cd release && sha256sum -c {sha_path.name}")
    print("restore  : unzip into an empty dir, then pnpm install --frozen-lockfile --ignore-scripts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
