#!/usr/bin/env bash
# 執行所有檢查與測試（本機獨立資料庫，不會碰到正式環境）
set -euo pipefail
cd "$(dirname "$0")/.."
export WRANGLER_SEND_METRICS=false

echo "▶ 型別檢查"; npx --no-install tsc --noEmit
echo "▶ API 測試"; node tests/run.mjs
echo "🎉 全部通過"
