#!/usr/bin/env bash
# Show how far the working tree has drifted from the committed baseline.
# Run this FIRST in a fresh AI session, before editing anything.
#
#   bash scripts/check-drift.sh
#
# It never modifies files. To restore one file: git checkout HEAD -- <path>
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

PROTECTED=(
  assets/game/simulation.ts
  assets/game/game.pack.ts
  assets/game/paint.ts
  assets/__tests__/movement.test.ts
  scripts/playthrough.mjs
  scripts/playthrough-resize.mjs
  scripts/verify-all.sh
  open-2.5d-game.bat
  HANDOFF.md
)

echo "=== baseline commit ==="
git log -1 --oneline --decorate 2>&1

echo "=== all changes vs HEAD ==="
git status --short 2>&1

echo "=== protected files changed since HEAD ==="
changed=$(git diff --name-only HEAD -- "${PROTECTED[@]}" 2>/dev/null)
if [ -z "$changed" ]; then
  echo "(none)"
else
  printf '%s\n' "$changed"
  echo "--- diff stat ---"
  git diff --stat HEAD -- "${PROTECTED[@]}" 2>&1
fi

echo "=== how to restore ==="
echo "  git checkout HEAD -- <path>       # one file"
echo "  git reset --hard HEAD            # everything (DESTRUCTIVE: review first)"
echo "  bash scripts/verify-all.sh       # confirm the restored tree is green"
