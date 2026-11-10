#!/usr/bin/env bash
# Incremental regression gate — run only what the change can break.
#
#   bash scripts/verify.sh                  # infer modules from git changes
#   bash scripts/verify.sh combat meta     # explicit modules
#   bash scripts/verify.sh --all           # full gate (delegates to verify-all.sh)
#
# Design: each module owns its tests in assets/<module>/__tests__/, so a change
# confined to one module needs only that module's tests. The full gate is forced
# when shared/, the engine layer, build config, or an unknown path changed —
# those can break anything. Pure Markdown changes never trigger browser
# playthroughs. Output: artifacts/verify/incremental-summary.txt
#
# NOTE: pnpm is NOT on this machine's PATH. Use ./node_modules/.bin/*.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

VITEST=./node_modules/.bin/vitest
TSC=./node_modules/.bin/tsc
FX=./node_modules/.bin/forgeax
OUT=artifacts/verify
mkdir -p "$OUT"
SUMMARY="$OUT/incremental-summary.txt"
: > "$SUMMARY"
export CODEBUDDY_SAFE_DELETE_ENABLED=0

ALL_MODULES="combat battle meta talent resource"

log() { printf '%s\n' "$*" | tee -a "$SUMMARY"; }
die() { log "[FAIL] $*"; exit 1; }

if [ "${1:-}" = "--all" ]; then
  log "[FULL] --all → 转交 verify-all.sh"
  exec bash scripts/verify-all.sh
fi

modules=""
add_module() {
  case " $modules " in
    *" $1 "*) ;;
    *) modules="$modules $1" ;;
  esac
}

combat_play=0
force_full=0

if [ "$#" -gt 0 ]; then
  for m in "$@"; do
    case " $ALL_MODULES " in
      *" $m "*) add_module "$m" ;;
      *) die "未知模块：$m（可用：$ALL_MODULES）" ;;
    esac
    [ "$m" = "combat" ] && combat_play=1
  done
  log "[MODE] 显式指定模块：$modules"
