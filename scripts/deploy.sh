#!/usr/bin/env bash
# 部署（每一步失敗都會立刻停止）：
#   1. 測試（SKIP_TESTS=1 可跳過）
#   2. 備份正式資料
#   3. 套用 D1 migrations → 部署 Worker → 同步 ADMIN_TOKEN secret
#   4. 部署後重新讀取看板，和部署前比對
. "$(dirname "$0")/_env.sh"

if [ "${SKIP_TESTS:-}" != "1" ]; then
  echo "▶ 測試"
  bash scripts/test.sh
fi

echo "▶ 部署前備份"
bash scripts/backup.sh
STAMP="$(cat backups/latest)"

echo "▶ 套用 D1 migrations"
$WR d1 migrations apply nice-family-db --remote

echo "▶ 部署 Worker"
$WR deploy

if [ -n "${ADMIN_TOKEN:-}" ]; then
  echo "▶ 同步 ADMIN_TOKEN secret"
  printf '%s' "$ADMIN_TOKEN" | $WR secret put ADMIN_TOKEN
fi

echo "▶ 部署後檢查資料"
AFTER="$(mktemp)"
curl -fsS "$WORKER_URL/api/board" -o "$AFTER"
if node -e "
const fs = require('fs');
const a = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const b = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const pick = d => JSON.stringify({ n: d.studentCount, daily: d.daily, exam: d.exam, albums: d.albums });
process.exit(pick(a) === pick(b) ? 0 : 1);
" "backups/nice-family-$STAMP.json" "$AFTER"; then
  rm -f "$AFTER"
  echo "🎉 部署完成，資料與部署前相同（備份：backups/nice-family-$STAMP.*）"
else
  rm -f "$AFTER"
  echo "⚠ 部署後資料和部署前不同（可能是部署期間有人點了看板）。部署前備份：backups/nice-family-$STAMP.*" >&2
  exit 1
fi
