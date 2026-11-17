#!/usr/bin/env bash
# 從舊版 Google Apps Script 搬資料到 D1（只在資料庫是空的時候才會匯入，避免重複）
#   bash scripts/import-gas.sh --local             # 匯入本機開發資料庫
#   bash scripts/import-gas.sh --remote            # 匯入正式資料庫
#   bash scripts/import-gas.sh --remote <gas.json> # 用已經下載的檔案，不重新抓
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-}"
case "$TARGET" in
  --local) WR="npx --no-install wrangler" ;;
  --remote) . scripts/_env.sh ;;
  *) echo "用法：bash scripts/import-gas.sh --local|--remote [gas.json]" >&2; exit 1 ;;
esac
export WRANGLER_SEND_METRICS=false

GAS_URL="${GAS_URL:-https://script.google.com/macros/s/AKfycby60_GyNszlRXQyrJSgvi_zxx4G9swTuDj_jUQeLABa68kwz1R6ag9dWRQHyaW-S2sE/exec}"
mkdir -p backups
SRC="${2:-}"
if [ -z "$SRC" ]; then
  SRC="backups/gas-$(date +%Y%m%d-%H%M%S).json"
  echo "▶ 下載舊版資料"
  curl -fsSL --max-time 60 "$GAS_URL" -o "$SRC"
fi
echo "  來源：$SRC"

echo "▶ 確認資料庫是空的"
COUNT="$($WR d1 execute nice-family-db "$TARGET" --json \
  --command "SELECT (SELECT COUNT(*) FROM cards) + (SELECT COUNT(*) FROM albums) AS n" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0].results[0].n))")"
if [ "$COUNT" != "0" ] && [ "${FORCE:-}" != "1" ]; then
  echo "❌ 資料庫已經有 $COUNT 筆卡片／相簿，不重複匯入（確定要再匯入一次請加 FORCE=1）" >&2
  exit 1
fi

echo "▶ 轉換並匯入"
SQL="backups/import-$(date +%Y%m%d-%H%M%S).sql"
node scripts/lib/gas-to-sql.mjs "$SRC" > "$SQL"
$WR d1 execute nice-family-db "$TARGET" --file "$SQL" >/dev/null
echo "✔ 匯入完成"
