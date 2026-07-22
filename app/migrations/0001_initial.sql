-- 兰芯云朵行政——订阅资产管理系统 · D1 初始账本 schema
--
-- 设计原则：飞书 Base 是可变且只读的导入源；D1 是唯一业务真相。
-- 所有金额均为最小货币单位 INTEGER（CNY=分、USD=美分），严禁 REAL。
-- 不存密码、OTP、Token、完整银行卡号或 MFA 恢复码。

PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  external_subject TEXT UNIQUE, -- Cloudflare Access / Feishu OAuth 的稳定 sub，不以邮箱做主键
  email TEXT UNIQUE,
  display_name TEXT NOT NULL,
  employment_status TEXT NOT NULL DEFAULT 'active'
    CHECK (employment_status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE CHECK (code IN (
    'system_admin', 'asset_admin', 'finance_reviewer',
    'payer', 'employee', 'auditor'
  )),
  display_name TEXT NOT NULL
);

CREATE TABLE user_roles (
  user_id TEXT NOT NULL REFERENCES users(id),
  role_id TEXT NOT NULL REFERENCES roles(id),
  assigned_by TEXT REFERENCES users(id),
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE vendors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  website TEXT,
  support_contact TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 一个付款者可以有多种脱敏付款方式；报销批次永远只属于一个付款者。
CREATE TABLE payers (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  owner_user_id TEXT REFERENCES users(id),
  payment_method_masked TEXT,
  active_from TEXT NOT NULL,
  active_until TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (active_until IS NULL OR active_until >= active_from)
);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  vendor_id TEXT REFERENCES vendors(id),
  owner_user_id TEXT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
  source_record_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 价格、币种和周期均版本化；历史候选只引用某一版本，避免主表变更改变账实。
CREATE TABLE subscription_term_versions (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  effective_start TEXT NOT NULL,
  effective_end TEXT,
  billing_cycle TEXT NOT NULL CHECK (billing_cycle IN ('monthly', 'quarterly', 'yearly', 'one_time')),
  settlement_mode TEXT NOT NULL CHECK (settlement_mode IN ('actual_bill', 'accrual')),
  billing_anchor_date TEXT NOT NULL,
  original_currency TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (effective_end IS NULL OR effective_end >= effective_start)
);

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

-- 付款者有效区间独立版本化，防止中途换卡/换人污染旧账。
CREATE TABLE payer_assignments (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  payer_id TEXT NOT NULL REFERENCES payers(id),
  effective_start TEXT NOT NULL,
  effective_end TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (effective_end IS NULL OR effective_end >= effective_start)
);

CREATE TRIGGER payer_assignments_no_overlap_insert
BEFORE INSERT ON payer_assignments
WHEN EXISTS (
  SELECT 1 FROM payer_assignments AS existing
  WHERE existing.subscription_id = NEW.subscription_id
    AND COALESCE(existing.effective_end, '9999-12-31') >= NEW.effective_start
    AND COALESCE(NEW.effective_end, '9999-12-31') >= existing.effective_start
)
BEGIN
  SELECT RAISE(ABORT, 'overlapping payer assignments');
END;

CREATE TRIGGER payer_assignments_no_overlap_update
BEFORE UPDATE OF subscription_id, effective_start, effective_end ON payer_assignments
WHEN EXISTS (
  SELECT 1 FROM payer_assignments AS existing
  WHERE existing.subscription_id = NEW.subscription_id
    AND existing.id != NEW.id
    AND COALESCE(existing.effective_end, '9999-12-31') >= NEW.effective_start
    AND COALESCE(NEW.effective_end, '9999-12-31') >= existing.effective_start
)
BEGIN
  SELECT RAISE(ABORT, 'overlapping payer assignments');
END;

-- 汇率固定为「1 原币最小单位 = numerator/denominator CNY 分」。
CREATE TABLE fx_quotes (
  id TEXT PRIMARY KEY,
  base_currency TEXT NOT NULL,
  quote_currency TEXT NOT NULL DEFAULT 'CNY' CHECK (quote_currency = 'CNY'),
  rate_numerator INTEGER NOT NULL CHECK (rate_numerator > 0),
  rate_denominator INTEGER NOT NULL CHECK (rate_denominator > 0),
  effective_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  provider TEXT NOT NULL,
  provider_reference TEXT,
  raw_response_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('verified', 'stale', 'manual', 'failed')),
  locked_at TEXT,
  UNIQUE (base_currency, quote_currency, effective_at, provider)
);

