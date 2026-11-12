CREATE TABLE IF NOT EXISTS onepass_org (
 org_id TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS onepass_grants (
 membership_id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES onepass_org(org_id),
 application_user_id TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), version INTEGER NOT NULL, event_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS onepass_entitlement (
 org_id TEXT PRIMARY KEY REFERENCES onepass_org(org_id), version INTEGER NOT NULL,
 event_id TEXT NOT NULL, status TEXT NOT NULL, period_end TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS onepass_receipts (
 event_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL
);
