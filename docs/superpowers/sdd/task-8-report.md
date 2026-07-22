# Task 8 report — recover an interrupted external identity binding

## Scope

An enterprise user could generate a binding code, complete external candidate presentation, then lose the browser-only transaction id by reloading or navigating away from the corporate Profile page. This task restores only the safe, already-persisted transaction state needed for the corporate owner to resume confirmation.

## Test-first evidence

Before implementation, Node 22 ran the new focused tests and produced the expected failures:

- `IdentityStore.listResumableLinkTransactions is not a function` for storage ownership/privacy coverage.
- `404` for the missing corporate recovery endpoint.
- Missing UI API contract and Profile recovery controls.

The red command was:

```sh
/Users/i/.nvm/versions/node/v22.22.2/bin/node ./node_modules/vitest/vitest.mjs run test/identity-store.test.ts test/index-access.test.ts test/ui.test.ts
```

It failed 6 new assertions while the pre-existing tests remained green.

## Implemented behavior

- Added corporate-only `GET /api/me/identities/link-transactions/recovery`.
- The identity store returns only the current corporate user’s unexpired, unconsumed `pending` and `candidate_presented` transactions.
- Each recovery record contains only transaction id, status, expiry, provider hint, and a masked candidate email. It never returns a binding code or hash, issuer, subject, or full external email.
- The existing corporate-entry and `corporate_primary` guard applies to this read endpoint. Both unbound and already-linked external-entry principals are denied.
- The Profile page loads recovery records on page load. It renders a clear wait-only state for `pending`; it renders an explicit `继续确认绑定` control only for `candidate_presented` and calls the existing confirmation API.
- The current in-memory binding-code panel also rechecks recovery status before enabling its confirmation button, so a pending transaction cannot be presented as confirmable.

## Coverage

- Store coverage: caller ownership, expiry exclusion, status filtering, secrecy of raw code/subject/full email, and linked-external denial.
- API coverage: corporate recovery result can drive the existing confirmation endpoint; both unbound and linked external principals receive `401`.
- UI coverage: recovery API contract, Profile recovery section, candidate-specific confirmation behavior, and no bootstrap regression.

## Task 8.1 — replacement-code rotation and masking hardening

The recovery flow now treats a newly generated binding code as a security rotation:

- Before inserting a replacement transaction, the same D1 batch cancels only that corporate user’s unconsumed `pending` or `candidate_presented` transactions and sets `consumed_at` to the server-provided start time.
- Therefore an older pending code cannot be submitted at the external entry, and an older candidate-presented transaction cannot be confirmed at the corporate entry. The replacement remains usable.
- The rotation writes `cancel_prior_live_identity_link_transactions` only when a prior live transaction was cancelled. Its audit detail contains the replacement transaction id only; it contains no binding code, external subject, or email.
- The email masking helper now returns `*@domain` for a one-character local part, rather than exposing the complete local part.

The Node 22 red tests first demonstrated that a prior code could still be presented and that `a@example.com` was returned unmasked. The rotation coverage includes cancellation of both pending and candidate-presented records, cross-user isolation, old presentation/confirmation rejection, replacement confirmation, and audit privacy.

## Validation

```sh
/Users/i/.nvm/versions/node/v22.22.2/bin/node ./node_modules/vitest/vitest.mjs run test/identity-store.test.ts test/index-access.test.ts test/ui.test.ts
# 3 files / 47 tests passed

/Users/i/.nvm/versions/node/v22.22.2/bin/node ./node_modules/vitest/vitest.mjs run
# 13 files / 106 tests passed

/Users/i/.nvm/versions/node/v22.22.2/bin/node ./node_modules/typescript/bin/tsc --noEmit
# passed
```

## Operational boundary

This task made no Cloudflare API, D1 remote, browser, credential, DNS, Access, or deployment changes. A deployment is required before the live corporate Profile can show the recovery control.
