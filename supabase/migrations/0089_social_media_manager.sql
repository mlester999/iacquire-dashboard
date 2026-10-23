-- Phase 4: the AI social media manager.
--
--   * social_accounts: a connected Facebook Page or Instagram professional account. The access token is stored AES-GCM encrypted in a column the
--     application role cannot read; status says honestly whether the connection works (connected, needs_reauth, error, revoked, disconnected).
--   * social_oauth_states: single-use sign-in state for the provider's authorization flow, plus the encrypted list of Pages the person may choose from.
--   * social_posts: drafts through published posts, with an approval that is bound to the exact version that was approved.
--   * social_post_events: the publishing history and the audit trail of every approval and publication.
--   * social_publish_jobs: durable, leased, idempotent publishing jobs (one active job per post), with the step-by-step state a restarted worker resumes from.
--   * social_media_assets, social_campaigns, social_post_metrics, social_ai_runs, social_settings.
--   * Six permissions (social.*), five notification kinds, and the private-file bucket `social-media` for managed media.
--
-- Additive. No existing row changes. Every table is workspace-keyed with composite foreign keys, has row-level security, and gives the application role
-- SELECT only: every write runs in trusted server code after its own authorization check. Nothing here contacts a provider.

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------

-- View: the whole team and the agency. Create (drafts, AI drafts, submit for approval): owner, manager, team member, sales rep and the agency. Approve:
-- only the client's owner and manager (the agency never approves what a client publishes). Publish (schedule, reschedule, cancel, retry an approved post):
-- owner, manager and the agency's managers. Connect and settings: the client's own owner and manager (the account belongs to the client); owner for settings.
insert into role_permissions (role, permission) values
  ('owner', 'social.view'), ('admin', 'social.view'), ('member', 'social.view'), ('sales_rep', 'social.view'), ('support', 'social.view'), ('viewer', 'social.view'),
  ('appointment_setter', 'social.view'), ('agency_staff', 'social.view'), ('agency_manager', 'social.view'), ('agency_super_admin', 'social.view'),
  ('owner', 'social.create'), ('admin', 'social.create'), ('member', 'social.create'), ('sales_rep', 'social.create'),
  ('agency_staff', 'social.create'), ('agency_manager', 'social.create'), ('agency_super_admin', 'social.create'),
  ('owner', 'social.approve'), ('admin', 'social.approve'),
  ('owner', 'social.publish'), ('admin', 'social.publish'), ('agency_manager', 'social.publish'), ('agency_super_admin', 'social.publish'),
  ('owner', 'social.connect'), ('admin', 'social.connect'),
  ('owner', 'social.settings')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

create table social_settings (
  org_id uuid primary key references organizations(id) on delete cascade,
  -- Posts written by people without the publish permission always need approval. This also requires it of people who could publish: off by default for them.
  approval_for_publishers boolean not null default false,
  -- AI drafts always need a person's approval, whatever this says: there is no setting that lets an AI draft publish itself.
  ai_drafts_enabled boolean not null default true,
  tracking_links boolean not null default true,
  default_hashtags text[] not null default '{}' check (cardinality(default_hashtags) <= 10),
  brand_voice_note text check (char_length(brand_voice_note) <= 600),
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null
);

-- ---------------------------------------------------------------------------
-- Accounts and the sign-in flow
-- ---------------------------------------------------------------------------

