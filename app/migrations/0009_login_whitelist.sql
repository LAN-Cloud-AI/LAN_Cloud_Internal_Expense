-- 登录白名单：通过 Access 登录且命中名单（精确邮箱或整个域名）的用户自动开通 employee。
-- Access 边缘 policy 仍是第一道门；白名单是第二道，决定谁能自动开户。
CREATE TABLE login_whitelist (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'domain')),
  value TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, value)
);

-- 预置企业域名，保持既有"企业邮箱首开自动开通"行为。
INSERT INTO login_whitelist (id, kind, value) VALUES ('wl-domain-lancloudtech', 'domain', 'lancloudtech.com');
