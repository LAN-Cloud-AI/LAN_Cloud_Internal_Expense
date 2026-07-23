-- 已作废候选不应永久阻塞同覆盖期的再生成：唯一约束只约束有效候选。
DROP INDEX IF EXISTS reimbursement_candidates_one_automatic_coverage;
CREATE UNIQUE INDEX reimbursement_candidates_one_automatic_coverage
  ON reimbursement_candidates (
    subscription_term_version_id,
    payer_assignment_id,
    coverage_start,
    coverage_end
  )
  WHERE source_charge_id IS NULL AND status != 'void';
