# iAcquire Client Portal

The workspace iAcquire clients use to run their AI-powered client acquisition and retention system:
a dedicated six-person AI workforce (powered by Hermes Agent), leads, appointments, sales, retention,
analytics, approvals, a knowledge center, human support, a **Setup Center** that shows each client
the real progress of their own system, and an agency admin portal (client Setup Manager, Secure
Integrations Manager, provisioning and activation review) for iAcquire staff.

> **Status:** built and covered by automated tests against a local PostgreSQL emulation and mocked
> providers. **No live Supabase project, Hermes gateway, GoHighLevel location or n8n instance has been
> connected or verified yet**, so the portal shows honest "Not configured" / "Credentials saved"
> states instead of simulated data. See [docs/verification-status.md](docs/verification-status.md)
> for exactly what is verified and what is not, and [docs/supabase-setup.md](docs/supabase-setup.md)
> for the steps that connect it.

## Foundation

| Layer | Production |
| --- | --- |
| Accounts and sessions | Supabase Auth (email/password, invitations, verification, reset), cookie sessions via `@supabase/ssr` |
| Application data | Supabase PostgreSQL with Row Level Security (`supabase/migrations`) |
| Private files | Supabase Storage private buckets with short-lived signed access |
| Integration secrets | Managed Supabase Vault references; no plaintext secret in application tables |
| Live setup updates | Scoped Supabase Realtime revision signals, plus server-sent events and polling fallbacks |

The Hostinger appointment-event PostgreSQL and n8n's internal database are separate systems and are
never used by the portal.

## Quick start (local synthetic demo)

The default configuration needs Supabase and shows a clear configuration notice until it is connected.
For a disposable local demo, opt in explicitly in `.env.local` (development and tests only; production
refuses it):

```bash
npm install
cp .env.example .env.local          # then uncomment AUTH_PROVIDER=local and DATABASE_DRIVER=pglite,
                                    # and set APP_ENCRYPTION_KEY (32+ random characters)
npm run db:seed -- --demo --mock-hermes http://127.0.0.1:8787
npm run mock:hermes                 # optional: local Hermes test double on :8787 (labelled, not a live AI)
npm run dev                         # http://localhost:3000
```

Local mode uses an embedded PostgreSQL (PGlite) in `.data/pglite`, migrated automatically on first use.
`--demo` creates a clearly labelled demo workspace with fictional sample records plus a second, empty
tenant for isolation checks. Demo passwords are random and written to `.data/dev-credentials.local.json`
(gitignored). Captured emails (verification, reset, invitations) are viewable at `/dev/mailbox`
in development only. To connect a real development project, follow
[docs/supabase-setup.md](docs/supabase-setup.md) instead.

| Account | Role |
| --- | --- |
| `admin@iacquire.test` | Agency super admin (`/admin`) |
| `staff@iacquire.test` | Agency staff (assigned clients only) |
| `owner@demo.test` | Client owner — Demo Workspace |
| `member@demo.test` | Client member — Demo Workspace |
| `owner@northwind.test` | Client owner — a separate, empty tenant |

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js app |
| `npm test` | Vitest suite (in-memory PostgreSQL emulation, mocked providers; no network) |
| `npm run lint` / `typecheck` | ESLint / TypeScript |
| `npm run db:migrate` | Apply SQL migrations (explicit step; hosted databases are never auto-migrated) |
| `npm run db:seed [-- --demo]` | Agency organization (and optional synthetic demo data; never run on real data) |
| `npm run admin:invite -- --email you@company.com [--staff]` | One-time invitation link for the first agency admin |
| `npm run auth:migrate` | Dry-run/apply the audited legacy-account to Supabase Auth migration |
| `npm run mock:hermes` | Local Hermes API test double for visual QA |

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · Tailwind CSS 4 · Radix primitives ·
Motion · Zod · Supabase (Auth, PostgreSQL, Storage, Realtime, Vault) · Vitest. PGlite is used only
for the explicit local demo and the automated tests.

## Where things live

```
supabase/migrations/    SQL schema, RLS policies, reference data (0001-0013); never auto-applied to hosted databases
src/app/(auth)/         login, invitations, verification, password reset, get-started
src/app/(setup)/        welcome screen and the 5-step onboarding wizard
src/app/(portal)/       client workspace: overview, setup, workforce, leads, appointments, sales,
                        retention, analytics, approvals, knowledge, activity, settings, support
src/app/(chat)/         full-screen AI employee chat
src/app/(admin)/admin/  agency portal: clients (+ per-client Setup Manager, Integrations, Provisioning,
                        Activation), the global Integrations manager, workforce, support, health, usage, audit
src/app/api/            streaming chat, help assistant, uploads, exports, health, setup sync, integrations
src/server/             server-only services (auth, tenancy, workforce, chat, approvals, leads, knowledge,
                        support, help, usage, audit, setup, security) and typed integration adapters
src/components/         UI by module; ui/ holds shared primitives
tests/                  security, tenancy, workflow, setup, provisioning and integration-contract tests
```

## Documentation

- [docs/supabase-setup.md](docs/supabase-setup.md) — connect Supabase, migrate data and accounts, rollback, table inventory
- [docs/integrations-setup.md](docs/integrations-setup.md) — the admin Integrations Manager and guided wizards; the credentials checklist
- [docs/client-provisioning.md](docs/client-provisioning.md) — client onboarding to activation, provisioning jobs, what is manual
- [docs/credential-security.md](docs/credential-security.md) — how integration secrets are stored, rotated and revoked
- [docs/verification-status.md](docs/verification-status.md) — real versus mocked verification and the live acceptance checklist
- [docs/migration-plan.md](docs/migration-plan.md) — the reviewed migration and rollback plan
- [docs/architecture.md](docs/architecture.md) — tenancy and security model, data model, chat and approval pipelines
- [docs/setup-center.md](docs/setup-center.md) — Setup Center and Setup Manager rules, live sync, data model, connector status
- [docs/integrations.md](docs/integrations.md) — Hermes (verified API contract and client-profile provisioning), GoHighLevel, n8n, email, help assistant
- [docs/aqi.md](docs/aqi.md) — AQi platform assistant, its provider/knowledge boundary, conversations, RLS and Super Admin controls
- [docs/ai-workforce.md](docs/ai-workforce.md) — AI employee identities, chat, knowledge, PDF/DOCX extraction and the live-run safety gate
- [docs/hermes-live-acceptance.md](docs/hermes-live-acceptance.md) — read-only live gateway evidence, restricted-tool blockers and controlled-run acceptance
- [docs/workforce-migration-and-release.md](docs/workforce-migration-and-release.md) — workforce migration 0045/0046, hosted compatibility, backup and rollback plan
- [docs/deployment.md](docs/deployment.md) — production checklist, environment, and remaining steps
