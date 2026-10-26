-- Rollback for 0108_workforce_appointment_changes.sql.
-- Do not discard a live proposal or approval history to restore the prior schema.
do $$
begin
  if exists (
    select 1 from public.chat_conversations
    where pending_workforce_appointment_change is not null
  ) then
    raise exception 'resolve pending appointment-change proposals before rolling back 0108';
  end if;

  if exists (
    select 1 from public.approval_requests
    where kind = 'appointment_change'
  ) then
    raise exception 'archive appointment-change approval history before rolling back 0108';
  end if;
end $$;

alter table public.chat_conversations
  drop column if exists pending_workforce_appointment_change;

alter table public.approval_requests
  drop constraint if exists approval_requests_kind_check;
alter table public.approval_requests
  add constraint approval_requests_kind_check check (kind in (
    'lead_import', 'outreach', 'follow_up_message', 'crm_update', 'campaign_activation',
    'knowledge_change', 'tool_action', 'config_change', 'appointment_booking',
    'standing_authorization', 'workflow_activation', 'workflow_action'));
