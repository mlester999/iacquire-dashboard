-- Agency profile checks are separate from employee runtime health. A valid read-only profile
-- identity check must not mark an employee online or change client workforce state.
create table agency_hermes_profile_checks (
  org_id uuid not null references organizations(id) on delete cascade,
  agent_instance_id uuid primary key,
  gateway_id uuid references hermes_gateways(id) on delete set null,
  profile_id text check (profile_id is null or profile_id ~ '^[a-z0-9][a-z0-9_-]{1,62}$'),
  status text not null check (status in (
    'not_configured', 'verified', 'cloudflare_auth_failed', 'hermes_auth_failed',
    'profile_unavailable', 'route_not_found', 'gateway_timeout', 'gateway_offline',
    'unexpected_response', 'identity_mismatch'
  )),
  identity_verified boolean not null default false,
  api_contract_verified boolean not null default false,
  tool_permissions_status text not null default 'not_checked' check (tool_permissions_status in (
    'not_checked', 'verified', 'restricted', 'incomplete', 'unavailable'
  )),
  detail text not null check (char_length(detail) between 1 and 500),
  checked_by uuid references users(id) on delete set null,
  checked_at timestamptz not null default now(),
  verified_at timestamptz,
  foreign key (agent_instance_id, org_id) references agent_instances(id, org_id) on delete cascade,
  check ((status = 'verified') = (identity_verified and api_contract_verified)),
  check ((status = 'verified') = (verified_at is not null))
);
create index agency_hermes_profile_checks_org_idx on agency_hermes_profile_checks(org_id, checked_at desc);

create function app.guard_agency_hermes_profile_check() returns trigger
language plpgsql set search_path=public,pg_temp as $$
declare v_kind text; v_role text; v_expected text;
begin
  select o.kind,a.role_key into v_kind,v_role
  from agent_instances a join organizations o on o.id=a.org_id
  where a.id=new.agent_instance_id and a.org_id=new.org_id;
  if v_kind is distinct from 'agency' then
    raise exception 'agency_profile_check_wrong_scope' using errcode='check_violation';
  end if;
  v_expected := case v_role
    when 'operations_manager' then 'iacquire-operations-manager'
    when 'lead_hunter' then 'iacquire-lead-hunter'
    when 'appointment_setter' then 'iacquire-appointment-setter'
    when 'sales_assistant' then 'iacquire-sales-assistant'
    when 'crm_manager' then 'iacquire-crm-manager'
    when 'performance_analyst' then 'iacquire-analyst'
    else null end;
  if new.profile_id is not null and new.profile_id <> v_expected then
    raise exception 'agency_profile_check_identity_mismatch' using errcode='check_violation';
  end if;
  if new.status='verified' and (new.profile_id is distinct from v_expected or new.gateway_id is null) then
    raise exception 'agency_profile_check_missing_identity_or_gateway' using errcode='check_violation';
  end if;
  if new.status='verified' then
    new.verified_at := coalesce(new.verified_at,new.checked_at,now());
  else
    new.verified_at := null;
    new.identity_verified := false;
    new.api_contract_verified := false;
  end if;
  return new;
end $$;
create trigger agency_hermes_profile_checks_guard before insert or update on agency_hermes_profile_checks
  for each row execute function app.guard_agency_hermes_profile_check();

alter table agency_hermes_profile_checks enable row level security;
grant select on agency_hermes_profile_checks to iaq_app_user;
create policy agency_hermes_profile_checks_super_admin_select on agency_hermes_profile_checks
  for select to iaq_app_user
  using (app.is_agency_admin() and exists (
    select 1 from organizations o where o.id=org_id and o.kind='agency'
  ));
