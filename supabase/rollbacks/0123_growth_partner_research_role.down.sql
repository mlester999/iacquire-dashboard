-- Existing rows resolve to the legacy Lead Hunter role. Refuse to drop any later request
-- whose explicit runtime provenance differs from that legacy behavior.
do $$
begin
  if exists (
    select 1 from public.lead_research_requests
     where agent_role is distinct from 'lead_hunter'
  ) then
    raise exception 'cannot_remove_growth_partner_research_role_with_requests' using errcode = '55000';
  end if;
  alter table public.lead_research_requests drop column agent_role;
end
$$;
