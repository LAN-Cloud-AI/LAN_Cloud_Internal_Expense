-- 报销明细会复制候选与付款者快照，因此在写入边界校验三者的一致性。
-- 这些触发器不依赖 SQLite 扩展，兼容 Cloudflare D1。

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

-- 批次草稿即使尚未付款，也不能被改成与已写入明细不一致的付款者。
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
