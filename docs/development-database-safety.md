# Development database safety

## Why this exists

The local `.env` used to point `npm run dev` at the hosted Supabase project (`DATABASE_DRIVER=postgres`, the production
`DATABASE_URL`). That made ordinary local work — clicking through the CRM, running a maintenance script, or seeding demo data — capable
of writing to production. Testing must never be able to change real client records by accident.

## What `npm run dev` does now

Next.js loads `.env.development` in development, after `.env` and before `.env.local`. That file sets:

```dotenv
AUTH_PROVIDER=local
DATABASE_DRIVER=pglite
PGLITE_DATA_DIR=.data/pglite-development
```

So `npm run dev` uses the embedded PostgreSQL database and local sign-in. It does not connect to Supabase. Outbound work is off or
captured (`EMAIL_PROVIDER=capture`, every provider write switch `false`, calendar sync disabled), and the Supabase/Resend/LLM keys are
blank so an accidental provider call cannot leave the machine. Override them in `.env.local` only for an approved staging target.

The first run creates and migrates `.data/pglite-development` automatically. To add the labelled demo workspaces and users:

```bash
npm run db:seed:local -- --demo --crm
```

Credentials are written to `.data/dev-credentials.local.json` (git-ignored).

To migrate or seed it explicitly:

```bash
npm run db:migrate:local
npm run db:seed:local
```

## The guard

`src/server/env.ts` refuses a **development** process that uses a remote Postgres database unless

```dotenv
ALLOW_REMOTE_DB_IN_DEV=true
```

is set explicitly. The error names the host (never the credentials) and explains both options. `src/instrumentation-node.ts` calls
`assertSafeDevelopmentDatabase()` before any startup work, so a mistyped `npm run dev` fails immediately rather than writing on the first
request.

The guard applies to `NODE_ENV=development` (the default when `NODE_ENV` is unset), which includes the maintenance scripts. It has no
effect on production (`NODE_ENV=production`). Production maintenance is therefore deliberate: run it with `NODE_ENV=production` and the
production environment, or set `ALLOW_REMOTE_DB_IN_DEV=true` for a specific remote task and remove it afterwards.

When a remote development database was explicitly allowed, startup prints:

```text
[iacquire] DEVELOPMENT is connected to a remote Postgres database (<host>); writes affect that environment.
```

## Working intentionally against staging

Use a **dedicated staging project**, never production. In `.env.local` (git-ignored):

```dotenv
AUTH_PROVIDER=supabase
DATABASE_DRIVER=postgres
DATABASE_URL=postgresql://postgres.<staging-ref>:...@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres
DATABASE_SSL_CA_FILE=certs/prod-ca-2021.crt
NEXT_PUBLIC_SUPABASE_URL=https://<staging-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_SECRET_KEY=sb_secret_...
ALLOW_REMOTE_DB_IN_DEV=true
```

`.env.local` overrides `.env.development`. Keep the flag only while that file is in use. See
[staging-environment.md](staging-environment.md).

## Verification

`tests/environment-safety.test.ts` covers:

- remote Postgres in development without the flag → refuses;
- embedded PGlite → allowed;
- local Postgres (`127.0.0.1`) → allowed without the flag;
- remote Postgres with `ALLOW_REMOTE_DB_IN_DEV=true` → allowed and warned.

Production behaviour is unchanged; the guard is inside the development branch only.
