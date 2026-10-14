# Build progress and continuation checklist

Durable record for the "ultimate all-in-one platform" build (brief dated 2026-10-14). Read this first when
resuming in a new session. Truth about *what is real versus mocked* lives in
[verification-status.md](verification-status.md); this file tracks *what was built, in which wave, and what is next*.

Completion labels used here (never "Done" for an unverified integration):
`Implemented locally` · `Tested with mocks` · `Tested against staging` · `Connected to live development provider` ·
`Verified end-to-end` · `Blocked awaiting credentials` · `Blocked awaiting approval` ·
`Production-ready but not activated` · `Activated in production`.
Everything below is at most **Tested with mocks / local PostgreSQL**. Nothing has been run against a live Supabase project,
Hermes gateway, GoHighLevel location, n8n instance, PayMongo account or email provider.

## Checkpoints and baseline

| Item | Value |
| --- | --- |
| Git | Initialised locally on 2026-10-14 (`main`, no remote, nothing pushed). `.env`, `.data`, build output are ignored. First commit `6ebe000` is the pre-continuation checkpoint |
| Filesystem backups | `../iAcquire-backups/` — `…wave0-baseline-…`, `…wave0b-messaging-complete-20261014-1930.tar.gz` (excludes `node_modules`, `.next*`) |
| Baseline at the checkpoint | typecheck, lint, build clean; **536 tests / 34 files**; 96 routes; migrations 0001–0019 |
| Current | typecheck, lint clean; **594 tests / 37 files**; migrations 0001–0020 |

The brief and earlier docs quoted 247 / 310 / 373 tests and 77 routes; those were historical. Use the numbers above.

## Completion matrix (brief section → status)

Legend: ✅ implemented and tested locally · 🟡 partial · ⬜ not started · 🔒 blocked on external access.

| Brief § | Capability | Status | Notes |
| --- | --- | --- | --- |
| 3 | Multi-tenant isolation (RLS + server checks + tests) | ✅ | `tests/tenant-isolation.test.ts` plus the schema-wide `tests/tenant-isolation-generic.test.ts`, which checks every table with an `org_id` automatically |
| 4 | Interactive onboarding, one question per card | ✅ | **Questionnaire v2** (this session): sections A–F, adaptive, per-answer server persistence, exact-question resume, honest autosave, AI assistant, review/approval. See [onboarding.md](onboarding.md) |
| 5 | Setup Center + provisioning engine | ✅ | Manual GHL mapping, activation review exist; master-snapshot *install* verification not built |
| 6 | Six isolated client employees | ✅ | One-profile-per-tenant guards, internal profiles refused |
| 7 | Employee modes (Autonomous / Approval required / Paused) + emergency stops | ✅ | Migration 0016, `src/server/automation/{controls,gate}.ts`; enforced at execution time. New employees start in Approval required |
| 7 | Plain-English customization + preview + rollback | ✅ | `interpretChangeRequest`; extend for follow-up / hours fields |
| 8 | Client↔employee chat | 🟡 | Hermes SSE, stop, persistence. Titles/search/attachments to audit |
| 9 | Unified Inbox (SMS / WhatsApp / email) | ✅ | Migration 0019, `src/server/messaging/*`, `/inbox`. Provider sending is behind `GHL_WRITES_ENABLED=false` |
| 10 | Autopilot: consent, follow-up presets, stop conditions, channel rules | ✅ | `followups.ts`, `send.ts` gates; tested with mocks |
| 11 | Owner-first human takeover, atomic claim, resume | ✅ | `handoff.ts`; tests for timeouts, fallback, single winner |
| 12 | Client staff roles | ✅ | Migration 0017: owner, manager (`admin`), sales rep, support, viewer |
| 13 | CRM / lead pipeline views | 🟡 | Read views exist; GHL writes disabled |
| 14 | Appointments / n8n Appointment Event Processor | 🔒 | Processor must stay inactive; portal-side ledger not built yet |
| 15 | Retention automation | 🟡 | Views exist; no outreach engine |
| 16 | Website Studio (50 variations) | ⬜ | Next up. Asset pipeline (`org_assets`, brand-assets bucket) is already in place |
| 17 | PayMongo, credit ledger, metered usage, 30% markup | ✅ | Migration 0018, `src/server/billing/*`, webhook with signature + replay + livemode checks. PayMongo credentials absent from `.env`; live checkout is gated by a review flag |
| 18 | Optional $299 maintenance | ✅ | Built in the custom-projects work |
| 19 | Fair use / inactivity / offboarding / export | ⬜ | |
| 22 | Premium UI/UX redesign | 🟡 | In progress; onboarding verified in browser at mobile and desktop, axe-clean light and dark |
| 23 | Notifications (in-app + email) | 🟡 | Kinds for billing, messaging, websites, incidents added in 0018; delivery wiring for website/incident kinds pending |
| 24 | Health monitoring + incidents | 🟡 | `/admin/health`; no incident records |
| 31 | Documentation | 🟡 | `onboarding.md` new; `architecture.md` data-model table still stops at 0013 |

