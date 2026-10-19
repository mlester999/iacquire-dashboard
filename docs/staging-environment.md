# Staging environment

## What exists today

- **Production:** Supabase project `lkkiavjwxaeoqgsbjyso` (Tokyo), 61 migrations applied, schema matches the repository.
- **Local isolated:** embedded PGlite via `.env.development` / `scripts/crm-qa-env.mjs`, fictional data, real migrations, RLS and
  services. This is what the browser and service tests use.
- **Staging:** **none.** There is one Supabase organization (`mlester080601@gmail.com's Org`, `juxhdecqdbjyqyvjlbgm`) and one project.

Docker is not installed on this workstation, so a local Supabase stack (`supabase start`) is not available. The embedded database is the
local substitute and is already used by the CRM QA harness.

## Recommended: a separate Supabase staging project

Create it with the same region as production (`ap-northeast-1`) so migrations, pooler behaviour and latency are comparable.

The CLI is authenticated and can create projects, but project creation can consume organization quota and may require billing. **Do not
run this without approval.**

```bash
# Example only — pick a strong database password and keep it in a secret store.
supabase projects create iacquire-staging \
  --org-id juxhdecqdbjyqyvjlbgm \
  --region ap-northeast-1 \
  --db-password '<staging-db-password>' \
  --size nano
```

Then link it locally (in a separate directory or with `--workdir`), or simply read the connection string from the dashboard:

1. **Migrations:** `supabase db push` from the repository, or:

   ```bash
   DATABASE_URL='postgresql://postgres.<staging-ref>:<password>@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres' \
   DATABASE_SSL_CA_FILE=certs/prod-ca-2021.crt \
   ALLOW_REMOTE_DB_IN_DEV=true \
   npm run db:migrate
   ```

   The runner refuses to apply migrations when native CRM data exists (see `crm-migrations` tests), so use a fresh project.

2. **Environment:** copy [`.env.staging.example`](../.env.staging.example) to `.env.staging.local` (git-ignored) and fill in the staging
   Supabase URL, publishable key, secret key, session pooler `DATABASE_URL`, `AUTH_PROVIDER=supabase`, `DATABASE_DRIVER=postgres`,
   `ALLOW_REMOTE_DB_IN_DEV=true`, `EMAIL_PROVIDER=capture`, every provider write switch `false`, and `SCHEDULER_ENABLED=false` initially.

3. **Test identities:** create them only in staging. Invite a client owner/manager/staff, an agency admin/staff, and a second client
   tenant. Do not create production organizations, users or records for testing.

4. **Run the acceptance matrix:**

   ```bash
   npm run test                 # local service/RLS suite
   npm run typecheck
   npm run lint
   npm run build
   # then with the staging env loaded: browser scenarios 1-10 from the acceptance plan
   ```

5. **Scheduler:** exercise `POST /api/internal/tick` in staging only. Start with `SCHEDULER_ENABLED=true`, a staging-only
   `CRON_SECRET`, `EMAIL_PROVIDER=capture`, and all provider writes off. Confirm `worker_job_runs`, reminders, workflow runs and
   outbox rows. Do not point staging at real provider credentials.

## Deploying a staging build

The repository has no staging Vercel project. If one is wanted, create a separate Vercel project (or a preview environment) with the
staging Supabase variables and a distinct `APP_URL`. A preview deployment of the current branch is also acceptable for read-only UI
checks, but it shares the preview's environment, not production data.

## What is blocked

| Item | Why | Action needed |
| --- | --- | --- |
| Supabase staging project | Organization quota / possible billing; not created | Approve creation or provide an existing staging project |
| Docker-based local Supabase | Docker is not installed | Install Docker, or keep using embedded PGlite |
| Staging deployment | No staging Vercel project | Approve a separate Vercel project or use preview deployments |
| Live provider testing | No test GHL/Resend/Twilio/Meta credentials | Provide a dedicated test location/account when in scope |

Until then, every write test is **local isolated** (PGlite, fictional data), and production remains read-only inspected.
