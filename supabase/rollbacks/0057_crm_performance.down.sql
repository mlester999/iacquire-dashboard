-- Rollback for 0057_crm_performance.sql. NOT a migration: the Supabase CLI does not run this folder. It only drops the indexes 0038 added (no
-- data is touched, so there is nothing to refuse); the CRM keeps working without them, more slowly on large workspaces. Run it in one
-- transaction after rolling back any later migration (highest number first). tests/crm-migrations.test.ts proves it executes.

drop index if exists crm_busy_blocks_user_end_idx;
drop index if exists appointment_refs_native_end_idx;
drop index if exists message_delivery_events_org_occurred_idx;
drop index if exists conversation_messages_org_created_idx;
drop index if exists contacts_directory_name_desc_idx;
drop index if exists contacts_directory_name_idx;
drop index if exists contacts_directory_recent_idx;
