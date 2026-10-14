-- iAcquire Client Setup Center: agency-managed onboarding checklist shared by the Admin Portal and Client Portal.
--
-- Design notes
--   * One authoritative row set per tenant. The agency writes through trusted server code
--     (withSystem + explicit agency access checks); client users only ever read, under RLS, through
--     column-level grants that omit staff-only columns.
--   * Task progress is separate from integration health: client_setup_tasks.status is work progress,
--     client_setup_checks holds verified/attested/failed integration readiness.
--   * Database CHECK constraints make false completion impossible even if application code is wrong:
--     a task that must be verified by a connector cannot be Completed by an agency status change.

-- ---------------------------------------------------------------------------
-- Templates (product configuration, not customer data)
-- ---------------------------------------------------------------------------

create table client_setup_templates (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z0-9_]{3,40}$'),
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '' check (char_length(description) <= 600),
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index client_setup_templates_one_default on client_setup_templates ((is_default)) where is_default;

create table client_setup_template_tasks (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references client_setup_templates(id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9_]{2,40}$'),
  title text not null check (char_length(title) between 1 and 160),
  client_title text check (char_length(client_title) <= 160),
  description text not null default '' check (char_length(description) <= 600),
  completion_notice text check (char_length(completion_notice) <= 200),
  -- Who the checklist item is about: work iAcquire does, or something the client provides.
  section text not null check (section in ('agency', 'client')),
  -- manual: staff mark it complete. verified: only a passing check completes it.
  -- activation: completed only by the final activation approval.
  completion_mode text not null check (completion_mode in ('manual', 'verified', 'activation')),
  check_key text check (check_key ~ '^[a-z_]{3,40}$'),
  -- Purchased service that makes this task applicable (null = always applies).
  service text check (service in ('crm', 'ai_workforce', 'automations', 'website', 'email', 'calendar')),
  required boolean not null default true,
  requires_evidence boolean not null default false,
  requires_client_response boolean not null default false,
  client_action jsonb check (client_action is null or pg_column_size(client_action) <= 4096),
  depends_on text[] not null default '{}',
  sort_order integer not null,
  unique (template_id, key),
  check ((completion_mode = 'verified') = (check_key is not null))
);

-- ---------------------------------------------------------------------------
-- Per-tenant setup
-- ---------------------------------------------------------------------------

create table client_setup_instances (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null unique references organizations(id) on delete cascade,
  template_id uuid references client_setup_templates(id) on delete set null,
  state text not null default 'in_setup' check (state in ('in_setup', 'ready_for_review', 'activated')),
  -- Purchased services; tasks tied to a service that is not listed are excluded from the checklist.
  services text[] not null default '{crm,ai_workforce,automations,website,email,calendar}',
  responsible_user_id uuid references users(id) on delete set null,
  -- Bumped on every change so open browsers know when to refetch.
  revision bigint not null default 1,
  ready_for_review_at timestamptz,
  ready_for_review_by uuid references users(id) on delete set null,
  activated_at timestamptz,
  activated_by uuid references users(id) on delete set null,
  activation_note text check (char_length(activation_note) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  check ((state = 'activated') = (activated_at is not null))
);
create trigger client_setup_instances_touch before update on client_setup_instances for each row execute function app.touch_updated_at();

create table client_setup_tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  instance_id uuid not null,
  template_key text,
  title text not null check (char_length(title) between 1 and 160),
  client_title text check (char_length(client_title) <= 160),
  description text not null default '' check (char_length(description) <= 600),
  completion_notice text check (char_length(completion_notice) <= 200),
  section text not null check (section in ('agency', 'client')),
  completion_mode text not null default 'manual' check (completion_mode in ('manual', 'verified', 'activation')),
  check_key text check (check_key ~ '^[a-z_]{3,40}$'),
  service text check (service in ('crm', 'ai_workforce', 'automations', 'website', 'email', 'calendar')),
  status text not null default 'pending'
    check (status in ('pending', 'in_progress', 'waiting_for_client', 'ready_for_review', 'completed', 'blocked')),
  required boolean not null default true,
  -- Agency-hidden optional task (kept for history, ignored by progress and readiness).
  hidden boolean not null default false,
  -- Not part of this client's purchased services.
  service_excluded boolean not null default false,
  requires_evidence boolean not null default false,
  requires_client_response boolean not null default false,
  sort_order integer not null default 0,
  assigned_to uuid references users(id) on delete set null,
  estimated_completion_at date,
  -- Client-visible text. Staff-only notes live in client_setup_task_events (visibility = 'internal').
  client_note text check (char_length(client_note) <= 2000),
  blocked_reason text check (char_length(blocked_reason) <= 1000),
  completion_note text check (char_length(completion_note) <= 2000),
  client_action jsonb check (client_action is null or pg_column_size(client_action) <= 4096),
  client_response jsonb check (client_response is null or pg_column_size(client_response) <= 8192),
  client_responded_at timestamptz,
  client_responded_by uuid references users(id) on delete set null,
  completed_at timestamptz,
  completed_by uuid references users(id) on delete set null,
  completion_source text check (completion_source in ('agency', 'connector', 'attestation', 'activation')),
  verified_at timestamptz,
  verified_detail text check (char_length(verified_detail) <= 600),
  created_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  unique (instance_id, template_key),
  foreign key (instance_id, org_id) references client_setup_instances (id, org_id) on delete cascade,
  -- Invariants enforced by the database itself.
  check ((status = 'completed') = (completed_at is not null)),
  check (status <> 'blocked' or (blocked_reason is not null and char_length(btrim(blocked_reason)) > 0)),
  check (not (hidden and required)),
  check ((completion_mode = 'verified') = (check_key is not null)),
  check (status <> 'completed' or completion_mode <> 'manual' or completion_source = 'agency'),
  check (status <> 'completed' or completion_mode <> 'verified' or completion_source in ('connector', 'attestation')),
  check (status <> 'completed' or completion_mode <> 'activation' or completion_source = 'activation')
);
create index client_setup_tasks_instance_idx on client_setup_tasks (org_id, section, sort_order);
create trigger client_setup_tasks_touch before update on client_setup_tasks for each row execute function app.touch_updated_at();

