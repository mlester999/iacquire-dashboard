# Verification status

This page separates what was **actually verified** from what was verified **only with mocks or local
emulation**, and from what is **not verified at all**. Nothing here has been run against a live Supabase
project, Hermes gateway, GoHighLevel location, n8n instance, email provider or domain. No production
deployment, remote push or external mutation has been performed.

## Quality gates (local)

| Check | Result |
| --- | --- |
| `npm test` | 310 tests passed in 23 files |
| `npm run typecheck` | passes |
| `npm run lint` | passes with 0 errors and 0 warnings |
| `npm run build` | passes with no warnings (Next.js 16.3.6, Turbopack) |

The tests run on an in-memory PostgreSQL (PGlite), a local emulation of the Supabase `auth`, `storage`
and `realtime` schemas (`supabase/local-compat.sql`), a mocked Supabase Auth SDK, and mocked provider
HTTP. They exercise the real migrations, Row Level Security policies, services and route handlers.

## What kind of evidence each area has

| Area | Evidence | Status |
| --- | --- | --- |
| Migrations 0001–0015, constraints, RLS | Applied to local PostgreSQL by the test suite; every public table has RLS enabled (tested) | Local only |
| Supabase Auth (sign-in, invitations, verification, reset, logout) | Mocked Auth SDK; state, mapping, single-use and session-revocation rules tested | **Mocked, not live** |
| Account migration to Supabase Auth | Idempotency, UUID preservation and no email-only linking tested against the mock | **Mocked, not live** |
| Storage (private buckets, signed access) | JWT/Storage policy emulation and authorization helpers tested | **Emulated, not live** |
| Supabase Realtime (server publish, browser subscriber, RLS topic policy) | Policy emulation; browser subscriber tested against a fake client (topic validation, malformed payloads, backoff, token renewal, cleanup) | **Emulated / fake client, not live** |
| Live setup sync across devices | Server-sent events and revision polling tested end to end locally; polling fallback is always on | Local only |
| Credentials (Vault references, rotation, revocation) | Test-memory adapter only. The Supabase Vault functions are not exercised | **Not verified against Vault** |
| Hermes adapter | Pinned to the upstream source contract and tested against a local mock gateway | **Mock, not a live gateway** |
| GoHighLevel adapter | Mocked HTTP: location-identity mismatch, protected locations, permission probes, metadata sync, mapping validation, read-only (GET only) | **Mock, not live** |
| n8n adapter | Mocked HTTP: failure handling, approved-ID enforcement, payload filtering, read-only | **Mock, not live** |
| Custom projects: catalog, requests, quotes, milestones, handover (migration 0015) | Services and RLS tested on local PostgreSQL: tenant isolation, agency-only columns, quote hash integrity, append-only approvals, status transitions, tenant-scoped files. Migration also applied to the linked Supabase project. | Local tests; schema applied to Supabase, flows not exercised live |
| Optional managed maintenance | Eligibility, opt-in, allowance, defect lane and tenant isolation tested locally | Local only |
| Founder portfolio import and image handling | Eleven projects imported (hidden, pending review) into the Supabase project; review gate, WebP optimization and publish rules tested locally; source fetch stubbed | Import run for real, images not yet imported or published |
| Assistant: catalog pricing and own-project status | Tested against the local database; no live LLM call | Local only |
| Public feeds `/api/public/services` and `/portfolio` | Called on the local dev server (no sign-in); not deployed | Local only |
| Google Calendar, email sending, domains | No connector exists. Setup steps are actionable and show as unverified | **Not built** |
| Marketplace appointment webhooks / n8n Appointment Event Processor | Not connected. The processor is untouched and inactive | **Not built** |

## Brief Part 16 checklist

