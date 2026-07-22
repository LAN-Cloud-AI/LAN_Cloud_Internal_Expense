# Task 9 — External binding UI hardening

## Outcome

The binding flow no longer writes a one-time binding code into the corporate Profile DOM, accessibility tree, URL, storage, log output, or audit detail.

- The generated code stays in the `showLinkTransaction()` JavaScript closure.
- A user must explicitly click **复制绑定码** before the browser writes it to the clipboard.
- The external form uses a password-masked `code` field and keeps the same one-time-code autocomplete hint.
- An external route without a verified Access identity renders a data-free `401` Access-login-required page rather than the binding form.
- The external form explains a `401` only as a required Access re-login; all non-401 presentation failures remain opaque.

## Validation

Focused Node 22 verification was run against the UI and Access route suites:

```text
test/ui.test.ts
test/index-access.test.ts
30 tests passed
```

No Cloudflare, DNS, Access, D1, browser, credential, or deployment mutation is part of this source-level task.
