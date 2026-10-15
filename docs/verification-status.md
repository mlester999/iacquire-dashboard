# Verification status

## Current checkpoint (2026-10-15)

| Gate | Result |
| --- | --- |
| `npm test` | **957 tests in 58 files passed** (877 in 49 before the Website Studio rebuild) |
| `npm run typecheck` | passes |
| `npm run lint` | **0 errors, 0 warnings** |
| `npm run build` | passes (Turbopack; TypeScript clean). Run with local database settings, not the hosted ones |
| Schema | 26 migrations, 154 public tables (`0026` adds five); every table with an `org_id` is checked automatically by `tests/tenant-isolation-generic.test.ts` |

Everything below is **local only**: an in-memory PostgreSQL (PGlite) running the real migrations, RLS policies, services and route handlers, with mocked Supabase Auth and mocked provider HTTP.
**Nothing has been run against a hosted Supabase project, Hermes gateway, GoHighLevel location, n8n instance, PayMongo account, email provider or domain registrar.**
Migrations `0016`–`0026` have **not** been applied to the hosted Supabase project. This work made no deployment, push or external mutation. (The repository now has a remote and `master` matches `origin/master`; those commits were made by you, not by this work.)

### Website Studio rebuild (2026-10-15, migration 0026)

Details and the honest scope are in [website-studio.md](website-studio.md); the apply plan is [website-studio-migration-0026.md](website-studio-migration-0026.md).

| Area | Evidence | Label |
| --- | --- | --- |
| Document model, operations, history, drag geometry, diff, section library, publish checks, legacy upgrade | `tests/website-editor-logic.test.ts` (23), `tests/website-templates.test.ts` | Implemented locally |
| 50 designs are distinct and honest | `tests/website-variations.test.ts` (8), `tests/website-art.test.ts` (3: scene weight budget, no script or external address, deterministic): every pair of the 50 differs on ≥4 of 6 character dimensions (three quarters differ on all six), no light-text floating header over a light section, built-in artwork only, sample content blocks publishing | Implemented locally |
| AI assistant | `tests/website-assistant.test.ts` (25): closed edit vocabulary, claim guard, built-in planner, model-reply parsing, one undoable step; `tests/website-admin.test.ts` covers its server boundary with the model **mocked** (outline only, no contact details, rate limit, permission) | Tested with mocks; **no real AI provider was called** |
| Agency Studio server modules | `tests/website-admin.test.ts` (29): template lifecycle and permissions, template changes never alter a client's site, agency scoping (staff vs super admin), comments, edit lock, archive, saved and shared sections, template-update offer, audit | Implemented locally |
| Migration 0026 and its rollback | `tests/website-migration-0026.test.ts` (3): the rollback script runs on a fully migrated local database inside a rolled-back transaction, removes and restores everything it should, and refuses when data would be lost | Implemented locally; **never run on the hosted project** |
| Renderer security | `tests/website-security.test.ts` (11): hostile text is drawn as text, unsafe links and styles are refused by the model, no scripts or third-party hosts in published output | Implemented locally |
| Responsive pictures, advanced paste | `tests/website-images.test.ts` (5), `tests/website-advanced.test.ts` (4) | Implemented locally |
| Editor, gallery, agency screens in a real browser | `/dev/studio-preview`, `/dev/gallery-preview`, `/dev/admin-studio-preview` (labelled **sample data**, in-memory API, no sign-in). Selection, inline editing, drag reorder and insert, **keyboard-only reorder, duplicate, delete, undo and redo**, device switching (columns stack on a phone), autosave state, assistant propose, apply and undo | Browser-checked on sample data |
| All 50 public designs, real renderer, isolated frames | **No horizontal overflow** on the home page at 390, 768, 1024 and 1440 px and on all six pages at 390 px (500 loads). **axe-core (WCAG 2.0/2.1/2.2 A and AA plus best practice): 0 violations** on all six pages of every design at 1440 px (300 loads) and on home, services and contact at 390 px (150 loads). Fixes made on the way: duplicate menu landmarks, strip galleries not keyboard-scrollable, one muted-text contrast, one skipped heading level, a floating header unreadable over a light page title, mid-tone palettes choosing white text | Browser-checked on sample content |
| Agency screens and editor panels, accessibility | axe on all six agency preview views and on the editor (every left tab, the assistant with a proposal, the shortcuts and save-version dialogs): 0 violations apart from the preview scaffold's own missing landmark/heading and its dev-only theme button | Browser-checked on sample data |
| Public site payload | The sites runtime route's client chunks contain none of the editor's code (marker search of the built chunks). Built-in artwork was slimmed (skyline 78 → 24 KB, city blocks 43 → 12 KB, facade 26 → 8 KB) | Measured locally |

