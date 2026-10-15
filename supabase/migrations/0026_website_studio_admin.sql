-- Website Studio, second stage: the agency template library, reusable components, review comments, edit locks, archiving, and richer enquiries.
--
-- What this adds (and deliberately does not):
--   * It reuses websites, website_versions, website_publications, website_domains and org_assets as they are. New tables are only
--     website_templates (+ versions), website_patterns, website_components and website_comments.
--   * Templates are a STARTING POINT. A site copies a template's content when it is created and keeps its own copy: editing or
--     unpublishing a template can never change a client's website.
--   * Nothing here touches the public runtime's privileges, except that the enquiry function also records which kind of form was sent.

-- ---------------------------------------------------------------------------
-- Permissions (mirrored in src/lib/permissions.ts; a test compares the two)
-- ---------------------------------------------------------------------------

insert into role_permissions (role, permission) values
  ('agency_staff', 'website.templates.design'), ('agency_super_admin', 'website.templates.design'),
  ('agency_super_admin', 'website.templates.publish'),
  ('agency_staff', 'website.review'), ('agency_super_admin', 'website.review');

-- ---------------------------------------------------------------------------
-- Template keys may now be "custom.my-template"; a version can be a named checkpoint, an assistant change, a restore or a template start.
-- ---------------------------------------------------------------------------

alter table websites drop constraint if exists websites_template_key_check;
alter table websites add constraint websites_template_key_check check (template_key ~ '^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$');
alter table website_versions drop constraint if exists website_versions_template_key_check;
alter table website_versions add constraint website_versions_template_key_check check (template_key ~ '^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$');
alter table website_publications drop constraint if exists website_publications_template_key_check;
alter table website_publications add constraint website_publications_template_key_check check (template_key ~ '^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$');
alter table website_versions drop constraint if exists website_versions_source_check;
alter table website_versions add constraint website_versions_source_check
  check (source in ('editor', 'generated', 'submit', 'publish', 'rollback', 'checkpoint', 'ai', 'restore', 'template'));

-- ---------------------------------------------------------------------------
-- Websites: archiving, and a soft edit lock so two people don't silently fight over one draft.
-- The revision check remains the real guarantee; the lock only tells the second person who is already in the editor.
-- ---------------------------------------------------------------------------

alter table websites add column archived_at timestamptz;
alter table websites add column edit_lock_user uuid references users(id) on delete set null;
alter table websites add column edit_lock_name text check (char_length(edit_lock_name) <= 120);
alter table websites add column edit_lock_expires timestamptz;
create index websites_archived_idx on websites (archived_at) where archived_at is not null;

-- ---------------------------------------------------------------------------
-- Template library
-- ---------------------------------------------------------------------------

create table website_templates (
  id uuid primary key default gen_random_uuid(),
  -- family.variation, the same shape as the built-in keys. Agency designs live under "custom.".
  key text not null unique check (key ~ '^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$'),
  -- builtin rows only carry the agency's choices about a design that lives in code (featured, hidden, archived, extra tags).
  kind text not null check (kind in ('builtin', 'custom')),
  name text not null check (char_length(name) between 1 and 80),
  description text not null default '' check (char_length(description) <= 300),
  family text not null default 'custom' check (char_length(family) <= 60),
  industries text[] not null default '{}' check (cardinality(industries) <= 12),
  tags text[] not null default '{}' check (cardinality(tags) <= 16),
  status text not null default 'draft' check (status in ('draft', 'in_review', 'published', 'hidden', 'archived')),
  featured boolean not null default false,
  version integer not null default 1 check (version > 0),
  -- What clients are offered: the last published copy (null until first published). Never edited in place.
  content jsonb check (content is null or pg_column_size(content) <= 300000),
  -- The designer's working copy. Publishing copies it into `content` and records a version.
  draft_content jsonb check (draft_content is null or pg_column_size(draft_content) <= 300000),
  draft_revision integer not null default 0 check (draft_revision >= 0),
  based_on text check (char_length(based_on) <= 80),
  -- An optional picture shown on the template's card instead of the rendered thumbnail.
  preview_image bytea check (preview_image is null or octet_length(preview_image) <= 600000),
  preview_mime text check (preview_mime in ('image/png', 'image/jpeg', 'image/webp')),
  created_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  check (kind = 'builtin' or draft_content is not null),
  check (status <> 'published' or kind = 'builtin' or content is not null),
  check ((preview_image is null) = (preview_mime is null))
);
create index website_templates_status_idx on website_templates (status, featured desc, updated_at desc);
create trigger website_templates_touch before update on website_templates for each row execute function app.touch_updated_at();

create table website_template_versions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references website_templates(id) on delete cascade,
  version integer not null check (version > 0),
  content jsonb not null check (pg_column_size(content) <= 300000),
  note text check (char_length(note) <= 300),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (template_id, version)
);
create trigger website_template_versions_frozen before update on website_template_versions for each row execute function app.block_update();

