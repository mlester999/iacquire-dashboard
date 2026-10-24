-- Employee chat can prepare one exact, short-lived appointment change proposal.
-- A proposal does not change the calendar; the owner/admin approval executor rechecks it before writing.
alter table public.chat_conversations
  add column if not exists pending_workforce_appointment_change jsonb
  check (pending_workforce_appointment_change is null or pg_column_size(pending_workforce_appointment_change) <= 4096);

comment on column public.chat_conversations.pending_workforce_appointment_change is
  'Server-only, expiring cancellation or reschedule proposal; explicit chat confirmation and owner/admin approval are required.';

alter table public.approval_requests drop constraint approval_requests_kind_check;
alter table public.approval_requests add constraint approval_requests_kind_check check (kind in (
  'lead_import', 'outreach', 'follow_up_message', 'crm_update', 'campaign_activation',
  'knowledge_change', 'tool_action', 'config_change', 'appointment_booking', 'appointment_change',
  'standing_authorization', 'workflow_activation', 'workflow_action'));
