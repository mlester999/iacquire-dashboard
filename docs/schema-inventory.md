# Portal schema inventory

**Current checkpoint:** the repository contains **26 versioned migrations**, `0001` through `0026`, declaring **154 public tables**: 153 application tables and the
`schema_migrations` bookkeeping table (counted from the migration source; the generic isolation test checks every table with an `org_id` against the real
migrated schema on each run). The first 89 tables (migrations `0001`–`0015`) are unchanged from the earlier verified inventory, and all **51 original tables** in
`0001`–`0004` are preserved. Migrations `0016`–`0026` add 65 tables, listed below. These counts describe the local schema source and disposable PostgreSQL
verification. **The hosted Supabase project was inspected on 2026-10-15: it had `0001`–`0025` applied (149 tables) and `0026` was applied then, giving 26 migrations and 154 public tables, matching this inventory.**

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

## Tables added in migrations 0016–0026: 65

| Migration / area | Count | Tables |
| --- | ---: | --- |
| `0016_operating_controls.sql` — pauses and emergency stops | 1 | automation_pauses |
| `0017_staff_roles.sql` — client staff profiles | 1 | staff_profiles |
| `0018_billing_credits.sql` — credits, payments, metering | 11 | agency_billing_settings, usage_rate_versions, usage_unit_rates, credit_accounts, billing_settings, credit_ledger_entries, payments, payment_webhook_events, usage_reservations, metered_usage_events, provider_fees |
| `0019_messaging.sql` — unified inbox, consent, follow-ups, handoff | 20 | messaging_policy, messaging_settings, messaging_channels, approved_test_destinations, whatsapp_templates, contacts, contact_identities, contact_merges, contact_memories, contact_consent_events, suppressions, conversations, conversation_messages, message_delivery_events, webhook_receipts, follow_up_plans, follow_up_steps, human_escalations, escalation_recipients, conversation_ownership_events |
| `0020_onboarding_v2.sql` — adaptive onboarding and brand assets | 2 | onboarding_answers, org_assets |
| `0021_websites.sql` — Website Studio | 8 | websites, website_versions, website_publications, website_asset_blobs, website_publication_assets, website_domains, website_form_submissions, website_usage_daily |
| `0022_operations.sql` — scheduler heartbeats, incidents, email delivery | 4 | worker_job_runs, incidents, incident_events, notification_deliveries |
| `0023_appointments.sql` — event ledger, bookings, reminders | 4 | appointment_settings, appointment_events, appointment_bookings, appointment_reminders |
| `0024_retention.sql` — customer programs | 3 | retention_programs, retention_enrollments, retention_steps |
| `0025_commercial_operations.sql` — agency finance, fair use, inactivity, offboarding | 6 | agency_finance_entries, fair_use_policies, fair_use_status, account_activity_reviews, offboarding_requests, offboarding_events |
| `0026_website_studio_admin.sql` — template library, shared and saved sections, review comments | 5 | website_templates, website_template_versions, website_patterns, website_components, website_comments |

The public site runtime role `iaq_site_runtime` (0021) has no table privileges; it reaches data only through `SECURITY DEFINER` functions. `credit_ledger_entries`,
`incident_events` and `offboarding_events` have no update or delete path in the application code (append-only by use).

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
