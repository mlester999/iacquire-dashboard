# Build progress and continuation checklist

Durable record for the "ultimate all-in-one platform" build (brief dated 2026-10-14). Read this first when
resuming in a new session. Truth about *what is real versus mocked* lives in
[verification-status.md](verification-status.md); this file tracks *what was built, in which wave, and what is next*.

Completion labels used here (never "Done" for an unverified integration):
`Implemented locally` · `Tested with mocks` · `Tested against staging` · `Connected to live development provider` ·
`Verified end-to-end` · `Blocked awaiting credentials` · `Blocked awaiting approval` ·
`Production-ready but not activated` · `Activated in production`.

## Wave 0 — baseline (2026-10-14)

| Check | Result |
| --- | --- |
| Repository | Not a git repository. Filesystem backup: `../iAcquire-backups/iacquire-wave0-baseline-20261014-174523.tar.gz` (excludes `node_modules`, `.next`) |
| `npm run typecheck` | passes |
| `npm run lint` | passes, 0 warnings |
| `npm test` | **373 tests in 27 files pass** (docs and the brief quoted 247 and 310; both were stale) |
| Routes | 69 pages, 27 route handlers, 15 migrations (0001–0015) |
| Supabase | `.env` is configured for hosted Supabase (`AUTH_PROVIDER=supabase`, `DATABASE_DRIVER=postgres`, Vault). Nothing in the test suite touches it. |
| Providers | Hermes / GHL / n8n adapters exist and are **mock-tested only**. `GHL_WRITES_ENABLED=false`, `EMAIL_PROVIDER=capture`. |

Existing before this build (do not rebuild): Supabase Auth + RLS + Vault references; six-employee workforce with
versioned configs, plain-English change proposals and rollback; Hermes-backed private chat; approvals; client
Setup Center + agency provisioning/activation; Integrations Manager (Hermes/GHL/n8n wizards); one-question-per-card
onboarding with debounced autosave; notifications; support tickets; custom projects/add-ons/maintenance/portfolio;
admin portal; UI redesign in progress (see [ui-redesign-audit.md](ui-redesign-audit.md)).

## Completion matrix (brief section → status)

Legend: ✅ exists and tested locally · 🟡 partial · ⬜ not started · 🔒 blocked on external access.

| Brief § | Capability | Status | Notes |
| --- | --- | --- | --- |
| 3 | Multi-tenant isolation (RLS + server checks + tests) | ✅ | `tests/tenant-isolation.test.ts`; extended per new table |
| 4 | Interactive onboarding, one question per card | 🟡 | Exists; server stores phase only (exact question was a localStorage hint), not adaptive, sections A–F incomplete |
| 5 | Setup Center + provisioning engine | ✅ | Manual GHL mapping, activation review exist; snapshot-install verification not built |
| 6 | Six isolated client employees | ✅ | One-profile-per-tenant guards, internal profiles refused |
| 7 | Employee modes (Autonomous / Approval required / Paused) | ⬜→wave 2 | |
| 7 | Emergency stops, enforced in backend | ⬜→wave 2 | |
| 7 | Plain-English customization + preview + rollback | ✅ | `interpretChangeRequest`; extend for follow-up / hours fields |
| 8 | Client↔employee chat | ✅ | Hermes SSE; no fake streaming |
| 9 | Unified Inbox (SMS / WhatsApp / email) | ⬜→wave 4 | |
| 10 | Autopilot: consent, follow-up presets, stop conditions, channel rules | ⬜→wave 4 | |
| 11 | Owner-first human takeover, atomic claim, resume | ⬜→wave 4 | |
| 12 | Client staff roles (owner/manager/sales/support/viewer) | 🟡 | Only owner/admin/member exist |
| 13 | CRM / lead pipeline views | 🟡 | Read views exist; GHL writes disabled |
| 14 | Appointments / n8n Appointment Event Processor | 🔒 | Processor must stay inactive; ledger not built here |
| 15 | Retention automation | 🟡 | Views exist; no outreach engine |
| 16 | Website Studio (50 variations) | ⬜→wave 5 | |
| 17 | PayMongo, credit ledger, metered usage, markup | ⬜→wave 6 | PayMongo credentials not in `.env` |
| 18 | Optional $299 maintenance | ✅ | Built in the custom-projects work |
| 19 | Fair use / inactivity / offboarding / export | ⬜→wave 6 | |
| 22 | Premium UI/UX redesign | 🟡 | In progress; QA pending |
| 23 | Notifications (in-app + email) | 🟡 | Exists; new event kinds needed |
| 24 | Health monitoring + incidents | 🟡 | `/admin/health`; no incident records |
| 31 | Documentation | 🟡 | Updated per wave |

## Hard constraints carried through every wave

- No commit, push or deploy without approval. No production activation. No real customer messages. No real charges.
- Never touch GHL location `u69CVh0ZlAofUmRoj1zF` (Aster Homes). `SQvVnld5MBHdMQ1qnSfw` is the agency, not a tenant.
- Never activate the n8n Appointment Event Processor or GHL draft workflows.
- Migrations are written and tested on local PostgreSQL. **Applying a migration to the hosted Supabase project is a
  separate approved step** (`npm run db:migrate`), listed under "Needs your approval" below.
- Secrets stay server-side; never print values from `.env`.

## Wave log

(Appended as each wave lands. Each entry: before / missing / built / DB / integrations / tested / blocked / next.)

## Needs your approval or credentials

- Apply new migrations (0016+) to the hosted Supabase project.
- PayMongo test-mode secret key + webhook secret (billing cannot be verified live without them).
- GHL location token for a *test* location, with messaging scopes, before any write path is enabled.
- Email sender domain (Resend) for escalation / invitation email.
- Legal/tax review of prepaid service credits, fair-use thresholds, and licensing terms.

## Continuation checklist

Updated at the end of each work block; the first unchecked item is where to resume.

- [ ] Wave 2a: employee operating modes + emergency stops (migration 0016)
