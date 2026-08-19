-- 账期增加半年付；周期从订阅生效日起整期连续覆盖。
PRAGMA foreign_keys = OFF;

DROP TRIGGER IF EXISTS subscription_term_versions_no_overlap_insert;
DROP TRIGGER IF EXISTS subscription_term_versions_no_overlap_update;

CREATE TABLE subscription_term_versions_new (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  effective_start TEXT NOT NULL,
  effective_end TEXT,
  billing_cycle TEXT NOT NULL CHECK (billing_cycle IN ('monthly', 'quarterly', 'semi_annual', 'yearly', 'one_time')),
  settlement_mode TEXT NOT NULL CHECK (settlement_mode IN ('actual_bill', 'accrual')),
  billing_anchor_date TEXT NOT NULL,
  original_currency TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (effective_end IS NULL OR effective_end >= effective_start)
);

INSERT INTO subscription_term_versions_new (
  id, subscription_id, effective_start, effective_end, billing_cycle,
  settlement_mode, billing_anchor_date, original_currency, amount_minor, created_at
)
SELECT
  id, subscription_id, effective_start, effective_end, billing_cycle,
  settlement_mode, billing_anchor_date, original_currency, amount_minor, created_at
FROM subscription_term_versions;

DROP TABLE subscription_term_versions;
ALTER TABLE subscription_term_versions_new RENAME TO subscription_term_versions;

CREATE TRIGGER subscription_term_versions_no_overlap_insert
BEFORE INSERT ON subscription_term_versions
WHEN EXISTS (
  SELECT 1 FROM subscription_term_versions AS existing
  WHERE existing.subscription_id = NEW.subscription_id
    AND COALESCE(existing.effective_end, '9999-12-31') >= NEW.effective_start
    AND COALESCE(NEW.effective_end, '9999-12-31') >= existing.effective_start
)
BEGIN
  SELECT RAISE(ABORT, 'overlapping subscription term versions');
END;

CREATE TRIGGER subscription_term_versions_no_overlap_update
BEFORE UPDATE OF subscription_id, effective_start, effective_end ON subscription_term_versions
WHEN EXISTS (
  SELECT 1 FROM subscription_term_versions AS existing
  WHERE existing.subscription_id = NEW.subscription_id
    AND existing.id != NEW.id
    AND COALESCE(existing.effective_end, '9999-12-31') >= NEW.effective_start
    AND COALESCE(NEW.effective_end, '9999-12-31') >= existing.effective_start
)
BEGIN
  SELECT RAISE(ABORT, 'overlapping subscription term versions');
END;

PRAGMA foreign_keys = ON;
