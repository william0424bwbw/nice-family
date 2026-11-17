# nice-family 專案說明（給 Claude Code）

班級親師看板：點作業／考試缺交、閉嘴牆總表、雲端相簿連結。部署在 Cloudflare Workers + D1（https://nice-family.teacherbear.workers.dev）。環境沿用 `../sport-day`。

## 專案規範（必須遵守）
- 腳本一律寫成 `.sh`（`#!/usr/bin/env bash`），放在 `scripts/`，用 Git Bash 執行；新增後 `git update-index --chmod=+x scripts/<名稱>.sh`
- 所有文字檔 UTF-8（無 BOM）+ LF；不要用 PowerShell 寫檔
- `.env`、`.dev.vars` 不可以 commit
- 部署和維護都用腳本，不要指示使用者到 Cloudflare Dashboard 手動操作

## 架構
- `public/index.html`：前端（單一檔案、原生 JS，不需要建置）
- `src/worker/index.ts`：API；`GET /api/board` 公開，其餘寫入要 `Authorization: Bearer <ADMIN_TOKEN>`
- D1：`cards`（daily／exam，軟刪除 `deleted_at`）、`card_status`（每位學生一格，沒有資料 = 0 已完成）、`albums`、`audit_log`、`settings`（`student_count`）
- 狀態：0 已完成、1 未交、2 再催、3 嚴重；點一下 +1，長按歸零。再開同名日常作業時，上一張未交的人自動升級
- 根目錄 `index.html` 是 GitHub Pages 的跳轉頁（舊網址 → 新網址）；舊版程式碼在 `legacy/index.html` 只當參考

## 常用指令
- 本機開發：`npm run dev` → http://localhost:8787/?mode=teacher（密碼在 `.dev.vars`，預設 dev）
- 測試：`bash scripts/test.sh`
- 第一次上線：`bash scripts/bootstrap.sh`（建立 D1 → 匯入舊資料 → 部署）
- 部署：`bash scripts/deploy.sh`（測試 → 備份 → migrations → 部署 → 資料比對）
- 備份：`bash scripts/backup.sh`
- 新增 migration：`npm run db:new -- <名稱>`
