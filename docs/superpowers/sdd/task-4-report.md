# Task 4 report — Worker dual-entry and employee boundary

## Scope completed

Implemented only the approved Task 4 Worker/authentication boundary work. No UI Task 5 work, Wrangler/configuration changes, migrations, Cloudflare mutations, or dependency changes were made.

- Exported `createApp(dependencies?)` with injectable identity resolution and clock. The production default remains `resolveAuthenticatedIdentity`.
- Added a first, URL-host-derived entry middleware. It stores the exact entry, signed identity, nullable business principal, and identity principal in Hono context.
- Unknown hosts return 404. The legacy host redirects only `GET`/`HEAD` with a 308 to the corporate host and returns 410 for all writes before identity resolution or provisioning.
- Corporate entry validates the signed corporate identity and idempotently calls `ensureCorporatePrincipal`; external entry resolves only a persisted `linked_external` identity. An unbound external identity can use only the opaque presentation API.
- Removed the legacy `resolvePrincipal()` path that queried `users.external_subject` from both API and UI routes. Removed the application bootstrap route/functions/type fields; Task 5 still owns replacing the currently stale bootstrap UI shell.
- Replaced mutation origin handling with context-entry-aware exact-Origin checks. Corporate and external origins cannot be used interchangeably; legacy writes are rejected.
- Added the identity API routes: caller-scoped masked identity list, transaction begin, opaque external candidate presentation, corporate confirmation, and linked-identity revoke.
- Added `IdentityStore.listMaskedIdentities()` so the API only returns the caller's own identity IDs, kind/status, provider hint, and masked email. It does not return issuer, subject, or full external email.
- Added transaction-initiation and candidate-presentation audit events without a raw binding code or full external email in `detail_json`.
- Added the employee-only dashboard early return: it queries only owner-scoped subscription/account-asset counts and returns fixed zeros without querying reimbursement candidates/batches, FX, or import tables. Employee remains allowed only on dashboard, subscriptions, and account assets; all other existing role allowlists continue to exclude it.
- Preserved non-production `DEV_AUTH=1` with an optional `x-dev-email`, so the same corporate-entry validation can run in local tests without affecting production JWT behavior.

## TDD evidence

The initial new Worker test suite failed because `createApp` did not exist. After the minimal factory export, it failed on the expected missing automatic-provisioning, legacy-routing, host, and identity-route behavior. Additional red checks were recorded for:

- missing link initiation/candidate audit events;
- an unbound external request reaching an arbitrary API route as 404 rather than the required 401; and
- missing optional development email propagation.

Each was implemented only after the corresponding failing test.

## Files changed

- `app/src/index.ts`
- `app/src/lib/auth.ts`
- `app/src/lib/identity-store.ts`
- `app/src/lib/types.ts`
- `app/test/index-access.test.ts`
- `app/test/identity-store.test.ts`
- `app/test/auth.test.ts`

## Verification

Focused checks:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/auth.test.ts test/index-access.test.ts test/identity-store.test.ts
```

Result: 3 test files passed, 45 tests passed.

Full regression:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run
```

Result: 13 test files passed, 91 tests passed.

Type check:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/typescript/bin/tsc --noEmit
```

Result: exit code 0.

## Review handoff

Awaiting the required independent Task 4 review. The worker is not deployed and Task 5 remains responsible for the corporate profile/external-only UI replacement.

## Fix 1 — atomic external candidate presentation audit

- Moved the candidate state update and `present_linked_external_identity_candidate` audit insert into one D1 `batch`. The audit statement is SQL-gated by the immediately preceding SQLite `changes() = 1` result and explicitly rechecks the same transaction, owner, and signed issuer/subject before it writes.
- TypeScript accepts the mutation only when exact `RETURNING` rows include both the transaction ID and the per-request audit UUID; it does not trust D1 metadata change counts.
- Added a test-only D1 fault injector that throws from the audit statement inside the adapter's real SQLite batch transaction. The new store and Worker tests prove the transaction remains `pending` with no candidate data after that failure, and the external API returns only the opaque `identity_presentation_rejected` response.
- The concurrent presentation regression now also proves that a successful path produces exactly one candidate-presentation audit even when metadata is deliberately unreliable.

Verification after Fix 1:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/identity-store.test.ts test/index-access.test.ts
# 2 files, 33 tests passed

/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run
# 13 files, 93 tests passed

/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/typescript/bin/tsc --noEmit
# exit 0
```

## Fix 2 — real candidate-presentation concurrency barrier

- Replaced the stale test-only prepared-statement/`.all()` interceptor with a batch-level barrier that recognizes only the actual candidate-presentation `UPDATE` in `presentExternalIdentity()`.
- The regression now holds the first candidate-presentation batch until the second caller has completed its own secret and identity preflight reads and reached the same real D1 mutation boundary. It explicitly records two batch arrivals; the old interceptor proved ineffective in a red run (`0` arrivals when `2` were required).
- The race remains wrapped in deliberately unreliable D1 change metadata and still proves one fulfilled presentation, one `link_secret_consumed` rejection, a `candidate_presented` transaction with no `consumed_at`, and exactly one candidate-presentation audit event.
- This fix changes only `app/test/identity-store.test.ts` and this report; it makes no Worker, UI, Cloudflare, migration, or production-logic change.

Verification after Fix 2:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/identity-store.test.ts
# 1 file, 19 tests passed

/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run
# 13 files, 93 tests passed

/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/typescript/bin/tsc --noEmit
# exit 0
```
