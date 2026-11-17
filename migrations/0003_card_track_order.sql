-- 卡片分類與排列順序
-- track：放在哪一欄（chinese 語文類／math 數學與其他）；NULL 代表依名稱自動判斷
-- sort_order：老師拖曳排列的順序；NULL 代表還沒排過，放在該欄最後
-- 再開同名作業時，新卡片會沿用上一張的分類和位置

ALTER TABLE cards ADD COLUMN track TEXT CHECK (track IN ('chinese', 'math'));
ALTER TABLE cards ADD COLUMN sort_order INTEGER;
