-- A Hermes gateway is shared infrastructure; Hermes profiles remain tenant-owned employees.
-- The gateway stores only an opaque Vault credential reference. Per-profile API keys stay on
-- agent_instances. No remote profile creation is assumed by this schema.

create table hermes_gateways (
  id uuid primary key default gen_random_uuid(),
  label text not null check (char_length(label) between 2 and 120),
  environment text not null default 'development' check (environment in ('development','staging','production')),
  base_url text not null check (base_url ~ '^https://[^[:space:]]+$' or base_url ~ '^http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?(/[^[:space:]]*)?$'),
  gateway_type text not null default 'multiplexed_profiles' check (gateway_type in ('multiplexed_profiles','single_profile')),
  reported_gateway_id text check (reported_gateway_id is null or char_length(reported_gateway_id) <= 120),
  declared_version text check (declared_version is null or char_length(declared_version) <= 80),
  access_credential_id uuid references integration_credentials(id) on delete set null,
  status text not null default 'credentials_saved' check (status in ('credentials_saved','testing','connected','needs_attention','error','disconnected')),
  profile_creation_status text not null default 'unverified' check (profile_creation_status in ('unverified','operator_cli_only','restricted_service_verified')),
  capabilities jsonb not null default '{}'::jsonb check (jsonb_typeof(capabilities) = 'object'),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_health_check_at timestamptz,
  last_latency_ms integer check (last_latency_ms is null or last_latency_ms >= 0),
  last_error text check (last_error is null or char_length(last_error) <= 500),
  revision integer not null default 1 check (revision > 0),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (base_url)
);
create trigger hermes_gateways_touch before update on hermes_gateways for each row execute function app.touch_updated_at();
create index hermes_gateways_status on hermes_gateways(status, updated_at desc);

-- The employee's organization, role, profile ID, API-key reference, and health fields stay on
-- agent_instances. This FK records which shared gateway serves that profile.
alter table agent_instances add column hermes_gateway_id uuid references hermes_gateways(id) on delete set null;
create index agent_instances_hermes_gateway on agent_instances(hermes_gateway_id) where hermes_gateway_id is not null;
create unique index agent_instances_gateway_profile_unique
  on agent_instances(hermes_gateway_id, hermes_profile)
  where hermes_gateway_id is not null and hermes_profile is not null;

create function app.guard_hermes_gateway_credential() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare v_org uuid; v_provider text;
begin
  if new.access_credential_id is not null then
    select org_id,provider into v_org,v_provider from integration_credentials where id=new.access_credential_id;
    if v_org is not null or v_provider <> 'hermes' then
      raise exception 'hermes_gateway_credential_scope_mismatch' using errcode='check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger hermes_gateway_credential_guard before insert or update on hermes_gateways
  for each row execute function app.guard_hermes_gateway_credential();

create function app.guard_hermes_gateway_type() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare v_profiles integer;
begin
  if new.gateway_type = 'single_profile' then
    select count(*) into v_profiles from agent_instances where hermes_gateway_id=new.id and hermes_profile is not null;
    if v_profiles > 1 then
      raise exception 'hermes_single_profile_gateway_in_use' using errcode='check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger hermes_gateway_type_guard before insert or update of gateway_type on hermes_gateways
  for each row execute function app.guard_hermes_gateway_type();

create function app.guard_agent_hermes_gateway() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare v_base_url text; v_gateway_type text;
begin
  if new.hermes_gateway_id is null then return new; end if;
  if new.hermes_base_url is null or new.hermes_profile is null then
    raise exception 'hermes_gateway_requires_profile_mapping' using errcode='check_violation';
  end if;
  select base_url,gateway_type into v_base_url,v_gateway_type from hermes_gateways where id=new.hermes_gateway_id;
  if v_base_url is null or rtrim(v_base_url,'/') <> rtrim(new.hermes_base_url,'/') then
    raise exception 'hermes_profile_gateway_mismatch' using errcode='check_violation';
  end if;
  if v_gateway_type='single_profile' and exists (
    select 1 from agent_instances where hermes_gateway_id=new.hermes_gateway_id and id<>new.id and hermes_profile is not null
  ) then
    raise exception 'hermes_single_profile_gateway_in_use' using errcode='check_violation';
  end if;
  return new;
end $$;
create trigger agent_hermes_gateway_guard before insert or update of hermes_gateway_id,hermes_base_url,hermes_profile on agent_instances
  for each row execute function app.guard_agent_hermes_gateway();

alter table hermes_gateways enable row level security;
grant select on hermes_gateways to iaq_app_user;
create policy hermes_gateways_agency_select on hermes_gateways for select to iaq_app_user
  using (app.is_agency_admin() or app.is_agency_staff());
