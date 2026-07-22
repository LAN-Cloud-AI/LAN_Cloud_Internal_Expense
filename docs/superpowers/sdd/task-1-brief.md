## Task 1: Establish baseline and add host-aware Access configuration

**Files:**
- Create: `app/src/lib/access-entry.ts`
- Create: `app/test/access-entry.test.ts`
- Modify: `app/src/lib/types.ts`
- Modify: `app/src/lib/auth.ts`
- Modify: `app/test/auth.test.ts`

**Interfaces:**
- Consumes: verified Access claims from `validateAccessClaims()` and Worker `Env`.
- Produces: `AccessEntry`, `AccessEntryKind`, `accessEntryForRequest()`, `isCorporateEmail()`, `isAllowedEntryOrigin()`, and `AuthenticatedIdentity.issuer` for later identity storage.

- [ ] **Step 1: Record the existing test/typecheck baseline.**

Run from `/Users/i/myCode/LAN_Cloud_Internal_Expense/app`:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run
```

Expected: 8 test files and 42 tests pass.

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/typescript/bin/tsc --noEmit
```

Expected: exit code 0.

- [ ] **Step 2: Write failing host/claim tests in `app/test/access-entry.test.ts` and extend `app/test/auth.test.ts`.**

Use these exact assertions:

```ts
expect(accessEntryForRequest('ie-oa.lancloudtech.com', env)?.kind).toBe('corporate');
expect(accessEntryForRequest('external-ie-oa.lancloudtech.com', env)?.audience).toBe('external-aud');
expect(accessEntryForRequest('ie_oa.lancloudtech.com', env)?.kind).toBe('legacy');
expect(accessEntryForRequest('evil.lancloudtech.com', env)).toBeNull();
expect(isCorporateEmail('  Employee@LanCloudTech.com ')).toBe('employee@lancloudtech.com');
expect(isCorporateEmail('employee@lancloudtech.com.evil')).toBeNull();
expect(isAllowedEntryOrigin('https://ie-oa.lancloudtech.com', corporateEntry)).toBe(true);
expect(isAllowedEntryOrigin('https://random.ie-oa.lancloudtech.com', corporateEntry)).toBe(false);
```

Update the valid JWT assertion to require `issuer: 'https://team.cloudflareaccess.com'` in the returned identity. Add one failure case for a missing `iss`.

- [ ] **Step 3: Run only the new/changed tests and verify they fail before implementation.**

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/access-entry.test.ts test/auth.test.ts
```

Expected: FAIL because `access-entry.ts` and new issuer return shape do not exist yet.

- [ ] **Step 4: Implement the minimum pure configuration layer.**

In `app/src/lib/types.ts`, replace single-entry fields with these exact optional values while retaining `DEV_AUTH`:

```ts
ACCESS_AUD_CORPORATE?: string;
ACCESS_AUD_EXTERNAL?: string;
ACCESS_ISSUER?: string;
ACCESS_JWKS_URL?: string;
APP_ORIGINS?: string;
MIGRATION_SYSTEM_ADMIN_EMAIL?: string;
```

Create `app/src/lib/access-entry.ts` with these stable exports:

```ts
export type AccessEntryKind = 'corporate' | 'external' | 'legacy';

export interface AccessEntry {
  kind: AccessEntryKind;
  hostname: string;
  audience: string;
  origin: string;
}

export function accessEntryForRequest(host: string, env: Env): AccessEntry | null;
export function isCorporateEmail(email: string | undefined): string | null;
export function isAllowedEntryOrigin(origin: string | undefined, entry: AccessEntry): boolean;
```

Use exact host equality after lowercasing and stripping a port. The legacy host uses the corporate audience but has no permitted mutation origin. `isCorporateEmail()` must return lowercased, trimmed email only when the split domain exactly equals `lancloudtech.com`.

In `app/src/lib/auth.ts`, change `AuthenticatedIdentity` to:

```ts
export interface AuthenticatedIdentity {
  issuer: string;
  subject: string;
  email?: string;
}
```

Have `validateAccessClaims()` return `issuer: claims.iss` only after its existing issuer comparison succeeds. Replace `resolveAuthenticatedIdentity(request, env)` with `resolveAuthenticatedIdentity(request, env, entry)` so the JWT validator receives `entry.audience`; preserve non-production `DEV_AUTH === '1'` by returning issuer `dev://local`.

- [ ] **Step 5: Re-run the focused tests and typecheck.**

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/access-entry.test.ts test/auth.test.ts
```

Expected: PASS.

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/typescript/bin/tsc --noEmit
```

Expected: exit code 0.
