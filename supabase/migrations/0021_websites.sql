-- Website Studio: sites, immutable versions and publications, domains, enquiry submissions, usage counters.
--
-- Trust boundary. The public site runtime executes on the open internet, so it connects (or SETs ROLE) as
-- iaq_site_runtime, which has NO table privileges at all. It can only call the few SECURITY DEFINER functions at the
-- bottom of this file: resolve a verified host to its live publication, read an asset of that publication, submit an
-- enquiry for it, rate-limit, and record usage. It can never read another tenant's data, a draft, a credential,
-- or a customer record, even if the runtime were compromised.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'iaq_site_runtime') then
    create role iaq_site_runtime nologin;
  end if;
end
$$;
grant iaq_site_runtime to current_user;
grant usage on schema app to iaq_site_runtime;
grant usage on schema public to iaq_site_runtime;

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------

insert into role_permissions (role, permission) values
  ('owner', 'website.view'), ('admin', 'website.view'), ('member', 'website.view'), ('sales_rep', 'website.view'), ('support', 'website.view'), ('viewer', 'website.view'),
  ('agency_staff', 'website.view'), ('agency_super_admin', 'website.view'),
  ('owner', 'website.edit'), ('admin', 'website.edit'), ('agency_staff', 'website.edit'), ('agency_super_admin', 'website.edit'),
  ('owner', 'website.domains'), ('admin', 'website.domains'), ('agency_staff', 'website.domains'), ('agency_super_admin', 'website.domains'),
  ('owner', 'website.approve'),
  ('owner', 'website.publish'), ('agency_super_admin', 'website.publish');

-- ---------------------------------------------------------------------------
-- Sites
-- ---------------------------------------------------------------------------

create or replace function app.reserved_site_label(p_label text) returns boolean
language sql immutable
as $$
  select p_label = any (array['www', 'app', 'api', 'admin', 'mail', 'email', 'sites', 'site', 'static', 'assets', 'cdn', 'status', 'docs', 'help', 'support', 'billing',
    'dashboard', 'login', 'portal', 'iacquire', 'ghl', 'n8n', 'hermes', 'supabase', 'ns1', 'ns2', 'smtp', 'ftp', 'test', 'staging', 'preview', 'dev'])
$$;

create table websites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  kind text not null default 'website' check (kind in ('website', 'landing_page')),
  template_key text not null check (template_key ~ '^[a-z]+\.[a-z]+$'),
  -- <subdomain>.<sites base domain>. Lower-case letters, digits and hyphens; reserved names are refused.
  subdomain text not null unique check (subdomain ~ '^[a-z0-9](?:[a-z0-9-]{1,40}[a-z0-9])$' and not app.reserved_site_label(subdomain)),
  -- The working copy. Saved versions and publications are immutable snapshots of it.
  draft_content jsonb not null check (pg_column_size(draft_content) <= 300000),
  draft_revision integer not null default 0 check (draft_revision >= 0),
  draft_updated_by uuid references users(id) on delete set null,
  draft_updated_at timestamptz not null default now(),
  approval_status text not null default 'draft' check (approval_status in ('draft', 'submitted', 'approved', 'changes_requested')),
  approval_version_id uuid,
  approval_note text check (char_length(approval_note) <= 600),
  approval_decided_by uuid references users(id) on delete set null,
  approval_decided_at timestamptz,
  published_publication_id uuid,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id)
);
-- One main website per organization; extra landing pages are allowed.
create unique index websites_one_main_per_org on websites (org_id) where kind = 'website';
create index websites_org_idx on websites (org_id, created_at desc);
create trigger websites_touch before update on websites for each row execute function app.touch_updated_at();

