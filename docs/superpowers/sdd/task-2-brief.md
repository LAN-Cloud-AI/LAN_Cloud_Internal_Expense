## Task 2: Add durable identity and binding-transaction schema

**Files:**
- Create: `app/migrations/0006_access_identities.sql`
- Modify: `app/test/schema-integrity.test.ts`
- Create: `app/test/helpers/sqlite-d1.ts`

**Interfaces:**
- Consumes: existing `users`, `roles`, `user_roles`, and `audit_events` tables.
- Produces: `user_access_identities` keyed by `(issuer, subject)` and `identity_link_transactions` that retains only a binding secret hash.

- [ ] **Step 1: Extend `schema-integrity.test.ts` with failing schema assertions.**

Add tests that execute all migrations and prove:

```ts
expect(() => insertIdentity('identity-b', 'user-2', 'https://issuer', 'same-subject')).toThrow();
expect(() => insertSecondCorporateIdentity('user-1')).toThrow();
expect(() => database.prepare("INSERT INTO identity_link_transactions (...) VALUES (..., 'plaintext-code', ...)").run()).not.toThrow();
expect(database.prepare('SELECT secret_hash FROM identity_link_transactions WHERE id = ?').get('link-1')).toMatchObject({ secret_hash: 'hash-only' });
```

Use a second `users` record so the duplicate `(issuer, subject)` check is cross-user. The transaction test must assert the schema has no `secret` or `raw_code` column through `PRAGMA table_info(identity_link_transactions)`.

- [ ] **Step 2: Run the schema test and verify it fails because migration `0006` does not exist.**

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/schema-integrity.test.ts
```

Expected: FAIL with missing-table errors.

- [ ] **Step 3: Implement `0006_access_identities.sql`.**

Create exactly these tables and constraints:

```sql
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
```

Backfill every non-null `users.external_subject` as `legacy_primary` with issuer `legacy://users.external_subject`; do not infer an issuer or trust `users.email`. The runtime corporate provisioning flow will upgrade a matching legacy subject only after it sees a real, signed corporate JWT.

Create `app/test/helpers/sqlite-d1.ts` with a `sqliteD1(database)` adapter implementing the methods used by the new identity store: `prepare().bind().first()`, `all()`, `run()`, and `batch()`. Each adapter method must execute parameterized `better-sqlite3` statements and return D1-shaped `{ results }` / `{ success: true }` values.

- [ ] **Step 4: Re-run migration and all existing schema tests.**

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/schema-integrity.test.ts
```

Expected: PASS, including old ledger constraints.
