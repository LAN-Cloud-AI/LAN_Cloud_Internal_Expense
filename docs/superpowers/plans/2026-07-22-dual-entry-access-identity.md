# 双入口 Access 身份绑定与域名迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `ie-oa.lancloudtech.com` 自动开通企业员工，并让经过确认绑定的任意 Cloudflare/GitHub 外部身份从独立入口安全登录同一套订阅资产与报销系统。

**Architecture:** 同一 Worker/D1/R2 通过两个 Cloudflare Access application 提供企业入口和外部入口。Worker 按 Host 选择 Access Audience、身份类型和精确 Origin；D1 的 `user_access_identities` 以已验签的 `(issuer, subject)` 作为唯一授权键，企业邮箱只用于首次企业身份开通。

**Tech Stack:** Cloudflare Workers、Cloudflare Access、D1、R2、Hono 4、TypeScript 5、Vitest 3、better-sqlite3（测试）、Wrangler 4。

## Global Constraints

- 绝不新增应用密码、Passkey、OTP、邮件发信、第三方 OAuth secret 或自建认证服务。
- 企业入口固定为 `https://ie-oa.lancloudtech.com`；外部入口固定为 `https://external-ie-oa.lancloudtech.com`；旧入口为 `https://ie_oa.lancloudtech.com`。
- 企业入口首次自动开通的唯一条件是：已验签 JWT、企业入口 AUD、严格的 `@lancloudtech.com` 邮箱和未被其他身份占用的 `(issuer, subject)`。
- 所有企业自动开通用户获得 `employee`，但 `employee` 只能读取本人 `owner_user_id` 范围的数据，不能读取全局财务/用户/附件/审计数据。
- 以 `(issuer, subject)` 绑定身份，永不根据 email 自动合并；外部绑定必须有 128-bit 一次性 secret、SHA-256 hash 存储、10 分钟 TTL、外部候选出现和企业入口最终确认。
- 不在 URL、日志、审计详情或仓库中保存绑定码、Cloudflare Token、Access JWT、外部完整邮箱或管理员迁移邮箱。
- `MIGRATION_SYSTEM_ADMIN_EMAIL` 仅通过 Workers secret 设置为用户指定的企业邮箱；首次迁移成功且验证后立即删除。
- Workspace 没有 Git repository；不要初始化 Git 或尝试提交。每个任务以通过指定测试和 typecheck 作为检查点。
- 测试与部署统一使用 `/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node`，不要依赖 PATH 中不存在的 `npm`。

---

## File Structure

| Path | Responsibility |
|---|---|
| `app/src/lib/access-entry.ts` | Host、AUD、Origin 和企业邮箱规则的纯函数。 |
| `app/src/lib/auth.ts` | Access JWT 验签，并将 issuer 纳入已认证身份。 |
| `app/src/lib/identity-policy.ts` | 身份类型、绑定 secret、掩码与纯安全决策。 |
| `app/src/lib/identity-store.ts` | D1 身份解析、企业自动开通、绑定交易、确认与解绑。 |
| `app/src/lib/types.ts` | Worker Env 的双 AUD、双 origin 和一次性管理员迁移 secret 类型。 |
| `app/src/index.ts` | Host 感知认证中间件、个人身份 API、自动开通、员工范围收紧、旧域名重定向。 |
| `app/src/ui.ts` | 个人设置、外部绑定页、无权限页及按角色收敛导航。 |
| `app/migrations/0006_access_identities.sql` | 新身份表、绑定交易表、历史 subject 回填及约束。 |
| `app/test/access-entry.test.ts` | 企业邮箱、Host/AUD/Origin 和旧域名决策测试。 |
| `app/test/identity-policy.test.ts` | secret、掩码、绑定状态和不可合并决策测试。 |
| `app/test/identity-store.test.ts` | D1 身份自动开通、绑定、冲突、解绑和管理员迁移测试。 |
| `app/test/index-access.test.ts` | Worker API 的双入口、employee 数据范围和 Origin 集成测试。 |
| `app/test/ui.test.ts` | 移除 bootstrap、个人身份设置与外部绑定 UI 测试。 |
| `app/test/helpers/sqlite-d1.ts` | 将 `better-sqlite3` 适配为测试所需最小 D1 API。 |
| `app/wrangler.jsonc` | 两个新 host、旧 host 过渡 route 和新变量。 |
| `docs/runbooks/cloudflare-access-dual-entry.md` | 受限 Token 下的 Access/DNS/Worker 部署、回滚和真实登录验收。 |

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

