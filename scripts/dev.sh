#!/usr/bin/env bash
# 本機開發：http://localhost:8787 （老師模式：http://localhost:8787/?mode=teacher）
# 本機老師密碼放在 .dev.vars（ADMIN_TOKEN=...），沒有的話會自動建立，密碼是 dev
set -euo pipefail
cd "$(dirname "$0")/.."
export WRANGLER_SEND_METRICS=false
[ -f .dev.vars ] || printf 'ADMIN_TOKEN=dev\n' > .dev.vars
npx --no-install wrangler d1 migrations apply nice-family-db --local
npx --no-install wrangler dev --ip 127.0.0.1 --port 8787 --show-interactive-dev-session=false
