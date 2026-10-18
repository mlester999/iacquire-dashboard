# Workforce migration and release plan

Status: **prepared, not applied. Hosted deployment requires explicit approval.**

This plan covers only the workforce-owned migrations. It does not authorize or attempt to reconcile
the concurrent CRM migration branch.

## What the hosted database actually has

Read-only inspection on 2026-10-18 (no writes):

- `schema_migrations` records `0001`–`0029`, then `0034`–`0044`.
- The highest hosted migration is `0044_agency_module_view_overrides`.
- Hosted `0041` is `crm_action_permissions`, `0042` is `company_delete_permission`, `0043` is
  `agency_manager_operational_defaults`, `0044` is `agency_module_view_overrides`.
- 203 public tables.
- `knowledge_documents` still has only its original columns; `employee_knowledge_entries` does not exist.
- Hosted has `app.has_permission`, `app.can_access_org`, `app.current_user_id` and
  `app.touch_updated_at`.
- Hosted does **not** have `app.permitted_orgs` or `app.accessible_orgs` (it predates the local
  RLS-initplan migration).
- Hosted has the composite `agent_instances_id_org_key` unique key required by the workforce FKs.

The local workforce migrations were previously numbered 0041/0042. That collided with hosted CRM
migrations. They are now:

- `0045_ai_workforce_experience.sql`
- `0046_knowledge_document_extraction.sql`

## Compatibility handling

`0045` checks whether `app.permitted_orgs(text)` exists:

- **Local branch:** it exists after `0040_rls_initplan`; policies use the statement-level
  `permitted_orgs` form. The local RLS-initplan guard continues to pass.
- **Hosted:** it does not exist; policies use the existing `app.has_permission(org_id, …)` form. This
  is still permission-checked and RLS-enforced, and is fail-closed.

Both migrations are idempotent for the objects they own and can be re-run after an interrupted deploy.
`0045` also creates the composite `(agent_instance_id, org_id)` foreign keys and refuses documents in
another tenant.

The workforce migrations do **not** depend on the local CRM migrations `0030`–`0040`. They depend on
the original workforce tables (`0002`), tenant integrity (`0005`), and the hosted or local permission
helpers. The divergent CRM migration lineage remains the CRM owner's responsibility.

## Approval gates

Do not proceed until all are true:

1. The repository owner approves a hosted deployment window.
2. A current database backup/snapshot is available and its restore has been tested.
3. The CRM owner confirms the hosted migration history and that no unapplied migration will be
   skipped or misinterpreted by this branch's local CRM files.
4. The workforce migrations 0045/0046 are reviewed against the hosted schema output above.
5. The deployment operator has explicit authorization to write to the hosted database.
6. The gateway remediation in [hermes-live-acceptance.md](hermes-live-acceptance.md) has either been
   applied and verified, or live AI traffic remains disabled.

## Deployment order

1. Back up the hosted database and record the current migration versions.
2. Apply `0045_ai_workforce_experience.sql`.
3. Apply `0046_knowledge_document_extraction.sql`.
4. Verify the schema checks below.
5. Deploy the application build that uses the new columns/statuses.
6. Run smoke tests on a non-production tenant.
7. Only then enable any live workforce traffic.

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
| Migration 0045/0046 review | iAcquire platform | Required |
| Divergent CRM migration reconciliation | CRM owner | Required separately |
| Gateway tool restrictions | Hermes administrator | Required |
| Complete-inventory contract | Hermes gateway/platform | Required |
| Deployment window and authorization | Repository owner | Required |
