-- AQi is the platform-wide assistant. It is deliberately separate from the AI employee registry:
-- its own configuration versions, knowledge, conversations, messages, feedback and usage.
-- Knowledge is platform-wide only; tenant business data must never be stored here.

create table if not exists aqi_config_versions (
  id uuid primary key default gen_random_uuid(),
  version integer not null unique check (version > 0),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  config jsonb not null,
  notes text check (notes is null or char_length(notes) <= 500),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  published_by uuid references users(id) on delete set null
);
create unique index if not exists aqi_one_published_config on aqi_config_versions ((status)) where status = 'published';

create table if not exists aqi_knowledge_entries (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 160),
  category text not null check (char_length(category) between 1 and 60),
  body text not null check (char_length(body) between 1 and 12000),
  route_prefix text check (route_prefix is null or route_prefix ~ '^/[a-z0-9/_-]*$'),
  roles text[] not null default '{}',
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  source text not null default 'iAcquire approved documentation' check (char_length(source) <= 200),
  version integer not null default 1 check (version > 0),
  published_at timestamptz,
  created_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists aqi_knowledge_published_idx on aqi_knowledge_entries (status, category);
create index if not exists aqi_knowledge_route_idx on aqi_knowledge_entries (route_prefix) where status = 'published';
create unique index if not exists aqi_knowledge_title_unique on aqi_knowledge_entries (lower(title));

