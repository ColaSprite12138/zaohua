#!/usr/bin/env bash
# One-command regression gate for the 2.5D arena.
#
# Why this exists: a fresh AI session can rewrite game logic without ever
# reading HANDOFF.md. This script makes the committed contract executable —
# deleting assertions, lowering step counts, or breaking the mouse mapping
# fails here instead of silently shipping.
#
# Usage (from the project root, in Git Bash):
#   bash scripts/verify-all.sh
# Output: artifacts/verify/summary.txt plus per-command .json / .stderr.log
#
# NOTE: pnpm is NOT on this machine's PATH. Always use ./node_modules/.bin/*.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

FX=./node_modules/.bin/forgeax
TSC=./node_modules/.bin/tsc
OUT=artifacts/verify
mkdir -p "$OUT"
SUMMARY="$OUT/summary.txt"
: > "$SUMMARY"

# Vite's safe-delete hook blocks build/package in this environment.
export CODEBUDDY_SAFE_DELETE_ENABLED=0

log() { printf '%s\n' "$*" | tee -a "$SUMMARY"; }
die() {
  log "[FAIL] $*"
  log "完整输出见 $SUMMARY 与 $OUT/"
  exit 1
}

run_json() {
  local name="$1"; shift
  local o="$OUT/$name.json" e="$OUT/$name.stderr.log"
  log "[RUN ] $name"
  if ! "$@" > "$o" 2> "$e"; then
    tail -n 20 "$o" "$e" 2>/dev/null
    die "$name：命令非零退出"
  fi
  local ok
  ok=$(node -e 'const fs=require("fs");const t=fs.readFileSync(process.argv[1],"utf8");const i=t.indexOf("{");process.stdout.write(String(JSON.parse(t.slice(i)).ok))' "$o" 2>/dev/null || echo "?")
  [ "$ok" = "true" ] || die "$name：JSON ok=$ok"
  log "[ OK ] $name"
}

# A step-count FLOOR is deliberate: a fresh session that deletes assertions
# to make the suite green must fail here, not be rewarded.
check_report() {
  local name="$1" path="$2" min_steps="$3"
  [ -f "$path" ] || die "$name：找不到报告 $path"
  local line
  line=$(node -e '
    const fs=require("fs");
    const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const steps=(r.steps||[]).length;
    const bad=(r.steps||[]).filter(s=>!s.ok).length;
    const errs=(r.errors||[]).length;
    console.log(`passed=${r.passed} steps=${steps} failedSteps=${bad} errors=${errs} viewports=${(r.viewports||[]).join(",")}`);
    if(!r.passed || bad || errs || steps < Number(process.argv[2])) process.exit(1);
  ' "$path" "$min_steps") || die "$name：报告不达标（含断言数量下限 $min_steps）"
  log "[ OK ] $name :: $line"
}

log "=== verify-all 开始 $(date '+%Y-%m-%d %H:%M:%S') ==="
log "工程：$(pwd)"

run_json check "$FX" project check --json

run_json test "$FX" project test --json
# vitest writes its summary to stderr with ANSI colour codes between "Tests"
# and the number, so a plain grep misses it. Strip escapes before matching.
tests=$(node -e '
  const fs=require("fs");
  const t=fs.readFileSync(process.argv[1],"utf8").replace(/\x1b\[[0-9;]*[mK]/g,"");
  const m=t.match(/Tests\s+(\d+)\s+passed/);
  process.stdout.write(m ? m[1] : "");
' "$OUT/test.stderr.log" 2>/dev/null || true)
[ "$tests" = "13" ] || die "单测数量应为 13，实际 ${tests:-未读到}（断言被删？）"
log "[ OK ] test :: 13 passed"

log "[RUN ] typecheck"
if ! "$TSC" --noEmit > "$OUT/tsc.out" 2> "$OUT/tsc.err"; then
  tail -n 20 "$OUT/tsc.out" "$OUT/tsc.err" 2>/dev/null
  die "typecheck：tsc 非零退出"
fi
[ ! -s "$OUT/tsc.out" ] || die "typecheck：tsc 有诊断输出"
log "[ OK ] typecheck :: 0 error"

run_json build "$FX" project build --json

run_json playthrough "$FX" project play \
  --script scripts/playthrough.mjs \
  --viewports "1600x900,1280x600" --json
check_report playthrough artifacts/play/scripts/playthrough/play.json 32

run_json resize "$FX" project play \
  --script scripts/playthrough-resize.mjs --json
check_report resize artifacts/play/scripts/playthrough-resize/play.json 4

run_json package "$FX" project package --output "$OUT/forgeax-game-web.zip" --json
( cd "$OUT" && sha256sum -c forgeax-game-web.zip.sha256 ) >> "$SUMMARY" 2>&1 \
  || die "package：sha256 校验失败"
log "[ OK ] package :: sha256 校验通过（验收包在 $OUT/，不动 release/）"

log "=== ALL GREEN $(date '+%Y-%m-%d %H:%M:%S') ==="
log "如步骤数高于基线，说明新增了断言：请同步更新 HANDOFF.md 的验收基线数字。"
