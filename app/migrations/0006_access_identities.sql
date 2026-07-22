-- 身份解析以 issuer + subject 为唯一授权依据；邮箱只用于展示和联系，不能合并账户。
CREATE TABLE user_access_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  verified_email TEXT,
  identity_kind TEXT NOT NULL CHECK (identity_kind IN ('corporate_primary', 'linked_external', 'legacy_primary')),
  provider_hint TEXT CHECK (provider_hint IN ('cloudflare', 'github') OR provider_hint IS NULL),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  revoked_at TEXT,
  UNIQUE (issuer, subject)
);

CREATE UNIQUE INDEX user_access_identities_one_active_corporate_primary
  ON user_access_identities(user_id)
  WHERE identity_kind = 'corporate_primary' AND revoked_at IS NULL;

CREATE TABLE identity_link_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  initiator_identity_id TEXT NOT NULL REFERENCES user_access_identities(id),
  secret_hash TEXT NOT NULL UNIQUE,
  candidate_issuer TEXT,
  candidate_subject TEXT,
  candidate_verified_email TEXT,
  candidate_provider_hint TEXT CHECK (candidate_provider_hint IN ('cloudflare', 'github') OR candidate_provider_hint IS NULL),
  status TEXT NOT NULL CHECK (status IN ('pending', 'candidate_presented', 'confirmed', 'cancelled', 'expired')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 历史 external_subject 没有可验证的 issuer 语义，迁移为隔离的 legacy 身份。
-- 不读取 users.email，运行时只在真实企业 JWT 校验通过后按 subject 升级。
INSERT INTO user_access_identities (id, user_id, issuer, subject, identity_kind)
SELECT
  'legacy-' || hex(id) || '-' || hex(external_subject),
  id,
  'legacy://users.external_subject',
  external_subject,
  'legacy_primary'
FROM users
WHERE external_subject IS NOT NULL;
