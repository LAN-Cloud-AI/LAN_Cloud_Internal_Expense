-- 当前没有半年付条款。D1 不能关闭外键，因此先复制条款、候选、明细到新表，
-- 再按子表→父表顺序替换，以把 billing_cycle CHECK 扩到 semi_annual。

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

CREATE TABLE reimbursement_candidates_new (
  id TEXT PRIMARY KEY,
  subscription_term_version_id TEXT NOT NULL REFERENCES subscription_term_versions_new(id),
  payer_assignment_id TEXT NOT NULL REFERENCES payer_assignments(id),
  source_charge_id TEXT,
  coverage_start TEXT NOT NULL,
  coverage_end TEXT NOT NULL,
  original_currency TEXT NOT NULL,
  original_amount_minor INTEGER NOT NULL CHECK (original_amount_minor >= 0),
  fx_quote_id TEXT REFERENCES fx_quotes(id),
  rate_numerator INTEGER NOT NULL CHECK (rate_numerator > 0),
  rate_denominator INTEGER NOT NULL CHECK (rate_denominator > 0),
  cny_amount_fen INTEGER NOT NULL CHECK (cny_amount_fen >= 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'selected', 'batched', 'paid', 'void')),
  locked_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (coverage_end >= coverage_start),
  UNIQUE (
    subscription_term_version_id,
    payer_assignment_id,
    coverage_start,
    coverage_end,
    source_charge_id
  )
);

INSERT INTO reimbursement_candidates_new (
  id, subscription_term_version_id, payer_assignment_id, source_charge_id,
  coverage_start, coverage_end, original_currency, original_amount_minor,
  fx_quote_id, rate_numerator, rate_denominator, cny_amount_fen, status, locked_at, created_at
)
SELECT
  id, subscription_term_version_id, payer_assignment_id, source_charge_id,
  coverage_start, coverage_end, original_currency, original_amount_minor,
  fx_quote_id, rate_numerator, rate_denominator, cny_amount_fen, status, locked_at, created_at
FROM reimbursement_candidates;

CREATE TABLE reimbursement_items_new (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES reimbursement_batches(id),
  candidate_id TEXT NOT NULL REFERENCES reimbursement_candidates_new(id),
  payer_id TEXT NOT NULL REFERENCES payers(id),
  coverage_start TEXT NOT NULL,
  coverage_end TEXT NOT NULL,
  original_currency TEXT NOT NULL,
  original_amount_minor INTEGER NOT NULL CHECK (original_amount_minor >= 0),
  rate_numerator INTEGER NOT NULL CHECK (rate_numerator > 0),
  rate_denominator INTEGER NOT NULL CHECK (rate_denominator > 0),
  cny_amount_fen INTEGER NOT NULL CHECK (cny_amount_fen >= 0),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'approved', 'paid', 'void')),
  voided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (coverage_end >= coverage_start)
);

INSERT INTO reimbursement_items_new (
  id, batch_id, candidate_id, payer_id, coverage_start, coverage_end,
  original_currency, original_amount_minor, rate_numerator, rate_denominator,
  cny_amount_fen, status, voided_at, created_at
)
SELECT
  id, batch_id, candidate_id, payer_id, coverage_start, coverage_end,
  original_currency, original_amount_minor, rate_numerator, rate_denominator,
  cny_amount_fen, status, voided_at, created_at
FROM reimbursement_items;

DROP TRIGGER IF EXISTS reimbursement_batches_payer_matches_existing_items;
DROP TRIGGER IF EXISTS reimbursement_items_candidate_must_be_pending_insert;
DROP TRIGGER IF EXISTS reimbursement_items_candidate_must_be_pending_update;
DROP TRIGGER IF EXISTS reimbursement_items_batch_payer_match_insert;
DROP TRIGGER IF EXISTS reimbursement_items_batch_payer_match_update;
DROP TRIGGER IF EXISTS reimbursement_items_candidate_payer_match_insert;
DROP TRIGGER IF EXISTS reimbursement_items_candidate_payer_match_update;
DROP TRIGGER IF EXISTS reimbursement_items_paid_immutable;
DROP TRIGGER IF EXISTS reimbursement_items_paid_no_delete;
DROP INDEX IF EXISTS reimbursement_items_one_active_candidate;
DROP TABLE reimbursement_items;

DROP INDEX IF EXISTS reimbursement_candidates_pending_idx;
DROP INDEX IF EXISTS reimbursement_candidates_one_automatic_coverage;
DROP TABLE reimbursement_candidates;