create table client_setup_task_dependencies (
  org_id uuid not null references organizations(id) on delete cascade,
  task_id uuid not null,
  depends_on_task_id uuid not null,
  primary key (task_id, depends_on_task_id),
  check (task_id <> depends_on_task_id),
  foreign key (task_id, org_id) references client_setup_tasks (id, org_id) on delete cascade,
  foreign key (depends_on_task_id, org_id) references client_setup_tasks (id, org_id) on delete cascade
);
create index client_setup_task_dependencies_org_idx on client_setup_task_dependencies (org_id);

-- Every change, who made it, and what it was before. Append-only.
create table client_setup_task_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  instance_id uuid not null,
  task_id uuid,
  actor_user_id uuid references users(id) on delete set null,
  actor_kind text not null check (actor_kind in ('agency', 'client', 'system')),
  event text not null check (event in (
    'task_created', 'status_changed', 'reopened', 'note', 'details_changed', 'assigned',
    'dependencies_changed', 'attachment_added', 'attachment_removed', 'visibility_changed',
    'reordered', 'client_requested', 'client_responded', 'verified', 'attested', 'check_run',
    'ready_for_review', 'sent_back', 'activated', 'services_changed', 'instance_created')),
  from_status text,
  to_status text,
  -- Text the client may read (only returned to clients when visibility = 'client').
  body text check (char_length(body) <= 2000),
  -- Staff-only reason or note. Never granted to client users.
  reason text check (char_length(reason) <= 2000),
  visibility text not null default 'internal' check (visibility in ('internal', 'client')),
  metadata jsonb not null default '{}'::jsonb check (pg_column_size(metadata) <= 8192),
  created_at timestamptz not null default now(),
  foreign key (instance_id, org_id) references client_setup_instances (id, org_id) on delete cascade,
  foreign key (task_id, org_id) references client_setup_tasks (id, org_id) on delete cascade
);
create index client_setup_task_events_task_idx on client_setup_task_events (task_id, created_at desc);
create index client_setup_task_events_org_idx on client_setup_task_events (org_id, created_at desc);

create or replace function app.setup_events_no_update() returns trigger
language plpgsql
as $$
begin
  raise exception 'client_setup_task_events is append-only' using errcode = 'insufficient_privilege';
end
$$;
create trigger client_setup_task_events_no_update before update on client_setup_task_events
  for each row execute function app.setup_events_no_update();

create table client_setup_task_attachments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  task_id uuid not null,
  label text not null check (char_length(label) between 1 and 120),
  url text not null check (url ~ '^https://[^[:space:]]+$' and char_length(url) <= 500),
  kind text not null default 'evidence' check (kind in ('evidence', 'documentation', 'website_preview', 'instructions')),
  visibility text not null default 'internal' check (visibility in ('internal', 'client')),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (task_id, org_id) references client_setup_tasks (id, org_id) on delete cascade
);
create index client_setup_task_attachments_task_idx on client_setup_task_attachments (task_id);

