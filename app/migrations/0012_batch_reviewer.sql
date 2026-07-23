-- 报销批次指定审批人：提交时选择具备财务审核权限的账号，后续审批/付款由其完成。
ALTER TABLE reimbursement_batches ADD COLUMN reviewer_user_id TEXT REFERENCES users(id);