create table website_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  website_id uuid not null,
  version integer not null check (version > 0),
  template_key text not null check (template_key ~ '^[a-z]+\.[a-z]+$'),
  content jsonb not null check (pg_column_size(content) <= 300000),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  source text not null check (source in ('editor', 'generated', 'submit', 'publish', 'rollback')),
  note text check (char_length(note) <= 300),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (website_id, org_id) references websites (id, org_id) on delete cascade,
  unique (website_id, version),
  unique (id, org_id)
);
create or replace function app.block_update() returns trigger language plpgsql as $$
begin raise exception '% rows cannot be changed once saved', tg_table_name using errcode = '42501'; end $$;
create trigger website_versions_frozen before update on website_versions for each row execute function app.block_update();

create table website_publications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  website_id uuid not null,
  number integer not null check (number > 0),
  version_id uuid not null,
  template_key text not null check (template_key ~ '^[a-z]+\.[a-z]+$'),
  -- A frozen copy of exactly what is served. The live site never reads the draft.
  content jsonb not null check (pg_column_size(content) <= 300000),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'live' check (status in ('live', 'superseded', 'failed')),
  health text not null default 'unchecked' check (health in ('unchecked', 'healthy', 'unhealthy')),
  health_detail text check (char_length(health_detail) <= 300),
  health_checked_at timestamptz,
  rolled_back_to integer,
  note text check (char_length(note) <= 300),
  published_by uuid references users(id) on delete set null,
  published_at timestamptz not null default now(),
  foreign key (website_id, org_id) references websites (id, org_id) on delete cascade,
  foreign key (version_id, org_id) references website_versions (id, org_id),
  unique (website_id, number),
  unique (id, org_id)
);
create unique index website_one_live_publication on website_publications (website_id) where status = 'live';
create or replace function app.freeze_publication() returns trigger language plpgsql as $$
begin
  if new.content is distinct from old.content or new.template_key is distinct from old.template_key or new.content_hash is distinct from old.content_hash
     or new.version_id is distinct from old.version_id or new.website_id is distinct from old.website_id or new.number is distinct from old.number then
    raise exception 'a publication''s content cannot be changed' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger website_publications_frozen before update on website_publications for each row execute function app.freeze_publication();

alter table websites add constraint websites_published_fk foreign key (published_publication_id, org_id) references website_publications (id, org_id) deferrable initially deferred;
alter table websites add constraint websites_approval_version_fk foreign key (approval_version_id, org_id) references website_versions (id, org_id);

-- Images are copied into the publication, so the public runtime needs no storage credentials and a publication stays consistent.
create table website_asset_blobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text not null check (mime_type in ('image/png', 'image/jpeg', 'image/webp')),
  bytes bytea not null check (octet_length(bytes) between 1 and 6291456),
  width integer check (width > 0),
  height integer check (height > 0),
  created_at timestamptz not null default now(),
  unique (org_id, sha256)
);
create table website_publication_assets (
  publication_id uuid not null references website_publications(id) on delete cascade,
  asset_id uuid not null,
  blob_id uuid not null references website_asset_blobs(id),
  alt text not null default '' check (char_length(alt) <= 200),
  width integer,
  height integer,
  primary key (publication_id, asset_id)
);

-- ---------------------------------------------------------------------------
-- Domains
-- ---------------------------------------------------------------------------

