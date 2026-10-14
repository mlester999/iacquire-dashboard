-- Custom Projects & Add-ons: service catalog, price history, founder portfolio, project requests,
-- quotes, delivery tracking and optional managed maintenance. Additive: no existing data is changed.
--
-- Access model (same as the rest of the portal): writes run through trusted server code after its own
-- authorization; iaq_app_user only receives SELECT, narrowed by row-level security and, for
-- agency-only fields (internal notes), by column grants.

-- ---------------------------------------------------------------------------
-- Permissions, notification kinds, support categories, private buckets
-- ---------------------------------------------------------------------------

insert into role_permissions (role, permission) values
  ('owner', 'projects.view'), ('admin', 'projects.view'), ('member', 'projects.view'),
  ('agency_staff', 'projects.view'), ('agency_super_admin', 'projects.view'),
  ('owner', 'projects.request'), ('admin', 'projects.request'),
  ('owner', 'projects.approve_quote'),
  ('agency_staff', 'projects.manage'), ('agency_super_admin', 'projects.manage'),
  ('agency_staff', 'quotes.manage'), ('agency_super_admin', 'quotes.manage'),
  ('agency_super_admin', 'catalog.manage'),
  ('agency_super_admin', 'portfolio.manage'),
  ('owner', 'maintenance.view'), ('admin', 'maintenance.view'),
  ('agency_staff', 'maintenance.view'), ('agency_super_admin', 'maintenance.view'),
  ('owner', 'maintenance.request'), ('admin', 'maintenance.request'),
  ('owner', 'maintenance.manage_plan'),
  ('agency_staff', 'maintenance.manage'), ('agency_super_admin', 'maintenance.manage');

alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in (
  'agent_task_completed', 'lead_awaiting_approval', 'booking_confirmed', 'workflow_failure',
  'knowledge_update_ready', 'support_reply', 'support_ticket_created', 'integration_disconnected',
  'usage_limit_approaching', 'approval_requested', 'approval_decided', 'agent_status', 'system',
  'setup_milestone', 'setup_action_required', 'setup_issue', 'setup_ready',
  'project_submitted', 'project_update', 'project_quote', 'project_decision', 'project_message',
  'maintenance_update'));

alter table support_tickets drop constraint support_tickets_category_check;
alter table support_tickets add constraint support_tickets_category_check check (category in (
  'general', 'ai_employees', 'integrations', 'billing', 'account', 'bug', 'onboarding', 'project', 'maintenance'));

alter table private_files drop constraint private_files_bucket_check;
alter table private_files add constraint private_files_bucket_check
  check (bucket in ('company-documents', 'support-attachments', 'project-files', 'project-uploads', 'portfolio-assets'));

create or replace function app.file_permission(p_org uuid, p_bucket text, p_write boolean, p_visibility text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (p_visibility = 'client' or app.staff_assigned(p_org)) and
    case p_bucket
      when 'company-documents' then app.has_permission(p_org, case when p_write then 'knowledge.edit' else 'knowledge.view' end)
      when 'support-attachments' then app.has_permission(p_org, 'support.use') or app.staff_assigned(p_org)
      when 'project-files' then case when p_write then app.staff_assigned(p_org) else app.has_permission(p_org, 'setup.view') end
      when 'project-uploads' then app.has_permission(p_org, case when p_write then 'projects.request' else 'projects.view' end) or app.staff_assigned(p_org)
      -- Portfolio images belong to the agency organization and are never exposed by direct storage access.
      when 'portfolio-assets' then app.is_agency_admin()
      else false end,
    false)
