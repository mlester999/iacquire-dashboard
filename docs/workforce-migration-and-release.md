# Workforce migration and release plan

Status (2026-10-19, updated): the duplicate migration numbers are fixed and the hosted database is fully
migrated. CRM files `0035`–`0039` became `0054`–`0058`, the Hermes inventory became `0059` and the RLS
rewrite became `0060` (a later `0061` adds the manager Blueprint grants). The nine CRM migrations,
`0059_hermes_tool_inventory`, `0060_rls_initplan` and `0061_agency_manager_blueprint_permissions` were
applied after `pg_dump` backups, and the hosted ledger rows for the CRM files were renamed in the same
pass. The hosted project now records **60 migrations** and **251 public tables** (was 213), every public
table has row level security enabled, and **no migration is pending**.

This plan covers the workforce-owned migrations. The CRM migration chain was reconciled and applied
after the earlier preflight, as recorded below. The workforce write gates are now satisfied for the
two files that were held back; they were applied in the same pass.

## Hosted pre-migration snapshot (2026-10-19)

Read-only inspection on 2026-10-19 (no writes):

- `public.schema_migrations` records `0001`–`0029`, then `0034`–`0049`. No
  `supabase_migrations.schema_migrations` ledger was present.
- 213 public tables. The employee knowledge tables and migrations `0045`–`0046` are present.
- AQi migrations `0047_aqi_assistant`, `0048_aqi_cost_controls`, and
  `0049_aqi_attachments` are recorded. The separate local `0059_hermes_tool_inventory.sql` is not.
- A later repository record reports AQi migrations `0050_aqi_conversation_content`,
  `0051_aqi_conversation_titles`, and `0052_aqi_conversation_lifecycle` applied on 2026-10-19.
  The CRM reconciliation and later targeted writes below followed this snapshot. Refresh the full
  hosted ledger before any future migration write.
- `crm_blueprints`, `crm_provider_switches`, and `hermes_tool_inventory` are absent.
- Hosted has `app.has_permission`, `app.can_access_org`, `app.current_user_id` and
  `app.touch_updated_at`.
- Hosted does **not** have `app.permitted_orgs` or `app.accessible_orgs` (it predates the local
  RLS-initplan migration).
- Hosted has the composite `agent_instances_id_org_key` unique key required by the workforce FKs.

### 2026-10-19 hosted write (CRM reconciliation)

The divergent CRM/workforce numbering was resolved by applying the CRM files with the repository's
`--only` runner and one transaction per migration:

- Backup first: `pg_dump --format=custom` to the git-ignored `.data/backups/pre-crm-20261019T063759.dump`
  (2,632 TOC entries; verified with `pg_restore --list`). A second backup,
  `.data/backups/pre-renumber-20261019T065124.dump`, was taken before the renumbering.
- Applied: `0030_crm_scheduling`, `0031_crm_messaging`, `0032_crm_automation`, `0033_crm_growth`,
  the CRM files now numbered `0054`–`0058`. None of the nine contains a `drop table`, `drop column`,
  `truncate` or `delete from` statement.
- Renumbered afterwards: the CRM files `0035`–`0039` → `0054`–`0058`, `0047_hermes_tool_inventory` →
  `0059_hermes_tool_inventory`, `0053_rls_initplan` → `0060_rls_initplan`, with the five hosted ledger
  rows renamed in place (`update schema_migrations set version = …`), so nothing was applied twice.
- Applied after the renumber: `0059_hermes_tool_inventory`, `0060_rls_initplan` (its guard checks
  passed; it rewrote every SELECT policy it proves, and 13 per-row policies remain by design) and
  `0061_agency_manager_blueprint_permissions` (a real authorization fix: the permission matrix grants
  agency managers `crm.blueprints.view`/`design`, but no migration had ever inserted those rows).
- Verified afterwards: 251 public tables, 60 recorded migrations, 0 public tables without row level
  security, `app.permitted_orgs`/`app.accessible_orgs` present, and the `crm_*` tables (including
  `crm_blueprints`, `crm_provider_switches`, `crm_workflows` and `crm_forms`) present. No pending
  migrations.

The local workforce migrations were previously numbered 0041/0042. That collided with hosted CRM
migrations. The supported local sequence is:

- `0045_ai_workforce_experience.sql`
- `0046_knowledge_document_extraction.sql`

## Compatibility handling

`0045` checks whether `app.permitted_orgs(text)` exists:

- **Local branch:** it exists after `0060_rls_initplan`; policies use the statement-level
  `permitted_orgs` form. The local RLS-initplan guard continues to pass.
- **Hosted before migration `0060`:** it did not exist, so `0045` used the existing
  `app.has_permission(org_id, …)` form. Migration `0060` subsequently added the statement-level
  helpers and rewrote the applicable SELECT policies; the final hosted schema was verified after
  that change.

Both migrations are idempotent for the objects they own and can be re-run after an interrupted deploy.
`0045` also creates the composite `(agent_instance_id, org_id)` foreign keys and refuses documents in
another tenant.

The local CRM and workforce files used to share numeric prefixes `0035`–`0039`, and
`0047_hermes_tool_inventory` shared `0047` with the applied AQi migration. That is resolved: the CRM
files are now `0054`–`0058`, the Hermes inventory is `0059`, and the RLS rewrite is `0060`, so every
migration has a unique number. Execution order is unchanged — CRM still runs before `0060`, which
rewrites their policies, and `0060` still runs after AQi `0050`–`0052`. The application migration
runner stores the full filename as the version; do not use a blanket Supabase CLI push or unfiltered
`npm run db:migrate` against the hosted URL.

