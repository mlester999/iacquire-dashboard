-- 0132: make the Growth Partner's approval-gated CRM changes independently switchable.
-- This changes role reference data only; it does not attach the role to existing tenants.
do $$
declare
  current_tools jsonb;
begin
  select default_tools into current_tools
    from public.agent_roles
   where key = 'growth_partner'
   for update;

  if not found then
    raise exception 'cannot_add_growth_partner_crm_ability_without_role' using errcode = '55000';
  end if;
  if jsonb_typeof(current_tools) <> 'array' then
    raise exception 'growth_partner_default_tools_must_be_array' using errcode = '55000';
  end if;

  if not current_tools @> '["crm.request_update"]'::jsonb then
    update public.agent_roles
       set default_tools = current_tools || '["crm.request_update"]'::jsonb
     where key = 'growth_partner';
  end if;
end
$$;
