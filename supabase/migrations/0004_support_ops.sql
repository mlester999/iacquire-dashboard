-- iAcquire Client Portal — notifications, support, help assistant, usage, audit, billing.

create table notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in (
    'agent_task_completed', 'lead_awaiting_approval', 'booking_confirmed', 'workflow_failure',
    'knowledge_update_ready', 'support_reply', 'support_ticket_created', 'integration_disconnected',
    'usage_limit_approaching', 'approval_requested', 'approval_decided', 'agent_status', 'system')),
  severity text not null default 'info' check (severity in ('info', 'success', 'warning', 'critical')),
  title text not null check (char_length(title) between 1 and 200),
  body text check (char_length(body) <= 1000),
  link text check (link ~ '^/[A-Za-z0-9/_?=&%.-]*$'),
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on notifications (user_id, created_at desc);
create index notifications_unread_idx on notifications (user_id) where read_at is null;

create table notification_preferences (
  user_id uuid not null references users(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  prefs jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, org_id)
);

-- ---------------------------------------------------------------------------
-- Human support (works without any external notification provider)
-- ---------------------------------------------------------------------------

create sequence support_ticket_ref_seq start with 1001;

create table support_tickets (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique default ('IAQ-' || nextval('support_ticket_ref_seq')::text),
  org_id uuid not null references organizations(id) on delete cascade,
  created_by uuid references users(id) on delete set null,
  subject text not null check (char_length(subject) between 3 and 160),
  category text not null default 'general'
    check (category in ('general', 'ai_employees', 'integrations', 'billing', 'account', 'bug', 'onboarding')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'waiting_for_client', 'resolved', 'closed')),
  assigned_to uuid references users(id) on delete set null,
  page_context text check (char_length(page_context) <= 200),
  external_notification text not null default 'not_configured'
    check (external_notification in ('not_configured', 'sent', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create index support_tickets_org_idx on support_tickets (org_id, last_message_at desc);
create index support_tickets_status_idx on support_tickets (status, last_message_at desc);
create trigger support_tickets_touch before update on support_tickets for each row execute function app.touch_updated_at();

create table support_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references support_tickets(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  author_id uuid references users(id) on delete set null,
  author_kind text not null check (author_kind in ('client', 'agency', 'system')),
  body text not null check (char_length(body) between 1 and 5000),
  internal boolean not null default false,
  created_at timestamptz not null default now()
);
create index support_messages_ticket_idx on support_messages (ticket_id, created_at);

-- iAcquire Assistant conversations: per user, separate from any tenant AI employee.
create table help_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  org_id uuid references organizations(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create index help_conversations_user_idx on help_conversations (user_id, last_message_at desc);

create table help_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references help_conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) <= 8000),
  mode text check (mode in ('ai', 'help_search', 'redirect', 'escalation')),
  links jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index help_messages_conversation_idx on help_messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Usage and cost controls
-- ---------------------------------------------------------------------------

create table usage_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  agent_instance_id uuid references agent_instances(id) on delete set null,
  kind text not null check (kind in ('agent_message', 'agent_run_failed', 'lead_research', 'help_request', 'crm_sync')),
  quantity integer not null default 1 check (quantity >= 0),
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz not null default now()
);
create index usage_events_org_idx on usage_events (org_id, created_at desc);

