#!/usr/bin/env bash
# 共用：讀取 .env 並檢查必要變數（由其他腳本 source）
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# 去掉 \r：.env 若被存成 CRLF，密碼和 Token 尾端會多一個看不見的字元
if [ -f .env ]; then set -a; . <(tr -d '\r' < .env); set +a; fi
: "${CLOUDFLARE_API_TOKEN:?請在 .env 設定 CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?請在 .env 設定 CLOUDFLARE_ACCOUNT_ID}"
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
export WRANGLER_SEND_METRICS=false
WR="npx --no-install wrangler"
WORKER_URL="${WORKER_URL:-https://nice-family.teacherbear.workers.dev}"
