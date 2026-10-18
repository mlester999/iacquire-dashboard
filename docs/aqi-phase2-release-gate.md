# AQi Phase 2 release gate

Status: **production deployment completed by explicit authorization; staging-first gate was not satisfied.**


This document records the production state found by the Phase 2 acceptance audit and the safe
sequence required before the local cost-control/support changes can ship.

## Production state (read-only audit, 2026-10-18; deployment update 2026-10-19)

- GitHub records a successful **Production** deployment by `vercel[bot]`:
  - environment: `Production`
  - SHA: `ceae6e5` (production deployment succeeded after the authorized push on 2026-10-19)
  - state: `success`
  - deployment URL: Vercel-generated and protected by Vercel SSO.
- The repository has **no** `.github/workflows`, Vercel config or other deployment config. The
  deployment integration is external to the repository and automatically deploys master.
- Hosted database migrations: through `0052`; `0048`–`0049` were applied on 2026-10-18 and
  `0050`–`0052` on 2026-10-19 with the transactional `--only` runner.
- Hosted public tables: **213**. The private `aqi-attachments` bucket exists as non-public with a
  50 MB limit.
- Hosted AQi: one published configuration, 14 published knowledge entries, 8 enabled questions and
  2 saved conversations.
- Hosted global LLM integration: model `deepseek-flash`, format `openai`, status **`connected`**.
  The AQi failure recorded at 10:58Z predates the successful connection test at 11:44Z; at that
  earlier point the connection was not eligible. A controlled live `llmComplete` probe and a real
  SSE `llmStream` probe against the existing credential both returned `OK` on 2026-10-18.
- The deployed AQi build (before the local resolution/error fixes) had also used its seeded
  `deepseek-chat` model instead of the integration's `deepseek-flash`, and cached a failed
  resolution for 30 seconds. The local fix uses the integration model by default, removes negative
  caching, and rechecks on send.
- Production app version and hosted database version match through migration `0052`. The deployed
  `ceae6e5` includes cost-control, support, attachment/composer, GIF-removal,
  conversational-intelligence and conversation title/lifecycle changes. Hosted `0050`–`0052` are
  applied and verified.

The earlier “local-only migrations” report was correct when written. The later user-authorized
`--only` migration run applied 0045–0047, and the subsequent master push triggered the external
Vercel production deployment. A GitHub deployment record alone is not proof of a healthy rollout;
the Vercel status does show `success`, but the app URL is SSO-protected and the deployed AQi build
has not been exercised through the browser against the now-connected provider.

## Required gate before any further production change

1. **Freeze automatic production deployment.** Disconnect the Vercel production branch deployment
   or require manual promotion. Do not push the local cost-control/support commit until this is
   done.
2. **Create a staging environment** with:
   - a separate Supabase project (never production data);
   - a separate global LLM integration with staging-only credentials;
   - a separate Vercel/staging project and `APP_URL`;
   - its own `APP_ENCRYPTION_KEY`, `SECRET_STORE`, and provider keys.
3. **Back up and restore-test** before touching production schema.
4. Production 0048/0049 are already applied. Restore the pre-migration backup into staging, replay
   both migrations there, and verify the private bucket, RLS, attachment upload/read/delete and extraction.
5. Deploy the local commit to staging; run real-provider acceptance.
6. Only after sign-off, take a production backup, apply 0048, deploy manually, and run smoke tests.

## Backup and restore procedure

No `pg_dump`, `pg_restore`, PostgreSQL server binary, Docker or isolated database host is available
in this environment. A full backup could therefore **not** be created or restore-verified here.
This is a hard blocker; a logical JSON export is not a substitute for a full PostgreSQL backup.

On an authorized host with PostgreSQL client tools:

```bash
# Read the URL from the secure environment, never paste it into a ticket or chat.
pg_dump "$DATABASE_URL" \
  --format=custom \
  --no-owner \
  --file="iacquire-pre-aqi-0048-$(date +%Y%m%dT%H%M%S).dump"

# Restore into a new, isolated database.
createdb iacq_restore_check
pg_restore \
  --clean --if-exists --no-owner \
  --dbname="postgresql://.../iacq_restore_check" \
  "iacquire-pre-aqi-0048-<timestamp>.dump"
```

Restore verification checklist:

- `schema_migrations` matches production exactly, including 0044–0047.
- Public table count is 213 after 0048/0049 (210 before them).
- `employee_knowledge_entries` and the six AQi tables exist.
- RLS is enabled on employee knowledge and AQi tables.
- Policy counts match: employee knowledge 3; AQi conversations 4; AQi messages 3; AQi knowledge 1.
- AQi configuration count is 1 published; knowledge 12; questions 8; messages 2 at the audit point.
- The restored database starts the staging application, health endpoint responds, and AQi reports the
  staging provider unavailable/available as configured.
- No production customer data is copied into a shared or developer database.

## Rollback procedure

Do not run these on production without a verified backup and explicit approval.

1. Stop AQi traffic and export/retain AQi conversations and the usage ledger.
2. Roll back **0048** first:
   - `0048_aqi_cost_controls.down.sql` refuses while any cost/reservation data exists.
   - It drops `aqi_budgets`, `aqi_model_prices`, and the cost/reservation columns.
3. Roll back **0047**:
   - `0047_aqi_assistant.down.sql` refuses while AQi conversations exist.
   - Export/delete AQi conversations deliberately first.
4. Roll back **0046**:
   - refuses while documents are `processing`, `failed` or `unsupported`.
5. Roll back **0045**:
   - refuses while employee-specific knowledge exists or documents are assigned to employees.
6. If data prevents a clean reverse migration, restore the verified backup instead of deleting
   production data to satisfy a rollback test.

## Real-provider acceptance matrix (staging only)

Use a test tenant and a harmless prompt. Do not use customer data.

| Check | Evidence required |
| --- | --- |
| Provider authentication | `/admin/aqi` health reports connected; test request succeeds |
| Model response | Real text answer from the approved model |
| SSE streaming | Deltas arrive incrementally; no non-streaming fallback used |
| Stop/cancel | Stop aborts the provider request; message status `cancelled`; no false success |
| Retry | Retry creates a real second provider call and a new persisted turn |
| Provider failure | Forced invalid key/429/timeout shows a safe retryable error; no fabricated answer |
| Tokens/cost | Provider usage is recorded; cost is computed only from configured prices |
| Citation/source accuracy | Displayed sources equal retrieved entries; unsupported markers are removed |
| Secret safety | No key appears in browser, network response, logs or report |
| Tenant ownership | A second user/tenant cannot read the conversation or source list |

The local OpenAI-compatible SSE server and the local browser QA are **simulated/local evidence**.
They are not live-provider acceptance.

## Current production readiness

- AQi base code: deployed; provider now connected and live-probed successfully, but the deployed
  build predates the resolution/error fixes.
- AQi cost-control/support/attachment remediation: committed on the local branch; deployment status is
  recorded by the user-authorized push to master.
- Migrations 0048 and 0049 are applied hosted; the private bucket, metadata table, RLS and policies
  were verified after application.
- Full backup/restore: **BLOCKED** by missing PostgreSQL backup/restore tooling and no isolated
  database host.
- Staging-first gate: **FAIL / bypassed by explicit production authorization.** Production was
  deployed and migrated before a staging environment existed; run the staging acceptance steps
  retroactively and freeze future auto-deployments.
- Live provider: **provider-level PASS** (controlled completion and SSE probes); full deployed AQi
  UI acceptance remains blocked by Vercel SSO and the undeployed local fix.
