-- 供应商维度不再使用：导入完成后订阅等数据都在系统内维护，表单不再采集 vendor。
-- 既有行均未有 API 写入来源，直接删除列与表。
ALTER TABLE subscriptions DROP COLUMN vendor_id;
ALTER TABLE account_assets DROP COLUMN vendor_id;
DROP TABLE vendors;
