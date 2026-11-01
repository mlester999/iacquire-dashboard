-- 0115_client_business_credentials.sql — the ledger of credentials a CLIENT's AI employee presents to the first-party business tools (client tier). Additive, and inert: nothing
-- reads or writes this table until the client tier is wired to a route and switched on (HERMES_CLIENT_BUSINESS_MCP_ENABLED, and org_features 'client_business_tools' per workspace).
--
-- A credential is `iamcpc1.<row id>.<43-character secret>`. It carries no claims: the row id finds this row, and everything else (the workspace, the employee, its role, its Hermes
-- profile) is read from the application's own records on every request. Only the sha256 of the secret is stored, so a database reader cannot present a credential.
--
--   * The composite foreign key (agent_instance_id, org_id) -> agent_instances(id, org_id) (the 0005 pattern) makes a row for an employee of another workspace impossible.
--   * A row may only be written for an employee of a CLIENT workspace, and its profile can never be an agency profile (the same rule as app.guard_agent_profile).
--   * At most one `active` and one `rotating_out` row per employee. A rotation moves the active row to `rotating_out` for at most 48 hours, then it ends.
--   * Once a hash is stored it never changes, and a revoked row stays revoked.
--   * Server only: row-level security on, no policy, and no grant to any signed-in role (the crm_agent_tokens posture).
--
-- Rollback: supabase/rollbacks/0115_client_business_credentials.down.sql (refused while any credential is not revoked).

create table agent_business_credentials (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  agent_instance_id uuid not null,
  -- The Hermes profile the employee had when this credential was issued. A credential whose employee has been re-mapped to another profile stops working.
  profile text not null check (profile ~ '^[a-z0-9][a-z0-9_-]{1,62}$' and profile <> 'default' and profile not like 'iacquire-%'),
  -- sha256 of the secret, lowercase hex. Null only while the row is `pending`: the id has been handed to the worker but the worker has not reported the secret's hash yet.
  secret_sha256 text unique check (secret_sha256 is null or secret_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'active', 'rotating_out', 'revoked')),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  -- A short machine code (for example org_suspended), never free text.
  revoked_reason text check (revoked_reason is null or revoked_reason ~ '^[a-z][a-z0-9_]{1,59}$'),
  last_used_at timestamptz,
  use_count integer not null default 0 check (use_count >= 0),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (agent_instance_id, org_id) references agent_instances (id, org_id) on delete cascade,
  check (expires_at > issued_at and expires_at <= issued_at + interval '400 days'),
  check (status = 'revoked' or (status = 'pending') = (secret_sha256 is null)),
  check ((status = 'revoked') = (revoked_at is not null))
);

create unique index agent_business_credentials_one_active on agent_business_credentials (agent_instance_id) where status = 'active';
create unique index agent_business_credentials_one_rotating_out on agent_business_credentials (agent_instance_id) where status = 'rotating_out';
create index agent_business_credentials_agent_idx on agent_business_credentials (org_id, agent_instance_id, status);

create function app.guard_agent_business_credential() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from organizations o where o.id = new.org_id and o.kind = 'client') then
      raise exception 'a client business credential belongs to a client workspace' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.org_id is distinct from old.org_id or new.agent_instance_id is distinct from old.agent_instance_id
     or new.profile is distinct from old.profile or new.issued_at is distinct from old.issued_at then
    raise exception 'a client business credential cannot move to another employee, workspace or profile' using errcode = 'check_violation';
  end if;
  if old.secret_sha256 is not null and new.secret_sha256 is distinct from old.secret_sha256 then
    raise exception 'a client business credential''s secret hash is written once' using errcode = 'check_violation';
  end if;
  if old.status = 'revoked' and (new.status <> 'revoked' or new.revoked_at is distinct from old.revoked_at or new.revoked_reason is distinct from old.revoked_reason) then
    raise exception 'a revoked client business credential stays revoked' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger agent_business_credentials_guard before insert or update on agent_business_credentials
  for each row execute function app.guard_agent_business_credential();

alter table agent_business_credentials enable row level security;
revoke all on agent_business_credentials from public, anon, authenticated, iaq_app_user, iaq_site_runtime;

comment on table agent_business_credentials is
  'Stored verifiers (sha256 only) of the credentials a client AI employee presents to the client business tools. Server only: no policy, no grant to any signed-in role.';