**Not verified:** signed-in client and agency flows against a real database in a browser (the agency screens were driven only on invented sample data); hosted Supabase; real DNS, certificates, domain purchase or publishing to a real host; the AI provider (mocked); screen-reader walkthroughs by a person; touch hardware; dark theme of the new screens; text that sits on images or gradients (axe reports it as "incomplete").

### Evidence and honest labels for the all-in-one build

Labels: *Implemented locally* (works on local PostgreSQL) · *Tested with mocks* (provider calls mocked) · *Blocked awaiting credentials/approval*. None is "Verified end to end".

| Area | Evidence | Label |
| --- | --- | --- |
| Operating controls: employee modes, pauses, emergency stops (0016) | Enforced in the execution gate; `tests/automation-controls.test.ts` | Implemented locally |
| Staff roles (0017) | `tests/staff-roles.test.ts`, permission-matrix drift test | Implemented locally |
| Credits, metering, PayMongo checkout and webhook (0018) | `tests/billing*.test.ts`: signature, replay, livemode, idempotency, reconciliation. Live checkout is gated by a review flag | Tested with mocks; **blocked awaiting PayMongo test keys** |
| Unified inbox, consent, autopilot, human takeover (0019) | `tests/messaging-*.test.ts`. Sending is behind `GHL_WRITES_ENABLED=false` | Tested with mocks; **blocked awaiting a GHL test location** |
| Adaptive onboarding, brand assets (0020) | `tests/onboarding-v2.test.ts`, `assets-and-reader.test.ts`; browser-checked on the sample preview | Implemented locally; live LLM not exercised |
| Website Studio, publishing, domains, forms, site runtime (0021) | `tests/website-*.test.ts` (six files). Probe, DNS and certificate checks use injected fakes | Tested with mocks; **no real host, DNS, certificate or domain purchase** |
| Operations: heartbeats, incidents, notification email (0022) | `tests/operations.test.ts` (35). Collectors read recorded state; **no active provider probes** | Implemented locally; email blocked awaiting a sender |
| Appointments: event ledger, availability, booking, reminders, AI booking (0023) | `tests/appointments.test.ts` (67): ordering, dedupe, stale events, slot re-check, approval gates, reminder gating. The n8n processor is untouched and inactive | Tested with mocks; **GHL writes disabled** |
| Retention programs (0024) | `tests/retention.test.ts` (28): approval hash, caps, stop conditions, credit release | Tested with mocks; wording and limits **need legal review** |
| Agency finance statement, billing controls (0018/0025) | `tests/finance.test.ts` (12). Real numbers only; reserve is planning guidance | Implemented locally; **needs accountant review** |
| Fair use, inactivity review (0025) | `tests/fair-use-inactivity.test.ts` (19). No limit ships | Implemented locally; **thresholds await real cost data** |
| Offboarding, export, deletion (0025) | `tests/offboarding.test.ts` (23): ZIP integrity, tenant scope, shutdown steps, every deletion guard, atomic purge. Purge is off by default | Implemented locally; **never run against real data** |

### Browser checks for the new screens

Run against the development-only `/dev/operations-preview` (clearly labelled **sample data**), in the in-app browser. axe-core (wcag2a/2aa/21a/21aa/best-practice) reported **no violations
in the product components** in light and dark for offboarding (agency), "your data" (client) and fair use (client card and agency panel), apart from the preview page's own missing landmark and heading. There was no horizontal
overflow at 375 px for those views or the finance statement. Limits: authenticated pages were not driven against a live database; keyboard-only walkthroughs were not recorded; the pane freezes CSS transitions, so a
dark-mode run reads some buttons mid-transition unless transitions are disabled first (done for the final runs).

## Historical verification record

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
