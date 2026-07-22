# Task 1 implementation report — host-aware Access configuration

## Scope completed

- Added a pure host-to-Access-entry layer for the fixed corporate, external, and legacy hostnames.
- Replaced the single Access audience/origin type fields with the dual-entry configuration fields required by the task.
- Added the issuer to every authenticated identity produced after JWT claim validation, including the explicit development identity issuer.
- Connected existing Worker authentication and production mutation-origin checks to the host-derived entry so production JWT validation uses the entry-specific audience and legacy mutations cannot pass an origin check.

## Changed files

- `app/src/lib/access-entry.ts` (new): fixed host/AUD/origin selection; strict corporate-email normalization; exact origin comparison.
- `app/test/access-entry.test.ts` (new): host, port/case normalization, untrusted host, corporate-domain, and exact-origin coverage.
- `app/src/lib/types.ts`: replaced `ACCESS_AUD` and `APP_ORIGIN` with `ACCESS_AUD_CORPORATE`, `ACCESS_AUD_EXTERNAL`, `APP_ORIGINS`, and `MIGRATION_SYSTEM_ADMIN_EMAIL`; retained `DEV_AUTH` and existing bootstrap fields.
- `app/src/lib/auth.ts`: added `AuthenticatedIdentity.issuer`; returns the verified claim issuer; requires an `AccessEntry` for direct resolution; derives the request entry when resolving an existing principal.
- `app/test/auth.test.ts`: asserts the returned issuer and rejects a missing issuer.
- `app/src/index.ts`: minimal Task 1 call-site integration required to keep the new Env interface type-safe and ensure existing authentication/origin handling uses the host-specific entry.

## TDD and verification evidence

Baseline, run from `app` before edits:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run
```

Passed: 8 test files, 42 tests.

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/typescript/bin/tsc --noEmit
```

Passed: exit code 0.

After adding the tests and before implementation:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/access-entry.test.ts test/auth.test.ts
```

Failed as expected: `access-entry.ts` did not exist and the valid claim result lacked `issuer`.

Final focused verification:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/access-entry.test.ts test/auth.test.ts
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/typescript/bin/tsc --noEmit
```

Passed: 2 test files, 13 tests; typecheck exit code 0.

Final broader regression check:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run
```

Passed: 9 test files, 47 tests.

## Self-review

- Host selection lowercases and removes only a numeric port, then performs exact equality; no wildcard or suffix matching is used.
- Corporate email acceptance requires exactly one `@`, a nonempty local part, and exact `lancloudtech.com` domain equality.
- Origin comparison is exact and requires both a supplied origin and a nonempty entry origin. The legacy entry uses an empty origin, so its mutation origin is always rejected.
- JWT issuer is included only after the issuer equality check succeeds. Production resolution requires a selected entry and passes that entry's audience to the JWT verifier. Development mode remains opt-in and returns `dev://local`.
- No secret, token, JWT, binding code, Cloudflare API call, dependency change, deployment, migration, or configuration-file change was made.

## Concern / required follow-up before deployment

The existing `wrangler` files still contain the old single-entry values because they are outside Task 1's permitted configuration scope. A later deployment/configuration task must set `ACCESS_AUD_CORPORATE`, `ACCESS_AUD_EXTERNAL`, `ACCESS_ISSUER`, and `ACCESS_JWKS_URL`, and must configure the two exact production origins before this code is deployed. Until then, the new fail-closed host selection will reject production authentication rather than accept an audience without host-specific validation.

## Fix 1

### Changed files

- `app/src/lib/auth.ts`: applies an entry-specific corporate-email gate only after `verifyCloudflareAccessJwt()` has completed signature and claim validation, before the identity can be returned or used for principal lookup. Corporate and legacy entries require a verified exact `@lancloudtech.com` email; external entries remain unrestricted by email domain. Development mode remains the explicit non-production `DEV_AUTH === '1'` local-test path.
- `app/test/auth.test.ts`: adds focused verified-identity entry-gate coverage for absent, non-corporate, and lookalike emails at both corporate and legacy entries; verifies a valid corporate email passes and external accepts a verified non-corporate email.

### Test results

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/access-entry.test.ts test/auth.test.ts
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/typescript/bin/tsc --noEmit
```

Passed: 2 test files, 18 tests; TypeScript typecheck exited 0.

### Self-review

- The gate consumes only `AuthenticatedIdentity.email` produced after verified JWT claim validation; no browser-provided field is consulted.
- It is placed after signature, issuer, audience, and expiry validation and before `resolveAuthenticatedIdentity()` returns to `resolvePrincipal()` for D1 lookup.
- `isCorporateEmail()` enforces exact split-domain equality, so suffix/lookalike domains are rejected. No deployment or Cloudflare configuration was changed.