-- Integration readiness, kept apart from task progress. Only a connector can mark a check
-- "verified"; "attested" is an explicit, evidenced agency statement and is always labelled as such.
create table client_setup_checks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  check_key text not null check (check_key ~ '^[a-z_]{3,40}$'),
  status text not null default 'unverified' check (status in ('unverified', 'verified', 'failed', 'attested')),
  -- Technical detail for agency staff; never shown to clients.
  detail text check (char_length(detail) <= 600),
  source text check (source in ('connector', 'attestation')),
  evidence_url text check (evidence_url is null or evidence_url ~ '^https://[^[:space:]]+$'),
  note text check (char_length(note) <= 2000),
  checked_at timestamptz,
  attested_by uuid references users(id) on delete set null,
  attested_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (org_id, check_key),
  check (status <> 'verified' or source = 'connector'),
  check (status <> 'attested' or (source = 'attestation' and attested_at is not null))
);
create trigger client_setup_checks_touch before update on client_setup_checks for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Permissions and notification kinds
-- ---------------------------------------------------------------------------

insert into role_permissions (role, permission) values
  ('owner', 'setup.view'), ('admin', 'setup.view'), ('member', 'setup.view'),
  ('agency_staff', 'setup.view'), ('agency_super_admin', 'setup.view'),
  ('owner', 'setup.respond'), ('admin', 'setup.respond'),
  ('agency_staff', 'setup.manage'), ('agency_super_admin', 'setup.manage'),
  ('agency_super_admin', 'setup.activate');

alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in (
  'agent_task_completed', 'lead_awaiting_approval', 'booking_confirmed', 'workflow_failure',
  'knowledge_update_ready', 'support_reply', 'support_ticket_created', 'integration_disconnected',
  'usage_limit_approaching', 'approval_requested', 'approval_decided', 'agent_status', 'system',
  'setup_milestone', 'setup_action_required', 'setup_issue', 'setup_ready'));

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table client_setup_templates enable row level security;
alter table client_setup_template_tasks enable row level security;
alter table client_setup_instances enable row level security;
alter table client_setup_tasks enable row level security;
alter table client_setup_task_dependencies enable row level security;
alter table client_setup_task_events enable row level security;
alter table client_setup_task_attachments enable row level security;
alter table client_setup_checks enable row level security;

-- Templates and checks: no grants for iaq_app_user (agency-only, served by trusted server code).

-- Writes never go through iaq_app_user: the server applies them after its own authorization.
grant select (id, org_id, state, services, revision, ready_for_review_at, activated_at, created_at, updated_at)
  on client_setup_instances to iaq_app_user;
create policy setup_instances_select on client_setup_instances for select to iaq_app_user
  using (app.has_permission(org_id, 'setup.view'));

-- Staff-only columns (assignee, who completed it, internal verification detail) are not granted.
grant select (id, org_id, instance_id, template_key, title, client_title, description, completion_notice, section,
              completion_mode, service, status, required, hidden, service_excluded, requires_client_response,
              sort_order, estimated_completion_at, client_note, blocked_reason, completion_note, client_action,
              client_response, client_responded_at, completed_at, created_at, updated_at)
  on client_setup_tasks to iaq_app_user;
create policy setup_tasks_select on client_setup_tasks for select to iaq_app_user
  using (app.has_permission(org_id, 'setup.view')
         and ((not hidden and not service_excluded) or app.staff_assigned(org_id)));

grant select on client_setup_task_dependencies to iaq_app_user;
create policy setup_dependencies_select on client_setup_task_dependencies for select to iaq_app_user
  using (app.has_permission(org_id, 'setup.view'));

-- Internal notes and reasons (the "reason" column) are never granted to clients.
grant select (id, org_id, instance_id, task_id, actor_kind, event, from_status, to_status, body, visibility, created_at)
  on client_setup_task_events to iaq_app_user;
create policy setup_events_select on client_setup_task_events for select to iaq_app_user
  using (app.has_permission(org_id, 'setup.view') and (visibility = 'client' or app.staff_assigned(org_id)));

grant select (id, org_id, task_id, label, url, kind, visibility, created_at) on client_setup_task_attachments to iaq_app_user;
create policy setup_attachments_select on client_setup_task_attachments for select to iaq_app_user
  using (app.has_permission(org_id, 'setup.view') and (visibility = 'client' or app.staff_assigned(org_id)));

-- ---------------------------------------------------------------------------
-- Default checklist
-- ---------------------------------------------------------------------------

insert into client_setup_templates (key, name, description, is_default)
values ('default', 'Standard AI client acquisition setup', 'The default checklist for the AI-powered client acquisition and retention system.', true);

insert into client_setup_template_tasks
  (template_id, key, title, client_title, description, completion_notice, section, completion_mode, check_key, service,
   required, requires_evidence, requires_client_response, client_action, depends_on, sort_order)
