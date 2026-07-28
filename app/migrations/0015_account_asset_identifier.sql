-- 账号资产的服务/平台标识；未识别的历史记录显式保留为“未分类”。
ALTER TABLE account_assets
  ADD COLUMN asset_identifier TEXT NOT NULL DEFAULT '未分类'
  CHECK (length(trim(asset_identifier)) > 0);

UPDATE account_assets
SET asset_identifier = CASE
  WHEN display_name LIKE '%的OBS' THEN 'OBS'
  WHEN display_name LIKE '% · GitHub ID' THEN 'GitHub'
  WHEN display_name LIKE '% · GitHub 邮箱' THEN 'GitHub'
  WHEN display_name LIKE '% · LeadsHunter 用户名' THEN 'LeadsHunter'
  WHEN display_name LIKE '% · Obsidian' THEN 'Obsidian'
  WHEN display_name LIKE '% · 兰芯域名邮箱' THEN '兰芯域名邮箱'
  ELSE asset_identifier
END;