-- Reusable sections the agency maintains for every client's editor (copied in when used, never linked).
create table website_patterns (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  category text not null default 'Other' check (char_length(category) <= 40),
  section jsonb not null check (pg_column_size(section) <= 60000),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger website_patterns_touch before update on website_patterns for each row execute function app.touch_updated_at();

-- A client's own saved sections.
create table website_components (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  section jsonb not null check (pg_column_size(section) <= 60000),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index website_components_org_idx on website_components (org_id, created_at desc) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- Review comments
-- ---------------------------------------------------------------------------

create table website_comments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  website_id uuid not null,
  page_slug text check (char_length(page_slug) <= 40),
  -- The part of the page the comment is about, when it is about one thing.
  node_id text check (char_length(node_id) <= 40),
  body text not null check (char_length(body) between 1 and 2000),
  author_id uuid references users(id) on delete set null,
  author_kind text not null check (author_kind in ('client', 'agency')),
  resolved_at timestamptz,
  resolved_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (website_id, org_id) references websites (id, org_id) on delete cascade
);
create index website_comments_site_idx on website_comments (website_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Media organisation
-- ---------------------------------------------------------------------------

alter table org_assets add column folder text check (char_length(folder) <= 60);

-- ---------------------------------------------------------------------------
-- Enquiries remember which kind of form was sent, and which one.
-- ---------------------------------------------------------------------------

alter table website_form_submissions add column purpose text not null default 'contact' check (purpose in ('contact', 'consultation', 'lead', 'appointment'));
alter table website_form_submissions add column form_id text check (char_length(form_id) <= 40);

drop function if exists app.submit_site_form(text, text, text, text, text, text, text, boolean, boolean, text, text, jsonb, text, text);
create or replace function app.submit_site_form(
  p_host text, p_page text, p_name text, p_email text, p_phone text, p_service text, p_message text,
  p_consent boolean, p_marketing boolean, p_consent_text text, p_ip_hash text, p_utm jsonb, p_referrer text, p_dedupe text,
  p_purpose text default 'contact', p_form_id text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  s record;
  v_id uuid;
  v_purpose text := case when p_purpose in ('contact', 'consultation', 'lead', 'appointment') then p_purpose else 'contact' end;
begin
  select * into s from app.site_by_host(p_host) limit 1;
  if not found then return jsonb_build_object('status', 'unknown_host'); end if;
  if coalesce((s.content -> 'form' ->> 'enabled')::boolean, false) is not true then return jsonb_build_object('status', 'disabled'); end if;
  if p_consent is not true then return jsonb_build_object('status', 'consent_required'); end if;
  insert into website_form_submissions (org_id, website_id, publication_id, host, page_slug, name, email, phone, service, message, consent, marketing_opt_in, consent_text, utm, referrer, ip_hash, dedupe_key, purpose, form_id)
  values (s.org_id, s.website_id, s.publication_id, lower(p_host), left(p_page, 40), left(p_name, 120), nullif(left(p_email, 320), ''), nullif(left(p_phone, 30), ''), nullif(left(p_service, 60), ''),
          left(p_message, 2000), true, coalesce(p_marketing, false), left(p_consent_text, 300), coalesce(p_utm, '{}'::jsonb), nullif(left(p_referrer, 300), ''), left(p_ip_hash, 80), p_dedupe, v_purpose, nullif(left(p_form_id, 40), ''))
  on conflict (website_id, dedupe_key) do nothing
  returning id into v_id;
  if v_id is null then return jsonb_build_object('status', 'duplicate'); end if;
  insert into website_usage_daily (website_id, org_id, day, form_submissions) values (s.website_id, s.org_id, (now() at time zone 'utc')::date, 1)
  on conflict (website_id, day) do update set form_submissions = website_usage_daily.form_submissions + 1;
  return jsonb_build_object('status', 'ok', 'id', v_id);
end $$;
revoke all on function app.submit_site_form(text, text, text, text, text, text, text, boolean, boolean, text, text, jsonb, text, text, text, text) from public;
grant execute on function app.submit_site_form(text, text, text, text, text, text, text, boolean, boolean, text, text, jsonb, text, text, text, text) to iaq_site_runtime;

-- The new columns are visible to people who may see enquiries.
grant select (purpose, form_id) on website_form_submissions to iaq_app_user;

-- ---------------------------------------------------------------------------
-- Row level security. Clients read; trusted server code writes.
-- ---------------------------------------------------------------------------

alter table website_templates enable row level security;
alter table website_template_versions enable row level security;
alter table website_patterns enable row level security;
alter table website_components enable row level security;
alter table website_comments enable row level security;
revoke all on website_templates, website_template_versions, website_patterns, website_components, website_comments from public, anon, authenticated, iaq_site_runtime;

-- Everyone signed in may read the published library (never a draft). The preview image is part of the row, so it follows the same rule.
grant select (id, key, kind, name, description, family, industries, tags, status, featured, version, based_on, published_at, updated_at, preview_mime) on website_templates to iaq_app_user;
create policy website_templates_select on website_templates for select to iaq_app_user using (status = 'published' or app.is_agency_staff());
-- Template content is read by trusted server code only (a client's site copies it; it is never sent to a client's browser until it has become their own).
grant select (id, name, category, status, updated_at) on website_patterns to iaq_app_user;
create policy website_patterns_select on website_patterns for select to iaq_app_user using (status = 'published' or app.is_agency_staff());
grant select on website_template_versions to iaq_app_user;
create policy website_template_versions_select on website_template_versions for select to iaq_app_user using (app.is_agency_staff());

grant select on website_components to iaq_app_user;
create policy website_components_select on website_components for select to iaq_app_user using (deleted_at is null and app.has_permission(org_id, 'website.view'));
grant select on website_comments to iaq_app_user;
create policy website_comments_select on website_comments for select to iaq_app_user using (app.has_permission(org_id, 'website.view'));
