# Portal schema inventory

**Historical checkpoint:** the counts below were verified through migration `0015`. The working repository now includes `0016`–`0021`; their catalog, RLS and table inventory must be included in the final refresh. Do not use the historical count as the current expanded-schema total.

The repository contains **15 versioned migrations**, `0001` through `0015`, declaring **89 public tables**: 88 application tables and the `schema_migrations` bookkeeping table. All **51 original tables** in migrations `0001`–`0004` are preserved. These counts describe the local schema source and disposable PostgreSQL verification; no hosted project has been inspected or migrated.

Supabase-managed `auth`, `storage`, `realtime`, `vault` and CLI migration-history tables are excluded from the public-table count. `supabase/local-compat.sql` emulates managed schemas only for isolated development/tests and must never run against a hosted project.

## Original application tables: 51

| Migration / area | Count | Tables |
| --- | ---: | --- |
| `0001_foundation.sql` — identity and tenancy | 14 | users, auth_credentials, auth_sessions, auth_tokens, rate_limit_buckets, email_outbox, organizations, company_profiles, organization_memberships, staff_assignments, invitations, access_requests, role_permissions, org_features |
| `0002_workforce.sql` — workforce and knowledge | 14 | onboarding_responses, company_knowledge, knowledge_documents, agent_roles, agent_instances, agent_config_versions, agent_provisioning_jobs, chat_conversations, chat_messages, agent_runs, tool_executions, integration_credentials, integration_status, ghl_location_mappings |
| `0003_business.sql` — business records | 13 | approval_requests, approval_events, tasks, lead_targeting_profiles, lead_research_requests, leads, crm_pipelines, crm_opportunities, appointment_refs, record_notes, retention_accounts, customer_feedback, service_history |
| `0004_support_ops.sql` — support and operations | 10 | notifications, notification_preferences, support_tickets, support_messages, help_conversations, help_messages, usage_events, usage_limits, billing_accounts, audit_logs |

Legacy authentication and credential tables remain restricted rollback data. Retaining those tables does not enable legacy production authentication or credential resolution.

## Additional tables: 38

| Migration / area | Count | Tables |
| --- | ---: | --- |
| `0008_setup_center.sql` — setup templates and tenant progress | 8 | client_setup_templates, client_setup_template_tasks, client_setup_instances, client_setup_tasks, client_setup_task_dependencies, client_setup_task_events, client_setup_task_attachments, client_setup_checks |
| `0009_supabase_foundation.sql` — migration bookkeeping and account migration | 2 | schema_migrations, auth_account_migrations |
| `0010_secure_integrations.sql` — managed credential references and health | 4 | credential_references, integration_connections, integration_connection_checks, automation_template_mappings |
| `0011_private_storage.sql` — recovery authorization and private files | 3 | auth_recovery_sessions, private_files, support_attachments |
| `0012_provisioning_activation.sql` — resumable jobs and readiness reviews | 3 | provisioning_jobs, provisioning_job_attempts, activation_reviews |
| `0015_custom_projects.sql` — services, portfolio, custom projects and maintenance | 18 | service_categories, service_catalog, service_price_versions, portfolio_projects, portfolio_assets, service_portfolio_links, client_project_requests, project_requirements, project_review_tasks, project_quotes, quote_approvals, client_projects, project_milestones, project_updates, project_files, project_messages, maintenance_subscriptions, maintenance_requests |

Migrations `0005_tenant_integrity.sql`, `0006_reference_data.sql`, `0007_capability_copy.sql`, `0013_setup_experience.sql` and `0014_llm_provider.sql` alter constraints, permissions, reference data or existing columns; they declare no new tables. The application runner creates `schema_migrations` when needed, and migration `0009` includes a compatible fresh CLI bootstrap; it is one table, not two.

## Equivalent names requested in the brief

| Requested concept | Existing implementation |
| --- | --- |
| setup_templates / setup_template_tasks | client_setup_templates / client_setup_template_tasks |
| organization_setup_instances / organization_setup_tasks | client_setup_instances / client_setup_tasks |
| setup_task_events / setup_task_dependencies / setup_task_evidence | client_setup_task_events / client_setup_task_dependencies / client_setup_task_attachments |
| organization_external_mappings | ghl_location_mappings, tenant-scoped integration_connections and automation_template_mappings |
| provisioning_jobs / provisioning_job_attempts / activation_reviews | Tables with those names in migration 0012 |
| integration_connections / integration_connection_checks / credential_references / automation_template_mappings | Tables with those names in migration 0010 |

The setup manager reuses these equivalents rather than creating competing setup histories. Composite foreign keys preserve same-tenant relationships; RLS is enabled on every public table, while grants distinguish server user queries, restricted bookkeeping and catalogs. Automated policy tests inspect the actual disposable PostgreSQL catalog and deny cross-tenant access; source declarations alone do not prove RLS behavior.

To compare the authorized hosted target after migration, run this read-only query through a trusted operator connection:

```sql
select c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;
```

Compare names and row counts with the preserved source before cutover. Do not run a schema repair or data import against a populated target automatically. See [supabase-setup.md](supabase-setup.md) for backup, transfer, account linking and rollback procedures.
