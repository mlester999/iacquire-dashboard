# Staging environment

Status: **not provisioned.** Creating a project consumes organization quota and may cost money, so it requires explicit approval. Nothing in this document has been run against a hosted staging resource.

## What exists today

- **Production:** Supabase project `lkkiavjwxaeoqgsbjyso` (Northeast Asia / Tokyo), in organization `juxhdecqdbjyqyvjlbgm`. The hosted ledger records migrations through `0063_aqi_phase3_hardening` (259 public tables, no pending migrations). Further schema changes still require approval; this document does not authorize them.
- **Local isolated:** embedded PGlite via `.env.development` / `scripts/crm-qa-env.mjs`, fictional data, the real migrations, RLS and services. This is what the CRM and AQi browser suites use.
- **Staging:** **none.** The organization has one project.

Docker is not installed on this workstation, so `supabase start` is unavailable. Embedded PGlite remains the local substitute.

## Exact resource to create (after approval)

| Setting | Value |
| --- | --- |
| Project name | `iacquire-staging` |
| Organization | `juxhdecqdbjyqyvjlbgm` (`mlester080601@gmail.com's Org`) |
| Region | `ap-northeast-1` (same as production, so migrations, pooler behaviour and latency are comparable) |
| Compute size | `nano` (the smallest; enough for acceptance, not load testing) |
| High availability | off |
| Custom domain | none |
| PITR / branching | none |
| Separate Vercel project | optional; local `next dev` against staging is enough for database acceptance |

The CLI is authenticated and can create it:

```bash
# Do not run until the cost and quota section below is approved.
supabase projects create iacquire-staging \
  --org-id juxhdecqdbjyqyvjlbgm \
  --region ap-northeast-1 \
  --db-password '<32+ random characters, stored in a secret manager>' \
  --size nano
```

On the **Free** plan, omit `--size` if the CLI refuses a paid compute size; the project uses the shared free instance. On Pro, `nano`/`micro` is the $10 compute instance. Either way, confirm the chosen size on the project's billing page before running migrations.

After creation, capture the project reference (the subdomain label in `https://<ref>.supabase.co`). Do not reuse the production reference.

## Cost and quota implications

Supabase bills per organization, and each project has its own compute instance. The exact marginal cost depends on the organization's current plan, which the CLI does not expose — confirm it at `https://supabase.com/dashboard/org/juxhdecqdbjyqyvjlbgm/billing` before creating anything.

| Plan | Monthly cost of a second Nano/Micro project | Quota and operational limits that matter for staging |
| --- | --- | --- |
| **Free** | **$0** — the plan includes **2 active projects** | 500 MB database per project, shared CPU / 500 MB RAM, 5 GB egress, 1 GB file storage, 50,000 MAU, no automatic backups, 1-day logs, and the project **pauses after 1 week of inactivity**. If the organization is on Free and already has one active project, staging fits the quota but uses the second and final slot. |
| **Pro** | **+$10/month** — $25 plan + two Micro projects ($10 each) − $10 compute credit = **$35/month** total; one project alone is $25. | 8 GB disk per project, daily backups kept 7 days, 250 GB egress, 100 GB file storage, 100,000 MAU, no inactivity pause. Spend caps are on by default. |
| **Team** | Same per-project compute as Pro; plan starts at $599/month. | 14-day backups, 28-day logs, SOC 2 / ISO 27001 features. Not needed for acceptance. |