## Task 4: Enforce two entry points and employee data boundaries in the Worker

**Files:**
- Modify: `app/src/index.ts`
- Modify: `app/src/lib/auth.ts`
- Create: `app/test/index-access.test.ts`

**Interfaces:**
- Consumes: `accessEntryForRequest()`, `IdentityStore`, `ResolvedIdentityPrincipal`, and existing business APIs.
- Produces: host-specific Access validation, automatic corporate provisioning, external candidate-only mode, exact CSRF behavior, and scoped employee responses.

- [ ] **Step 1: Write failing Worker access tests using a `sqliteD1` Env and `DEV_AUTH=1`.**

Export `createApp()` from `app/src/index.ts` with optional test overrides:

```ts
export interface AppDependencies {
  resolveIdentity?: (request: Request, env: Env, entry: AccessEntry) => Promise<AuthenticatedIdentity | null>;
  now?: () => Date;
}
export function createApp(dependencies?: AppDependencies): Hono<AppBindings>;
```

Test these requests:

```ts
expect((await app.request('https://ie-oa.lancloudtech.com/api/session', {}, corporateEnv)).status).toBe(200);
expect((await app.request('https://external-ie-oa.lancloudtech.com/api/dashboard', {}, externalUnboundEnv)).status).toBe(401);
expect((await app.request('https://external-ie-oa.lancloudtech.com/api/me/identities', {}, externalBoundEnv)).status).toBe(401);
expect((await app.request('https://ie-oa.lancloudtech.com/api/dashboard', {}, employeeEnv)).json()).resolves.toMatchObject({ data: { pending_candidates: { count: 0 } } });
expect((await app.request('https://ie-oa.lancloudtech.com/api/payers', {}, employeeEnv)).status).toBe(403);
```

For a corporate `POST`, include `Origin: https://ie-oa.lancloudtech.com` and expect 2xx; include `Origin: https://attacker.example` and expect 403. Verify the same JWT identity cannot be resolved when an external entry expects `linked_external`.