create table website_domains (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  website_id uuid not null,
  hostname text not null check (hostname = lower(hostname) and char_length(hostname) <= 253
    and hostname ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'),
  kind text not null check (kind in ('platform', 'custom')),
  -- pending_dns: ownership not yet proven. verified: ownership proven (served). active: verified, certificate ready and reachable.
  status text not null default 'pending_dns' check (status in ('pending_dns', 'verified', 'active', 'error', 'removed')),
  verification_token text not null check (verification_token ~ '^[0-9a-f]{32}$'),
  verified_at timestamptz,
  dns_checked_at timestamptz,
  dns_detail text check (char_length(dns_detail) <= 300),
  routing_ok boolean,
  ssl_status text not null default 'unknown' check (ssl_status in ('unknown', 'pending', 'ready', 'error')),
  ssl_checked_at timestamptz,
  ssl_detail text check (char_length(ssl_detail) <= 300),
  live_ok boolean,
  live_checked_at timestamptz,
  is_primary boolean not null default false,
  -- How the owner came to hold the domain. Purchases are requests the owner approves; nothing is bought automatically.
  acquisition text not null default 'existing' check (acquisition in ('platform', 'existing', 'purchase_requested', 'purchase_approved', 'purchased')),
  registrar text check (char_length(registrar) <= 80),
  purchase_cost_micros bigint check (purchase_cost_micros > 0),
  purchase_approved_by uuid references users(id) on delete set null,
  purchase_approved_at timestamptz,
  renews_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  foreign key (website_id, org_id) references websites (id, org_id) on delete cascade,
  -- Nobody can claim a host under our own domain as a custom domain.
  check (kind = 'platform' or hostname !~ '(^|\.)iacquire\.com$'),
  check (acquisition <> 'purchased' or registrar is not null),
  check (acquisition <> 'purchase_approved' or purchase_approved_at is not null)
);
create unique index website_domains_host_unique on website_domains (hostname) where removed_at is null;
create unique index website_domains_one_primary on website_domains (website_id) where is_primary and removed_at is null;
create index website_domains_site_idx on website_domains (website_id) where removed_at is null;

-- ---------------------------------------------------------------------------
-- Enquiries and usage
-- ---------------------------------------------------------------------------

create table website_form_submissions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  website_id uuid not null,
  publication_id uuid not null,
  host text not null check (char_length(host) <= 253),
  page_slug text not null default 'home' check (char_length(page_slug) <= 40),
  name text not null default '' check (char_length(name) <= 120),
  email text check (char_length(email) <= 320),
  phone text check (char_length(phone) <= 30),
  service text check (char_length(service) <= 60),
  message text not null default '' check (char_length(message) <= 2000),
  consent boolean not null check (consent),
  marketing_opt_in boolean not null default false,
  consent_text text not null default '' check (char_length(consent_text) <= 300),
  utm jsonb not null default '{}'::jsonb check (pg_column_size(utm) <= 1024),
  referrer text check (char_length(referrer) <= 300),
  ip_hash text check (char_length(ip_hash) <= 80),
  dedupe_key text not null check (char_length(dedupe_key) between 8 and 80),
  status text not null default 'received' check (status in ('received', 'processed', 'failed', 'spam')),
  error text check (char_length(error) <= 300),
  contact_id uuid,
  attempts integer not null default 0 check (attempts between 0 and 10),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (website_id, org_id) references websites (id, org_id) on delete cascade,
  unique (website_id, dedupe_key),
  check (email is not null or phone is not null)
);
create index website_submissions_queue_idx on website_form_submissions (created_at) where status = 'received';
create index website_submissions_org_idx on website_form_submissions (org_id, created_at desc);

create table website_usage_daily (
  website_id uuid not null,
  org_id uuid not null references organizations(id) on delete cascade,
  day date not null,
  requests bigint not null default 0 check (requests >= 0),
  bytes_served bigint not null default 0 check (bytes_served >= 0),
  form_submissions integer not null default 0 check (form_submissions >= 0),
  primary key (website_id, day),
  foreign key (website_id, org_id) references websites (id, org_id) on delete cascade
);
create index website_usage_org_idx on website_usage_daily (org_id, day desc);

-- ---------------------------------------------------------------------------
-- Row level security: clients read; trusted server code writes
-- ---------------------------------------------------------------------------

alter table websites enable row level security;
alter table website_versions enable row level security;
alter table website_publications enable row level security;
alter table website_asset_blobs enable row level security;
alter table website_publication_assets enable row level security;
alter table website_domains enable row level security;
alter table website_form_submissions enable row level security;
alter table website_usage_daily enable row level security;
revoke all on websites, website_versions, website_publications, website_asset_blobs, website_publication_assets, website_domains,
  website_form_submissions, website_usage_daily from public, anon, authenticated, iaq_site_runtime;