create table social_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  platform text not null check (platform in ('facebook', 'instagram')),
  -- meta: the real Graph API. simulated: a local stand-in used by tests and QA, refused in production.
  adapter text not null default 'meta' check (adapter in ('meta', 'simulated')),
  external_id text not null check (char_length(external_id) between 1 and 80),
  name text not null check (char_length(name) between 1 and 200),
  username text check (char_length(username) <= 120),
  avatar_url text check (char_length(avatar_url) <= 500),
  parent_account_id uuid,
  -- AES-GCM encrypted JSON. Never readable by the application role, never returned to a browser, null once disconnected or revoked.
  credentials text,
  token_expires_at timestamptz,
  data_access_expires_at timestamptz,
  scopes text[] not null default '{}',
  -- The provider's id of the person who authorized the connection: how a deauthorization callback finds the accounts it affects.
  provider_user_id text check (char_length(provider_user_id) <= 80),
  status text not null default 'connected' check (status in ('connected', 'needs_reauth', 'error', 'revoked', 'disconnected')),
  status_detail text check (char_length(status_detail) <= 400),
  last_checked_at timestamptz,
  last_success_at timestamptz,
  connected_by uuid references users(id) on delete set null,
  connected_at timestamptz not null default now(),
  -- What the provider last said about its limits: { quotaUsage, quotaTotal, checkedAt, blockedUntil }. Read, never assumed.
  rate_state jsonb not null default '{}'::jsonb check (jsonb_typeof(rate_state) = 'object' and pg_column_size(rate_state) <= 2048),
  -- What this account can do given the permissions actually granted: { contentTypes: [...], insights: bool }.
  capabilities jsonb not null default '{}'::jsonb check (jsonb_typeof(capabilities) = 'object' and pg_column_size(capabilities) <= 4096),
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (parent_account_id, org_id) references social_accounts (id, org_id) on delete set null (parent_account_id)
);
create unique index social_accounts_live_idx on social_accounts (org_id, platform, external_id) where status <> 'disconnected';
create index social_accounts_provider_user_idx on social_accounts (provider_user_id) where provider_user_id is not null and status in ('connected', 'needs_reauth', 'error');
create trigger social_accounts_touch before update on social_accounts for each row execute function app.touch_updated_at();

create table social_oauth_states (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  platform text not null check (platform in ('facebook', 'instagram')),
  -- sha256 of the state value handed to the provider; the value itself is not stored.
  state_hash text not null unique check (state_hash ~ '^[0-9a-f]{64}$'),
  return_path text not null default '/social/accounts' check (char_length(return_path) <= 200),
  -- After the provider sends the person back: the Pages (and their tokens) they may choose from, encrypted, for ten minutes. The scheduler clears it once the
  -- state has expired, and a deauthorization or data-deletion callback clears the ones that belong to that platform user.
  pending text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index social_oauth_states_user_idx on social_oauth_states (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Campaigns and media
-- ---------------------------------------------------------------------------

create table social_campaigns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  goal text check (char_length(goal) <= 400),
  -- The utm_campaign value its posts' links carry (lower case, hyphens).
  utm_campaign text not null check (utm_campaign ~ '^[a-z0-9][a-z0-9_-]{0,59}$'),
  starts_on date,
  ends_on date,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  check (ends_on is null or starts_on is null or ends_on >= starts_on)
);
create unique index social_campaigns_utm_idx on social_campaigns (org_id, utm_campaign) where status = 'active';

create table social_media_assets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  -- managed: bytes in the workspace's private storage. google_drive / onedrive: a file in the client's own drive (reference only).
  source text not null default 'managed' check (source in ('managed', 'google_drive', 'onedrive')),
  -- A removed asset keeps this until its stored file is really deleted (the scheduler retries a failed delete), then it is cleared.
  private_file_id uuid,
  external_ref text check (char_length(external_ref) <= 400),
  kind text not null check (kind in ('image', 'video')),
  filename text not null check (char_length(filename) between 1 and 200),
  mime_type text not null check (char_length(mime_type) <= 120),
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 52428800),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  duration_seconds numeric(8, 2) check (duration_seconds is null or duration_seconds > 0),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  alt_text text check (char_length(alt_text) <= 400),
  status text not null default 'ready' check (status in ('ready', 'invalid', 'removed')),
  -- Per platform: { facebook: { ok, problems: [] }, instagram: { ok, problems: [] } }.
  validation jsonb not null default '{}'::jsonb check (jsonb_typeof(validation) = 'object' and pg_column_size(validation) <= 4096),
  uploaded_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (private_file_id, org_id) references private_files (id, org_id) on delete set null (private_file_id),
  check (source <> 'managed' or private_file_id is not null or status = 'removed')
);
create index social_media_assets_org_idx on social_media_assets (org_id, created_at desc) where status <> 'removed';

-- ---------------------------------------------------------------------------
-- Posts
-- ---------------------------------------------------------------------------

