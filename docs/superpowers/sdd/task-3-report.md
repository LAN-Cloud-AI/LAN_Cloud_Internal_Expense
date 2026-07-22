# Task 3 implementation report — identity policy and D1 identity store

## Scope completed

Implemented the Task 3 identity policy, D1 identity store, and advisory Access-provider helper only. No Worker routes, deployment configuration, migrations, dependencies, Cloudflare APIs, or Task 4 work were changed.

## Changed files

- `app/src/lib/identity-policy.ts` (new): identity kinds, 128-bit unpadded RFC 4648 base32 binding-secret creation, SHA-256 secret hashing, email masking, and entry/identity eligibility rules.
- `app/src/lib/identity-store.ts` (new): the D1 identity write surface for corporate provisioning, legacy upgrade by matching subject only, link transaction lifecycle, `RETURNING`-verified external identity confirmation/revocation, role resolution, fixed-code `IdentityProblem` errors, and audits.
- `app/src/lib/auth.ts`: added same-host `resolveAccessProviderHint()`; it forwards only the current Access assertion and maps valid `idp.type` values to advisory `cloudflare`/`github` hints. Failures and unknown values resolve to `null`.
- `app/test/identity-policy.test.ts` (new): binding secret/hash, masking, and entry eligibility tests.
- `app/test/identity-store.test.ts` (new): idempotent corporate provisioning, exact corporate-email validation, no email merge, legacy same-subject upgrade, one-time administrator migration, candidate-only external presentation, confirm/consume, conflict, and revoke behavior.
- `app/test/helpers/sqlite-d1.ts` and `app/test/sqlite-d1.test.ts`: local D1 adapter coverage, including `RETURNING` result rows and diagnostic-only metadata behavior.
- `app/test/auth.test.ts`: added mocked Access `get-identity` coverage for the advisory provider helper and unknown IdP fallback.

## TDD evidence

After adding the new policy/store test files, before implementation:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/identity-policy.test.ts test/identity-store.test.ts
```

Failed intentionally: both suites could not import the non-existent `identity-policy` and `identity-store` modules.

After implementation:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/identity-policy.test.ts test/identity-store.test.ts test/schema-integrity.test.ts
```

Passed: 3 test files, 21 tests.

Focused behavioral check including the provider helper:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/identity-policy.test.ts test/identity-store.test.ts test/auth.test.ts test/schema-integrity.test.ts
```

Passed: 4 test files, 36 tests.

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/typescript/bin/tsc --noEmit
```

Passed: exit code 0.

Final regression check:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run
```

Passed: 11 test files, 68 tests.

## Self-review

- Authority and lookup are always `(issuer, subject)`; verified email is stored only on the identity and is neither queried nor copied as a join key.
- Corporate provisioning rejects non-exact corporate domains and can upgrade only the isolated legacy identity whose subject exactly matches the verified corporate subject.
- New and existing corporate principals receive `employee` idempotently. The migration-admin role/audit pair is guarded by an atomic audit insert, so only the first exact normalized corporate-email provision can acquire `system_admin` through this path.
- Raw binding secrets are returned only from `beginLinkTransaction()` and persisted only as a SHA-256 hash. External presentation updates transaction candidate columns only; it creates no identity row.
- Link confirmation uses one D1 batch to conditionally create or reactivate the linked identity first, then consume the transaction, then audit the successful confirmation. The unique `(issuer, subject)` schema constraint remains the final cross-user conflict guard.
- Provider detection is not consulted by `resolve()` or any authorization decision. Task 4 must call the helper only after JWT verification, as specified by the approved route plan.
- D1 write failures are mapped to fixed `IdentityProblem` public codes rather than exposing SQL messages.

## Concerns

None within Task 3 scope. Route-level sequencing of JWT verification before provider-hint lookup and the use of `IdentityStore` from request handling are deliberately owned by Task 4.

## Fix 1

Addressed the Important Task 3 identity-service consistency review findings only. No Worker routes, UI, deployment/configuration, migrations, dependencies, Cloudflare operations, or Task 4 work were changed.

### Changes

- `app/test/helpers/sqlite-d1.ts` now builds fresh D1 metadata from each `better-sqlite3` `RunResult`; `run()` and every item returned by `batch()` expose local per-statement values for adapter realism. Fix 2 deliberately removes any production authorization dependency on those metadata values.
- `presentExternalIdentity()` now succeeds only when its pending-row conditional update reports exactly one changed row. A stale concurrent presentation cannot succeed by rereading another caller's matching candidate.
- `confirmLinkTransaction()` now creates or reactivates the linked identity first. In the same atomic batch, transaction consumption is conditioned on that immediately preceding mutation changing one row, and the audit is conditioned on consumption changing one row. Returned D1 change counts are inspected. A losing competing transaction returns `identity_already_bound` and remains `candidate_presented` with `consumed_at = NULL`.
- A revoked `(issuer, subject)` can be reactivated only after a new presentation and confirmation by its original corporate user. The existing identity row and global unique key are retained; another user cannot claim or reactivate it, and email is not consulted.
- Legacy upgrade now makes the audit and employee-role write conditional on winning the legacy-row CAS. A zero-row loser rereads only the caller's exact signed `(issuer, subject)`; it returns that matching winner or the fixed `identity_kind_conflict` error, never a different issuer's principal.
- Principal resolution now reads the active identity and roles in one SQL statement. Revocation is a conditional mutation followed by a change-conditioned audit in one batch; exactly one concurrent revocation can succeed and write one audit event.
- `resolveAccessProviderHint()` now accepts only status `200`; all other statuses, malformed JSON, unknown providers, missing assertions, and fetch failures resolve to `null`.
- Added focused concurrency/regression coverage for real adapter change counts, stale repeated presentation, legacy-upgrade races, competing confirmations, same-owner revoked-identity reactivation, one-read resolution, concurrent revocation/audit, and provider-helper failure modes.

### TDD and verification results

Before the fixes, the focused regression run failed as expected with 7 failures and 25 passes across 3 files: adapter changes, non-200 provider hint, legacy upgrade race, competing confirmation consumption, revoked reactivation, two-read resolution, and duplicate revocation/audit.

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/sqlite-d1.test.ts test/identity-store.test.ts test/auth.test.ts
```