$$;
grant execute on function app.file_permission(uuid,text,boolean,text) to iaq_app_user;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values
  ('project-uploads','project-uploads',false,10485760,array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/png','image/jpeg','text/plain','text/markdown','text/csv']),
  ('portfolio-assets','portfolio-assets',false,10485760,array['image/png','image/jpeg','image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Service catalog (global, editable by the agency, versioned prices)
-- ---------------------------------------------------------------------------

create table service_categories (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9_]{2,40}$'),
  name text not null check (char_length(name) between 2 and 80),
  description text not null default '' check (char_length(description) <= 600),
  tier text not null check (tier in ('ready_to_use', 'custom', 'maintenance')),
  sort_order integer not null default 0,
  visible boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger service_categories_touch before update on service_categories for each row execute function app.touch_updated_at();

create table service_catalog (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references service_categories(id),
  slug text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$'),
  kind text not null default 'ready_system' check (kind in ('ready_system', 'custom_build', 'maintenance_plan')),
  name text not null check (char_length(name) between 2 and 120),
  tagline text not null default '' check (char_length(tagline) <= 300),
  description text not null default '' check (char_length(description) <= 2000),
  problem_solved text not null default '' check (char_length(problem_solved) <= 600),
  accomplishes text[] not null default '{}',
  deliverables text[] not null default '{}',
  exclusions text[] not null default '{}',
  optional_upgrades text[] not null default '{}',
  platforms text[] not null default '{}',
  use_cases text[] not null default '{}',
  tags text[] not null default '{}',
  keywords text[] not null default '{}',
  delivery_min_days integer check (delivery_min_days > 0),
  delivery_max_days integer check (delivery_max_days > 0),
  availability text not null default 'available' check (availability in ('available', 'coming_soon', 'unavailable')),
  featured boolean not null default false,
  requires_quote boolean not null default true,
  visible boolean not null default true,
  core_overlap_note text check (char_length(core_overlap_note) <= 500),
  source_note text check (char_length(source_note) <= 300),
  plan_config jsonb not null default '{}'::jsonb check (jsonb_typeof(plan_config) = 'object'),
  current_price_version_id uuid,
  sort_order integer not null default 0,
  created_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (delivery_max_days is null or delivery_min_days is null or delivery_max_days >= delivery_min_days)
);
create index service_catalog_category_idx on service_catalog (category_id, sort_order);
create trigger service_catalog_touch before update on service_catalog for each row execute function app.touch_updated_at();

-- Every price change is a new immutable row; the catalog points at the current one.
create table service_price_versions (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references service_catalog(id) on delete cascade,
  version integer not null check (version > 0),
  price_type text not null check (price_type in ('range', 'starting_at', 'monthly', 'custom_quote')),
  min_cents integer check (min_cents >= 0),
  max_cents integer check (max_cents >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  note text check (char_length(note) <= 300),
  source text not null default 'agency' check (source in ('founder_portfolio', 'agency')),
  effective_at timestamptz not null default now(),
  created_by uuid references users(id) on delete set null,
  unique (service_id, version),
  check (price_type = 'custom_quote' or min_cents is not null),
  check (price_type <> 'range' or (max_cents is not null and max_cents >= min_cents)),
  check (price_type <> 'custom_quote' or (min_cents is null and max_cents is null))
);
alter table service_catalog add constraint service_catalog_current_price_fk
  foreign key (current_price_version_id) references service_price_versions(id) deferrable initially deferred;

-- ---------------------------------------------------------------------------
-- Founder portfolio (global content, imported with an admin review step)
-- ---------------------------------------------------------------------------

create table portfolio_projects (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$'),
  title text not null check (char_length(title) between 2 and 200),
  anonymized_title text check (char_length(anonymized_title) <= 200),
  client_name_public boolean not null default false,
  summary text not null default '' check (char_length(summary) <= 1200),
  problem text not null default '' check (char_length(problem) <= 4000),
  solution text not null default '' check (char_length(solution) <= 4000),
  published_outcome text check (char_length(published_outcome) <= 600),
  sections jsonb not null default '[]'::jsonb check (jsonb_typeof(sections) = 'array' and pg_column_size(sections) <= 65536),
  limitations text[] not null default '{}',
  privacy_note text check (char_length(privacy_note) <= 600),
  technologies text[] not null default '{}',
  categories text[] not null default '{}',
  project_status text not null default 'built' check (project_status in ('built', 'in_development', 'built_locally', 'planned')),
  status_label text check (char_length(status_label) <= 60),
  live_demo_url text check (live_demo_url ~ '^https://'),
  attribution text not null default 'Selected Work from Our Founder' check (char_length(attribution) <= 120),
  source_url text check (source_url ~ '^https://'),
  source_imported_at timestamptz,
  featured boolean not null default false,
  review_state text not null default 'pending_review' check (review_state in ('pending_review', 'approved')),
  disclosure_confirmed boolean not null default false,
  visible boolean not null default false,
  sort_order integer not null default 0,
  created_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Nothing reaches clients until an admin has reviewed it and confirmed public disclosure is permitted.
  check (not visible or (review_state = 'approved' and disclosure_confirmed))
);
create index portfolio_projects_visible_idx on portfolio_projects (visible, featured desc, sort_order);
create trigger portfolio_projects_touch before update on portfolio_projects for each row execute function app.touch_updated_at();

create table portfolio_assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references portfolio_projects(id) on delete cascade,
  kind text not null default 'screenshot' check (kind in ('screenshot', 'cover')),
  private_file_id uuid references private_files(id),
  thumb_file_id uuid references private_files(id),
  -- Reference to the image on the source site. Not copied until an admin imports or uploads it.
  source_url text check (source_url ~ '^https://'),
  alt text not null default '' check (char_length(alt) <= 300),
  caption text check (char_length(caption) <= 300),
  width integer check (width > 0),
  height integer check (height > 0),
  anonymized boolean not null default false,
  published boolean not null default false,
  sort_order integer not null default 0,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (private_file_id is not null or source_url is not null)
);
create index portfolio_assets_project_idx on portfolio_assets (project_id, sort_order);

create table service_portfolio_links (
  service_id uuid not null references service_catalog(id) on delete cascade,
  project_id uuid not null references portfolio_projects(id) on delete cascade,
  sort_order integer not null default 0,
  primary key (service_id, project_id)
);

-- ---------------------------------------------------------------------------
-- Project requests and delivery
-- ---------------------------------------------------------------------------

create sequence project_request_ref_seq start with 1001;

create table client_project_requests (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique default ('PRJ-' || nextval('project_request_ref_seq')::text),
  org_id uuid not null references organizations(id) on delete cascade,
  created_by uuid references users(id) on delete set null,
  service_id uuid references service_catalog(id) on delete set null,
  title text not null check (char_length(title) between 3 and 160),
  summary text not null default '' check (char_length(summary) <= 4000),
  tools_used text[] not null default '{}',
  preferred_deadline date,
  budget_range text check (char_length(budget_range) <= 80),
  status text not null default 'submitted' check (status in (
    'submitted', 'under_review', 'discovery_needed', 'quote_preparing', 'quote_sent', 'awaiting_approval',
    'approved', 'in_development', 'testing', 'ready_for_review', 'completed', 'on_hold', 'cancelled')),
  status_before_hold text check (status_before_hold in (
    'submitted', 'under_review', 'discovery_needed', 'quote_preparing', 'quote_sent', 'awaiting_approval',
    'approved', 'in_development', 'testing', 'ready_for_review')),
  assigned_to uuid references users(id) on delete set null,
  suggested_service_ids uuid[] not null default '{}',
  -- Agency-only. Not granted to iaq_app_user, so clients can never read or change it.
  internal_notes text check (char_length(internal_notes) <= 8000),
  cancel_reason text check (char_length(cancel_reason) <= 500),
  submitted_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id)
);
create index project_requests_org_idx on client_project_requests (org_id, last_activity_at desc);
create index project_requests_status_idx on client_project_requests (status, last_activity_at desc);
create trigger project_requests_touch before update on client_project_requests for each row execute function app.touch_updated_at();

alter table support_tickets add column project_id uuid references client_project_requests(id) on delete set null;
create index support_tickets_project_idx on support_tickets (project_id) where project_id is not null;

create table project_requirements (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  org_id uuid not null,
  key text not null check (key ~ '^[a-z_]{2,40}$'),
  label text not null check (char_length(label) between 1 and 200),
  answer text not null default '' check (char_length(answer) <= 4000),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (request_id, key),
  foreign key (request_id, org_id) references client_project_requests (id, org_id) on delete cascade
);

create table project_review_tasks (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  org_id uuid not null,
  kind text not null check (kind in ('initial_review', 'respond_to_client', 'prepare_quote', 'review_decision')),
  title text not null check (char_length(title) <= 200),
  status text not null default 'open' check (status in ('open', 'done')),
  assigned_to uuid references users(id) on delete set null,
  due_at timestamptz,
  completed_at timestamptz,
  completed_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (request_id, org_id) references client_project_requests (id, org_id) on delete cascade
);
create index project_review_tasks_open_idx on project_review_tasks (status, created_at) where status = 'open';

create table project_quotes (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  org_id uuid not null,
  version integer not null check (version > 0),
  status text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'changes_requested', 'declined', 'superseded', 'withdrawn')),
  project_name text not null check (char_length(project_name) between 3 and 160),
  scope text not null default '' check (char_length(scope) <= 8000),
  deliverables text[] not null default '{}',
  included_integrations text[] not null default '{}',
  exclusions text[] not null default '{}',
  timeline_text text not null default '' check (char_length(timeline_text) <= 300),
  estimated_weeks_min integer check (estimated_weeks_min > 0),
  estimated_weeks_max integer check (estimated_weeks_max > 0),
  one_time_cents integer not null default 0 check (one_time_cents >= 0),
  ongoing_monthly_cents integer check (ongoing_monthly_cents >= 0),
  ongoing_description text check (char_length(ongoing_description) <= 1000),
  revision_terms text not null default '' check (char_length(revision_terms) <= 2000),
  payment_terms text not null default '' check (char_length(payment_terms) <= 2000),
  warranty_terms text not null default '' check (char_length(warranty_terms) <= 2000),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  valid_until date,
  content_hash text,
  -- Agency-only drafting notes.
  internal_notes text check (char_length(internal_notes) <= 4000),
  prepared_by uuid references users(id) on delete set null,
  sent_by uuid references users(id) on delete set null,
  sent_at timestamptz,
  first_viewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  unique (request_id, version),
  foreign key (request_id, org_id) references client_project_requests (id, org_id) on delete cascade,
  check (estimated_weeks_max is null or estimated_weeks_min is null or estimated_weeks_max >= estimated_weeks_min),
  check (status = 'draft' or (sent_at is not null and content_hash is not null))
);
-- A client only ever has one live quote to act on.
create unique index project_quotes_one_live on project_quotes (request_id) where status = 'sent';
create trigger project_quotes_touch before update on project_quotes for each row execute function app.touch_updated_at();

