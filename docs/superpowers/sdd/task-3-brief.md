## Task 3: Implement identity policy and D1 identity store

**Files:**
- Create: `app/src/lib/identity-policy.ts`
- Create: `app/src/lib/identity-store.ts`
- Create: `app/test/identity-policy.test.ts`
- Create: `app/test/identity-store.test.ts`
- Modify: `app/src/lib/auth.ts`

**Interfaces:**
- Consumes: `AuthenticatedIdentity`, `AccessEntryKind`, D1 identity tables, and an optional migration-admin corporate email.
- Produces: `ResolvedIdentityPrincipal`, `ensureCorporatePrincipal()`, `beginLinkTransaction()`, `presentExternalIdentity()`, `confirmLinkTransaction()`, and `revokeLinkedIdentity()`.

- [ ] **Step 1: Write the failing pure-policy tests.**

In `app/test/identity-policy.test.ts`, test these contracts:

```ts
expect(await hashBindingSecret('code')).toHaveLength(64);
expect(createBindingSecret(() => new Uint8Array(16).fill(1))).toMatch(/^[A-Z2-7]{26}$/);
expect(maskIdentityEmail('personal@example.com')).toBe('p******l@example.com');
expect(canUseIdentityAtEntry('corporate', 'linked_external')).toBe(false);
expect(canUseIdentityAtEntry('external', 'corporate_primary')).toBe(false);
expect(canUseIdentityAtEntry('external', 'linked_external')).toBe(true);
```

Define the implementation signatures before tests:

```ts
export type IdentityKind = 'corporate_primary' | 'linked_external' | 'legacy_primary';
export function createBindingSecret(randomBytes?: () => Uint8Array): string;
export async function hashBindingSecret(secret: string): Promise<string>;
export function maskIdentityEmail(email: string | null | undefined): string | null;
export function canUseIdentityAtEntry(entry: AccessEntryKind, identityKind: IdentityKind): boolean;
```

In `app/test/auth.test.ts`, add a mocked `get-identity` response test for the advisory provider helper:

```ts
await expect(resolveAccessProviderHint(requestWithAccessAssertion, mockedFetcher)).resolves.toBe('github');
await expect(resolveAccessProviderHint(requestWithUnknownIdp, mockedFetcher)).resolves.toBeNull();
```

The test must prove that provider information is advisory only: an unknown or unavailable provider result cannot make an unbound identity authorized.

- [ ] **Step 2: Write failing D1 store tests using `sqliteD1`.**

Cover these concrete cases in `app/test/identity-store.test.ts`:

```ts
await store.ensureCorporatePrincipal(corporateIdentity, { migrationAdminEmail: undefined });
await store.ensureCorporatePrincipal(corporateIdentity, { migrationAdminEmail: undefined });
expect(countUsers()).toBe(1);
expect(roleCodesFor('user-1')).toEqual(['employee']);

await expect(store.ensureCorporatePrincipal({ ...corporateIdentity, email: 'x@lancloudtech.com.evil' }, {})).rejects.toMatchObject({ code: 'corporate_email_required' });

const link = await store.beginLinkTransaction(corporatePrincipal, new Date('2026-07-22T00:00:00Z'));
await store.presentExternalIdentity(externalIdentity, link.secret, 'github', now);
await expect(store.confirmLinkTransaction(corporatePrincipal, link.id, now)).resolves.toMatchObject({ identityKind: 'linked_external' });
await expect(store.presentExternalIdentity(secondIdentity, link.secret, 'cloudflare', now)).rejects.toMatchObject({ code: 'link_secret_consumed' });
```

Also assert same email/different subject stays unbound, one `(issuer, subject)` cannot bind to two users, external identities cannot start a link transaction, and `MIGRATION_SYSTEM_ADMIN_EMAIL` grants `system_admin` only on the first matching corporate provision.

- [ ] **Step 3: Run the policy/store tests and verify they fail.**

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/identity-policy.test.ts test/identity-store.test.ts
```

Expected: FAIL because the identity modules do not exist.

- [ ] **Step 4: Implement `identity-policy.ts`.**

Use `crypto.getRandomValues()` to generate 16 bytes, encode in RFC 4648 base32 without padding, and uppercase it. Use Web Crypto `crypto.subtle.digest('SHA-256', ...)` for `hashBindingSecret()`. `maskIdentityEmail()` must preserve the domain and only the first/last local-part characters; return `null` for absent values. Reject entry/identity kind combinations exactly as tested; legacy identities never initiate external binding.

In `app/src/lib/auth.ts`, add:

```ts
export async function resolveAccessProviderHint(
  request: Request,
  fetcher?: typeof fetch,
): Promise<'cloudflare' | 'github' | null>;
```

It calls the same-host `/cdn-cgi/access/get-identity` endpoint only after the request JWT is already verified, forwards only the current `Cf-Access-Jwt-Assertion` header, and maps the returned `idp.type` to `cloudflare` / `github`. Treat non-200 responses, malformed JSON, unknown IdP types, and fetch failures as `null`; this value is display/audit metadata only and never an authorization condition.

- [ ] **Step 5: Implement `identity-store.ts` as the only D1 identity write surface.**

Define these exported shapes:

```ts
export interface ResolvedIdentityPrincipal {
  userId: string;
  identityId: string;
  identityKind: IdentityKind;
  issuer: string;
  subject: string;
  email?: string;
  roles: AppRole[];
}

export class IdentityStore {
  constructor(private readonly db: D1Database) {}
  resolve(identity: AuthenticatedIdentity, entry: AccessEntryKind): Promise<ResolvedIdentityPrincipal | null>;
  ensureCorporatePrincipal(identity: AuthenticatedIdentity, options: { migrationAdminEmail?: string }): Promise<ResolvedIdentityPrincipal>;
  beginLinkTransaction(principal: ResolvedIdentityPrincipal, now: Date): Promise<{ id: string; secret: string; expiresAt: string }>;
  presentExternalIdentity(identity: AuthenticatedIdentity, secret: string, providerHint: 'cloudflare' | 'github' | null, now: Date): Promise<{ transactionId: string; expiresAt: string }>;
  confirmLinkTransaction(principal: ResolvedIdentityPrincipal, transactionId: string, now: Date): Promise<{ identityId: string }>;
  revokeLinkedIdentity(principal: ResolvedIdentityPrincipal, identityId: string): Promise<void>;
}
```

Use D1 `batch()` for every multi-row state change. `ensureCorporatePrincipal()` may upgrade only a matching `legacy_primary` record with the same subject after the email passes `isCorporateEmail()`; it must never join records by email. It must insert role `role-employee` idempotently, and conditionally insert `role-system-admin` only when the normalized verified email exactly matches `MIGRATION_SYSTEM_ADMIN_EMAIL` and no earlier `migrate_system_administrator` audit event exists. All errors returned to routes use a typed `IdentityProblem` with fixed public codes, never a raw SQL error.

`presentExternalIdentity()` must not insert an identity row; it writes only candidate fields on a pending, unexpired transaction. `confirmLinkTransaction()` must atomically assert pending/candidate status, expiry, same owner, and no existing live `(issuer, subject)` before inserting one `linked_external` row and setting `consumed_at`.

- [ ] **Step 6: Run focused identity tests and typecheck.**

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/identity-policy.test.ts test/identity-store.test.ts test/schema-integrity.test.ts
```

Expected: PASS.

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/typescript/bin/tsc --noEmit
```

Expected: exit code 0.