Sources: [Supabase pricing](https://supabase.com/pricing) and [billing FAQ](https://supabase.com/docs/guides/platform/billing-faq).

**Recommendation:** use **Free** for a short, supervised acceptance window if the organization has a free slot and the database fits under 500 MB; otherwise use **Pro + Nano/Micro** (about **$10/month marginal**) so the project stays warm and has daily backups. Either choice needs approval. Check the production database size first: 259 tables plus attachments can approach 500 MB, and a paused staging project mid-acceptance would invalidate the run.

Creating the project is the only paid/quota-consuming step. Applying migrations, creating test identities and running the browser suite do not add a separate Supabase charge.

## Credentials and configuration

Copy [`.env.staging.example`](../.env.staging.example) to `.env.staging.local` (git-ignored). Fill in:

| Credential | Where it comes from | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Staging dashboard → Connect → **Session pooler** | Use the staging project reference and the password chosen at creation. Never the production string. |
| `DATABASE_SSL_CA_FILE` | `certs/prod-ca-2021.crt` (already in the repository) | Supabase's public CA for the pooler. |
| `NEXT_PUBLIC_SUPABASE_URL` | Staging dashboard → API | `https://<staging-ref>.supabase.co`. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Staging dashboard → API keys | Publishable client key. |
| `SUPABASE_SECRET_KEY` | Staging dashboard → API keys | Server-only. Never commit or expose to the browser. |
| `APP_ENCRYPTION_KEY` | Generate locally | At least 32 random characters; staging-only. |
| `SITES_FORM_SECRET` | Generate locally | At least 24 characters; staging-only. |
| `CRON_SECRET` | Generate locally | Staging-only; only used with `SCHEDULER_ENABLED=true` during the supervised scheduler test. |
| `SECRET_STORE=vault` | Staging dashboard → Vault | Confirm Vault is enabled before saving integration credentials. |
| Optional provider test accounts | Resend / Twilio / Meta WhatsApp / Google / Microsoft / n8n / DeepSeek test projects | Only for the scenarios the approver opens. All write switches stay `false`; email stays `capture` unless a test sender is explicitly approved. |

Test identities must exist **only in staging**: a client owner, client manager, client staff user, an agency administrator, an agency staff member, and a second client tenant for isolation tests. Do not create production organizations, users or records for testing.

## Approvals needed

Do not proceed until each item is explicitly approved:

1. **Create the staging Supabase project** in `juxhdecqdbjyqyvjlbgm`, region `ap-northeast-1`, size `nano`. State whether the organization is on Free or Pro and the accepted monthly figure ($0 or about +$10).
2. **Confirm billing and spend cap** on the organization; state who owns the project.
3. **Apply migrations `0001`–`0063`** to the staging project only (the repository's migration runner, not production).
4. **Create the staging test identities** listed above.
5. **Run the acceptance browser matrix** against staging with all provider writes off and `EMAIL_PROVIDER=capture`.
6. **Optional scheduler test:** set a staging-only `CRON_SECRET` and `SCHEDULER_ENABLED=true`, call `POST /api/internal/tick` once, observe, then disable it again. No production scheduler.
7. **Optional hosted deployment:** create a separate Vercel staging project or preview with the staging environment. Not required for database acceptance; the app can run locally against staging Supabase.
8. **Optional live-provider checks:** approve one test account at a time. The default is no outbound writes.

Still explicitly **not approved** by this document: the production scheduler, any outbound provider write, a live GoHighLevel migration, production data changes, or any further production migration.

## Acceptance matrix

Run in this order; stop at the first failure and record it. These are the release gates for staging.

| # | Check | Pass condition |
| --- | --- | --- |
| 1 | Launcher safety | `scripts/crm-qa.mjs`/browser QA refuses a non-loopback origin; staging tests use an explicit `APP_URL` and are not the CRM QA harness. |
| 2 | Health | `GET /api/health` returns `database: ok`, the expected migration count, and `scheduler: never_ran` (or `fresh` only after the approved scheduler test). |
| 3 | Schema | Every repository migration is recorded; `pendingMigrations` is empty; the expected public-table count (259 after `0063`, up from 258) and RLS enabled on every tenant table; no browser grants on management-only AQi/CRM tables. |
| 4 | Auth | Sign-in, sign-out, invitation, verification, reset and disabled-account paths work with real staging identities. |
| 5 | Tenant isolation | Two client tenants cannot read each other's contacts, deals, files, conversations or CRM reports through the app or the Data API; anonymous requests get nothing. |
| 6 | Native-first onboarding | A fresh client owner sees iAcquire CRM as the default provider, the CRM setup guide (`/crm/setup`), a Blueprint/organisation setup path, and no required GoHighLevel step. |
| 7 | Native CRM | Contact create/edit/merge, company, tag, custom field, Smart List, pipeline/stage move, task, note, import/export, calendar/booking and form submission all persist and re-read correctly. |
| 8 | Cross-surface compatibility | AQi opens and cites staged knowledge; Hermes chat reaches a test profile; Website Studio edits and publishes to a test host/preview without production DNS; a Website Studio form creates a native contact/deal; AQi guidance targets resolve on the staged routes. |
| 9 | GoHighLevel configuration preserved | A staging tenant with a saved (fake) GoHighLevel mapping still shows its provider state, and provider switching previews without contacting a real location; no cutover is confirmed. |
| 10 | Scheduler | With `SCHEDULER_ENABLED=false`, `/api/internal/tick` returns 503. With the staging secret and switch on, one tick runs, a second is skipped by the lease, and `worker_job_runs` records both. |
| 11 | Provider writes | Every provider write switch remains `false`; email outbox rows, if any, are `capture`, not sent. |
| 12 | Browser UI | Desktop 1440 px, tablet 768/1024 px and phone 390 px: no horizontal overflow, 0 axe serious/critical, 0 console/page errors, 0 failed requests, 0 5xx. |

## Local fallback

Until staging is approved, local PGlite remains the only acceptance environment. The limitations stay as recorded in [crm-local-qa.md](crm-local-qa.md), [verification-status.md](verification-status.md) and [aqi-phase3.md](aqi-phase3.md): no hosted identity, no hosted RLS, no real provider, no deployment.