-- Recorded decisions. This is an acknowledgement tied to an account and timestamp, not an e-signature.
create table quote_approvals (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null,
  request_id uuid not null,
  org_id uuid not null,
  decision text not null check (decision in ('accepted', 'changes_requested', 'declined')),
  note text check (char_length(note) <= 2000),
  decided_by uuid not null references users(id),
  decided_at timestamptz not null default now(),
  content_hash text not null,
  acknowledgement text not null,
  ip_hash text,
  unique (quote_id),
  foreign key (quote_id, org_id) references project_quotes (id, org_id) on delete cascade
);
create or replace function app.quote_approvals_append_only() returns trigger
language plpgsql
as $$
begin
  raise exception 'quote_approvals is append-only' using errcode = 'insufficient_privilege';
end
$$;
create trigger quote_approvals_no_change before update or delete on quote_approvals
  for each row execute function app.quote_approvals_append_only();

create table client_projects (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  org_id uuid not null,
  quote_id uuid,
  agreed_price_cents integer not null check (agreed_price_cents >= 0),
  ongoing_monthly_cents integer check (ongoing_monthly_cents >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  scope text not null default '' check (char_length(scope) <= 8000),
  deliverables text[] not null default '{}',
  timeline_text text not null default '' check (char_length(timeline_text) <= 300),
  agreed_at timestamptz not null default now(),
  started_at timestamptz,
  expected_completion_on date,
  completed_at timestamptz,
  handover_notes text check (char_length(handover_notes) <= 4000),
  handover_recorded_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (request_id, org_id) references client_project_requests (id, org_id) on delete cascade,
  foreign key (quote_id, org_id) references project_quotes (id, org_id)
);
create trigger client_projects_touch before update on client_projects for each row execute function app.touch_updated_at();

create table project_milestones (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  org_id uuid not null,
  title text not null check (char_length(title) between 2 and 160),
  description text check (char_length(description) <= 1000),
  sort_order integer not null default 0,
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'awaiting_approval', 'completed', 'blocked')),
  due_on date,
  requires_client_approval boolean not null default false,
  client_approved_by uuid references users(id) on delete set null,
  client_approved_at timestamptz,
  client_note text check (char_length(client_note) <= 1000),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (request_id, org_id) references client_project_requests (id, org_id) on delete cascade
);
create index project_milestones_request_idx on project_milestones (request_id, sort_order);
create trigger project_milestones_touch before update on project_milestones for each row execute function app.touch_updated_at();

create table project_updates (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  org_id uuid not null,
  author_id uuid references users(id) on delete set null,
  kind text not null default 'progress' check (kind in ('progress', 'milestone', 'deliverable', 'status_change', 'handover', 'system')),
  body text not null check (char_length(body) between 1 and 4000),
  visibility text not null default 'client' check (visibility in ('client', 'internal')),
  created_at timestamptz not null default now(),
  foreign key (request_id, org_id) references client_project_requests (id, org_id) on delete cascade
);
create index project_updates_request_idx on project_updates (request_id, created_at desc);

create table project_files (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  org_id uuid not null,
  private_file_id uuid not null,
  kind text not null default 'reference' check (kind in ('requirement', 'reference', 'deliverable', 'handover')),
  visibility text not null default 'client' check (visibility in ('client', 'internal')),
  description text check (char_length(description) <= 300),
  uploaded_by uuid references users(id) on delete set null,
  uploaded_by_kind text not null check (uploaded_by_kind in ('client', 'agency')),
  created_at timestamptz not null default now(),
  unique (private_file_id),
  foreign key (request_id, org_id) references client_project_requests (id, org_id) on delete cascade,
  foreign key (private_file_id, org_id) references private_files (id, org_id)
);
create index project_files_request_idx on project_files (request_id, created_at);

create table project_messages (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  org_id uuid not null,
  author_id uuid references users(id) on delete set null,
  author_kind text not null check (author_kind in ('client', 'agency', 'system')),
  kind text not null default 'message' check (kind in ('message', 'info_request', 'info_response')),
  body text not null check (char_length(body) between 1 and 5000),
  internal boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (request_id, org_id) references client_project_requests (id, org_id) on delete cascade,
  check (not internal or author_kind = 'agency')
);
create index project_messages_request_idx on project_messages (request_id, created_at);

-- ---------------------------------------------------------------------------
-- Optional managed maintenance
-- ---------------------------------------------------------------------------