| # | Requirement | Evidence | Live? |
| --- | --- | --- | --- |
| 1 | Existing tests remain passing | 247/247 (220 at the start of this session) | n/a |
| 2–4 | Typecheck, lint, build | pass, no warnings | n/a |
| 5 | Supabase login works | `tests/supabase-auth.test.ts` (mock) | **No** |
| 6 | Password reset works | `tests/supabase-auth.test.ts` (mock) | **No** |
| 7 | Client invitation flow works | `tests/supabase-auth.test.ts` (mock), `tests/auth.test.ts` (local mode) | **No** |
| 8 | Database persistence works | Local PostgreSQL only; no hosted persistence or restart check | **No** |
| 9 | RLS blocks cross-tenant access | `tests/tenant-isolation.test.ts` (every tenant table), `tests/supabase-security.test.ts` | Emulated |
| 10 | Client onboarding persists | `tests/modules.test.ts`, `tests/provisioning.test.ts` | Local |
| 11 | Admin can update setup progress | `tests/setup-center.test.ts` | Local |
| 12 | Client receives updated progress | `tests/setup-center.test.ts` (stream/poll), `tests/setup-realtime.test.ts` (fake client) | Local / fake |
| 13 | Task histories remain accurate | `tests/setup-center.test.ts` (append-only events, who/what/when) | Local |
| 14 | Blocked integration prevents activation | `tests/setup-center.test.ts`, `tests/provisioning.test.ts` | Local |
| 15 | Unconfigured connectors show honest statuses | `tests/setup-center.test.ts`, `tests/setup-experience.test.ts`, `tests/integrations-security.test.ts` | Local |
| 16 | Credential APIs reject unauthorized access | `tests/integrations-api.test.ts` (route handler: unauthenticated, non-agency, foreign Origin, oversized/forged bodies), `tests/integrations-security.test.ts` | Local |
| 17 | Secrets absent from browser responses and logs | `tests/integrations-api.test.ts`, and `tests/integrations-security.test.ts` which captures console output and scans audit, check, connection, credential and status tables after saves, failed tests, reflected keys and disconnects (mutation-checked) | Local; hosted logs not checked |
| 18 | Hermes adapter mock tests pass | `tests/hermes-contract.test.ts`, `tests/integrations-security.test.ts` | Mock |
| 19 | GHL location mismatch rejected | `tests/integrations-security.test.ts` | Mock |
| 20 | n8n fails safely when unavailable | `tests/integrations-security.test.ts` | Mock |
| 21 | Mobile UI has no overflow | Real browser at 375 px: all 18 wizard steps (Hermes, GoHighLevel, n8n), client Setup Center, agency Setup Manager, global and client integrations pages: no horizontal overflow | Real browser, **sample data** |
| 22 | Accessibility checks pass | axe-core 4.14.0 in a real browser, fresh page loads in light and in dark theme: 0 violations on all 18 wizard steps and on the global and client integrations pages. The two Setup screens report only the dev-preview banner lacking a landmark (not part of the product). Contrast was fixed first (see below) | Real browser, **sample data** |

### Browser checks: scope and limits

- They ran against the development-only pages `/dev/setup-preview` and `/dev/integrations-preview`, which
  render **clearly labelled sample data** and simulate no connection. Authenticated pages were not driven
  in a browser in this pass, so real data loading, sign-in and the live wizard test calls were not
  exercised visually.
- axe-core could not automatically evaluate roughly 6–9 text nodes per Setup screen because they sit on
  gradient backgrounds (brand buttons and the page backdrop). Those were not measured manually.
- Keyboard use was not tested by hand. The wizard moves focus to each step heading and the dialog is a
  Radix focus-trapping dialog; no keyboard-only walkthrough has been recorded.
- The shared `--faint` text colour failed WCAG AA (2.6:1 light, 3.3:1 dark) in 113 places. It was changed to
  `#667085` (light) and `#7d869a` (dark), which reach at least 4.5:1 on the main surfaces. This subtly
  changes secondary text across the app. The dev-preview banner also lacks a landmark; that is not part of
  the product.
- The in-app browser pane often captured a stale frame mid-animation and never finishes CSS transitions.
  Layout claims above come from DOM measurements and axe, not from screenshots alone. Dark theme was tested
  by persisting `iaq-theme=dark` and loading each page fresh; toggling the theme on a live page produced
  false contrast failures (buttons still mid-transition), so those runs were discarded and redone.

## Live acceptance checklist (after you authorize a development Supabase project)

Do these in order, on the **development** project only, with dedicated test identities.

1. Apply `supabase/migrations` and confirm the table inventory in `supabase-setup.md`.
2. Enable Vault; confirm `credentialStoreReady`; save a **throwaway** credential and confirm only a
   reference and fingerprint reach portal tables, then revoke it.
3. Sign in, sign out, expired invitation, verification email, forgot password, one-time reset link,
   disabled account. Confirm emails actually arrive from a verified sender.
4. With two real client users in different organizations, prove through the Supabase Data API and Storage
   that neither can read the other's rows or files, and that anonymous access gets nothing.
5. Upload and download a private file with signed access that expires within 120 seconds.
6. Open the same client's Setup Center on two devices, change a task as an agency admin, and confirm both
   update (Realtime first; then block WebSockets to confirm the polling fallback).
7. Restart the server and confirm all data persisted.
8. Run the account migration with `--dry-run`, review the counts, then apply on a copy.
9. Only after each of the above passes: connect Hermes (dedicated test profile, never an `iacquire-*`
   profile), run the wizard test; connect a GoHighLevel test location (not the agency or Aster Homes
   locations) with read-only scopes; connect n8n and read the inventory.

Do not activate workflows, publish GHL drafts, enable the Appointment Event Processor, or send any
customer message as part of acceptance. Those need your separate authorization.
