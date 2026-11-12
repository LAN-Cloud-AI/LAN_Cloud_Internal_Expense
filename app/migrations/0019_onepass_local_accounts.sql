-- Explicitly link a OnePass organization membership to an existing Expense
-- account. Creating a OnePass grant alone never creates or changes this link.
CREATE TABLE onepass_local_accounts (
  org_id TEXT NOT NULL CHECK(length(org_id) BETWEEN 1 AND 100),
  membership_id TEXT NOT NULL CHECK(length(membership_id) BETWEEN 1 AND 100),
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  PRIMARY KEY (org_id, membership_id)
);