create table maintenance_subscriptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  plan_service_id uuid references service_catalog(id) on delete set null,
  status text not null default 'requested' check (status in ('requested', 'active', 'cancel_requested', 'cancelled', 'declined')),
  monthly_price_cents integer not null check (monthly_price_cents >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  monthly_request_allowance integer not null check (monthly_request_allowance >= 0),
  terms_version text not null,
  accepted_by uuid not null references users(id),
  accepted_at timestamptz not null default now(),
  request_note text check (char_length(request_note) <= 1000),
  activated_by uuid references users(id) on delete set null,
  activated_at timestamptz,
  billing_start_on date,
  renewal_on date,
  cancel_requested_by uuid references users(id) on delete set null,
  cancel_requested_at timestamptz,
  cancel_note text check (char_length(cancel_note) <= 1000),
  cancelled_at timestamptz,
  internal_notes text check (char_length(internal_notes) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  check (status <> 'active' or (activated_at is not null and billing_start_on is not null))
);
create unique index maintenance_one_open_plan on maintenance_subscriptions (org_id) where status in ('requested', 'active', 'cancel_requested');
create trigger maintenance_subscriptions_touch before update on maintenance_subscriptions for each row execute function app.touch_updated_at();

create sequence maintenance_request_ref_seq start with 1001;
create table maintenance_requests (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique default ('MNT-' || nextval('maintenance_request_ref_seq')::text),
  org_id uuid not null references organizations(id) on delete cascade,
  subscription_id uuid,
  kind text not null check (kind in ('core_defect', 'managed_change')),
  title text not null check (char_length(title) between 3 and 160),
  description text not null default '' check (char_length(description) <= 4000),
  status text not null default 'open' check (status in ('open', 'in_progress', 'waiting_for_client', 'completed', 'declined')),
  ticket_id uuid references support_tickets(id) on delete set null,
  counts_against_allowance boolean not null default false,
  period_month date not null default date_trunc('month', now())::date,
  created_by uuid references users(id) on delete set null,
  assigned_to uuid references users(id) on delete set null,
  resolution_note text check (char_length(resolution_note) <= 2000),
  internal_notes text check (char_length(internal_notes) <= 4000),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (subscription_id, org_id) references maintenance_subscriptions (id, org_id),
  -- Confirmed defects in the original setup are never charged to the managed-maintenance allowance.
  check (kind <> 'core_defect' or not counts_against_allowance),
  check (kind <> 'managed_change' or subscription_id is not null)
);
create index maintenance_requests_org_idx on maintenance_requests (org_id, created_at desc);
create trigger maintenance_requests_touch before update on maintenance_requests for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table service_categories enable row level security;
alter table service_catalog enable row level security;
alter table service_price_versions enable row level security;
alter table portfolio_projects enable row level security;
alter table portfolio_assets enable row level security;
alter table service_portfolio_links enable row level security;
alter table client_project_requests enable row level security;
alter table project_requirements enable row level security;
alter table project_review_tasks enable row level security;
alter table project_quotes enable row level security;
alter table quote_approvals enable row level security;
alter table client_projects enable row level security;
alter table project_milestones enable row level security;
alter table project_updates enable row level security;
alter table project_files enable row level security;
alter table project_messages enable row level security;
alter table maintenance_subscriptions enable row level security;
alter table maintenance_requests enable row level security;

revoke all on service_categories, service_catalog, service_price_versions, portfolio_projects, portfolio_assets,
  service_portfolio_links, client_project_requests, project_requirements, project_review_tasks, project_quotes,
  quote_approvals, client_projects, project_milestones, project_updates, project_files, project_messages,
  maintenance_subscriptions, maintenance_requests from public, anon, authenticated;

-- Catalog and portfolio: any signed-in user sees what the agency has published; staff see everything.
grant select on service_categories to iaq_app_user;
create policy service_categories_select on service_categories for select to iaq_app_user
  using (app.current_user_id() is not null and (visible or app.is_agency_staff()));

grant select on service_catalog to iaq_app_user;
create policy service_catalog_select on service_catalog for select to iaq_app_user
  using (app.current_user_id() is not null and (visible or app.is_agency_staff()));

grant select on service_price_versions to iaq_app_user;
create policy service_price_versions_select on service_price_versions for select to iaq_app_user
  using (exists (select 1 from service_catalog s where s.id = service_id));

grant select on portfolio_projects to iaq_app_user;
create policy portfolio_projects_select on portfolio_projects for select to iaq_app_user
  using (app.current_user_id() is not null and (visible or app.is_agency_staff()));

grant select (id, project_id, kind, alt, caption, width, height, anonymized, published, sort_order, created_at) on portfolio_assets to iaq_app_user;
create policy portfolio_assets_select on portfolio_assets for select to iaq_app_user
  using ((published or app.is_agency_staff()) and exists (select 1 from portfolio_projects p where p.id = project_id));

grant select on service_portfolio_links to iaq_app_user;
create policy service_portfolio_links_select on service_portfolio_links for select to iaq_app_user
  using (exists (select 1 from service_catalog s where s.id = service_id) and exists (select 1 from portfolio_projects p where p.id = project_id));

-- Tenant project data. internal_notes and other agency-only columns are deliberately not granted.
grant select (id, ref, org_id, created_by, service_id, title, summary, tools_used, preferred_deadline, budget_range, status,
              status_before_hold, assigned_to, cancel_reason, submitted_at, last_activity_at, closed_at, created_at, updated_at)
  on client_project_requests to iaq_app_user;
create policy project_requests_select on client_project_requests for select to iaq_app_user
  using (app.has_permission(org_id, 'projects.view'));

grant select on project_requirements to iaq_app_user;
create policy project_requirements_select on project_requirements for select to iaq_app_user
  using (app.has_permission(org_id, 'projects.view'));

-- Review tasks are an agency work queue: no grants for iaq_app_user.

grant select (id, request_id, org_id, version, status, project_name, scope, deliverables, included_integrations, exclusions,
              timeline_text, estimated_weeks_min, estimated_weeks_max, one_time_cents, ongoing_monthly_cents, ongoing_description,
              revision_terms, payment_terms, warranty_terms, currency, valid_until, content_hash, sent_at, first_viewed_at, created_at)
  on project_quotes to iaq_app_user;
create policy project_quotes_select on project_quotes for select to iaq_app_user
  using (app.has_permission(org_id, 'projects.view') and (status <> 'draft' or app.staff_assigned(org_id)));

grant select (id, quote_id, request_id, org_id, decision, note, decided_by, decided_at, content_hash, acknowledgement)
  on quote_approvals to iaq_app_user;
create policy quote_approvals_select on quote_approvals for select to iaq_app_user
  using (app.has_permission(org_id, 'projects.view'));

grant select on client_projects to iaq_app_user;
create policy client_projects_select on client_projects for select to iaq_app_user
  using (app.has_permission(org_id, 'projects.view'));

grant select on project_milestones to iaq_app_user;
create policy project_milestones_select on project_milestones for select to iaq_app_user
  using (app.has_permission(org_id, 'projects.view'));

grant select on project_updates to iaq_app_user;
create policy project_updates_select on project_updates for select to iaq_app_user
  using (app.has_permission(org_id, 'projects.view') and (visibility = 'client' or app.staff_assigned(org_id)));

grant select on project_files to iaq_app_user;
create policy project_files_select on project_files for select to iaq_app_user
  using (app.has_permission(org_id, 'projects.view') and (visibility = 'client' or app.staff_assigned(org_id)));

grant select on project_messages to iaq_app_user;
create policy project_messages_select on project_messages for select to iaq_app_user
  using (app.has_permission(org_id, 'projects.view') and (not internal or app.staff_assigned(org_id)));

grant select (id, org_id, plan_service_id, status, monthly_price_cents, currency, monthly_request_allowance, terms_version,
              accepted_by, accepted_at, request_note, activated_at, billing_start_on, renewal_on, cancel_requested_at, cancelled_at, created_at)
  on maintenance_subscriptions to iaq_app_user;
create policy maintenance_subscriptions_select on maintenance_subscriptions for select to iaq_app_user
  using (app.has_permission(org_id, 'maintenance.view'));

grant select (id, ref, org_id, subscription_id, kind, title, description, status, ticket_id, counts_against_allowance, period_month,
              created_by, resolution_note, closed_at, created_at, updated_at)
  on maintenance_requests to iaq_app_user;
create policy maintenance_requests_select on maintenance_requests for select to iaq_app_user
  using (app.has_permission(org_id, 'maintenance.view'));

-- ---------------------------------------------------------------------------
-- Seed: service catalog from the founder's published portfolio
-- (https://www.automatewithmarky.com/systems and /services/ai-automation, read 2026-10-14).
-- Prices are published starting prices or ranges; final custom prices are always quoted after discovery.
-- ---------------------------------------------------------------------------

insert into service_categories (code, name, description, tier, sort_order) values
  ('ready_automations', 'Ready-to-Use Automations', 'Proven automation systems configured to your tools and accounts.', 'ready_to_use', 10),
  ('ready_ai_agents', 'Ready-to-Use AI Agents', 'Chat and voice agents that answer, qualify and book, adapted to your business.', 'ready_to_use', 20),
  ('ready_web_funnels', 'Websites, Funnels & Shopify', 'Pages, funnels and stores built to convert, with capture and follow-up wired in.', 'ready_to_use', 30),
  ('custom_automation', 'Custom Automation Systems', 'Multi-step automation and integration work designed around how your business operates.', 'custom', 40),
  ('custom_ai_agents', 'Custom AI Agents', 'Chat or voice agents with your own knowledge, tools, guardrails and handoff rules.', 'custom', 50),
  ('custom_web_saas', 'Custom Web, SaaS & Shopify', 'Custom applications, portals, platforms and storefronts built around your product.', 'custom', 60),
  ('managed_maintenance', 'Managed Maintenance', 'Optional ongoing monitoring, fixes and improvements for your iAcquire system.', 'maintenance', 90);

create temp table _svc (
  slug text, category text, kind text, name text, tagline text, problem text, accomplishes text[], deliverables text[],
  exclusions text[], upgrades text[], platforms text[], use_cases text[], tags text[], keywords text[],
  dmin integer, dmax integer, ptype text, pmin integer, pmax integer, requires_quote boolean, featured boolean,
  overlap text, source_note text, sort integer
);

insert into _svc values
('lead-capture-qualification', 'ready_automations', 'ready_system', 'Lead Capture & Qualification System',
 $$Capture every inquiry, qualify it automatically, and route it to the right place — without manual data entry.$$,
 $$Leads arrive from forms, ads, calls, and DMs, then sit in an inbox until someone copies them into a spreadsheet or CRM.$$,
 array[$$Stop copying leads into your CRM by hand$$, $$Respond to new inquiries immediately$$, $$Screen out leads that do not fit before your team spends time$$],
 array[$$Lead capture from your forms, ads, or website$$, $$Automatic qualification questions and routing rules$$, $$CRM contact and pipeline creation$$, $$Instant internal notification$$, $$Service-area / budget / availability checks$$],
 array[]::text[], array[]::text[], array['n8n','Make','GoHighLevel','Webhooks'],
 array[$$Website form submissions routed into your CRM with an instant team alert$$, $$Ad leads checked against service area, budget and availability before follow-up$$],
 array['ai-automation','crm-integrations'], array['lead','leads','capture','qualify','qualification','form','intake','inquiry','inquiries','routing','pipeline'],
 3, 7, 'range', 49900, 99900, true, true,
 null, $$Built on real work: HomeVeal Bathroom Remodeling: AI Lead-to-Appointment System$$, 10),
('ai-follow-up-appointment-reminders', 'ready_automations', 'ready_system', 'AI Follow-Up & Appointment Reminders',
 $$Automated email and SMS follow-up that keeps every lead and appointment moving without manual chasing.$$,
 $$Follow-up depends on whoever remembers, so warm leads go cold and appointments get missed.$$,
 array[$$Keep warm leads from going cold$$, $$Reduce missed appointments with timely reminders$$, $$Stop messaging contacts who have already replied$$],
 array[$$Multi-step email and SMS sequences$$, $$Event triggers from your CRM or calendar$$, $$Reminder and no-show recovery flows$$, $$Reply detection that stops sequences$$, $$Activity logged back to the CRM$$],
 array[]::text[], array[]::text[], array['GoHighLevel','n8n','Twilio','Email'],
 array[$$Appointment reminders and confirmations by SMS and email$$, $$No-show recovery sequences that stop when the contact replies$$],
 array['ai-automation'], array['follow up','follow-up','reminder','reminders','sms','email','no-show','nurture','sequence','appointment'],
 4, 8, 'range', 49900, 99900, true, false,
 $$Your iAcquire package already includes the AI Appointment Setter for standard follow-up. This service is for separately scoped sequences beyond your agreed package.$$,
 $$Built on real work: 4BR Guest Follow-Up: QR Check-In and Conditional Sequences$$, 20),
('crm-pipeline-automation', 'ready_automations', 'ready_system', 'CRM & Pipeline Automation',
 $$Keep contacts, deals, tags, and stages synchronized across your CRM and the tools your team already uses.$$,
 $$The CRM is out of date because updates have to be entered by hand in two or three places.$$,
 array[$$Keep CRM records current without double entry$$, $$Move deals through stages automatically$$, $$Clean up duplicate contacts$$],
 array[$$Two-way CRM and tool synchronization$$, $$Stage, tag, and ownership automation$$, $$Task and reminder creation$$, $$Duplicate prevention and data cleanup$$, $$Pipeline reporting feed$$],
 array[]::text[], array[]::text[], array['GoHighLevel','Make','n8n','REST APIs'],
 array[$$Deals, tags and owners kept in sync between your CRM and your other tools$$, $$Automatic follow-up tasks when a deal changes stage$$],
 array['ai-automation','crm-integrations'], array['crm','pipeline','sync','synchronize','deal','deals','tags','duplicate','gohighlevel','ghl','hubspot','salesforce'],
 5, 10, 'range', 49900, 99900, true, false,
 $$Your iAcquire package already includes the AI CRM Manager for standard CRM upkeep. This service is for separately scoped integrations beyond your agreed package.$$,
 null, 30),
('data-extraction-processing', 'ready_automations', 'ready_system', 'Data Extraction & Processing Workflow',
 $$Turn documents, emails, and exports into clean structured data in the sheet, CRM, or database you already use.$$,
 $$Someone is still reading PDFs, invoices, or emails and retyping the details into a spreadsheet.$$,
 array[$$Stop retyping details from documents and emails$$, $$Get consistent, validated records$$, $$Route anything uncertain to a person$$],
 array[$$Document and email intake$$, $$AI extraction into a defined schema$$, $$Validation and duplicate checks$$, $$Delivery to Sheets, Airtable, Notion, or your database$$, $$Exception queue for anything uncertain$$],
 array[]::text[], array[]::text[], array['n8n','OpenAI','Google Sheets','Airtable'],
 array[$$Invoices or forms parsed into a spreadsheet with an exception queue$$, $$Inbound emails turned into structured records$$],
 array['ai-automation'], array['extract','extraction','invoice','invoices','pdf','document','documents','spreadsheet','data entry','parse','ocr'],
 5, 10, 'range', 49900, 99900, true, false,
 null, $$Built on real work: Automated Accounting Workflow: Xero to Google Sheets and Asana$$, 40),
('reporting-notification-system', 'ready_automations', 'ready_system', 'Reporting & Notification System',
 $$Scheduled reports and real-time alerts delivered to Slack, email, or a dashboard before anyone has to ask.$$,
 $$Numbers are pulled together manually at the end of the week, so decisions are always made on stale data.$$,
 array[$$Get reports without pulling numbers by hand$$, $$Be alerted when something needs attention$$, $$Keep decisions based on current data$$],
 array[$$Scheduled data collection and aggregation$$, $$Formatted report delivery by email or Slack$$, $$Threshold alerts for anomalies$$, $$Weekly and monthly rollups$$, $$Optional lightweight dashboard$$],
 array[]::text[], array[]::text[], array['n8n','Google Sheets','Slack','APIs'],
 array[$$A weekly summary delivered to Slack every Monday$$, $$An alert when a metric crosses a threshold you set$$],
 array['ai-automation'], array['report','reports','reporting','notification','notifications','alert','alerts','dashboard','slack','weekly'],
 4, 8, 'range', 49900, 99900, true, false,
 $$Your iAcquire portal already includes analytics and the AI Performance Analyst. This service is for separately scoped reporting pipelines beyond your agreed package.$$,
 null, 50),
('ai-inquiry-appointment-agent', 'ready_ai_agents', 'ready_system', 'AI Inquiry & Appointment Agent',
 $$A chat agent that answers real questions, qualifies the visitor, and books qualified appointments on your calendar.$$,
 $$Website visitors ask questions at night and on weekends, then leave when nobody answers.$$,
 array[$$Answer visitor questions around the clock$$, $$Qualify visitors with your key questions$$, $$Book qualified appointments and hand edge cases to a person$$],
 array[$$Website chat agent trained on your services$$, $$Qualification flow with your key questions$$, $$Calendar availability checks and booking$$, $$Conversation summaries sent to you$$, $$Human handoff rules for edge cases$$],
 array[]::text[], array[]::text[], array['OpenAI','Claude','n8n','Calendars'],
 array[$$A website chat agent that qualifies visitors and books consultations$$, $$After-hours inquiries answered and summarized for your team$$],
 array['ai-agents'], array['chatbot','chat agent','chat','website chat','inquiry','inquiries','booking','appointment','ai agent','agent','assistant'],
 5, 10, 'range', 69900, 149900, true, true,
 $$Your iAcquire package already includes standard AI employees such as the AI Appointment Setter. Activating or configuring those is part of your core package and is never an add-on. This service is for separately scoped agents beyond it.$$,
 $$Built on real work: Tony AI: Trainable AI Negotiation and Conversation Platform$$, 60),
('ai-voice-receptionist', 'ready_ai_agents', 'ready_system', 'AI Voice Receptionist',
 $$A voice agent that answers inbound calls, checks live availability, and books or reschedules appointments.$$,
 $$Calls go to voicemail whenever the team is busy, and after-hours callers never call back.$$,
 array[$$Answer calls when your team cannot$$, $$Check availability and book or reschedule appointments$$, $$Log call summaries and escalate to a human when needed$$],
 array[$$Inbound call handling with a natural voice$$, $$Live calendar availability checks$$, $$Booking, rescheduling, and confirmation$$, $$Call summaries and transcripts logged$$, $$Escalation path to a human$$],
 array[]::text[], array[]::text[], array['Vapi','Retell AI','ElevenLabs','n8n'],
 array[$$An AI receptionist that answers calls and books appointments on your calendar$$, $$After-hours calls handled with a summary logged for your team$$],
 array['ai-agents'], array['voice','phone','call','calls','receptionist','answer calls','inbound','phone calls','book appointments','voice agent'],
 7, 14, 'range', 69900, 149900, true, true,
 $$Your iAcquire package already includes standard AI employees such as the AI Appointment Setter. Activating or configuring those is part of your core package and is never an add-on. This service is for separately scoped voice agents beyond it.$$,
 $$Built on real work: Money Reset AI Voice Agent: Retell-Powered Appointment Automation$$, 70),
('customer-support-ai-assistant', 'ready_ai_agents', 'ready_system', 'Customer Support AI Assistant',
 $$An assistant that answers common customer questions from your own documents and escalates the rest to a human.$$,
 $$The same handful of questions eats hours every week, and answers vary depending on who replies.$$,
 array[$$Answer common questions consistently from your own documents$$, $$Escalate anything uncertain with context$$, $$See which questions your documents do not yet answer$$],
 array[$$Knowledge base built from your documents$$, $$Grounded answers with source references$$, $$Escalation to email or Slack with context$$, $$Web widget or messenger deployment$$, $$Question and gap reporting$$],
 array[]::text[], array[]::text[], array['OpenAI','Supabase','n8n','Vector search'],
 array[$$A support widget that answers from your FAQs and policies$$, $$Escalations sent to Slack with the conversation attached$$],
 array['ai-agents'], array['support','customer support','faq','help desk','helpdesk','knowledge base','customers','questions','chatbot','rag'],
 7, 14, 'range', 69900, 149900, true, false,
 $$Your iAcquire package includes the iAcquire Assistant and standard AI employees. This service is for a separately scoped support assistant trained on your own documents.$$,
 $$Built on real work: Cavinti Suite: AI Support Agent Chatbot$$, 80),
('internal-ai-knowledge-assistant', 'ready_ai_agents', 'ready_system', 'Internal AI Knowledge Assistant',
 $$A private assistant your team can ask about SOPs, pricing, policies, and past work instead of searching folders.$$,
 $$Internal knowledge is scattered across drives, chats, and people's heads, so answers take too long.$$,
 array[$$Give your team answers without searching folders$$, $$Keep answers private and access-controlled$$, $$Cite the source document for every answer$$],
 array[$$Document ingestion from Drive, Notion, or uploads$$, $$Private, access-controlled answers$$, $$Citations back to the source document$$, $$Slack or web app interface$$, $$Refresh schedule for new documents$$],
 array[]::text[], array[]::text[], array['OpenAI','Supabase','Slack','RAG'],
 array[$$Ask a Slack assistant about SOPs and pricing and get a cited answer$$, $$New documents indexed on a schedule$$],
 array['ai-agents'], array['internal','knowledge','sop','sops','policies','rag','team','documents','assistant','wiki','search'],
 7, 14, 'range', 69900, 149900, true, false,
 null, $$Built on real work: Zorivelle Realty Chatbot: RAG-Powered Document Q&A$$, 90),
('high-converting-landing-page', 'ready_web_funnels', 'ready_system', 'High-Converting Landing Page System',
 $$A fast, focused landing page built for one offer, one audience, and one clear next step.$$,
 $$Traffic lands on a generic homepage that explains everything and asks for nothing.$$,
 array[$$Give each offer a focused page with one clear next step$$, $$Send leads straight into your CRM or automation$$, $$Track conversions from day one$$],
 array[$$Single-offer page structure with clear hierarchy$$, $$Lead form wired to your CRM or automation$$, $$Mobile-first build with fast load times$$, $$Trust, FAQ, and objection-handling sections$$, $$Analytics and conversion tracking setup$$],
 array[]::text[],
 array[$$Custom website design$$, $$Conversion-focused landing pages$$, $$Multi-page websites$$, $$Custom forms and lead capture$$, $$CRM integration$$, $$Advanced animations$$, $$Custom APIs$$],
 array['React','Tailwind CSS','Forms','Analytics'],
 array[$$A single-offer landing page with a lead form connected to your CRM$$, $$A campaign page for an ad with conversion tracking$$],
 array['websites-funnels'], array['landing page','website','web page','site','page','conversion','forms','lead form','funnel page'],
 5, 10, 'range', 89900, 179900, true, false,
 null, $$Built on real work: HomeVeal Bathroom Remodeling: AI Lead-to-Appointment System$$, 100),
('gohighlevel-funnel-lead-magnet', 'ready_web_funnels', 'ready_system', 'GoHighLevel Funnel & Lead Magnet',
 $$A complete GoHighLevel funnel: landing page, lead magnet delivery, booking calendar, and nurture automation.$$,
 $$A funnel was half-built in GoHighLevel and the follow-up never got wired up.$$,
 array[$$Finish a funnel that stalled partway$$, $$Deliver lead magnets automatically$$, $$Nurture and book leads from one connected funnel$$],
 array[$$Funnel and landing page in your GHL account$$, $$Lead magnet capture and delivery$$, $$Calendar and booking integration$$, $$Email/SMS nurture sequences$$, $$Pipeline and opportunity setup$$],
 array[]::text[],
 array[$$Booking funnels$$, $$Lead magnet funnels$$, $$Checkout and upsell experiences$$, $$Custom forms and lead capture$$, $$CRM integration$$],
 array['GoHighLevel','Calendars','Email','SMS'],
 array[$$A lead magnet funnel that delivers a guide and nurtures by email and SMS$$, $$A booking funnel connected to your calendar and pipeline$$],
 array['websites-funnels','crm-integrations'], array['funnel','ghl','gohighlevel','lead magnet','booking funnel','nurture','landing'],
 5, 12, 'range', 89900, 179900, true, false,
 null, $$Built on real work: Money Reset: Lead Magnet and Sales Funnel$$, 110),
('shopify-starter-system', 'ready_web_funnels', 'ready_system', 'Shopify Starter System',
 $$A conversion-focused Shopify setup with a product page built to sell and the essentials already wired.$$,
 $$The store is live but the product page is a default theme layout with no structure for conversion.$$,
 array[$$Turn a default product page into one built to convert$$, $$Offer bundles, quantity discounts or subscriptions$$, $$Track store events from the start$$],
 array[$$Conversion-focused product page structure$$, $$Bundles, quantity offers, or subscriptions$$, $$Trust, review, and comparison sections$$, $$Checkout and upsell configuration$$, $$Analytics and event tracking$$],
 array[]::text[],
 array[$$Shopify custom sections$$, $$Checkout and upsell experiences$$, $$Custom forms and lead capture$$, $$Advanced animations$$, $$Custom APIs$$],
 array['Shopify','Liquid','Checkout','Analytics'],
 array[$$A product page with a bundle selector, reviews and a comparison table$$, $$Upsells configured at checkout$$],
 array['websites-funnels','shopify'], array['shopify','store','ecommerce','e-commerce','product page','checkout','upsell','bundle','liquid'],
 7, 14, 'range', 89900, 179900, true, false,
 null, $$Built on real work: VTL Sleep Spray: Custom Shopify Liquid Storefront$$, 120),
('custom-automation-system', 'custom_automation', 'custom_build', 'Custom Automation System',
 $$Multi-step automation and integration work designed around how your business actually operates.$$,
 $$Your process crosses several tools, has exceptions, or does not fit a productized system.$$,
 array[$$Automate a process that spans several tools$$, $$Handle exceptions, retries and monitoring$$, $$Hand over documented, maintainable workflows$$],
 array[$$Discovery and process mapping$$, $$Multiple connected workflows and integrations$$, $$Error handling, retries, and logging$$, $$Documentation and handover$$, $$30 days of post-launch fixes$$],
 array[$$Third-party platform subscriptions and usage costs$$, $$Work outside the written scope unless added by a signed-off change$$],
 array[]::text[], array['n8n','Make.com','Zapier','GoHighLevel','Google Sheets','Airtable','Notion','Slack','ClickUp','APIs','Webhooks'],
 array[$$Business process automation across your CRM, calendar and messaging tools$$, $$Payment integrations and data synchronization$$, $$Approval systems with error recovery and monitoring$$, $$Reporting pipelines and webhooks$$],
 array['ai-automation','crm-integrations','custom-development'], array['custom','automation','workflow','integration','integrations','n8n','make','zapier','webhook','api','payment','approval','sync','process'],
 14, 28, 'starting_at', 150000, null, true, true,
 null, $$Typical timeline 2–4 weeks, depending on scope.$$, 200),
('custom-ai-agent', 'custom_ai_agents', 'custom_build', 'Custom AI Agent',
 $$A chat or voice agent with your own knowledge, tools, guardrails, and handoff rules.$$,
 $$You need an agent that reasons, uses your data, and takes real actions — not a scripted bot.$$,
 array[$$Build an agent grounded in your own knowledge$$, $$Let it use your tools safely, with human review where it matters$$, $$Evaluate and tune it before launch$$],
 array[$$Use-case design and conversation architecture$$, $$Knowledge base and retrieval setup$$, $$Tool calling into your systems$$, $$Guardrails, escalation, and human review$$, $$Evaluation passes and prompt tuning$$],
 array[$$AI provider and telephony usage costs$$, $$Guaranteed answers: retrieval reduces unsupported answers but does not eliminate model error$$],
 array[]::text[], array['OpenAI','Claude','n8n','Supabase','Vapi','Retell AI','ElevenLabs','RAG'],
 array[$$Custom AI chat or voice agents with human-in-the-loop review$$, $$RAG systems and internal company assistants$$, $$Tool-calling agents and multi-agent workflows$$, $$AI-powered support systems with advanced business integrations$$],
 array['ai-agents','custom-development'], array['custom','ai agent','agent','voice','chat','rag','assistant','tool calling','multi-agent','llm','knowledge','human in the loop'],
 21, 42, 'starting_at', 200000, null, true, true,
 null, $$Typical timeline 3–6 weeks, depending on scope.$$, 210),
('custom-web-saas-shopify', 'custom_web_saas', 'custom_build', 'Custom Web, SaaS & Shopify Build',
 $$A custom application, platform, portal, or storefront built around your product and workflow.$$,
 $$Off-the-shelf software cannot support the product or internal tool you need.$$,
 array[$$Build the product or internal tool off-the-shelf software cannot support$$, $$Add authentication, roles and payments where needed$$, $$Integrate with your existing stack$$],
 array[$$Product and technical scoping$$, $$Frontend, backend, and database build$$, $$Authentication, roles, and payments where needed$$, $$Integrations with your existing stack$$, $$Deployment, QA, and documentation$$],
 array[$$Hosting, domain and third-party subscription costs$$, $$Ongoing development after handover unless separately agreed$$],
 array[]::text[], array['React','TypeScript','Supabase','Shopify','Liquid','Stripe','Vercel'],
 array[$$Custom SaaS applications, business dashboards and client or admin portals$$, $$Internal tools, web applications and learning management systems$$, $$Shopify storefronts with payment integrations and AI-enabled features$$],
 array['custom-development','shopify','websites-funnels'], array['custom','saas','web app','application','portal','dashboard','admin','internal tool','lms','shopify','storefront','platform','database','authentication','payments','software'],
 28, 70, 'starting_at', 250000, null, true, true,
 null, $$Typical timeline 4–10 weeks, depending on scope.$$, 220),
('managed-maintenance', 'managed_maintenance', 'maintenance_plan', 'Fully Managed Maintenance',
 $$Optional hands-on upkeep for your iAcquire system: monitoring, troubleshooting, reasonable configuration adjustments and AI optimization.$$,
 $$Integrations change, prompts drift and settings need adjusting. This plan keeps someone watching.$$,
 array[$$Have iAcquire monitor and look after your live system$$, $$Get reasonable configuration changes without a new project$$, $$Keep your AI employees tuned as your business changes$$],
 array[$$Monitoring of your connected integrations and AI employee health, with alerts to our team$$, $$Troubleshooting when an integration, workflow or AI employee stops working as configured$$, $$Reasonable configuration adjustments, such as updating AI knowledge or instructions, changing approval rules or reconnecting a service$$, $$AI optimization reviews based on how your AI employees are performing$$, $$Smaller improvements within your monthly request allowance$$],
 array[$$New automations, AI agents, websites, funnels or software: these are quoted separately, even with an active plan$$, $$Third-party platform subscriptions and usage or API costs$$, $$Correcting confirmed defects in your original iAcquire setup: these are handled under your service agreement and do not use your allowance$$, $$Unlimited requests, unlimited AI usage, free future development or lifetime maintenance$$],
 array[]::text[], array[]::text[], array[]::text[], array[]::text[], array['maintenance','support','monitoring'],
 null, null, 'monthly', 29900, null, false, false,
 null, $$iAcquire's own optional plan. Not required to use your original system.$$, 900);

insert into service_catalog (category_id, slug, kind, name, tagline, problem_solved, accomplishes, deliverables, exclusions, optional_upgrades,
                             platforms, use_cases, tags, keywords, delivery_min_days, delivery_max_days, requires_quote, featured,
                             core_overlap_note, source_note, sort_order, plan_config, description)
select c.id, s.slug, s.kind, s.name, s.tagline, s.problem, s.accomplishes, s.deliverables, s.exclusions, s.upgrades,
       s.platforms, s.use_cases, s.tags, s.keywords, s.dmin, s.dmax, s.requires_quote, s.featured,
       s.overlap, s.source_note, s.sort,
       case when s.kind = 'maintenance_plan' then '{"monthlyRequestAllowance": 4}'::jsonb else '{}'::jsonb end,
       s.tagline
from _svc s join service_categories c on c.code = s.category;

insert into service_price_versions (service_id, version, price_type, min_cents, max_cents, source, note)
select c.id, 1, s.ptype, s.pmin, s.pmax,
       case when s.kind = 'maintenance_plan' then 'agency' else 'founder_portfolio' end,
       case when s.kind = 'ready_system' then 'Published range for the standard system with focused customization. Final price confirmed in writing before work starts.'
            when s.kind = 'custom_build' then 'Published starting price. Final price is quoted after discovery and a written scope.'
            else 'Optional monthly plan. Billing starts only after you accept the plan and your system is activated.' end
from _svc s join service_catalog c on c.slug = s.slug;

update service_catalog c set current_price_version_id = v.id from service_price_versions v where v.service_id = c.id and v.version = 1;
drop table _svc;