-- 真实报销系统账户只存别名、脱敏账号和凭据库引用。
CREATE TABLE reimbursement_accounts (
  id TEXT PRIMARY KEY,
  payer_id TEXT NOT NULL REFERENCES payers(id),
  platform TEXT NOT NULL,
  account_alias TEXT NOT NULL,
  account_masked TEXT,
  vault_ref TEXT,
  owner_user_id TEXT REFERENCES users(id),
  mfa_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (mfa_status IN ('enabled', 'disabled', 'unknown')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (payer_id, platform, account_alias)
);

CREATE TABLE account_assets (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT REFERENCES users(id),
  vendor_id TEXT REFERENCES vendors(id),
  account_identifier_masked TEXT NOT NULL,
  display_name TEXT NOT NULL,
  vault_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'retired')),
  expires_on TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 可扩展账户属性仅用于非核心字段；财务关键字段不允许动态化。
CREATE TABLE account_field_definitions (
  id TEXT PRIMARY KEY,
  field_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL CHECK (field_type IN ('text', 'integer', 'date', 'boolean', 'select')),
  options_json TEXT,
  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE account_field_values (
  account_asset_id TEXT NOT NULL REFERENCES account_assets(id),
  field_definition_id TEXT NOT NULL REFERENCES account_field_definitions(id),
  value_text TEXT,
  value_integer INTEGER,
  value_date TEXT,
  value_boolean INTEGER CHECK (value_boolean IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_asset_id, field_definition_id)
);

-- 来源血缘。这里不保存任何来源密钥或用户 token。
CREATE TABLE source_connections (
  id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL CHECK (source_system IN ('feishu_base')),
  display_name TEXT NOT NULL,
  import_enabled INTEGER NOT NULL DEFAULT 0 CHECK (import_enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE source_schema_versions (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES source_connections(id),
  schema_hash TEXT NOT NULL,
  mapping_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('approved', 'schema_drift', 'retired')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (connection_id, schema_hash)
);

CREATE TABLE source_import_runs (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES source_connections(id),
  schema_version_id TEXT REFERENCES source_schema_versions(id),
  mode TEXT NOT NULL CHECK (mode IN ('preview', 'apply')),
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'schema_drift')),
  cursor TEXT,
  summary_json TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE TABLE source_records (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES source_connections(id),
  table_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  source_revision TEXT,
  canonical_entity_type TEXT,
  canonical_entity_id TEXT,
  raw_hash TEXT NOT NULL,
  tombstoned_at TEXT,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (connection_id, table_id, record_id)
);

CREATE TABLE source_mapping_errors (
  id TEXT PRIMARY KEY,
  import_run_id TEXT NOT NULL REFERENCES source_import_runs(id),
  source_record_id TEXT REFERENCES source_records(id),
  code TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 请求幂等：同一用户同一动作同一 key 必须返回同一份已保存响应。
CREATE TABLE idempotency_requests (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  UNIQUE (actor_id, action, idempotency_key)
);

CREATE TABLE reimbursement_candidates (
  id TEXT PRIMARY KEY,
  subscription_term_version_id TEXT NOT NULL REFERENCES subscription_term_versions(id),
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
CREATE INDEX reimbursement_candidates_pending_idx
  ON reimbursement_candidates (status, payer_assignment_id, coverage_start);

-- 一次「一键报销」提交可以产生多个 batch，但每个 batch 只对应一个付款者。
CREATE TABLE reimbursement_submissions (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users(id),
  cutoff_date TEXT NOT NULL,
  idempotency_request_id TEXT NOT NULL UNIQUE REFERENCES idempotency_requests(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'completed', 'failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE reimbursement_batches (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES reimbursement_submissions(id),
  payer_id TEXT NOT NULL REFERENCES payers(id),
  coverage_start TEXT NOT NULL,
  coverage_end TEXT NOT NULL,
  total_cny_fen INTEGER NOT NULL CHECK (total_cny_fen >= 0),
  reimbursement_account_id TEXT REFERENCES reimbursement_accounts(id),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'reviewing', 'approved', 'paid', 'returned', 'void')),
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (coverage_end >= coverage_start),
  UNIQUE (submission_id, payer_id)
);

CREATE TABLE reimbursement_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES reimbursement_batches(id),
  candidate_id TEXT NOT NULL REFERENCES reimbursement_candidates(id),
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
CREATE UNIQUE INDEX reimbursement_items_one_active_candidate
  ON reimbursement_items (candidate_id) WHERE voided_at IS NULL;

-- 已付款账本不可篡改或硬删；需要修正时必须创建冲销/调整明细。
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

CREATE TRIGGER reimbursement_batches_paid_immutable
BEFORE UPDATE ON reimbursement_batches
WHEN OLD.status = 'paid'
BEGIN
  SELECT RAISE(ABORT, 'paid reimbursement batch is immutable');
END;

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('candidate', 'batch', 'item')),
  entity_id TEXT NOT NULL,
  r2_object_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  uploaded_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('fx_rates', 'feishu_import')),
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'schema_drift')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  error_code TEXT,
  detail_json TEXT
);