## Hard constraints carried through every wave

- No push or deploy without approval. A **local** git checkpoint was explicitly requested in the brief; nothing is pushed.
- No production activation. No real customer messages. No real charges.
- Never touch GHL location `u69CVh0ZlAofUmRoj1zF` (Aster Homes). `SQvVnld5MBHdMQ1qnSfw` is the agency, not a tenant.
- Never activate the n8n Appointment Event Processor or GHL draft workflows.
- Migrations are written and tested on local PostgreSQL. **Applying a migration to the hosted Supabase project is a
  separate approved step** (`npm run db:migrate`), listed under "Needs your approval" below.
- Secrets stay server-side; never print values from `.env`.

## Wave log

Each entry: before / built / database / tested / blocked.

### Waves 2a–6a, built in earlier sessions of this brief (recorded from code and tests; not re-audited line by line)

- **Operating controls (0016):** employee modes, client/agency pauses, execution gate, UI controls.
- **Staff roles (0017):** five client roles, availability, escalation authorization and notification preferences.
- **Billing core (0018):** prepaid credits ledger (append-only, micro-dollars), reservations, metered usage with immutable rate versions (×1.30), fixed provider fees kept separate, PayMongo checkout and webhook, reconciliation function, billing UI.
- **Messaging core (0019):** contacts with exact-identifier matching and audited merges, consent history, suppressions, conversations/messages with real delivery states, follow-up plans (one active plan per contact across channels), human escalations with owner-first timeouts and atomic claim, ownership history, GHL webhook ingest, responder, send gates, inbox and settings UI.

### Wave 2b — adaptive onboarding and brand assets (this session)

- **Before:** a five-phase multi-field wizard; the server stored only the phase (the question was a browser hint); no adaptivity; sections A–F incomplete.
- **Built:** questionnaire v2 (definitions, engine, save pipeline, service, interface), AI assistant and website reader, brand asset pipeline with safe background removal, sample-data preview, schema-wide isolation guard. The earlier wizard components and their tests were replaced.
- **Database:** `0020_onboarding_v2.sql` (answers table, session fields, `org_assets`, `brand-assets` bucket, contact/brand columns, knowledge provenance hash).
- **Tested:** 33 + 11 + 15 + 6 new tests (onboarding, autosave, assets/reader, isolation guard); full suite 594 passing. Real-browser checks on the preview: resume after refresh, simulated outage blocks Next and shows "Not saved — Retry", no horizontal overflow at 375 px after a fix, axe-core 0 violations (light and dark) apart from the preview banner.
- **Not verified:** the authenticated page against hosted Supabase, the live LLM, real website fetches, the Supabase `brand-assets` bucket.

## Needs your approval or credentials

- Apply migrations 0016–0020 to the hosted Supabase project (`npm run db:migrate`, after a backup).
- PayMongo test-mode secret key + webhook secret (billing cannot be verified live without them).
- GHL location token for a *test* location, with messaging scopes, before any write path is enabled.
- Email sender domain (Resend) for escalation / invitation email.
- An LLM connection (Integrations → Model) to enable the onboarding assistant and help chat.
- Legal/tax review of prepaid service credits, fair-use thresholds, and licensing terms.

## Continuation checklist

Updated at the end of each work block; the first unchecked item is where to resume.

- [x] Wave 0: baseline, backup, local git checkpoint
- [x] Wave 2a: employee operating modes + emergency stops (0016)
- [x] Staff roles (0017), billing core (0018), messaging core (0019)
- [x] Wave 2b: adaptive onboarding v2 + brand assets (0020)
- [ ] Wave 5: Website Studio — migration 0021, shared renderer (10 families × 5 variations), Studio UI, publish/versioning, domains, forms, isolated site runtime
- [ ] Appointments and calendar availability; portal-side appointment event ledger (processor stays inactive)
- [ ] Retention workflows
- [ ] Wave 6b: agency financial reporting (reserve, gross markup vs profit), maintenance billing, fair use, inactivity review, offboarding/export
- [ ] Wave 7: provider health probes, incidents, notification delivery for new kinds, security review, final QA
- [ ] Docs: refresh `architecture.md` (tables 0014–0020), `schema-inventory.md`, `verification-status.md`, `deployment.md`
