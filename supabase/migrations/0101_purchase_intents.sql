-- 0101_purchase_intents.sql — a verified, single-use path from an invited prospect to a client workspace.
--
-- The commercial model is frozen here: US$1,499 setup and the optional US$299/month plan. A row stores the price snapshot it was created with, so a later price change never
-- rewrites what a buyer was shown. The public side is a bearer link whose SHA-256 hash is the only copy kept; a person confirms the details, a Super Admin records the
-- verified payment, and only then can a workspace be created. It does not create a second billing system: the canonical payment and setup-clearance rows are made by the
-- existing billing services after the client organization exists.

create table purchase_intents (
  id uuid primary key default gen_random_uuid(),
  agency_org_id uuid not null references organizations(id) on delete restrict,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  reference text not null unique check (reference ~ '^PUR-[A-Z0-9]{8,24}$'),
  buyer_name text not null check (length(btrim(buyer_name)) between 2 and 120),
  buyer_email text not null check (length(buyer_email) between 3 and 254 and buyer_email = lower(buyer_email) and buyer_email like '%@%'),
  company text not null check (length(btrim(company)) between 2 and 120),
  industry text not null default '' check (length(industry) <= 120),
  website text not null default '' check (length(website) <= 300),
  timezone text not null default 'America/Chicago' check (length(timezone) between 1 and 64),
  maintenance_selected boolean not null default false,
  setup_fee_cents integer not null check (setup_fee_cents = 149900),
  maintenance_monthly_cents integer not null check (maintenance_monthly_cents = 29900),
  currency text not null default 'USD' check (currency = 'USD'),
  product_version text not null check (length(product_version) between 1 and 40),
  status text not null default 'invited' check (status in ('invited', 'started', 'payment_verified', 'provisioned', 'cancelled', 'expired')),
  expires_at timestamptz not null,
  started_at timestamptz,
  payment_at timestamptz,
  provisioned_at timestamptz,
  cancelled_at timestamptz,
  expired_at timestamptz,
  payment_method text check (payment_method is null or length(payment_method) between 1 and 40),
  payment_reference text check (payment_reference is null or length(payment_reference) between 1 and 120),
  payment_paid_on date,
  payment_note text check (payment_note is null or length(payment_note) between 10 and 1000),
  payment_amount_cents integer check (payment_amount_cents is null or payment_amount_cents > 0),
  payment_id uuid references payments(id) on delete set null,
  client_org_id uuid references organizations(id) on delete set null,
  created_by uuid not null references users(id) on delete restrict,
  verified_by uuid references users(id) on delete set null,
  provisioned_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (client_org_id is null or status in ('payment_verified', 'provisioned')),
  check (status <> 'provisioned' or (client_org_id is not null and payment_id is not null)),
  check ((payment_at is null) = (payment_method is null)),
  check ((status = 'payment_verified' or status = 'provisioned') = (payment_reference is not null)),
  check (status not in ('started', 'payment_verified', 'provisioned') or started_at is not null),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  check ((status = 'expired') = (expired_at is not null))
);

create unique index purchase_intents_one_open_email on purchase_intents (buyer_email) where status in ('invited', 'started', 'payment_verified');
create index purchase_intents_agency_created on purchase_intents (agency_org_id, created_at desc);
create index purchase_intents_open_expiry on purchase_intents (expires_at) where status in ('invited', 'started');

-- The timeline shown on the intent page. A person's note is a word they typed; an audit row holds ids and fixed words, not the note.
create table purchase_intent_events (
  id bigint generated always as identity primary key,
  intent_id uuid not null references purchase_intents(id) on delete cascade,
  agency_org_id uuid not null references organizations(id) on delete restrict,
  kind text not null check (kind in ('created', 'link_rotated', 'started', 'payment_verified', 'workspace_created', 'provisioned', 'cancelled', 'expired')),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 8192),
  actor_id uuid references users(id) on delete set null,
  actor_kind text not null default 'system' check (actor_kind in ('user', 'system', 'buyer')),
  created_at timestamptz not null default now()
);
create index purchase_intent_events_intent on purchase_intent_events (intent_id, id);

