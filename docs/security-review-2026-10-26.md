# Security and adversarial review, 2026-10-26

Scope: the surfaces added or changed for the release candidate on `integrate/phases-3-7-workforce`, at the head this document ships with. Two independent read-only reviewers worked from separate briefs (money and identity paths; authorization, tenant isolation and development-only routes) and reported findings with a severity, the exact code path, and whether an existing guard stops the exploit. The findings below were then re-checked against the code and, where confirmed, fixed in this worktree with a regression test. **No dynamic testing was performed by the reviewers** (no HTTP requests, no SQL, no build); every database claim is from the migration text and the repository's own tests. Nothing was pushed, deployed, or pointed at a real provider.

## Summary

| Severity | Found | Fixed | Accepted (with reason) |
| --- | ---: | ---: | --- |
| Critical | 0 | — | — |
| High | 2 | 2 | — |
| Medium | 1 | 1 | — |
| Low | 5 | 2 | 3 |

No Critical finding. Both High findings were confirmed by reading the code and are closed below with tests that fail if the guard is removed.

## Findings

| id | Severity | Finding | Status |
| --- | --- | --- | --- |
| H1 | **High** | `/api/assets/upload` parsed `req.formData()` **before** authenticating, with no byte ceiling; eight sibling upload routes parsed without a ceiling too. A `Content-Length` header is only a claim, so a chunked request made the server hold an arbitrary body | **Fixed** |
| H2 | **High** | The per-role tool allowlist was advisory by default (`roleToolEnforcement` returned `report` unless the variable said `enforce`), so every client profile was provisioned with the `web` toolset and an over-wide profile could go online and run | **Fixed** |
| M1 | Medium | The admin client-detail trusted reader (`withSystem`) showed a client's held knowledge text and failed-run error text to any agency person holding `agency.workforce.view`, even with the D70 rule on — the one reader the switch did not cover | **Fixed** |
| L-1 | Low | Credit-note writes took the note lock before the invoice lock while issuing took them the other way (a deadlock shape, no money effect) | **Fixed** |
| L-2 | Low | Per-IP rate-limit buckets key on the first `X-Forwarded-For` entry, which an appending proxy leaves attacker-chosen | Accepted: the money-relevant limits are keyed on values the attacker cannot rotate (invoice id, connection id, checkout attempt); recorded as a deployment note |
| L-3 | Low | The production `/dev` block does not literally cover paths the middleware matcher exempts (an image extension) | Accepted: the per-page guards still answer 404; defence in depth, no exposure |
| L-4 | Low | The customer invoice link is a permanent bearer credential (no expiry) | Accepted: rotation exists, and a link that expires mid-conversation is its own support problem; the founder owns a link-lifetime decision |
| L-5 | Low | Authenticated JSON endpoints parse `req.json()` without a byte ceiling | Accepted for now, **pinned by a test** so the list cannot grow; an upload or text body may not use a raw parse |

## What was changed

* **H1.** Every route that accepts a file or free-text body now reads it through `src/server/security/bounded-body.ts`, which abandons the stream at the ceiling. `/api/assets/upload` authenticates first (`requireUserOrThrow()`) and only then reads the form, so an anonymous request cannot make the server buffer anything. The nine routes fixed: `assets/upload`, `social/media`, `knowledge/upload`, `support/uploads`, `admin/messages/upload`, `admin/projects/[id]/files`, `projects/[id]/files`, `admin/portfolio/[id]/assets`, `admin/website-templates/[key]/preview`, plus `aqi/attachments` (which had no length check at all), `aqi/knowledge/documents`, `onboarding/suggest` and `agent-tools/[tool]`.
* **H2.** `roleToolEnforcement()` now enforces unless a deployment writes exactly `report`; the variable is documented in `.env.example` and `.env.staging.example`. The behavior change is tested both ways, including that a typo, a blank value or any other word stays on the strict side. The test suite keeps its older Hermes fixtures in report mode (`vitest.config.ts`, so a fixture about something else still exercises that thing); `tests/employee-tool-policy.test.ts` removes the opt-out and proves the enforced path for every role.
* **M1.** `clientContentAccess()` asks the same question the database asks (`agency_policy_switches` plus an active, unexpired, unended `crm_support_sessions` row) and `getTenantDetail` uses it for held knowledge text and failed-run error text. With the rule off (the default) nothing changes. With it on and no session, the screen says how many entries are withheld and why, instead of looking empty.
* **L-1.** `updateCreditNoteDraft` and `submitCreditNote` lock the invoice first, then the note, matching `issueCreditNote`, so two people acting on one draft queue instead of deadlocking.

## The two findings that looked High and were not

These are recorded because they are where the next reviewer will look first, and because "why this is not a vulnerability" is the useful half.

* **PayPal's test/live mode is a word the owner chooses, so could sandbox money count as live?** Refuted one layer down: `paypalHttp` pins the origin to the declared environment (`api-m.sandbox.paypal.com` or `api-m.paypal.com`) and refuses redirects, so a sandbox key fails the token call against the live origin. Connect, replace-credentials and the daily re-check all verify the credentials **before** writing the mode, and the database refuses a test-mode payment on a real invoice (`migrations/0093`). PayMongo is stronger: the mode is read off the key prefix.
* **Can a forged or replayed webhook make money arrive?** Refuted: PayPal is verified by asking PayPal (`/v1/notifications/verify-webhook-signature`, with the body parsed as exactly one JSON object so no trailing `webhook_id` can be appended); PayMongo is verified by a timing-safe HMAC over `timestamp.body` inside a 24-hour window; both are deduplicated by an event-id ledger row locked `FOR UPDATE`. Amount and currency are never taken from the event as truth: they are compared with the amount we stored, and a mismatch freezes the row into a hold with a critical notice instead of applying it.

Also verified and found sound (not exhaustive, but the parts the reviewers read end to end): the D70 switch's authorization and audit; the 15 policies guarded by the four permissions and the single Super Admin audit-log branch; storage key shape and cross-tenant reads; storage entitlement at the single upload primitive; every bearer link (purchase, proposal, invoice, demo) for randomness, hash-only storage, constant-time comparison, expiry and rotation; the sign-in redirect and the same-site check with `Origin: null`; the health probe's bounds and its scheduler-only entry point; and the demo's public surface.

## Not covered

* No penetration test, no dependency audit, no fuzzing, no dynamic scan. Every reviewer finding is a code-reading finding.
* The Hermes gateway, the Python provisioner worker and the model provider were out of scope (H2 is the portal-side policy and default).
* Migration `0112` is not applied to any hosted database, so the database half of the D70 rule is proven on embedded Postgres only.
* Deployment facts could not be checked from the repository: whether the hosting proxy overwrites `X-Forwarded-For`, whether the platform caps request bodies, and whether `WORKFORCE_ROLE_TOOL_ENFORCEMENT` is set in the real environment. H1 is fixed regardless; L-2's severity depends on the proxy.
* Uploads behind a session still read the whole body before checking the size in a few AQi-adjacent paths that use the bounded reader with a large ceiling (50 MB); the ceiling is a bound, not a streaming scan.

## Tests that now hold these lines

`tests/upload-bodies-bounded.test.ts` (every file or free-text body goes through the bounded reader; the upload route authenticates before it reads; the list of authenticated JSON bodies cannot grow unnoticed), `tests/employee-tool-policy.test.ts` (the enforcement default and both directions of the inventory decision), `tests/client-content-policy.test.ts` (the switch, the database rule, and the admin reader asking the same question), and `tests/invoices-credit-notes*.test.ts` (58 tests, including the lock-order path).