create table usage_limits (
  org_id uuid primary key references organizations(id) on delete cascade,
  monthly_agent_messages integer not null default 1500 check (monthly_agent_messages >= 0),
  monthly_tokens bigint check (monthly_tokens >= 0),
  daily_lead_research integer not null default 5 check (daily_lead_research >= 0),
  monthly_help_requests integer not null default 500 check (monthly_help_requests >= 0),
  warn_at_percent integer not null default 80 check (warn_at_percent between 1 and 100),
  hard_stop boolean not null default true,
  fair_use_note text check (char_length(fair_use_note) <= 1000),
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Billing information (no live payment collection)
-- ---------------------------------------------------------------------------

create table billing_accounts (
  org_id uuid primary key references organizations(id) on delete cascade,
  setup_fee_cents integer not null default 149900 check (setup_fee_cents >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  setup_payment_status text not null default 'not_invoiced'
    check (setup_payment_status in ('not_invoiced', 'invoiced', 'paid', 'waived', 'refunded')),
  activation_status text not null default 'pending' check (activation_status in ('pending', 'active', 'suspended')),
  invoice_url text check (invoice_url ~ '^https://'),
  receipt_url text check (receipt_url ~ '^https://'),
  paid_at timestamptz,
  service_terms text check (char_length(service_terms) <= 4000),
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Audit log (append-only; no secrets or message bodies)
-- ---------------------------------------------------------------------------

create table audit_logs (
  id bigint generated always as identity primary key,
  org_id uuid references organizations(id) on delete set null,
  actor_user_id uuid references users(id) on delete set null,
  actor_kind text not null check (actor_kind in ('user', 'agency', 'agent', 'system')),
  agent_instance_id uuid references agent_instances(id) on delete set null,
  action text not null check (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  target_type text check (char_length(target_type) <= 60),
  target_id text check (char_length(target_id) <= 120),
  result text not null check (result in ('success', 'denied', 'failure')),
  approval_id uuid,
  ip_hash text,
  metadata jsonb not null default '{}'::jsonb check (pg_column_size(metadata) <= 8192),
  created_at timestamptz not null default now()
);
create index audit_logs_org_idx on audit_logs (org_id, created_at desc);
create index audit_logs_actor_idx on audit_logs (actor_user_id, created_at desc);

create or replace function app.audit_logs_append_only() returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_logs is append-only' using errcode = 'insufficient_privilege';
end
$$;
create trigger audit_logs_no_update before update or delete on audit_logs
  for each row execute function app.audit_logs_append_only();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table notifications enable row level security;
alter table notification_preferences enable row level security;
alter table support_tickets enable row level security;
alter table support_messages enable row level security;
alter table help_conversations enable row level security;
alter table help_messages enable row level security;
alter table usage_events enable row level security;
alter table usage_limits enable row level security;
alter table billing_accounts enable row level security;
alter table audit_logs enable row level security;

grant select on notifications to iaq_app_user;
grant update (read_at) on notifications to iaq_app_user;
create policy notifications_select on notifications for select to iaq_app_user
  using (user_id = app.current_user_id());
create policy notifications_update on notifications for update to iaq_app_user
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());

grant select, insert, update on notification_preferences to iaq_app_user;
create policy notification_prefs_all on notification_preferences for all to iaq_app_user
  using (user_id = app.current_user_id() and app.can_access_org(org_id))
  with check (user_id = app.current_user_id() and app.can_access_org(org_id));

grant select on support_tickets to iaq_app_user;
create policy support_tickets_select on support_tickets for select to iaq_app_user
  using (app.has_permission(org_id, 'support.use') or app.staff_assigned(org_id));

-- Internal agency notes are never visible to client users.
grant select on support_messages to iaq_app_user;
create policy support_messages_select on support_messages for select to iaq_app_user
  using ((not internal and app.has_permission(org_id, 'support.use')) or app.staff_assigned(org_id));

grant select on help_conversations to iaq_app_user;
create policy help_conversations_select on help_conversations for select to iaq_app_user
  using (user_id = app.current_user_id());

grant select on help_messages to iaq_app_user;
create policy help_messages_select on help_messages for select to iaq_app_user
  using (exists (select 1 from help_conversations c where c.id = conversation_id));

grant select on usage_events to iaq_app_user;
create policy usage_events_select on usage_events for select to iaq_app_user
  using (app.has_permission(org_id, 'usage.view'));

grant select on usage_limits to iaq_app_user;
create policy usage_limits_select on usage_limits for select to iaq_app_user
  using (app.has_permission(org_id, 'usage.view'));

grant select on billing_accounts to iaq_app_user;
create policy billing_select on billing_accounts for select to iaq_app_user
  using (app.has_permission(org_id, 'billing.view'));

grant select on audit_logs to iaq_app_user;
create policy audit_select on audit_logs for select to iaq_app_user
  using ((org_id is not null and app.has_permission(org_id, 'activity.view')) or app.is_agency_admin());
