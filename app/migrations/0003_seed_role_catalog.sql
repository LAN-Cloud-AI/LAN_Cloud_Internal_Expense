-- 角色代码是应用授权的固定白名单；预置目录让首位管理员可安全完成引导。
INSERT OR IGNORE INTO roles (id, code, display_name) VALUES
  ('role-system-admin', 'system_admin', '系统管理员'),
  ('role-asset-admin', 'asset_admin', '资产管理员'),
  ('role-finance-reviewer', 'finance_reviewer', '财务审核员'),
  ('role-payer', 'payer', '付款者'),
  ('role-employee', 'employee', '普通员工'),
  ('role-auditor', 'auditor', '审计只读');
