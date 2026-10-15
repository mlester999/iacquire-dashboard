# Build progress and continuation checklist

Durable record for the "ultimate all-in-one platform" build (brief dated 2026-10-14). Read this first when
resuming in a new session. Truth about *what is real versus mocked* lives in
[verification-status.md](verification-status.md); this file tracks *what was built, in which wave, and what is next*.

Completion labels used here (never "Done" for an unverified integration):
`Implemented locally` · `Tested with mocks` · `Tested against staging` · `Connected to live development provider` ·
`Verified end-to-end` · `Blocked awaiting credentials` · `Blocked awaiting approval` ·
`Production-ready but not activated` · `Activated in production`.
Everything below is at most **Tested with mocks / local PostgreSQL**. Nothing has been run against a live Supabase project,
Hermes gateway, GoHighLevel location, n8n instance, PayMongo account, email provider or domain registrar.

## Checkpoints and baseline

| Item | Value |
| --- | --- |
| Git | Branch `master` with a remote (`origin`) that you added; it matched `origin/master` when last checked. **This work never pushed.** `.env`, `.data`, build output are ignored. Checkpoints: `6ebe000` (Wave 0 baseline), `fa76674` (adaptive onboarding v2, brand assets, isolation guard), `fb75e3c` (Website Studio, redesign passes). **Everything after `fb75e3c` (operations, appointments, retention, commercial operations, docs) is uncommitted in the working tree** until you approve a commit |
| Filesystem backups | `../iAcquire-backups/`: `…wave0-baseline-…`, `…wave0b-messaging-complete-20261014-1930.tar.gz` (excludes `node_modules`, `.next*`). No backup has been taken since the operations/commercial work |
| Baseline at the first checkpoint | typecheck, lint, build clean; 536 tests / 34 files; 96 routes; migrations 0001–0019 |
| Current (2026-10-15) | typecheck clean; lint **0 errors, 0 warnings**; build passes; **958 tests / 58 files**; **migrations 0001–0026, 154 tables** (0026 not applied to the hosted project) |

## Completion matrix (brief section → status)

Legend: ✅ implemented and tested locally · 🟡 partial · ⬜ not started · 🔒 blocked on external access.