create table social_ai_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  kind text not null check (kind in ('ideas', 'caption', 'variations')),
  brief jsonb not null default '{}'::jsonb check (jsonb_typeof(brief) = 'object' and pg_column_size(brief) <= 4096),
  -- What the model returned, after the checks that remove unsupported claims. Suggestions only: nothing here is a post.
  output jsonb not null default '{}'::jsonb check (pg_column_size(output) <= 32768),
  status text not null check (status in ('succeeded', 'failed')),
  failure text check (char_length(failure) <= 400),
  created_at timestamptz not null default now(),
  unique (id, org_id)
);

create table social_posts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  account_id uuid not null,
  campaign_id uuid,
  kind text not null check (kind in ('text', 'link', 'image', 'video')),
  caption text not null default '' check (char_length(caption) <= 63206),
  hashtags text[] not null default '{}' check (cardinality(hashtags) <= 30),
  -- https only; the scheme may be written in any case (HTTPS://...), and the application lower-cases it on the way in.
  link_url text check (link_url is null or (link_url ~* '^https://' and char_length(link_url) <= 1000)),
  -- A short code carried in the link as utm_content, so a lead that arrives from this post can be tied back to it.
  tracking_code text check (tracking_code is null or tracking_code ~ '^[a-z0-9]{8}$'),
  media_asset_ids uuid[] not null default '{}' check (cardinality(media_asset_ids) <= 10),
  status text not null default 'draft' check (status in ('draft', 'pending_approval', 'changes_requested', 'approved', 'scheduled', 'publishing', 'needs_reconciliation', 'published', 'failed', 'cancelled', 'rejected')),
  scheduled_at timestamptz,
  -- The time zone the person scheduled in, for display. The instant above is what publishing uses.
  timezone text check (char_length(timezone) <= 64),
  origin text not null default 'human' check (origin in ('human', 'ai')),
  ai_run_id uuid,
  author_id uuid references users(id) on delete set null,
  -- Bumps on every change to what will be posted. An approval names the version it approved; a changed post needs approving again.
  version integer not null default 1 check (version >= 1),
  approved_version integer,
  approved_by uuid references users(id) on delete set null,
  approved_at timestamptz,
  decision_note text check (char_length(decision_note) <= 600),
  provider_post_id text check (char_length(provider_post_id) <= 120),
  permalink text check (char_length(permalink) <= 500),
  published_at timestamptz,
  failure_code text check (char_length(failure_code) <= 60),
  failure_message text check (char_length(failure_message) <= 400),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (account_id, org_id) references social_accounts (id, org_id) on delete restrict,
  foreign key (campaign_id, org_id) references social_campaigns (id, org_id) on delete set null (campaign_id),
  foreign key (ai_run_id, org_id) references social_ai_runs (id, org_id) on delete set null (ai_run_id),
  check (status <> 'published' or provider_post_id is not null),
  check (status not in ('scheduled', 'publishing', 'needs_reconciliation') or (scheduled_at is not null and approved_version is not null)),
  check (approved_version is null or approved_version <= version)
);
create index social_posts_org_idx on social_posts (org_id, coalesce(scheduled_at, created_at) desc);
create index social_posts_account_idx on social_posts (account_id, status);
create index social_posts_due_idx on social_posts (scheduled_at) where status = 'scheduled';
-- The same provider post can never be recorded against two posts of one account.
create unique index social_posts_provider_post_idx on social_posts (account_id, provider_post_id) where provider_post_id is not null;
create unique index social_posts_tracking_idx on social_posts (org_id, tracking_code) where tracking_code is not null;
create trigger social_posts_touch before update on social_posts for each row execute function app.touch_updated_at();

create table social_post_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  post_id uuid not null,
  at timestamptz not null default now(),
  kind text not null check (char_length(kind) between 1 and 40),
  actor_id uuid references users(id) on delete set null,
  actor_kind text not null default 'user' check (actor_kind in ('user', 'ai', 'system')),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 2048),
  foreign key (post_id, org_id) references social_posts (id, org_id) on delete cascade
);
create index social_post_events_post_idx on social_post_events (post_id, id);

-- ---------------------------------------------------------------------------
-- Durable publishing
-- ---------------------------------------------------------------------------

