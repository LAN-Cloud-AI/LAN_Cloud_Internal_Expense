-- SQLite 的 UNIQUE 对 NULL 不视为相等。自动生成的候选没有 source_charge_id，
-- 因此需要单独的部分唯一索引，避免同一账期被重复报销。
CREATE UNIQUE INDEX reimbursement_candidates_one_automatic_coverage
  ON reimbursement_candidates (
    subscription_term_version_id,
    payer_assignment_id,
    coverage_start,
    coverage_end
  )
  WHERE source_charge_id IS NULL;