else
  changed=$(
    {
      git diff --name-only
      git diff --cached --name-only
      git diff --name-only origin/main..HEAD 2>/dev/null || true
      # New module files are untracked until committed; `git diff` cannot see
      # them, so a change consisting only of new files would look like "no
      # change" and skip that module's tests entirely.
      git ls-files --others --exclude-standard
    } | sort -u
  )
  if [ -z "$changed" ]; then
    log "[IDLE] 未检测到改动，仅跑类型检查。"
  else
    log "[CHANGED] 本次改动文件："
    printf '%s\n' "$changed" | sed 's/^/  /' | tee -a "$SUMMARY"
  fi

  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
      *.md|docs/*) continue ;;
      assets/combat/*)
        add_module combat
        case "$f" in *.ts) combat_play=1 ;; esac ;;
      assets/battle/*)   add_module battle ;;
      assets/meta/*|meta-ui/*|scripts/verify-meta-ui.cjs|scripts/build-meta-ui.mjs)
        add_module meta ;;
      assets/talent/*)   add_module talent ;;
      assets/resource/*) add_module resource ;;
      assets/shared/*|assets/game/*|assets/__tests__/*|forge.json|package.json|pnpm-lock.yaml|tsconfig.json|vitest.config.ts|open-2.5d-game.bat)
        force_full=1 ;;
      scripts/playthrough*)
        add_module combat
        combat_play=1 ;;
      scripts/*) : ;;
      *) force_full=1 ;;
    esac
  done <<< "$changed"
fi

if [ "$force_full" -eq 1 ]; then
  log "[FULL] 命中共享层 / 引擎层 / 构建配置或未知路径 → 转交 verify-all.sh"
  exec bash scripts/verify-all.sh
fi

log "=== verify (增量) 开始 $(date '+%Y-%m-%d %H:%M:%S') ==="
log "[SCOPE] 模块：${modules:-（无）}｜combat 浏览器验收：$( [ "$combat_play" -eq 1 ] && echo 是 || echo 否 )"

# The standalone meta page is transpiled from assets/meta/inventory.ts. Check
# the generated script is in sync, then run its own headless-browser drag/drop
# acceptance. Both are the meta module's independent verification.
case " $modules " in
  *" meta "*)
    log "[RUN ] meta :: generated browser script in sync"
    node scripts/build-meta-ui.mjs --check >> "$SUMMARY" 2>&1 \
      || die "meta-ui/inventory.js 与 inventory.ts 不同步"
    log "[RUN ] meta :: standalone page browser acceptance"
    node scripts/verify-meta-ui.cjs >> "$SUMMARY" 2>&1 \
      || { tail -n 20 "$SUMMARY"; die "meta-ui 独立页面浏览器验收失败"; }
    ;;
esac

log "[RUN ] typecheck（全局，秒级）"
"$TSC" --noEmit > "$OUT/incremental-tsc.out" 2> "$OUT/incremental-tsc.err" \
  || { tail -n 20 "$OUT/incremental-tsc.out" "$OUT/incremental-tsc.err"; die "tsc 非零退出"; }
[ ! -s "$OUT/incremental-tsc.out" ] || die "tsc 有诊断输出"
log "[ OK ] typecheck :: 0 error"

for m in $modules; do
  path="assets/$m/__tests__"
  [ -d "$path" ] || die "$m：找不到独立验收目录 $path"
  log "[RUN ] $m :: vitest run $path"
  if ! "$VITEST" run "$path" > "$OUT/inc-$m.out" 2> "$OUT/inc-$m.err"; then
    tail -n 25 "$OUT/inc-$m.out" "$OUT/inc-$m.err" 2>/dev/null
    die "$m：单测失败"
  fi
  # vitest may emit ANSI colour codes even when redirected; strip them first.
  count=$(node -e '
    const fs=require("fs");
    const t=fs.readFileSync(process.argv[1],"utf8").replace(/\x1b\[[0-9;]*[mK]/g,"");
    const m=t.match(/Tests\s+(\d+)\s+passed/);
    process.stdout.write(m ? m[1] : "");
  ' "$OUT/inc-$m.out" 2>/dev/null || true)
  [ -n "$count" ] && [ "$count" -ge 1 ] || die "$m：未读到通过的测试数（验收被删空？）"
  log "[ OK ] $m :: $count passed"
done

if [ "$combat_play" -eq 1 ]; then
  check_play() {
    local name="$1" path="$2" min="$3"
    [ -f "$path" ] || die "$name：找不到报告 $path"
    node -e '
      const fs=require("fs");
      const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      const steps=(r.steps||[]).length;
      const bad=(r.steps||[]).filter(s=>!s.ok).length;
      const errs=(r.errors||[]).length;
      console.log(`passed=${r.passed} steps=${steps} failed=${bad} errors=${errs}`);
      if(!r.passed || bad || errs || steps < Number(process.argv[2])) process.exit(1);
    ' "$path" "$min" >> "$SUMMARY" 2>&1 || die "$name：报告不达标（步骤下限 $min）"
    log "[ OK ] $name"
  }
  log "[RUN ] combat :: playthrough（1600x900）"
  "$FX" project play --script scripts/playthrough.mjs \
    --viewports "1600x900,1280x600" --json > "$OUT/inc-playthrough.json" 2> "$OUT/inc-playthrough.err" \
    || { tail -n 20 "$OUT/inc-playthrough.json" "$OUT/inc-playthrough.err"; die "playthrough 非零退出"; }
  check_play playthrough artifacts/play/scripts/playthrough/play.json 35

  log "[RUN ] combat :: playthrough-resize（1700x1000）"
  "$FX" project play --script scripts/playthrough-resize.mjs --json \
    > "$OUT/inc-resize.json" 2> "$OUT/inc-resize.err" \
    || { tail -n 20 "$OUT/inc-resize.json" "$OUT/inc-resize.err"; die "resize 非零退出"; }
  check_play resize artifacts/play/scripts/playthrough-resize/play.json 4
fi

log "=== INCREMENTAL GREEN $(date '+%Y-%m-%d %H:%M:%S') ==="
log "发版前或跨模块改动请再跑一次 bash scripts/verify-all.sh（全量 + package）。"
