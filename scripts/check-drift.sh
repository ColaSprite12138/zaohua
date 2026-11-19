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
  assets/game/voxel.ts
  assets/game/atlas.ts
  assets/game/status-bar.ts
  assets/combat/status.ts
  assets/combat/reactions.ts
  assets/combat/attack.ts
  assets/combat/skills.ts
  assets/combat/sight.ts
  assets/combat/fog.ts
  assets/combat/zones.ts
  assets/resource/maps/arena.ldtk
  assets/resource/maps/arena.generated.ts
  assets/resource/maps/tileset.generated.ts
  assets/resource/maps/tilesets/xianxia.png
  scripts/bake-voxel-atlas.mjs
  scripts/arena_layout.py
  scripts/preview_map.py
  scripts/gen_arena_map.py
  scripts/import_map.py
  docs/art-style.md
  assets/__tests__/movement.test.ts
  assets/meta/inventory.ts
  assets/meta/trade.ts
  assets/meta/shop.ts
  assets/meta/workshop.ts
  assets/resource/tables/shop.xlsx
  assets/resource/tables/workshop.xlsx
  assets/combat/attack-spec.ts
  assets/combat/monster-skills.ts
  assets/combat/enemies.ts
  assets/resource/tables/monster.xlsx
  assets/resource/tables/monster_skill.xlsx
  scripts/playthrough.mjs
  scripts/playthrough-resize.mjs
  scripts/playthrough-monster-skill.mjs
  scripts/playthrough-worldmap.mjs
  # 搜打撤 PVP（2026-11-20）：撮合撮合契约、配对状态机、房间接线。改这些 = 改联机行为。
  docs/pvp-matchmaking.md
  server/trade-api/src/match.mjs
  assets/meta/match-client.ts
  meta-ui/match-flow.js
  assets/combat/source.ts
  scripts/playthrough-fog.mjs
  scripts/lib/map-route.mjs
  scripts/verify-all.sh
  # 帧同步 P2（2026-11-20）：这几份一起构成「同一份输入 → 同一份结果」的契约。
  # 改任何一份都等于改协议，必须同步更新 docs/pvp-matchmaking.md 的手册页。
  assets/net/step-clock.ts
  assets/net/input-frame.ts
  assets/net/input-latch.ts
  assets/net/lockstep.ts
  assets/net/state-hash.ts
  assets/net/remote-actor.ts
  assets/net/base64.ts
  meta-ui/net-bridge.js
  game/server/source/index.ts
  scripts/verify-fixed-step.mjs
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
