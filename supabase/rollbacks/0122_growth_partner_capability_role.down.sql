-- A runtime row or an audit trail may now refer to this role. Preserve it instead of making the
-- rollback silently orphan an employee or invalidate historical evidence.
do $$
begin
  if exists (select 1 from public.agent_instances where role_key = 'growth_partner') then
    raise exception 'cannot_remove_growth_partner_role_with_runtime_rows' using errcode = '55000';
  end if;
  delete from public.agent_roles where key = 'growth_partner';
end
$$;
