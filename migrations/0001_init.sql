-- NICE 家族看板：資料表
-- 設計重點：
--   1. 每位學生的每個狀態是一筆資料（card_status），點一下只改一格，兩台裝置同時點不會互相覆蓋
--   2. 卡片與相簿都是「軟刪除」（deleted_at），取下、清空、全員完成後都可以從「復原」找回來
--   3. audit_log 記錄每一次修改

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES ('student_count', '25');

-- 作業卡（daily）與考試卡（exam）
CREATE TABLE cards (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT    NOT NULL CHECK (kind IN ('daily', 'exam')),
  name           TEXT    NOT NULL,                 -- 顯示名稱，例如「國習 11/17」「國語-第一單元」
  base_name      TEXT    NOT NULL,                 -- 作業種類，例如「國習」（再開同名作業時催繳升級用）
  priority       INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 5),
  locked         INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  created_at     INTEGER NOT NULL,                 -- 毫秒
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER,                          -- 不是 NULL 表示已取下（可以復原）
  deleted_reason TEXT                              -- manual 手動取下／completed 全員完成／clear 清空／escalated 被新卡接續
);
CREATE INDEX idx_cards_active ON cards (deleted_at, kind, priority);

-- 每位學生在每張卡的狀態；沒有資料 = 0（已完成）
-- 1 未交／2 再催／3 嚴重
CREATE TABLE card_status (
  card_id    INTEGER NOT NULL REFERENCES cards (id),
  seat       INTEGER NOT NULL CHECK (seat >= 1),
  status     INTEGER NOT NULL CHECK (status BETWEEN 1 AND 3),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (card_id, seat)
);

CREATE TABLE albums (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  icon        TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  url         TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);

CREATE TABLE audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  action TEXT    NOT NULL,
  detail TEXT    NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_audit_at ON audit_log (at);
