#!/usr/bin/env bash
# 備份正式資料到 backups/（不進版控）：
#   nice-family-<時間>.sql    整個資料庫（含已取下的卡片與修改紀錄）
#   nice-family-<時間>.json   目前看板內容（GET /api/board）
# 設定 BACKUP_MIRROR_DIR（.env）時，會再複製一份到該資料夾（例如 OneDrive）
# 最新一次的時間戳記寫在 backups/latest（deploy.sh 會用到）
. "$(dirname "$0")/_env.sh"
mkdir -p backups
STAMP="$(date +%Y%m%d-%H%M%S)"
SQL="backups/nice-family-$STAMP.sql"
JSON="backups/nice-family-$STAMP.json"

echo "▶ 匯出整個資料庫"
$WR d1 export nice-family-db --remote --output "$SQL" >/dev/null
[ -s "$SQL" ] || { echo "❌ SQL 備份是空的：$SQL" >&2; exit 1; }

echo "▶ 匯出看板內容"
curl -fsS "$WORKER_URL/api/board" -o "$JSON"
node -e "
const d = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
if (!Array.isArray(d.daily) || !Array.isArray(d.albums)) throw new Error('JSON 內容不正確');
console.log('  日常作業 ' + d.daily.length + ' 張、考試 ' + d.exam.length + ' 張、相簿 ' + d.albums.length + ' 本');
" "$JSON"

echo "$STAMP" > backups/latest
if [ -n "${BACKUP_MIRROR_DIR:-}" ]; then
  mkdir -p "$BACKUP_MIRROR_DIR"
  cp "$SQL" "$JSON" "$BACKUP_MIRROR_DIR/"
  echo "  另存一份到 $BACKUP_MIRROR_DIR"
fi
echo "✔ 已備份：$SQL $JSON"
