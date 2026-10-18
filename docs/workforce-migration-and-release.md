# Workforce migration and release plan

Status (2026-10-19): **no CRM/workforce migration was applied during the CRM branch integration**. The read-only CRM preflight found migration records `0001`–`0029` and `0034`–`0049` in `public.schema_migrations`, 213 public tables, and no `crm_blueprints`, `crm_provider_switches`, or `hermes_tool_inventory`. A later repository record reports that AQi migrations `0050`–`0052` were applied on 2026-10-19; that newer ledger state was not re-read during the CRM pass. The 11 CRM/Hermes/RLS migration filenames in the pending list remain unverified on the hosted database. A verified current backup and restore, plus reconciliation of the divergent CRM/workforce migration history, are still required before applying them.

This plan covers only the workforce-owned migrations. It does not authorize or attempt to reconcile
the concurrent CRM migration branch.

## What the latest hosted records show

Read-only inspection on 2026-10-19 (no writes):

- `public.schema_migrations` records `0001`–`0029`, then `0034`–`0049`. No
  `supabase_migrations.schema_migrations` ledger was present.
- 213 public tables. The employee knowledge tables and migrations `0045`–`0046` are present.
- AQi migrations `0047_aqi_assistant`, `0048_aqi_cost_controls`, and
  `0049_aqi_attachments` are recorded. The separate local `0047_hermes_tool_inventory.sql` is not.
- The latest repository record reports AQi migrations `0050_aqi_conversation_content`,
  `0051_aqi_conversation_titles`, and `0052_aqi_conversation_lifecycle` applied on 2026-10-19.
  The CRM preflight above predates those writes; refresh the hosted ledger before any CRM migration.
- `crm_blueprints`, `crm_provider_switches`, and `hermes_tool_inventory` are absent.
- Hosted has `app.has_permission`, `app.can_access_org`, `app.current_user_id` and
  `app.touch_updated_at`.
- Hosted does **not** have `app.permitted_orgs` or `app.accessible_orgs` (it predates the local
  RLS-initplan migration).
- Hosted has the composite `agent_instances_id_org_key` unique key required by the workforce FKs.

The local workforce migrations were previously numbered 0041/0042. That collided with hosted CRM
migrations. The supported local sequence is:

- `0045_ai_workforce_experience.sql`
- `0046_knowledge_document_extraction.sql`

## Compatibility handling

`0045` checks whether `app.permitted_orgs(text)` exists:

- **Local branch:** it exists after `0053_rls_initplan`; policies use the statement-level
  `permitted_orgs` form. The local RLS-initplan guard continues to pass.
- **Hosted:** it does not exist; policies use the existing `app.has_permission(org_id, …)` form. This
  is still permission-checked and RLS-enforced, and is fail-closed.

Both migrations are idempotent for the objects they own and can be re-run after an interrupted deploy.
`0045` also creates the composite `(agent_instance_id, org_id)` foreign keys and refuses documents in
another tenant.

The local CRM and workforce files share numeric prefixes `0035`–`0040`, while the local Hermes inventory
file shares `0047` with the already-applied AQi migration. RLS migration `0053` runs after the AQi
migrations `0050`–`0052` and the earlier CRM/workforce files so it can rewrite the final policy set. The application migration runner
stores the full filename as the version; do not use a blanket Supabase CLI push or unfiltered
`npm run db:migrate` against the hosted URL. The exact 11 local files not recorded by the hosted preflight are:

- `0030_crm_scheduling`, `0031_crm_messaging`, `0032_crm_automation`, `0033_crm_growth`
- `0035_crm_blueprints`, `0036_crm_ghl_migration`, `0037_crm_setup_native`,
  `0038_crm_performance`, `0039_crm_provider_switch`, `0053_rls_initplan`
- `0047_hermes_tool_inventory`

The workforce files with matching numeric prefixes (`0035_hermes_setup_persistence` through
`0040_agency_workforce_permissions`) are already recorded under their full filenames. Resolve exact
migration identities with the CRM owner before any write. The CRM migrations depend on their own
ordered chain; the workforce migrations depend on the original workforce tables (`0002`), tenant
integrity (`0005`), and the permission helpers. Neither chain should be applied from the default
unfiltered runner to the hosted database.

## Approval gates

The user authorized a master push and requested migrations on 2026-10-19. That does not satisfy the
independent recovery and migration-history checks below. Hosted writes remain blocked until all are
true:

1. A current database backup is available and its restore has been tested. This was not available
   during this integration.
2. The CRM owner confirms the exact hosted migration identities and the missing CRM chain.
3. A targeted migration order is reviewed, including the filename-prefix collisions.
4. A deployment window is scheduled and the user/operator authorization still covers that window.
5. The gateway remediation in [hermes-live-acceptance.md](hermes-live-acceptance.md) has either been
   applied and verified, or live AI traffic remains disabled.

## Deployment order

1. Back up the hosted database, test restore, and record exact full migration filenames.
2. Have the CRM owner confirm and review the pending CRM migrations in dependency order.
3. Apply only the approved exact filenames with the application's `--only` option; do not use the
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
