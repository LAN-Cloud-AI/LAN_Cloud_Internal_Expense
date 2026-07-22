# Task 2 implementation report — durable access identity schema

## Scope completed

- Added the additive `0006_access_identities.sql` migration. It introduces the durable `(issuer, subject)` identity authority and hash-only link-transaction storage without changing the existing ledger tables or constraints.
- Backfilled every historical non-null `users.external_subject` as a `legacy_primary` identity under the isolated issuer `legacy://users.external_subject`. The migration does not inspect or trust `users.email`.
- Added schema-integrity coverage for cross-user issuer/subject uniqueness, one active corporate primary identity, hash-only binding storage, absence of raw-code columns, and the historical legacy backfill.
- Added the parameterized `better-sqlite3` D1 adapter required for the later identity-store tests: `prepare().bind().first()`, `all()`, `run()`, and transactional `batch()`.

## Changed files

- `app/migrations/0006_access_identities.sql` (new): `user_access_identities`, the partial unique corporate-primary index, `identity_link_transactions`, and the legacy-subject backfill.
- `app/test/schema-integrity.test.ts`: seeds historical rows immediately before `0006` is applied, preserving the migration test setup; adds two identity/binding schema tests and a second user for the cross-user uniqueness assertion.
- `app/test/helpers/sqlite-d1.ts` (new): D1-shaped test adapter backed by parameterized `better-sqlite3` statements.
- `docs/superpowers/sdd/task-2-report.md` (new): this report.

## TDD and verification evidence

After the schema assertions were added but before `0006` existed:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/schema-integrity.test.ts
```

Failed intentionally: 2 new tests failed with `no such table: user_access_identities`; the pre-existing 6 ledger tests passed.

After the migration and adapter were added:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/schema-integrity.test.ts
```

Passed: 1 test file, 8 tests.

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/typescript/bin/tsc --noEmit
```

Passed: exit code 0.

Final broader regression check:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run
```

Passed: 9 test files, 54 tests.

## Self-review

- `(issuer, subject)` has a table-level `UNIQUE` constraint and the test inserts the duplicate identity for a different user, proving that external email cannot cause an implicit merge.
- The partial unique index only restricts non-revoked `corporate_primary` identities; linked and legacy identities are not incorrectly constrained by that index.
- Link transactions include only `secret_hash TEXT NOT NULL UNIQUE`; schema assertions verify neither `secret` nor `raw_code` exists.
- The migration is additive: it retains `users.external_subject` and does not alter ledger tables, roles, or prior migration constraints. The complete schema suite confirms the pre-existing ledger constraints still hold.
- The adapter binds every supplied value through `better-sqlite3`, returns D1-shaped successful results, and wraps its `batch()` writes in a SQLite transaction.

## Concerns

None within Task 2 scope. The newly added adapter intentionally implements only the D1 methods required by the planned identity store; it is a test helper, not a general Worker D1 emulator.

## Fix 1

### Changes

- Updated the legacy-identity backfill ID to `legacy-` plus separately `hex()`-encoded `users.id` and `external_subject` values, joined by a non-hex delimiter. This is deterministic and unambiguously represents every text-value pair.
- Added a migration regression assertion for the formerly ambiguous pairs `('a-b', 'c')` and `('a', 'b-c')`; both rows backfill and receive different IDs.
- Added a schema assertion that two different linked identities for different users can share one `verified_email`, confirming email is neither a merge key nor a unique key.

### Verification

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/schema-integrity.test.ts
```

Passed: 1 test file, 9 tests.

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run
```

Passed: 9 test files, 55 tests.

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/typescript/bin/tsc --noEmit
```

Passed: exit code 0.

### Self-review

- The migration remains additive and does not alter ledger tables or constraints.
- `hex()` encodes each component independently, so delimiters inside either source value cannot create a collision.
- No index or constraint was added to `verified_email`; only `(issuer, subject)` remains the identity uniqueness authority.