grant select on websites, website_versions, website_domains, website_usage_daily to iaq_app_user;
grant select (id, org_id, website_id, number, version_id, template_key, content_hash, status, health, health_detail, health_checked_at, rolled_back_to, note, published_by, published_at)
  on website_publications to iaq_app_user;
grant select (id, org_id, website_id, page_slug, name, email, phone, service, message, consent, marketing_opt_in, utm, referrer, status, contact_id, processed_at, created_at)
  on website_form_submissions to iaq_app_user;

create policy websites_select on websites for select to iaq_app_user using (app.has_permission(org_id, 'website.view'));
create policy website_versions_select on website_versions for select to iaq_app_user using (app.has_permission(org_id, 'website.view'));
create policy website_publications_select on website_publications for select to iaq_app_user using (app.has_permission(org_id, 'website.view'));
create policy website_domains_select on website_domains for select to iaq_app_user using (app.has_permission(org_id, 'website.view') and removed_at is null);
create policy website_usage_select on website_usage_daily for select to iaq_app_user using (app.has_permission(org_id, 'website.view'));
-- Enquiries contain customer details: only people who may see contacts.
create policy website_submissions_select on website_form_submissions for select to iaq_app_user using (app.has_permission(org_id, 'contacts.view'));

-- ---------------------------------------------------------------------------
-- The public runtime's entire surface
-- ---------------------------------------------------------------------------

-- A verified host with a live publication, or nothing. This is where "custom-domain mapping denies unverified hosts" lives.
create or replace function app.site_by_host(p_host text)
returns table (website_id uuid, org_id uuid, publication_id uuid, template_key text, content jsonb, content_hash text, host_kind text, published_at timestamptz, canonical_host text)
language sql stable security definer set search_path = public, pg_temp
as $$
  select w.id, w.org_id, p.id, p.template_key, p.content, p.content_hash, d.kind, p.published_at,
         coalesce((select d2.hostname from website_domains d2
                   where d2.website_id = w.id and d2.removed_at is null and d2.is_primary and d2.status in ('verified', 'active') limit 1), d.hostname)
  from website_domains d
  join websites w on w.id = d.website_id and w.org_id = d.org_id
  join website_publications p on p.id = w.published_publication_id and p.status = 'live'
  join organizations o on o.id = w.org_id
  where d.hostname = lower(p_host) and d.removed_at is null and d.status in ('verified', 'active') and o.status in ('active', 'onboarding')
$$;

create or replace function app.site_asset(p_host text, p_sha text)
returns table (mime_type text, bytes bytea)
language sql stable security definer set search_path = public, pg_temp
as $$
  select b.mime_type, b.bytes
  from app.site_by_host(p_host) s
  join website_publication_assets pa on pa.publication_id = s.publication_id
  join website_asset_blobs b on b.id = pa.blob_id and b.org_id = s.org_id
  where b.sha256 = lower(p_sha)
  limit 1
$$;

create or replace function app.site_asset_by_id(p_host text, p_asset uuid)
returns table (sha256 text, mime_type text, width integer, height integer, alt text)
language sql stable security definer set search_path = public, pg_temp
as $$
  select b.sha256, b.mime_type, coalesce(pa.width, b.width), coalesce(pa.height, b.height), pa.alt
  from app.site_by_host(p_host) s
  join website_publication_assets pa on pa.publication_id = s.publication_id and pa.asset_id = p_asset
  join website_asset_blobs b on b.id = pa.blob_id and b.org_id = s.org_id
$$;

create or replace function app.site_assets_for_host(p_host text)
returns table (asset_id uuid, sha256 text, mime_type text, width integer, height integer, alt text)
language sql stable security definer set search_path = public, pg_temp
as $$
  select pa.asset_id, b.sha256, b.mime_type, coalesce(pa.width, b.width), coalesce(pa.height, b.height), pa.alt
  from app.site_by_host(p_host) s
  join website_publication_assets pa on pa.publication_id = s.publication_id
  join website_asset_blobs b on b.id = pa.blob_id and b.org_id = s.org_id