The post-write verification recorded 60 hosted migrations, 251 public tables, RLS enabled on every
public table, and no pending migrations. The CRM migrations depend on their own ordered chain; the
workforce migrations depend on the original workforce tables (`0002`), tenant integrity (`0005`), and
the permission helpers. Never apply either chain from the default unfiltered runner to the hosted
database.

## Controls for any future hosted write

The CRM, Hermes inventory, and RLS migrations were applied on 2026-10-19 after custom-format backups
and schema post-checks. The backups were inspected with `pg_restore --list`, but a restore was not
test-run. No further hosted migration is currently recorded as pending. For any future hosted write,
all of these controls must be satisfied first:

1. A current database backup is available and its restore has been tested.
2. Re-read and reconcile the full hosted migration ledger, including the AQi `0050`–`0052` entries
   and the renumbered CRM/Hermes/RLS files.
3. Review the exact targeted order for any remaining migration, including its compatibility and
   rollout checks.
4. A deployment window is scheduled and the user/operator authorization still covers that window.
5. The gateway remediation in [hermes-live-acceptance.md](hermes-live-acceptance.md) has either been
   applied and verified, or live AI traffic remains disabled.

## Deployment order

1. Back up the hosted database, test restore, and record exact full migration filenames.
2. Re-read the full hosted ledger and review the specific requested migration against its gates.
3. Apply only an approved exact filename with the application's `--only` option; do not use the
   unfiltered runner or a prefix-only Supabase CLI push.
4. Apply the Hermes tool-inventory migration separately after validating its compatibility with the
   hosted AQi migration `0047_aqi_assistant`.
5. Verify the schema checks below and the CRM-specific RLS/equivalence checks.
6. Deploy the application build that uses the new CRM and workforce schemas.
7. Run smoke tests on a non-production tenant. Enable live traffic only after the gateway inventory
   contract and profile allowlists are verified.

Do not apply migration files through an automated process that also applies the divergent local CRM
migrations.

## Post-migration schema checks

Run read-only SQL:

```sql
select to_regclass('public.employee_knowledge_entries');
select column_name from information_schema.columns
 where table_schema='public' and table_name='knowledge_documents'
   and column_name in ('agent_instance_id','risk_flags','last_used_at','processing_detail','extraction_method','processed_at')
 order by column_name;
select pg_get_constraintdef(oid) from pg_constraint where conname='knowledge_documents_status_check';
select relrowsecurity from pg_class where oid='public.employee_knowledge_entries'::regclass;
select policyname, cmd from pg_policies where schemaname='public' and tablename='employee_knowledge_entries' order by policyname;
```

Expected: table exists; six columns; status check includes `processing/failed/unsupported`; RLS true;
select/insert/update policies present.

## Application smoke tests

On an isolated non-production tenant:

1. Upload a text note and a selectable-text PDF/DOCX; verify `ready`, extracted text and source label.
2. Upload an encrypted/scanned PDF and malformed DOCX; verify `unsupported`/`failed` and no retrieval.
3. Verify a held prompt-injection document is not included in instructions.
4. Verify employee-specific knowledge is absent from another employee and another tenant.
5. Verify configuration preview does not alter the active version.
6. Verify chat history, rename, delete, pagination and no horizontal overflow at 390 px.
7. Verify internal and client users see only their own workspace.
8. Re-run the browser QA suite documented in [ai-workforce.md](ai-workforce.md).

## Rollback plan

If a migration must be reverted:

1. Stop application writes that use the new columns.
2. Roll back `0046_knowledge_document_extraction.down.sql` first. It refuses if any document is
   `processing`, `failed` or `unsupported`.
3. Roll back `0045_ai_workforce_experience.down.sql` second. It refuses while employee-specific
   knowledge entries exist or documents are assigned to employees. Export/remove those deliberately.
4. Restore the pre-deployment backup if data-dependent refusal is not acceptable.
5. Redeploy the previous application build.

The rollback tests run on an isolated migrated database and inside a transaction that is always rolled
back; they do not modify the shared test database. A separate private-schema test
(`tests/knowledge-migration-hosted-compat.test.ts`) removes the `permitted_orgs` helper, applies
0045/0046, and asserts that the hosted-compatible `has_permission` policies are created.

## Monitoring and failure response

- Watch the migration runner and application logs for `22P02`/`42P01`/`42501` errors during the first
  hour.
- Check that no `knowledge_documents` row stays `processing` for more than the bounded extraction
  window; use the retry action only after confirming the stored file exists.
- Check that audit events `knowledge.document_uploaded`, `knowledge.document_processed`,
  `knowledge.document_reprocessed` and `knowledge.document_deleted` are being written.
- If a policy error appears, stop AI traffic immediately; do not disable RLS to work around it.
- If extraction errors spike, disable employee knowledge uploads or switch to text-only uploads while
  preserving the existing data.

## Approval checklist

| Item | Owner | Status |
| --- | --- | --- |
| Hosted backup/restore proven | Platform owner | Required |
| Migration 0045/0046 review | iAcquire platform | Applied 2026-10-18 |
| Divergent CRM migration reconciliation | CRM owner | Required separately |
| Gateway tool restrictions | Hermes administrator | Required |
| Complete-inventory contract | Hermes gateway/platform | Required |
| Deployment window and authorization | Repository owner | Required |