-- The one agency workspace. A purchase intent belongs to it and never to a client workspace.
create or replace function app.purchase_intent_agency_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from organizations where id = new.agency_org_id and kind = 'agency') then
    raise exception 'purchase_intent_agency_must_be_the_agency_workspace' using errcode = '23514';
  end if;
  if new.client_org_id is not null and not exists (select 1 from organizations where id = new.client_org_id and kind = 'client') then
    raise exception 'purchase_intent_client_must_be_a_client_workspace' using errcode = '23514';
  end if;
  new.buyer_email := lower(btrim(new.buyer_email));
  new.buyer_name := btrim(new.buyer_name);
  new.company := btrim(new.company);
  new.updated_at := now();
  return new;
end $$;

create trigger purchase_intents_guard before insert or update on purchase_intents for each row execute function app.purchase_intent_agency_guard();
create trigger purchase_intents_touch before update on purchase_intents for each row execute function app.touch_updated_at();

-- The event's agency must match its intent's agency. This is checked here, not trusted from the caller.
create or replace function app.purchase_intent_event_agency_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from purchase_intents i where i.id = new.intent_id and i.agency_org_id = new.agency_org_id) then
    raise exception 'purchase_intent_event_agency_mismatch' using errcode = '23514';
  end if;
  if not exists (select 1 from organizations where id = new.agency_org_id and kind = 'agency') then
    raise exception 'purchase_intent_event_agency_must_be_the_agency_workspace' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger purchase_intent_events_agency before insert on purchase_intent_events for each row execute function app.purchase_intent_event_agency_guard();

create or replace function app.purchase_intent_events_immutable() returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  raise exception 'purchase_intent_events rows are append-only' using errcode = '42501';
end $$;
create trigger purchase_intent_events_immutable before update or delete on purchase_intent_events for each row execute function app.purchase_intent_events_immutable();

-- Who may read: an active agency account holding the prospects view permission, and only the one agency workspace. The application role has SELECT only; every write is
-- made by trusted server code through withSystem, exactly as the other commercial tables are.
create or replace function app.purchase_intents_allowed() returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(app.is_agency_staff() and app.has_agency_permission('agency.prospects.view'), false)
$$;

-- Resolving the agency workspace through a security-definer function keeps the policy from depending on the caller's own RLS view of organizations.
create or replace function app.purchase_intent_agency_org() returns uuid
language sql stable security definer set search_path = public, pg_temp
as $$
  select id from organizations where kind = 'agency' limit 1
$$;

revoke all on function app.purchase_intent_agency_guard() from public;
revoke all on function app.purchase_intent_event_agency_guard() from public;
revoke all on function app.purchase_intent_events_immutable() from public;
revoke all on function app.purchase_intents_allowed() from public, anon, authenticated;
revoke all on function app.purchase_intent_agency_org() from public, anon, authenticated;
grant execute on function app.purchase_intents_allowed(), app.purchase_intent_agency_org() to iaq_app_user;

alter table purchase_intents enable row level security;
alter table purchase_intent_events enable row level security;
revoke all on purchase_intents, purchase_intent_events from public, anon, authenticated, iaq_site_runtime;
grant select on purchase_intents, purchase_intent_events to iaq_app_user;

create policy purchase_intents_select on purchase_intents for select to iaq_app_user
  using (agency_org_id = (select app.purchase_intent_agency_org()) and (select app.purchase_intents_allowed()));
create policy purchase_intent_events_select on purchase_intent_events for select to iaq_app_user
  using (agency_org_id = (select app.purchase_intent_agency_org()) and (select app.purchase_intents_allowed()));

-- A purchase intent is a commercial record. The rollback refuses while any exists.
