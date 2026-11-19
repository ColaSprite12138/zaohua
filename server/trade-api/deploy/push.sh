#!/usr/bin/env bash
#
# 把本地 server/trade-api 推到 CVM 并重启 systemd 服务。
#
#   bash server/trade-api/deploy/push.sh
#
# 为什么不是 git pull：服务器上 /opt/colasprite-api **不是 git 仓库**（故意的——
# 线上不暴露 .git，也不让线上有推送权限），所以走 scp 覆盖 + 重启。
#
# 每次都会先备份 data/app.db。回滚 = 把 data/app.db.bak-<stamp> 覆盖回 app.db，
# 再把 git 切到上一个 commit 重跑这个脚本。
#
# 不传 --delete / -r 之外的任何同步语义：src/ 里被删掉的文件不会自动消失，
# 删文件时必须手动 ssh 清理（宁可多留一个孤儿文件，也不要误删 wallet.mjs）。
set -euo pipefail

HOST="${HOST:-root@43.154.234.9}"
DEST="${DEST:-/opt/colasprite-api}"
SERVICE="${SERVICE:-trade-api}"

here="$(cd "$(dirname "$0")/.." && pwd)"
stamp="$(date +%Y%m%d-%H%M%S)"

echo "[1/5] 备份线上数据库 -> data/app.db.bak-${stamp}"
ssh "$HOST" "cp ${DEST}/data/app.db ${DEST}/data/app.db.bak-${stamp}"

echo "[2/5] 上传入口与包清单"
scp -q "${here}/server.mjs" "${here}/package.json" "${here}/prune.mjs" "${HOST}:${DEST}/"

echo "[3/5] 上传 src/*.mjs"
scp -q "${here}"/src/*.mjs "${HOST}:${DEST}/src/"

echo "[4/5] 重启 ${SERVICE}"
ssh "$HOST" "systemctl restart ${SERVICE} && sleep 1 && systemctl is-active ${SERVICE}"

echo "[5/5] 线上自检"
ssh "$HOST" "curl -fsS --max-time 5 http://127.0.0.1:8790/api/v1/health || curl -fsS --max-time 5 http://127.0.0.1:8790/ || true" || true
echo
echo "完成。备份：${DEST}/data/app.db.bak-${stamp}"