| Brief § | Capability | Status | Notes |
| --- | --- | --- | --- |
| 3 | Multi-tenant isolation (RLS + server checks + tests) | ✅ | `tests/tenant-isolation.test.ts` plus the schema-wide `tests/tenant-isolation-generic.test.ts`, which checks every table with an `org_id` automatically (so each new table in 0021–0025 is covered) |
| 4 | Interactive onboarding, one question per card | ✅ | Questionnaire v2, adaptive, per-answer persistence, resume, AI assistant. See [onboarding.md](onboarding.md) |
| 5 | Setup Center + provisioning engine | ✅ | Manual GHL mapping and activation review exist; master-snapshot *install* verification not built |
| 6 | Six isolated client employees | ✅ | One-profile-per-tenant guards; internal agency profiles refused |
| 7 | Employee modes + emergency stops | ✅ | Migration 0016; enforced at execution time. New employees start in Approval required |
| 7 | Plain-English customization + preview + rollback | ✅ | `interpretChangeRequest`; extend for follow-up / hours fields |
| 8 | Client↔employee chat | 🟡 | Hermes SSE, stop, persistence. **Titles, search and attachments still to audit** |
| 9 | Unified Inbox (SMS / WhatsApp / email) | ✅ | Migration 0019; sending is behind `GHL_WRITES_ENABLED=false` |
| 10 | Autopilot: consent, follow-up presets, stop conditions | ✅ | `followups.ts`, `send.ts` gates; tested with mocks |
| 11 | Owner-first human takeover | ✅ | `handoff.ts`; timeouts, fallback, single winner tested |
| 12 | Client staff roles | ✅ | Migration 0017 |
| 13 | CRM / lead pipeline views | 🟡 | Read views exist; **GHL writes disabled; write-path audit not done** |
| 14 | Appointments + portal-side event ledger | ✅ 🔒 | Migration 0023: ledger, availability, booking, reminders, AI booking. n8n processor untouched and inactive. Provider booking is blocked until GHL writes are enabled for a test location. [appointments.md](appointments.md) |
| 15 | Retention automation | ✅ 🔒 | Migration 0024: five approved, capped, stoppable programs. Wording and limits need legal review. [retention.md](retention.md) |
| 16 | Website Studio (50 variations) | ✅ 🔒 | Rebuilt 2026-10-15 (migration 0026): structured document model and one renderer, 50 genuinely distinct designs, visual editor, agency Studio (overview, client websites, template library and designer, reviews, domains, media), optional AI assistant, publishing checks, versions and rollback. No real host, DNS, certificate, AI provider or signed-in browser run. [website-studio.md](website-studio.md), [apply plan](website-studio-migration-0026.md) |
| 17 | PayMongo, credit ledger, metered usage, 30% markup | ✅ 🔒 | Migration 0018 plus `/admin/billing` (new): FX, live-payments review, unit rates, credit adjustments, provider fees. No PayMongo keys. [finance-and-billing.md](finance-and-billing.md) |
| 17 | Agency financial reporting (reserve, markup vs profit) | ✅ | Migration 0025: statement keeps cash, usage, fees, costs, tax and reserve distinct; reserve is internal planning only. Needs accountant review |
| 18 | Optional $299 maintenance | 🟡 | Eligibility and opt-in built earlier. **A recurring monthly PayMongo checkout for maintenance is not built** |
| 19 | Fair use | ✅ | No limit ships; measured, "No limit set" until you choose numbers; only new storage uploads can ever be refused. [fair-use-and-inactivity.md](fair-use-and-inactivity.md) |
| 19 | Inactivity review | ✅ | 180 days, three notices, staff decision; never deletes or pauses automatically |
| 19 | Offboarding, export, deletion | ✅ 🔒 | Client export ZIP, agency shutdown/billing/plan/delete with guards. Permanent deletion is off by default. [offboarding-and-export.md](offboarding-and-export.md) |
| 22 | Premium UI/UX redesign | 🟡 | New screens axe-checked (light and dark) and checked at 375 px on sample data. Not every legacy screen re-audited; **keyboard-only walkthroughs not recorded** |
| 23 | Notifications (in-app + email) | 🟡 | Grouped preferences and email level; email waits for a sender. Delivery wired for incidents, appointments, fair use, offboarding; **some older kinds are still in-app only** |
| 24 | Health monitoring + incidents | ✅ 🟡 | Heartbeats, evidence-based incidents, client-visible notices. **No active provider probes**: only recorded state is observed. [operations-and-incidents.md](operations-and-incidents.md) |
| 31 | Documentation | ✅ | New docs for each area; architecture, schema inventory, verification status and deployment refreshed |

## Hard constraints carried through every wave

- No push or deploy without approval. Nothing is pushed.
- No production activation. No real customer messages. No real charges. No domain purchases.
- Never touch GHL location `u69CVh0ZlAofUmRoj1zF` (Aster Homes). `SQvVnld5MBHdMQ1qnSfw` is the agency, not a tenant.
- Never activate the n8n Appointment Event Processor or GHL draft workflows.
- Migrations are written and tested on local PostgreSQL. **Applying a migration to the hosted Supabase project is a
  separate approved step** (`npm run db:migrate`), listed under "Needs your approval" below.
- Secrets stay server-side; never print values from `.env`.

## Wave log

Each entry: before / built / database / tested / blocked.

### Earlier waves (recorded from code and tests)

- **Operating controls (0016), staff roles (0017), billing core (0018), messaging core (0019):** see the completion matrix.
- **Adaptive onboarding and brand assets (0020):** questionnaire v2, AI assistant, brand asset pipeline. 33 + 11 + 15 + 6 tests.
- **Website Studio (0021):** ten families × five variations, draft/version/approval/publication, domains with separate verification, routing, SSL and live checks, forms, `iaq_site_runtime` with no table privileges. Six test files.

### Wave 6a — operations and incidents (0022)

- **Before:** `/admin/health` showed provider state but nothing recorded incidents or whether background work was running.
- **Built:** single authenticated scheduler endpoint with an idempotent job registry and heartbeats; evidence-based incidents (open on evidence, close only on a later passing check); collectors by source; client-visible service notices; notification email queue and grouped preferences.
- **Tested:** `tests/operations.test.ts` (35). Found and fixed: incident events ordered randomly within one transaction (added `seq`).
- **Not verified:** any provider outage (no active probes); email delivery.

### Wave 6b — appointments (0023)

- **Before:** appointments were read-only references; the AI could not see real availability.
- **Built:** provider-timestamp-ordered event ledger with dedupe and stale detection; availability from the calendar only; held/booked/needs_manual honesty; reminders through the messaging gate; AI booking with approval or an owner switch; hold expiry; UI.
- **Tested:** `tests/appointments.test.ts` (67). Found and fixed: reminders in quiet hours were blocked instead of queued; client could not read calendar mappings under its own access (read through the trusted path).
- **Blocked:** real booking until GHL writes are enabled for a test location.

