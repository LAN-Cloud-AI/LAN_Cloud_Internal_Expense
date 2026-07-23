-- 飞书导入功能整体下线：系统不再与多维表格同步，来源血缘表全部移除。
-- 已导入的业务数据（人员、订阅、条款、付款者、账号资产）保留。
DROP TABLE IF EXISTS source_mapping_errors;
DROP TABLE IF EXISTS source_records;
DROP TABLE IF EXISTS source_import_runs;
DROP TABLE IF EXISTS source_schema_versions;
DROP TABLE IF EXISTS source_connections;
ALTER TABLE subscriptions DROP COLUMN source_record_id;
