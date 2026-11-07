-- 0132 rollback is safe only while the Growth Partner tools remain exactly as this migration
-- left them. Preserve any later workspace policy edit instead of silently removing it.
do $$
declare
  current_tools jsonb;
  before_tools constant jsonb := '["tasks.read", "research.public_web", "leads.stage_for_review", "calendar.read_availability", "appointments.read", "appointments.request_change", "calendar.booking_rules.update", "calendar.create", "crm.read", "crm.read_opportunities", "crm.contacts.create", "drafts.create", "analytics.read"]'::jsonb;
  after_tools constant jsonb := '["tasks.read", "research.public_web", "leads.stage_for_review", "calendar.read_availability", "appointments.read", "appointments.request_change", "calendar.booking_rules.update", "calendar.create", "crm.read", "crm.read_opportunities", "crm.contacts.create", "drafts.create", "analytics.read", "crm.request_update"]'::jsonb;
begin
  select default_tools into current_tools
    from public.agent_roles
   where key = 'growth_partner'
   for update;

  if not found then
    raise exception 'cannot_roll_back_missing_growth_partner_role' using errcode = '55000';
  end if;
  if current_tools = before_tools then
    return;
  end if;
  if current_tools <> after_tools then
    raise exception 'refusing_to_roll_back_0132_custom_growth_partner_default_tools' using errcode = '55000';
  end if;

  update public.agent_roles
     set default_tools = before_tools
   where key = 'growth_partner';
end
$$;