### Wave 6c — retention programs (0024)

- **Built:** five standard programs (all off), owner approval bound to exact wording, per-customer caps, daily enrollment cap, stop conditions shared with follow-ups, credit release on stop.
- **Tested:** `tests/retention.test.ts` (28). **Needs legal review** of default wording and limits.

### Wave 6d — commercial operations (0025)

- **Before:** agency billing controls had no UI; no finance statement, fair use, inactivity handling or offboarding existed.
- **Built:** `/admin/billing` (statement, entries, rates and payments, clients); fair-use measurement, thresholds, client card and agency fleet view; inactivity review; client data export ZIP; offboarding with shutdown, billing close, deletion plan and guarded atomic purge; admin and client UI; sample views in `/dev/operations-preview`.
- **Tested:** `tests/finance.test.ts` (12), `tests/fair-use-inactivity.test.ts` (19), `tests/offboarding.test.ts` (23). Found and fixed: files were removed before the database purge (now database first, files after commit, orphans reported); client fair-use view could not see platform default thresholds (computed through the trusted path); lint errors in new components (set-state-in-effect, impure render, unescaped apostrophes).
- **Browser checks:** axe (light and dark) and 375 px overflow on the sample views: no product violations. A resolved-incident contrast failure (`opacity-80`) and a 375 px overflow were fixed.
- **Not verified:** deletion against real data or a restored backup; PayMongo refunds; accountant treatment of credits and reserve.

## Needs your approval or credentials

- **Apply migrations 0016–0025** to the hosted Supabase project (`npm run db:migrate`, after a backup; development project first).
- **Commit** the uncommitted work after `fb75e3c` (local only; no push).
- PayMongo **test** secret key and webhook secret.
- GHL **test** location token with messaging and calendar scopes (never `u69CVh0ZlAofUmRoj1zF` or `SQvVnld5MBHdMQ1qnSfw`) before any write path is enabled.
- Email sender (Resend) for escalation, notification and invitation email.
- An LLM connection (Integrations → Model) for the onboarding assistant and help chat.
- Wildcard DNS and certificate, a CNAME target and a separate sites deployment for Website Studio.
- **Decisions:** fair-use thresholds (from real provider costs); retention period (default 90 days, minimum 30); inactivity window (180 days); the reserve guidance ($200 per setup payment is shown as internal planning only); whether to remove or replace the older `usage_limits` defaults (1,500 messages, hard stop) that predate this work and were not derived from measured costs.
- **Legal and tax review:** prepaid credits, marketing consent and opt-out wording for retention programs, data-export licensing text, retention period.
- `OFFBOARDING_PURGE_ENABLED` stays off until a backup restore has been proven.

## Continuation checklist

Updated at the end of each work block; the first unchecked item is where to resume.

- [x] Wave 0: baseline, backup, local git checkpoint
- [x] Operating modes + emergency stops (0016); staff roles (0017); billing core (0018); messaging core (0019)
- [x] Adaptive onboarding v2 + brand assets (0020)
- [x] Website Studio (0021)
- [x] Operations, incidents, scheduler heartbeats (0022)
- [x] Appointments and event ledger (0023)
- [x] Retention programs (0024)
- [x] Agency finance, fair use, inactivity, offboarding/export (0025), including admin and client UI
- [x] Docs: new area docs; architecture, schema inventory, verification status, deployment refreshed
- [ ] Take a filesystem backup (tarball) and, once approved, a local git checkpoint of the work since `fb75e3c`
- [ ] Optional monthly maintenance checkout (kind `maintenance`, agency-created per period, idempotent)
- [ ] Active provider health probes (read-only, rate-limited, gated behind configured credentials)
- [ ] Security review of the new routes and actions (`/security-review`): `/api/data-export`, `/api/internal/tick`, offboarding and finance actions, site runtime
- [ ] Chat titles, search and attachments audit; CRM write-path design and audit (writes stay disabled)
- [ ] Notification delivery for the remaining older kinds
- [ ] Final QA of authenticated pages against a development Supabase project at 375 / 390 / 768 / 1024 / 1440, light and dark, plus keyboard-only and reduced-motion walkthroughs
- [ ] Release readiness: live acceptance checklist in [verification-status.md](verification-status.md), then the production steps in [deployment.md](deployment.md)