Final focused identity/auth/schema verification:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/sqlite-d1.test.ts test/identity-policy.test.ts test/identity-store.test.ts test/auth.test.ts test/schema-integrity.test.ts
```

Passed: 5 test files, 44 tests.

Full regression suite:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run
```

Passed: 12 test files, 76 tests.

Typecheck:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/typescript/bin/tsc --noEmit
```

Passed: exit code 0.

## Fix 2

Removed the final security-sensitive dependence on Cloudflare D1 response metadata. Cloudflare documents `D1Result.meta.changes` as operational metadata, so it is no longer used to decide whether an identity state transition succeeded.

### Mechanism

- `presentExternalIdentity()` now uses its conditional `UPDATE ... RETURNING id` result as its exact one-call CAS marker. A stale replay has an empty result set even if metadata falsely claims one changed row.
- Legacy upgrade, linked-identity confirmation, and revocation keep SQLite `changes()` only as the immediately-following SQL gate inside one sequential transactional D1 `batch`. TypeScript verifies only the exact `RETURNING id` rows afterwards.
- Confirmation generates an audit UUID before the batch and requires three exact result markers: the identity mutation id, the consumed transaction id, and that audit UUID. It returns success only when all three are returned.
- Revocation similarly requires both the revoked identity id and its unique audit UUID. A replay/competing revocation cannot report success or create another audit event.
- The local SQLite D1 adapter now returns reader rows from `RETURNING` statements in both direct calls and batch items. Its local `RunResult.changes` test remains diagnostic only.
- Added an `withUnreliableChangeMetadata()` test wrapper that always reports `meta.changes = 1`. It covers legacy upgrade races, repeated external presentation, same-owner confirmation/recovery races, and repeated revocation; none can become a false success solely from forged metadata.

### D1 assumption

This implementation relies on Cloudflare D1's documented SQLite SQL semantics, support for query result sets from prepared/batch statements, and sequential transactional `batch()` execution. `RETURNING` is the verifiable caller-visible mutation result; `changes()` is used only within the same batch to guard its immediately following statement.

### TDD and verification results

Before the implementation, after adding the forged-metadata coverage:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/identity-store.test.ts
```

Failed as expected: 5 failures, 12 passes. The failures showed false successes for legacy upgrade, presentation, same-owner reactivation, and repeated revocation when the adapter reported `meta.changes = 1` for every statement.

Focused identity/auth/sqlite/schema verification:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/sqlite-d1.test.ts test/identity-policy.test.ts test/identity-store.test.ts test/auth.test.ts test/schema-integrity.test.ts
```

Passed: 5 test files, 47 tests.

Full regression suite:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run
```

Passed: 12 test files, 79 tests.

Typecheck:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/typescript/bin/tsc --noEmit
```

Passed: exit code 0.
