-- 小秘書帳號，以及「誰登記的」紀錄
-- 秘書只能把狀態往上調（登記沒交）；銷帳只有老師能做。
-- 秘書可以取消自己 5 分鐘內的登記：還原成她開始點之前的狀態（prev_status）

CREATE TABLE accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL UNIQUE,      -- 顯示名稱，例如「小狐狸」
  short         TEXT    NOT NULL,             -- 格子上的徽章字，例如「狐」
  salt          TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,             -- SHA-256(salt + 密碼)
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 密碼錯誤紀錄：錯太多次就先擋下所有登入（在比對密碼之前檢查，猜對也一樣擋）
CREATE TABLE auth_failures (
  ip TEXT    NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX idx_auth_failures ON auth_failures (at, ip);

ALTER TABLE card_status ADD COLUMN updated_by TEXT;                      -- 誰最後改了這格（老師或秘書名稱）
ALTER TABLE card_status ADD COLUMN prev_status INTEGER NOT NULL DEFAULT 0; -- 這個人開始點之前的狀態（取消登記用）
ALTER TABLE cards ADD COLUMN created_by TEXT;
