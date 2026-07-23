-- 外部报销平台账号登记册从未使用（0 行）：报销全流程只依赖 payers，
-- 批次上的外部账号引用列同步移除。
ALTER TABLE reimbursement_batches DROP COLUMN reimbursement_account_id;
DROP TABLE reimbursement_accounts;
