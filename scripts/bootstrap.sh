#!/usr/bin/env bash
# 第一次上線用（只需要執行一次）：
#   1. 建立正式 D1 資料庫，把 ID 寫進 wrangler.jsonc
#   2. 套用 migrations、從舊版 Google Apps Script 匯入資料
#   3. 部署
. "$(dirname "$0")/_env.sh"
: "${ADMIN_TOKEN:?請在 .env 設定 ADMIN_TOKEN（老師密碼）}"

if grep -q '00000000-0000-0000-0000-000000000000' wrangler.jsonc; then
  echo "▶ 建立 D1 資料庫 nice-family-db"
  OUT="$($WR d1 create nice-family-db 2>&1)" || { echo "$OUT" >&2; exit 1; }
  ID="$(printf '%s' "$OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
  [ -n "$ID" ] || { echo "$OUT" >&2; echo "❌ 找不到資料庫 ID" >&2; exit 1; }
  sed -i "s/00000000-0000-0000-0000-000000000000/$ID/" wrangler.jsonc
  echo "  ✔ $ID（已寫入 wrangler.jsonc，請 commit）"
fi

echo "▶ 套用 D1 migrations"
$WR d1 migrations apply nice-family-db --remote

echo "▶ 匯入舊版資料"
bash scripts/import-gas.sh --remote "${1:-}"

echo "▶ 部署 Worker"
$WR deploy
printf '%s' "$ADMIN_TOKEN" | $WR secret put ADMIN_TOKEN

echo "▶ 第一次備份"
bash scripts/backup.sh
echo "🎉 上線完成：$WORKER_URL （老師：$WORKER_URL/?mode=teacher）"