create table if not exists aqi_suggested_questions (
  id uuid primary key default gen_random_uuid(),
  question text not null check (char_length(question) between 3 and 200),
  scope text not null default 'global' check (scope in ('global', 'role', 'page')),
  role text,
  route_prefix text check (route_prefix is null or route_prefix ~ '^/[a-z0-9/_-]*$'),
  sort_order integer not null default 0,
  enabled boolean not null default true,
  created_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create index if not exists aqi_questions_order_idx on aqi_suggested_questions (enabled, sort_order);
create unique index if not exists aqi_questions_unique on aqi_suggested_questions (question, scope, coalesce(role, ''), coalesce(route_prefix, ''));

create table if not exists aqi_conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  title text not null default 'New conversation' check (char_length(title) between 1 and 120),
  config_version_id uuid references aqi_config_versions(id) on delete set null,
  page_route text check (page_route is null or char_length(page_route) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create index if not exists aqi_conversations_user_idx on aqi_conversations (user_id, last_message_at desc);
create index if not exists aqi_conversations_org_idx on aqi_conversations (org_id, last_message_at desc);

create table if not exists aqi_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references aqi_conversations(id) on delete cascade,
  org_id uuid references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null default '',
  status text not null default 'complete' check (status in ('streaming', 'complete', 'failed', 'cancelled')),
  error_code text,
  model text,
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  feedback_rating smallint check (feedback_rating is null or feedback_rating in (-1, 1)),
  feedback_comment text check (feedback_comment is null or char_length(feedback_comment) <= 1000),
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists aqi_messages_conversation_idx on aqi_messages (conversation_id, created_at);
create index if not exists aqi_messages_feedback_idx on aqi_messages (feedback_rating, created_at) where feedback_rating is not null;

create table if not exists aqi_usage_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  kind text not null check (kind in ('message', 'feedback', 'config_publish')),
  conversation_id uuid references aqi_conversations(id) on delete set null,
  model text,
  input_tokens integer,
  output_tokens integer,
  latency_ms integer,
  created_at timestamptz not null default now()
);
create index if not exists aqi_usage_created_idx on aqi_usage_events (created_at desc);

alter table aqi_config_versions enable row level security;
alter table aqi_knowledge_entries enable row level security;
alter table aqi_suggested_questions enable row level security;
alter table aqi_conversations enable row level security;
alter table aqi_messages enable row level security;
alter table aqi_usage_events enable row level security;

grant select on aqi_config_versions, aqi_knowledge_entries, aqi_suggested_questions to iaq_app_user;
grant select, insert, update, delete on aqi_conversations, aqi_messages to iaq_app_user;

create policy aqi_config_published_select on aqi_config_versions for select to iaq_app_user
  using (status = 'published');
create policy aqi_knowledge_published_select on aqi_knowledge_entries for select to iaq_app_user
  using (status = 'published');
create policy aqi_questions_enabled_select on aqi_suggested_questions for select to iaq_app_user
  using (enabled);

create policy aqi_conversations_select on aqi_conversations for select to iaq_app_user
  using (user_id = app.current_user_id() and (org_id is null or app.has_permission(org_id, 'workspace.view'::text)));
create policy aqi_conversations_insert on aqi_conversations for insert to iaq_app_user
  with check (user_id = app.current_user_id() and (org_id is null or app.has_permission(org_id, 'workspace.view'::text)));
create policy aqi_conversations_update on aqi_conversations for update to iaq_app_user
  using (user_id = app.current_user_id() and (org_id is null or app.has_permission(org_id, 'workspace.view'::text)))
  with check (user_id = app.current_user_id() and (org_id is null or app.has_permission(org_id, 'workspace.view'::text)));
create policy aqi_conversations_delete on aqi_conversations for delete to iaq_app_user
  using (user_id = app.current_user_id() and (org_id is null or app.has_permission(org_id, 'workspace.view'::text)));

create policy aqi_messages_select on aqi_messages for select to iaq_app_user
  using (exists (select 1 from aqi_conversations c where c.id = conversation_id and c.user_id = app.current_user_id()
    and (c.org_id is null or app.has_permission(c.org_id, 'workspace.view'::text))));
create policy aqi_messages_insert on aqi_messages for insert to iaq_app_user
  with check (user_id = app.current_user_id() and exists (select 1 from aqi_conversations c where c.id = conversation_id and c.user_id = app.current_user_id()));
create policy aqi_messages_update on aqi_messages for update to iaq_app_user
  using (user_id = app.current_user_id() and exists (select 1 from aqi_conversations c where c.id = conversation_id and c.user_id = app.current_user_id()))
  with check (user_id = app.current_user_id());

insert into aqi_config_versions (version, status, config, notes, published_at)
values (
  1,
  'published',
  jsonb_build_object(
    'identity', 'AQi',
    'description', 'The official iAcquireOS platform assistant.',
    'tone', 'friendly, professional and plain-English',
    'greeting', 'Hi, I''m AQi. I can help you find your way around iAcquireOS, understand your permissions and use the features available to you.',
    'instructions', 'Answer from the approved iAcquireOS knowledge supplied for this request. Be concise and practical. Never claim to have changed a setting, sent a message or created a ticket. If you cannot verify an answer, say so and point to Support or the correct administrator.',
    'maxTokens', 700,
    'temperature', 0.3,
    'model', 'deepseek-chat'
  ),
  'Initial published AQi configuration',
  now()
)
on conflict (version) do nothing;

insert into aqi_knowledge_entries (title, category, body, route_prefix, roles, status, source, published_at)
values
  ('What iAcquireOS is', 'Platform overview', 'iAcquireOS is the operating system for an iAcquire client workspace: it brings AI employees, leads, appointments, sales, CRM, websites, analytics, knowledge and support into one portal. The exact modules available depend on the workspace and the signed-in person''s role.', null, '{}', 'published', 'Approved platform overview', now()),
  ('AI employees', 'AI Employees', 'AI employees are named, role-specific assistants. A workspace owner or manager can open AI Workforce to see each employee, chat with it, review its instructions and activity, and manage its knowledge. Availability depends on the employee''s connection and health status; a setup-required or paused employee cannot chat.', '/workforce', '{}', 'published', 'Approved workforce guide', now()),
  ('Employee instructions and knowledge', 'AI Employees', 'Open an AI employee, then use Configure to edit its tone, instructions and allowed tools. Use the Knowledge tab for employee-specific notes and documents, or the workspace Knowledge Center for company-wide knowledge. Changes are versioned; a risky instruction may be held for iAcquire review. Nothing is applied until the saved version is active.', '/workforce', '{}', 'published', 'Approved workforce guide', now()),
  ('Chat with an AI employee', 'AI Employees', 'Open AI Workforce, choose an employee, and select Start a chat. Chat history is saved in the workspace. You can start a new conversation, search earlier conversations, stop a response, or retry after a failure. If the employee is not online, the portal shows its real status instead of pretending it is available.', '/chat', '{}', 'published', 'Approved workforce guide', now()),
  ('Knowledge Center', 'Knowledge', 'Knowledge Center holds the company knowledge used by AI employees and the documents your team uploads. Owners and managers can edit knowledge. Text notes and selectable-text PDF/Word documents can be read; encrypted or image-only PDFs and damaged files are stored but not used, and OCR is not supported.', '/knowledge', '{}', 'published', 'Approved knowledge guide', now()),
  ('Integrations', 'Integrations', 'Integrations connect iAcquireOS to services such as Hermes, GoHighLevel, calendars, messaging and email. Open Settings → Integrations to see what is connected and what needs attention. Credentials are stored server-side and are never shown again. Only an owner or manager can change them.', '/settings/integrations', '{}', 'published', 'Approved integrations guide', now()),
  ('Team roles and permissions', 'Account and permissions', 'Owners and managers can invite and manage the team under Settings → Team. A person''s role controls what they can see and do; the server enforces it even if a page is opened directly. If a control is missing, your role does not include that permission. Ask an owner or manager for access rather than trying to bypass it.', '/settings/team', '{}', 'published', 'Approved permissions guide', now()),
  ('Billing and usage', 'Billing', 'Billing shows the workspace plan, usage and any available actions. Only the workspace owner can manage billing; managers and staff may be able to view usage. The core iAcquire setup is a one-time $1,499 fee; optional projects, add-ons and maintenance are separate and are confirmed in writing before work begins.', '/billing', '{}', 'published', 'Approved billing guide', now()),
  ('Setup and onboarding', 'Setup', 'Setup Center shows the work needed to activate the workspace. Owners and managers can respond to setup requests and approve previews. The setup percentage measures completed setup work; activation also needs successful connection checks and an agency review.', '/setup', '{}', 'published', 'Approved setup guide', now()),
  ('Support and human escalation', 'Support', 'If AQi cannot resolve a problem, open Support or use Talk to iAcquire Team. You can describe the issue, choose a category and keep a reference number. A support request is only created when the real Support workflow confirms it; AQi never claims a ticket exists.', '/support', '{}', 'published', 'Approved support guide', now()),
  ('Native CRM', 'CRM', 'The native CRM is the workspace''s own contacts, companies, pipelines, deals, tasks and activity record. Access depends on CRM permissions and whether the workspace uses the native CRM or an external provider. AQi can explain where a feature is, but it cannot read or change CRM records for you.', '/crm', '{}', 'published', 'Approved CRM overview', now()),
  ('AQi is not an administrator', 'Platform overview', 'AQi can explain the portal and prepare a support request, but it cannot change settings, invite people, publish a website, send messages, move money or alter an AI employee for you. Those actions stay with the authorized person and the normal confirmation screens.', null, '{}', 'published', 'Immutable AQi boundary', now())
on conflict do nothing;

insert into aqi_suggested_questions (question, scope, role, route_prefix, sort_order)
values
  ('What can I do in iAcquireOS?', 'global', null, null, 10),
  ('How do I manage my AI employees?', 'global', null, null, 20),
  ('Where can I find my integrations?', 'global', null, null, 30),
  ('How do I contact support?', 'global', null, null, 40),
  ('How do I change an employee''s instructions?', 'page', null, '/workforce', 50),
  ('Where is my Knowledge Center?', 'page', null, '/knowledge', 60),
  ('How do I invite a team member?', 'page', null, '/settings/team', 70),
  ('What does my role allow me to do?', 'role', 'viewer', null, 80)
on conflict do nothing;
