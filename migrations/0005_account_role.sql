-- 帳號權限：helper = 小秘書（只能登記）；teacher = 導師二等協同老師（老師權限，但不能管理帳號）
ALTER TABLE accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'helper' CHECK (role IN ('helper', 'teacher'));