- [ ] **Step 2: Run the Worker access test and verify it fails before route changes.**

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/index-access.test.ts
```

Expected: FAIL because `createApp()` and host-aware identity behavior do not exist.

- [ ] **Step 3: Replace global authentication plumbing in `app/src/index.ts`.**

Implement the following request sequence:

```ts
const entry = accessEntryForRequest(new URL(c.req.url).host, c.env);
if (!entry) return problem(c, 404, 'unknown_entry_host', '入口地址无效。');
if (entry.kind === 'legacy' && ['GET', 'HEAD'].includes(c.req.method)) {
  return c.redirect(`https://ie-oa.lancloudtech.com${new URL(c.req.url).pathname}${new URL(c.req.url).search}`, 308);
}
if (entry.kind === 'legacy') return problem(c, 410, 'legacy_host_write_blocked', '请使用新入口完成写操作。');
```

For non-legacy `/api/*` requests, resolve and validate the Access identity using the entry-specific AUD. At the corporate entry, call `ensureCorporatePrincipal()` after successful identity validation; at the external entry, only call `store.resolve(identity, 'external')`. Store both `entry` and principal in Hono context. Do not execute auto-provision from a UI route before the JWT has passed all checks.

Replace `ensureMutationOrigin()` with an entry-aware function that uses `isAllowedEntryOrigin(origin, entry)` and rejects all writes on legacy host. Remove `/api/bootstrap`, `BOOTSTRAP_ADMIN_*` imports and all bootstrap behavior.

- [ ] **Step 4: Add the identity APIs with fixed authorization.**

Add these route contracts:

```ts
GET    /api/me/identities
POST   /api/me/identities/link-transactions
POST   /api/external/identity-presentations
POST   /api/me/identities/link-transactions/:id/confirm
DELETE /api/me/identities/:id
```

`/api/me/*` routes require a corporate entry and a `corporate_primary` principal. `/api/external/identity-presentations` requires only a valid external Access identity and a JSON `{ code: string }`; call `resolveAccessProviderHint()` server-side and pass its value (or `null`) into `presentExternalIdentity()`. Do not accept a browser-supplied provider name. The response may not return user names, email addresses, roles, transaction owner, or account existence. Confirm/revoke responses return only the caller's masked identity data. Apply exact Origin validation to every mutation.

- [ ] **Step 5: Tighten employee read paths before granting automatic employee access.**

For `GET /api/dashboard`, add a separate employee query path that returns only:

```ts
{
  pending_candidates: { count: 0, total_cny_fen: 0 },
  review_batches: { count: 0 },
  fx_exceptions: { count: 0 },
  import_exceptions: { count: 0 },
  owned_subscriptions: { count: number },
  owned_account_assets: { count: number }
}
```

Never query reimbursement candidates, batches, FX exceptions, or import exceptions for employee users. Keep existing `subscriptions` and `account-assets` `owner_user_id = auth.userId` filters, and remove `employee` from every other endpoint's allowed role list. Ensure the attachment route continues to reject employee users.

- [ ] **Step 6: Run the Worker access tests, all tests, and typecheck.**

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/index-access.test.ts
```

Expected: PASS.

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run
```

Expected: all test files pass.

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/typescript/bin/tsc --noEmit
```

Expected: exit code 0.

## Task 5: Replace bootstrap UI with personal identity settings and external binding UI

**Files:**
- Modify: `app/src/ui.ts`
- Modify: `app/test/ui.test.ts`
- Modify: `app/src/index.ts`

**Interfaces:**
- Consumes: `/api/session`, `/api/me/identities`, binding API endpoints, `AccessEntryKind`.
- Produces: `/profile` for enterprise identity management and a data-free external binding page.

- [ ] **Step 1: Replace bootstrap tests with failing identity-UI tests.**

Delete bootstrap-specific expectations and assert:

```ts
expect(UI_API_CONTRACT).toMatchObject({ identities: '/api/me/identities', beginIdentityLink: '/api/me/identities/link-transactions' });
expect(renderAdminUi({ page: 'profile', principal: { displayName: 'employee@lancloudtech.com', roles: ['employee'] } })).toContain('登录身份');
expect(html).toContain('data-action="begin-identity-link"');
expect(html).not.toContain('bootstrap-admin');
expect(renderExternalIdentityUi()).toContain('输入绑定码');
expect(renderExternalIdentityUi()).not.toContain('订阅资产');
```

- [ ] **Step 2: Run the UI test and verify it fails.**

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/ui.test.ts
```

Expected: FAIL because profile and external-only UI do not exist.

- [ ] **Step 3: Implement the profile and external-only rendering.**

Add `profile` to `UI_PAGES`, a `/profile` nav/profile link, and these exports:

```ts
export function renderAdminUi(options: UiShellOptions = {}): string;
export function renderExternalIdentityUi(): string;
```

Profile HTML must display the enterprise identity as non-removable, display masked external identities, and expose buttons for “绑定 Cloudflare” and “绑定 GitHub”. A button calls `POST /api/me/identities/link-transactions`, then renders the returned code and exact external URL; code must be inserted with `textContent`, never HTML. Confirmation and revoke buttons use same-origin JSON requests with `credentials: 'same-origin'`.

`renderExternalIdentityUi()` must contain only binding-code instructions and a form posting `{ code }` to `/api/external/identity-presentations`; it must not render navigation, dashboard cards, user profile, subscriptions, billing data, or error details that reveal whether a code/user exists.

In `index.ts`, route external unbound GET requests to `renderExternalIdentityUi()` and route corporate `/profile` requests to `renderAdminUi({ page: 'profile', ... })`. Do not render `renderAdminUi()` with a null principal on either entry.

- [ ] **Step 4: Restrict navigation by role.**

For `employee`, show only 总览、订阅资产、账号资产、个人设置. Hide reimbursements, rates, people, and imports rather than relying only on failing API calls. Keep server authorization as the actual security boundary.

- [ ] **Step 5: Re-run UI tests, all tests, and typecheck.**

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/ui.test.ts
```

Expected: PASS.

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run
```

Expected: all test files pass.

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/typescript/bin/tsc --noEmit
```

Expected: exit code 0.

## Task 6: Prepare production configuration and deployment runbook

**Files:**
- Modify: `app/wrangler.jsonc`
- Create: `docs/runbooks/cloudflare-access-dual-entry.md`
- Modify: `app/README.md`

**Interfaces:**
- Consumes: deployed Worker `lan-cloud-internal-expense`, existing D1/R2 bindings, existing Cloudflare/GitHub Access IdPs, and a scoped Cloudflare API token stored only in the terminal environment.
- Produces: repeatable staged deployment that protects both new hostnames before business UI becomes reachable.

- [ ] **Step 1: Write failing configuration assertions into the runbook checklist.**

The runbook must require these post-deploy facts before declaring success:

```text
Corporate app domain: ie-oa.lancloudtech.com
Corporate policy: email_domain lancloudtech.com
External app domain: external-ie-oa.lancloudtech.com
External policy: Cloudflare and GitHub login_method selectors only
Worker routes: ie-oa, external-ie-oa, and temporary ie_oa
Worker secrets: ACCESS_AUD_CORPORATE, ACCESS_AUD_EXTERNAL, ACCESS_ISSUER, ACCESS_JWKS_URL
```

- [ ] **Step 2: Update `app/wrangler.jsonc`.**

Set `APP_ORIGINS` to the exact comma-separated pair:

```json
"APP_ORIGINS": "https://ie-oa.lancloudtech.com,https://external-ie-oa.lancloudtech.com"
```

Replace the single route with exactly these three patterns, all in `lancloudtech.com`:

```json
"ie-oa.lancloudtech.com/*"
"external-ie-oa.lancloudtech.com/*"
"ie_oa.lancloudtech.com/*"
```

Delete `APP_ORIGIN` and comments for `BOOTSTRAP_ADMIN_*`; document `ACCESS_AUD_CORPORATE`, `ACCESS_AUD_EXTERNAL`, `ACCESS_ISSUER`, `ACCESS_JWKS_URL`, and `MIGRATION_SYSTEM_ADMIN_EMAIL` as Worker secrets only.

- [ ] **Step 3: Write the exact no-secret-leak deployment sequence into `docs/runbooks/cloudflare-access-dual-entry.md`.**

The runbook uses variables that are never echoed:

```sh
CF_ACCOUNT_ID=889e913c81be632234cb26e2b75b0b9a
CF_ZONE_ID=12d261b22fda850521cbfc9dba0bc644
CF_WORKER=lan-cloud-internal-expense
CF_D1=lan-cloud-expense
```

It must instruct the operator to verify the already-exported token without printing it:

```sh
curl --silent --show-error --fail-with-body \
  -H "Authorization: Bearer $CF_DEPLOY_TOKEN" \
  https://api.cloudflare.com/client/v4/user/tokens/verify
```

Then, in order:

1. GET existing Access organization, corporate app, policy, and IdP ids; save only response ids locally.
2. Create proxied placeholder A records for `ie-oa` and `external-ie-oa` only if DNS lookup confirms they do not exist; use the same placeholder convention as the existing Worker route.
3. Update the existing corporate Access app with new primary `domain`, destinations `[ie-oa, ie_oa]`, and current corporate IdPs. Replace its policy include rule with exactly `email_domain: lancloudtech.com`.
4. Create external Access app with `allowed_idps` limited to the existing Cloudflare and GitHub IdP ids. Create its policy with two `login_method` include selectors, one per IdP. Never use `everyone`, `email_domain`, Email OTP, or a bypass policy there.
5. Apply remote D1 migration with Wrangler, deploy Worker, and set dual-AUD/issuer/JWKs secrets. Set the operator-provided migration-admin email through `wrangler secret put MIGRATION_SYSTEM_ADMIN_EMAIL` without placing it in a command history file.
6. Verify both Access apps are enabled before accepting application traffic, then verify Worker routes.

Use the exact Node/Wrangler invocation pattern:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/wrangler/bin/wrangler.js d1 migrations apply lan-cloud-expense --remote
```

and:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/wrangler/bin/wrangler.js deploy
```

- [ ] **Step 4: Add rollback and verification instructions.**

Require these explicit checks:

```sh
curl -I https://ie-oa.lancloudtech.com/
curl -I https://external-ie-oa.lancloudtech.com/
curl -I https://ie_oa.lancloudtech.com/
```

Expected: each reaches Cloudflare Access, not an origin response. Then use the browser to verify: corporate login auto-provisions the designated account; a non-corporate external identity sees only the code form; link/confirm succeeds; external login returns the same session user id; employee cannot load global data; and revocation immediately blocks external API access.

After browser verification confirms the designated admin has `system_admin`, delete `MIGRATION_SYSTEM_ADMIN_EMAIL`, remove old `BOOTSTRAP_ADMIN_*` secrets, and remove any exact-email legacy Access policy. Rollback before that point is: restore the prior Worker version, keep the old Access app destination/policy, and do not roll back or delete the D1 migration; the new tables are additive and safe to leave.

- [ ] **Step 5: Run build validation.**

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/typescript/bin/tsc --noEmit
```

Expected: exit code 0.

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/wrangler/bin/wrangler.js deploy --dry-run --outdir dist
```

Expected: Worker bundle completes without route or type errors.

## Task 7: Execute staged production deployment and verify live behavior

**Files:**
- Modify remotely: D1 schema, Worker script/secrets, DNS records, Access applications, Access policies, Worker routes.
- Update: `docs/runbooks/cloudflare-access-dual-entry.md` only with non-secret deployment timestamps, returned resource ids, and validation outcomes.

**Interfaces:**
- Consumes: passing code/tests, scoped token, Cloudflare account/zone, and the operator-approved corporate administrator email supplied outside the repository.
- Produces: live protected corporate/external entrypoints and a completed evidence record.

- [ ] **Step 1: Re-run the full local verification suite immediately before changing Cloudflare.**

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run
```

Expected: all tests pass.

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/typescript/bin/tsc --noEmit
```

Expected: exit code 0.

- [ ] **Step 2: Apply the runbook’s Access/DNS/D1/Worker sequence without printing credentials.**

Run the commands in `docs/runbooks/cloudflare-access-dual-entry.md` in the documented order. After each Cloudflare API mutation, GET the exact resource and compare domain, destinations, `allowed_idps`, policy selectors, route pattern, and D1 migration list to the intended values.

- [ ] **Step 3: Perform authenticated browser acceptance tests.**

Use the existing logged-in browser only after both Access policy reads are verified. Record non-sensitive evidence for these outcomes: corporate automatic provision; one-time admin migration; employee personal-data scoping; Cloudflare external binding; GitHub external binding; unbound external denial; external identity revocation; old host redirect; and two-host API Origin enforcement.

- [ ] **Step 4: Remove temporary migration access and complete the evidence record.**

Only after the designated corporate account has a confirmed `system_admin` role, delete `MIGRATION_SYSTEM_ADMIN_EMAIL` and prior bootstrap secrets. Update the runbook with the non-secret verification date, live hostnames, Worker version id, Access app ids, D1 migration status, and test result summary. Re-run `curl -I` for all three hosts and one final `/api/session` browser check.

## Plan Self-Review

### Spec coverage

- 企业邮箱自动正式开通 + `employee`：Tasks 2–4。
- 员工本人范围与全局财务隔离：Task 4。
- 任意外部 Cloudflare/GitHub 绑定及后续登录：Tasks 3–5。
- 邮箱不自动合并、双确认、一次性 secret、审计、解绑和恢复边界：Tasks 2–4。
- `ie-oa` 主域迁移、旧域过渡、双 AUD、精确 Origin：Tasks 1, 4, 6–7。
- 指定企业管理员的一次性迁移：Tasks 3, 6–7。
- Cloudflare 受限 Token、D1/R2 不重建、上线与回滚验证：Tasks 6–7。

### Placeholder and type consistency check

All paths, exported interfaces, endpoint names, role scopes, hostnames, test commands, deployment commands, and expected outcomes are specified above. `AccessEntryKind`, `IdentityKind`, `ResolvedIdentityPrincipal`, `IdentityStore`, and the binding API route names are defined before they are consumed by later tasks.