create table social_publish_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  post_id uuid not null,
  account_id uuid not null,
  post_version integer not null,
  -- post id : version : scheduled instant. A redelivered or doubled request for the same publication names the same key and finds the same job.
  idempotency_key text not null unique check (char_length(idempotency_key) <= 120),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'unknown')),
  run_at timestamptz not null default now(),
  attempt integer not null default 0 check (attempt >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 10),
  -- A worker holds the job until the lease runs out. A worker that dies simply stops renewing; another takes the job over, resuming from `state`.
  lease_until timestamptz,
  claimed_by text check (char_length(claimed_by) <= 80),
  -- The steps already done at the provider (container created, object created, publish sent), so a resumed job continues rather than repeats.
  state jsonb not null default '{}'::jsonb check (jsonb_typeof(state) = 'object' and pg_column_size(state) <= 4096),
  last_error text check (char_length(last_error) <= 400),
  last_error_kind text check (last_error_kind in ('rate_limited', 'auth', 'permission', 'invalid_content', 'transient', 'unknown_outcome', 'blocked')),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  foreign key (post_id, org_id) references social_posts (id, org_id) on delete cascade,
  foreign key (account_id, org_id) references social_accounts (id, org_id) on delete restrict
);
-- One live job per post: a second worker, a double click or a retry cannot start a parallel publication.
create unique index social_publish_jobs_active_idx on social_publish_jobs (post_id) where status in ('queued', 'running', 'unknown');
create index social_publish_jobs_due_idx on social_publish_jobs (run_at) where status = 'queued';
create index social_publish_jobs_lease_idx on social_publish_jobs (lease_until) where status = 'running';

create table social_post_metrics (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  post_id uuid not null,
  fetched_at timestamptz not null default now(),
  -- Only the numbers the provider returned: { reach, impressions, likes, comments, shares, clicks, ... }. A number it did not return is absent, not zero.
  metrics jsonb not null default '{}'::jsonb check (jsonb_typeof(metrics) = 'object' and pg_column_size(metrics) <= 2048),
  source text not null check (source in ('meta', 'simulated')),
  foreign key (post_id, org_id) references social_posts (id, org_id) on delete cascade
);
create index social_post_metrics_post_idx on social_post_metrics (post_id, fetched_at desc);

-- ---------------------------------------------------------------------------
-- Row-level security: read under the signed-in member's access, write only from trusted server code
-- ---------------------------------------------------------------------------

alter table social_settings enable row level security;
alter table social_accounts enable row level security;
alter table social_oauth_states enable row level security;
alter table social_campaigns enable row level security;
alter table social_media_assets enable row level security;
alter table social_ai_runs enable row level security;
alter table social_posts enable row level security;
alter table social_post_events enable row level security;
alter table social_publish_jobs enable row level security;
alter table social_post_metrics enable row level security;

revoke all on social_settings, social_accounts, social_oauth_states, social_campaigns, social_media_assets, social_ai_runs, social_posts, social_post_events, social_publish_jobs, social_post_metrics
  from public, anon, authenticated;
-- The sign-in state and its encrypted choices are server-only: no grant at all.
grant select on social_settings, social_campaigns, social_media_assets, social_ai_runs, social_posts, social_post_events, social_publish_jobs, social_post_metrics to iaq_app_user;
-- An account is readable except its credentials.
grant select (id, org_id, platform, adapter, external_id, name, username, avatar_url, parent_account_id, token_expires_at, data_access_expires_at, scopes, provider_user_id, status,
  status_detail, last_checked_at, last_success_at, connected_by, connected_at, rate_state, capabilities, disconnected_at, created_at, updated_at) on social_accounts to iaq_app_user;

create policy social_settings_select on social_settings for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('social.view'::text))::uuid[]));
create policy social_accounts_select on social_accounts for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('social.view'::text))::uuid[]));
create policy social_campaigns_select on social_campaigns for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('social.view'::text))::uuid[]));
create policy social_media_assets_select on social_media_assets for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('social.view'::text))::uuid[]));
create policy social_ai_runs_select on social_ai_runs for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('social.view'::text))::uuid[]));
create policy social_posts_select on social_posts for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('social.view'::text))::uuid[]));
create policy social_post_events_select on social_post_events for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('social.view'::text))::uuid[]));
create policy social_publish_jobs_select on social_publish_jobs for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('social.view'::text))::uuid[]));
create policy social_post_metrics_select on social_post_metrics for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('social.view'::text))::uuid[]));

