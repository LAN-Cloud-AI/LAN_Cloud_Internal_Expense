# Task 7 report — free external-entry hostname migration and deployment

## Scope

The previously planned deep external hostname was replaced with the approved first-level hostname `external-ie-oa.lancloudtech.com`. The hostname is intentionally a standard proxied DNS + Worker route so Cloudflare Universal SSL can cover it without Workers Custom Domain, Advanced Certificate Manager (ACM), or a paid certificate.

## Implemented local changes

- Updated the exact external hostname in Worker host recognition, generated binding URL, origin allowlist, production Wrangler route, and all affected tests.
- Kept the corporate host and the legacy migration host unchanged.
- Kept the external entry as a normal proxied DNS + normal Worker route. The first-level hostname is intended to use Cloudflare Universal SSL; the repository configuration does not use Workers Custom Domain, Advanced Certificate Manager (ACM), or a paid certificate.
- Updated the application README, Access/DNS runbook, design/plan records, and Task 1 test brief so operational instructions match the approved hostname.

## Remote deployment record — 2026-07-22

- Created a proxied DNS record for `external-ie-oa.lancloudtech.com`.
- Created its dedicated self-hosted Access application and exact Allow policy. The application permits only the configured Cloudflare and GitHub IdPs, with automatic IdP redirect disabled.
- Updated only the Worker secret that holds the external Access audience; no secret value was read back or recorded.
- Deployed Worker version `6bc43be7-9649-4637-a899-a87db1b8b72e`. Wrangler confirmed exactly three ordinary routes: corporate, the new external host, and the temporary legacy host.
- Confirmed TLS verification and the Cloudflare Access challenge (`302`) for all three hosts. This proves the new external host has a valid edge certificate and is not falling through to the placeholder origin.
- The retired external Worker route is absent from the deployed route list. Its obsolete Access/DNS resources were deliberately not deleted during this deployment because permanent cleanup requires a separate, explicit destructive-action confirmation.

## Remaining browser acceptance

An authorized corporate administrator must still complete the real-login checks in the runbook: first corporate provisioning and administrator grant, Cloudflare and GitHub external identity binding, role isolation, and identity revocation. Do not delete the one-time migration administrator secret until the administrator role is observed through a real corporate login.

## Validation

- Full Vitest suite: 13 files / 101 tests passed.
- TypeScript `tsc --noEmit`: passed.
- Wrangler `deploy --dry-run --outdir`: passed, followed by the successful production deployment above.
- The local SQLite tests require Node 22 (ABI 127) because `better-sqlite3` was built for that runtime; the bundled Node 24 runtime produces an ABI mismatch and was not used as deployment evidence.
