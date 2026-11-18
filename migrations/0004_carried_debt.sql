-- 再開同名作業時，舊卡沒交的人併進新卡；carried 記錄這一格併進來幾份舊的
-- 新卡上用骷髏標出（欠1、欠2…）；老師銷帳時整列刪除，一起清掉
ALTER TABLE card_status ADD COLUMN carried INTEGER NOT NULL DEFAULT 0;