DROP TRIGGER IF EXISTS subscription_term_versions_no_overlap_insert;
DROP TRIGGER IF EXISTS subscription_term_versions_no_overlap_update;
DROP TABLE subscription_term_versions;

ALTER TABLE subscription_term_versions_new RENAME TO subscription_term_versions;
ALTER TABLE reimbursement_candidates_new RENAME TO reimbursement_candidates;
ALTER TABLE reimbursement_items_new RENAME TO reimbursement_items;

CREATE INDEX reimbursement_candidates_pending_idx
  ON reimbursement_candidates (status, payer_assignment_id, coverage_start);
CREATE UNIQUE INDEX reimbursement_candidates_one_automatic_coverage
  ON reimbursement_candidates (
    subscription_term_version_id,
    payer_assignment_id,
    coverage_start,
    coverage_end
  )
  WHERE source_charge_id IS NULL AND status != 'void';
CREATE UNIQUE INDEX reimbursement_items_one_active_candidate
  ON reimbursement_items (candidate_id) WHERE voided_at IS NULL;

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

CREATE TRIGGER reimbursement_items_paid_immutable
BEFORE UPDATE ON reimbursement_items
WHEN OLD.status = 'paid'
BEGIN
  SELECT RAISE(ABORT, 'paid reimbursement item is immutable');
END;

CREATE TRIGGER reimbursement_items_paid_no_delete
BEFORE DELETE ON reimbursement_items
WHEN OLD.status = 'paid'
BEGIN
  SELECT RAISE(ABORT, 'paid reimbursement item cannot be deleted');
END;

CREATE TRIGGER reimbursement_items_candidate_must_be_pending_insert
BEFORE INSERT ON reimbursement_items
WHEN COALESCE((
  SELECT status FROM reimbursement_candidates WHERE id = NEW.candidate_id
), '') <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'candidate must be pending');
END;

CREATE TRIGGER reimbursement_items_candidate_must_be_pending_update
BEFORE UPDATE OF candidate_id ON reimbursement_items
WHEN COALESCE((
  SELECT status FROM reimbursement_candidates WHERE id = NEW.candidate_id
), '') <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'candidate must be pending');
END;

CREATE TRIGGER reimbursement_items_batch_payer_match_insert
BEFORE INSERT ON reimbursement_items
WHEN COALESCE((
  SELECT payer_id FROM reimbursement_batches WHERE id = NEW.batch_id
), '') <> NEW.payer_id
BEGIN
  SELECT RAISE(ABORT, 'item payer does not match batch payer');
END;

CREATE TRIGGER reimbursement_items_batch_payer_match_update
BEFORE UPDATE OF batch_id, payer_id ON reimbursement_items
WHEN COALESCE((
  SELECT payer_id FROM reimbursement_batches WHERE id = NEW.batch_id
), '') <> NEW.payer_id
BEGIN
  SELECT RAISE(ABORT, 'item payer does not match batch payer');
END;

CREATE TRIGGER reimbursement_items_candidate_payer_match_insert
BEFORE INSERT ON reimbursement_items
WHEN COALESCE((
  SELECT assignment.payer_id
  FROM reimbursement_candidates AS candidate
  JOIN payer_assignments AS assignment ON assignment.id = candidate.payer_assignment_id
  WHERE candidate.id = NEW.candidate_id
), '') <> NEW.payer_id
BEGIN
  SELECT RAISE(ABORT, 'item payer does not match candidate payer');
END;

CREATE TRIGGER reimbursement_items_candidate_payer_match_update
BEFORE UPDATE OF candidate_id, payer_id ON reimbursement_items
WHEN COALESCE((
  SELECT assignment.payer_id
  FROM reimbursement_candidates AS candidate
  JOIN payer_assignments AS assignment ON assignment.id = candidate.payer_assignment_id
  WHERE candidate.id = NEW.candidate_id
), '') <> NEW.payer_id
BEGIN
  SELECT RAISE(ABORT, 'item payer does not match candidate payer');
END;

CREATE TRIGGER reimbursement_batches_payer_matches_existing_items
BEFORE UPDATE OF payer_id ON reimbursement_batches
WHEN EXISTS (
  SELECT 1
  FROM reimbursement_items
  WHERE batch_id = OLD.id
    AND payer_id <> NEW.payer_id
)
BEGIN
  SELECT RAISE(ABORT, 'batch payer does not match existing item payer');
END;