-- ---------------------------------------------------------------------------
-- Managed media storage: the private-file bucket and who may use it
-- ---------------------------------------------------------------------------

alter table private_files drop constraint if exists private_files_bucket_check;
alter table private_files add constraint private_files_bucket_check
  check (bucket in ('company-documents', 'support-attachments', 'project-files', 'project-uploads', 'portfolio-assets', 'brand-assets', 'aqi-attachments', 'social-media'));

-- 0049's definition, with one more bucket: reading needs social.view, writing needs social.create.
create or replace function app.file_permission(p_org uuid, p_bucket text, p_write boolean, p_visibility text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (p_visibility = 'client' or app.staff_assigned(p_org)) and
    case p_bucket
      when 'company-documents' then app.has_permission(p_org, case when p_write then 'knowledge.edit' else 'knowledge.view' end)
      when 'support-attachments' then
        case when app.is_agency_staff() then
          app.user_can_access_org(app.current_user_id(), p_org)
          and app.user_has_agency_permission(app.current_user_id(), case when p_write then 'agency.support.manage' else 'agency.support.view' end)
          and (p_visibility = 'client' or p_visibility = 'internal')
        else p_visibility = 'client' and app.has_permission(p_org, 'support.use') end
      when 'project-files' then case when p_write then app.staff_assigned(p_org) else app.has_permission(p_org, 'setup.view') end
      when 'project-uploads' then
        case when app.is_agency_staff() then
          app.staff_assigned(p_org)
          and app.user_can_access_org(app.current_user_id(), p_org)
          and app.user_has_agency_permission(app.current_user_id(), 'projects.view')
          and app.user_has_agency_permission(app.current_user_id(), case when p_write then 'projects.manage' else 'projects.view' end)
        else app.has_permission(p_org, case when p_write then 'projects.request' else 'projects.view' end) end
      when 'portfolio-assets' then app.is_agency_admin()
      when 'brand-assets' then app.has_permission(p_org, case when p_write then 'workspace.manage_profile' else 'workspace.view' end)
      when 'aqi-attachments' then
        not app.is_agency_staff() and app.has_permission(p_org, 'agents.use')
      when 'social-media' then app.has_permission(p_org, case when p_write then 'social.create' else 'social.view' end)
      else false end,
    false)
$$;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('social-media', 'social-media', false, 52428800, array['image/png', 'image/jpeg', 'image/webp', 'video/mp4'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Notification kinds
-- ---------------------------------------------------------------------------

-- Read back from the live constraint and extended, never rewritten from a copy (see 0083 and 0087).
do $$
declare
  def text;
  kinds text[];
  literal text;
begin
  select pg_get_constraintdef(c.oid) into def from pg_constraint c where c.conname = 'notifications_kind_check' and c.conrelid = 'notifications'::regclass;
  if def is null then
    raise exception 'notifications_kind_check not found; cannot extend the notification kinds';
  end if;
  kinds := array(select m[1] from regexp_matches(def, '''([a-z0-9_]+)''::text', 'g') as m);
  if cardinality(kinds) = 0 then
    literal := substring(def from '''\{([^}]*)\}''::text\[\]');
    if literal is not null then
      kinds := string_to_array(literal, ',');
    end if;
  end if;
  if kinds is null or cardinality(kinds) < 20 then
    raise exception 'could not read the current notification kinds from notifications_kind_check (read %); refusing to rewrite it', coalesce(cardinality(kinds), 0);
  end if;
  kinds := array(select distinct k from unnest(kinds || array['social_approval_requested', 'social_approval_decided', 'social_post_published', 'social_post_failed', 'social_account_attention']) as k order by k);
  alter table notifications drop constraint notifications_kind_check;
  execute 'alter table notifications add constraint notifications_kind_check check (kind in (' || (select string_agg(quote_literal(k), ', ' order by k) from unnest(kinds) as k) || '))';
end $$;
