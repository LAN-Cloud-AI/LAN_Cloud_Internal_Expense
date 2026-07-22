# Task 5 report — personal identity settings and external binding UI

## Scope

Replaced the obsolete first-administrator bootstrap presentation with the approved dual-entry identity UI only. No Worker identity-policy logic, migrations, Wrangler configuration, Cloudflare resources, or deployment state was changed.

- Added the corporate-only `/profile` UI page with a fixed corporate-primary card, masked linked-identity loading, Cloudflare/GitHub UX binding controls, refresh-then-confirm flow, and linked-identity revocation control.
- Added the standalone `renderExternalIdentityUi()` page. It contains only binding-code instructions and the opaque external presentation form; it has no navigation, account context, or business data.
- Removed bootstrap paths/actions/cards from UI API contract and client code.
- Added role-aware UI rendering: an `employee`-only principal sees only 总览、订阅资产、账号资产、个人设置, receives a personal dashboard, and has no restricted forms/actions or restricted endpoint configuration in its rendered boot payload.
- Added host-aware UI routing: unbound external identities receive the data-free binding page (including unknown non-API GET paths); external `/profile` redirects to the corporate profile; corporate requests without a resolved principal receive a controlled 401 explanation; no route passes a null principal to `renderAdminUi`.

## Files changed

- `app/src/ui.ts`
- `app/src/index.ts`
- `app/test/ui.test.ts`
- `app/test/index-access.test.ts`
- `docs/superpowers/sdd/task-5-report.md`

## TDD evidence

Initial focused red run:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/ui.test.ts test/index-access.test.ts
```

It failed as expected because `profile`, the identity API contract, external-only renderer, employee filtering, and the new corporate/external UI routes did not exist. A later red refinement also proved that unknown external paths still returned 404 and employee boot payloads still exposed restricted endpoint URLs before those cases were implemented.

## Verification

Focused UI/access regression and type check:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run test/ui.test.ts test/index-access.test.ts
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/typescript/bin/tsc --noEmit
```

Result: 2 test files, 24 tests passed; TypeScript exited 0.

Final full regression and type check:

```sh
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/vitest/vitest.mjs run
/Applications/Cursor.app/Contents/Resources/app/resources/helpers/node node_modules/typescript/bin/tsc --noEmit
```

Result: 13 test files, 101 tests passed; TypeScript exited 0.