select t.id, v.key, v.title, v.client_title, v.description, v.completion_notice, v.section, v.completion_mode, v.check_key, v.service,
       true, false, v.requires_client_response, v.client_action::jsonb, v.depends_on, v.sort_order
from client_setup_templates t
cross join (values
  ('company_info', 'Company information submitted', null,
   'The details you shared about your business, goals and how your AI team should communicate.',
   'Company information received', 'client', 'verified', 'onboarding', null, false,
   '{"type":"provide_info","label":"Add missing information","instructions":"Tell us what else we should know about your business so we can finish your setup."}',
   '{}'::text[], 10),
  ('ghl_subaccount', 'GHL sub-account created', 'Your CRM workspace is created',
   'We create a private CRM workspace for your business so your contacts, pipeline and appointments stay separate from every other client.',
   null, 'agency', 'verified', 'ghl_location', 'crm', false, null,
   '{company_info}'::text[], 20),
  ('crm_snapshot', 'CRM snapshot installed', 'CRM template installed',
   'We install our proven CRM template: pipeline stages, forms and message templates built for client acquisition.',
   null, 'agency', 'verified', 'crm_snapshot', 'crm', false, null,
   '{ghl_subaccount}'::text[], 30),
  ('crm_assets', 'Pipelines, tags, custom fields, and forms configured', 'Pipelines, tags, fields and forms configured',
   'We tailor stages, tags and fields to how your business sells, and set up your lead and booking forms.',
   null, 'agency', 'verified', 'crm_assets', 'crm', false, null,
   '{crm_snapshot}'::text[], 40),
  ('ai_employees', 'Six client-specific Hermes AI employees configured', 'Your six AI employees are configured',
   'Each AI employee gets its own private environment and is checked live before it is marked ready.',
   'Your AI team is ready', 'agency', 'verified', 'hermes_employees', 'ai_workforce', true,
   '{"type":"approve","label":"Approve your AI employee configuration","instructions":"Review how each AI employee will work and communicate in AI Workforce, then approve so we can finish and test them."}',
   '{company_info}'::text[], 50),
  ('workflows', 'Automation workflows configured', 'Automations configured',
   'Follow-up and reminder workflows are built, tested and reviewed by our team. Nothing is switched on without your approval.',
   null, 'agency', 'verified', 'workflows', 'automations', false, null,
   '{crm_assets}'::text[], 60),
  ('website_built', 'Website and funnel built', null,
   'Our team designs and builds your website and lead-capture funnel.',
   'Your website has been built', 'agency', 'manual', null, 'website', false, null,
   '{company_info}'::text[], 70),
  ('website_published', 'Website published and domain connected', null,
   'After you approve the design, we publish your website and connect your domain.',
   null, 'agency', 'verified', 'website_live', 'website', true,
   '{"type":"review_and_approve","label":"Review your website","instructions":"Open the preview link and approve the design, or tell us what you would like changed."}',
   '{website_built}'::text[], 80),
  ('email_domain', 'Business email configured and verified', 'Business email set up and verified',
   'We set up your business email address and verify your domain so your messages are trusted and delivered.',
   null, 'client', 'verified', 'email_domain', 'email', false,
   '{"type":"external","label":"Verify your email domain","instructions":"We will share the DNS records to add at your domain provider. Tell us when they are in place so we can verify them."}',
   '{company_info}'::text[], 90),
  ('calendar', 'Google Calendar connected and appointment availability checked', 'Google Calendar connected',
   'We connect your calendar so your AI Appointment Setter only offers times that are really free.',
   null, 'client', 'verified', 'calendar', 'calendar', false,
   '{"type":"external","label":"Connect Google Calendar","instructions":"Approve access to the Google calendar we should use when we send you the authorization link, then let us know it is done."}',
   '{ghl_subaccount}'::text[], 100),
  ('integration_tests', 'AI workforce and integration tests passed', 'Final system checks passed',
   'We run live checks across your AI employees and connected tools before activation.',
   null, 'agency', 'verified', 'final_health', null, false, null,
   '{ghl_subaccount,crm_assets,ai_employees,workflows,website_published,email_domain,calendar}'::text[], 110),
  ('final_review', 'Final agency review and activation', 'Final review and activation',
   'Our team does a last quality review and then approves your system for activation.',
   null, 'agency', 'activation', null, null, false, null,
   '{integration_tests}'::text[], 120)
) as v(key, title, client_title, description, completion_notice, section, completion_mode, check_key, service, requires_client_response, client_action, depends_on, sort_order)
where t.key = 'default';
