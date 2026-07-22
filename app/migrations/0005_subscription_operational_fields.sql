-- 可变的订阅运营信息。价格、币种、周期仍必须通过 term version 变更，
-- 不能在这些主数据字段中覆盖历史费用事实。
ALTER TABLE subscriptions ADD COLUMN auto_renew INTEGER NOT NULL DEFAULT 0
  CHECK (auto_renew IN (0, 1));
ALTER TABLE subscriptions ADD COLUMN payment_method_masked TEXT;
ALTER TABLE subscriptions ADD COLUMN notes TEXT;