$$;

create or replace function app.submit_site_form(
  p_host text, p_page text, p_name text, p_email text, p_phone text, p_service text, p_message text,
  p_consent boolean, p_marketing boolean, p_consent_text text, p_ip_hash text, p_utm jsonb, p_referrer text, p_dedupe text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  s record;
  v_id uuid;
begin
  select * into s from app.site_by_host(p_host) limit 1;
  if not found then return jsonb_build_object('status', 'unknown_host'); end if;
  if coalesce((s.content -> 'form' ->> 'enabled')::boolean, false) is not true then return jsonb_build_object('status', 'disabled'); end if;
  if p_consent is not true then return jsonb_build_object('status', 'consent_required'); end if;
  insert into website_form_submissions (org_id, website_id, publication_id, host, page_slug, name, email, phone, service, message, consent, marketing_opt_in, consent_text, utm, referrer, ip_hash, dedupe_key)
  values (s.org_id, s.website_id, s.publication_id, lower(p_host), left(p_page, 40), left(p_name, 120), nullif(left(p_email, 320), ''), nullif(left(p_phone, 30), ''), nullif(left(p_service, 60), ''),
          left(p_message, 2000), true, coalesce(p_marketing, false), left(p_consent_text, 300), coalesce(p_utm, '{}'::jsonb), nullif(left(p_referrer, 300), ''), left(p_ip_hash, 80), p_dedupe)
  on conflict (website_id, dedupe_key) do nothing
  returning id into v_id;
  if v_id is null then return jsonb_build_object('status', 'duplicate'); end if;
  insert into website_usage_daily (website_id, org_id, day, form_submissions) values (s.website_id, s.org_id, (now() at time zone 'utc')::date, 1)
  on conflict (website_id, day) do update set form_submissions = website_usage_daily.form_submissions + 1;
  return jsonb_build_object('status', 'ok', 'id', v_id);
end $$;

create or replace function app.record_site_usage(p_host text, p_requests bigint, p_bytes bigint) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare s record;
begin
  select * into s from app.site_by_host(p_host) limit 1;
  if not found then return; end if;
  insert into website_usage_daily (website_id, org_id, day, requests, bytes_served)
  values (s.website_id, s.org_id, (now() at time zone 'utc')::date, greatest(p_requests, 0), greatest(p_bytes, 0))
  on conflict (website_id, day) do update
    set requests = website_usage_daily.requests + excluded.requests, bytes_served = website_usage_daily.bytes_served + excluded.bytes_served;
end $$;

-- Fixed-window limiter shared by every runtime instance, using the portal's existing buckets.
create or replace function app.site_rate_limit(p_key text, p_limit integer, p_window_seconds integer) returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_start timestamptz;
  v_hits integer;
begin
  if p_window_seconds < 1 or p_limit < 1 or char_length(p_key) > 200 then return false; end if;
  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into rate_limit_buckets (bucket_key, window_start, hits) values ('site:' || p_key, v_start, 1)
  on conflict (bucket_key, window_start) do update set hits = rate_limit_buckets.hits + 1
  returning hits into v_hits;
  return v_hits <= p_limit;
end $$;

revoke all on function app.site_by_host(text), app.site_asset(text, text), app.site_asset_by_id(text, uuid), app.site_assets_for_host(text),
  app.submit_site_form(text, text, text, text, text, text, text, boolean, boolean, text, text, jsonb, text, text),
  app.record_site_usage(text, bigint, bigint), app.site_rate_limit(text, integer, integer) from public;
grant execute on function app.site_by_host(text), app.site_asset(text, text), app.site_asset_by_id(text, uuid), app.site_assets_for_host(text),
  app.submit_site_form(text, text, text, text, text, text, text, boolean, boolean, text, text, jsonb, text, text),
  app.record_site_usage(text, bigint, bigint), app.site_rate_limit(text, integer, integer) to iaq_site_runtime;
