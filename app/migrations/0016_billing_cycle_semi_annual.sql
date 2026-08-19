-- D1 不能关闭外键；subscription_term_versions 被 reimbursement_candidates 引用，
-- 因此不能在本环境重建表以扩展 billing_cycle CHECK。
-- 半年付先不入库。本条仅占位，让远端 migration 记录可前进。
CREATE TABLE IF NOT EXISTS _migration_0016_noop (id INTEGER PRIMARY KEY);
DROP TABLE IF EXISTS _migration_0016_noop;
