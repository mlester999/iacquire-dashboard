-- Intelligent missed-call recovery (Phase 2B foundation).
--
-- A call record (crm_call_records) says what the provider reported. A *case* says "this caller was missed and someone owes them an answer": it
-- is the durable unit the recovery engine, the Inbox and the CRM timeline work on. Design rules:
--
--   * The server is the only writer. The application role gets SELECT under row-level security (statement-level helpers, as 0060 requires) and
--     no write grant. Every write runs in trusted server code after its own authorization check.
--   * One open case per caller number per workspace (a partial unique index): a second missed call from the same number joins the open case
--     through missed_call_case_calls instead of creating a second follow-up. A call id belongs to exactly one case.
--   * The case's state is one of eleven values and moves only through validated transitions (src/lib/missed-calls/state.ts). Every move bumps
--     `version`, so two writers racing on the same case cannot both win, and is written to the append-only missed_call_case_events trail with
--     its actor.
--   * An action (a task, a notice, a text, an AI call-back) has a dedupe key that is unique per workspace, so a retry or a second worker can
--     never do it twice. A text is "sent" only when the message row says so; an AI call-back is never anything but "blocked" until a verified
--     outbound-call capability exists.
--   * Nothing here sends. Texts go through the existing send chain (consent, opt-out, quiet hours, ownership fences, credits, provider
--     switches). The policy is OFF by default and `activated_at` must be set by a person before any automatic send.

-- ---------------------------------------------------------------------------
-- Policy: one row per workspace, safe defaults
-- ---------------------------------------------------------------------------

create table missed_call_policies (
  org_id uuid primary key references organizations(id) on delete cascade,
  -- Master switch. Off: calls are still detected and shown, and a person can work every case by hand, but nothing happens automatically.
  enabled boolean not null default false,
  -- manual: tasks and notices only. assisted: also drafts a text that a person approves. automatic: also sends an eligible text.
  mode text not null default 'manual' check (mode in ('manual', 'assisted', 'automatic')),
  -- A person confirmed the channel, the wording and the rules. No text is drafted or sent before this is set.
  activated_at timestamptz,
  activated_by uuid references users(id) on delete set null,
  classes text[] not null default array['ring_no_answer', 'voicemail', 'abandoned', 'provider_failed']::text[]
    check (classes <@ array['ring_no_answer', 'voicemail', 'abandoned', 'busy', 'provider_failed']::text[] and cardinality(classes) between 1 and 5),
  -- An answered call that ends within this many seconds with nothing said is treated as abandoned.
  abandoned_max_seconds integer not null default 8 check (abandoned_max_seconds between 1 and 60),
  delay_minutes integer not null default 2 check (delay_minutes between 0 and 1440),
  max_attempts integer not null default 2 check (max_attempts between 1 and 5),
  attempt_gap_minutes integer not null default 240 check (attempt_gap_minutes between 15 and 10080),
  response_window_hours integer not null default 48 check (response_window_hours between 1 and 336),
  case_expiry_hours integer not null default 72 check (case_expiry_hours between 6 and 720),
  -- wait_for_open: a text waits until business hours. send_after_hours_text: the after-hours wording goes out promptly (quiet hours still apply).
  after_hours_behavior text not null default 'wait_for_open' check (after_hours_behavior in ('wait_for_open', 'send_after_hours_text')),
  action_task boolean not null default true,
  task_due_minutes integer not null default 60 check (task_due_minutes between 5 and 10080),
  action_notify boolean not null default true,
  notify_roles text[] not null default array['owner', 'admin']::text[] check (notify_roles <@ array['owner', 'admin', 'member', 'sales_rep', 'support', 'appointment_setter']::text[] and cardinality(notify_roles) between 1 and 6),
  assign_user_id uuid references users(id) on delete set null,
  action_opportunity boolean not null default true,
  action_follow_up boolean not null default true,
  action_message boolean not null default false,
  message_channels text[] not null default array['sms']::text[] check (message_channels <@ array['sms', 'email']::text[] and cardinality(message_channels) between 1 and 2),
  message_open text check (char_length(message_open) <= 480),
  message_after_hours text check (char_length(message_after_hours) <= 480),
  -- recorded: only a customer with consent already on record is texted. inbound_call: the business has confirmed that a caller may receive
  -- one service text about their own call (after checking the rules where its customers are); the basis is written on the consent record.
  sms_consent_basis text not null default 'recorded' check (sms_consent_basis in ('recorded', 'inbound_call')),
  consent_ack_at timestamptz,
  consent_ack_by uuid references users(id) on delete set null,
  action_ai_callback boolean not null default false,
  route_appointment_setter boolean not null default false,
  version integer not null default 1,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (sms_consent_basis = 'recorded' or consent_ack_at is not null)
);
create trigger missed_call_policies_touch before update on missed_call_policies for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Cases
-- ---------------------------------------------------------------------------

create table missed_call_cases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid,
  conversation_id uuid,
  -- The caller as the provider reported it (E.164) or null for a withheld number. Never a verified identity: caller ID can be spoofed.
  caller_number text check (caller_number ~ '^\+[1-9][0-9]{6,14}$'),
  business_number text check (business_number ~ '^\+[1-9][0-9]{6,14}$'),
  -- The class of the first missed call; every call keeps its own in missed_call_case_calls.
  classification text not null check (classification in ('ring_no_answer', 'voicemail', 'abandoned', 'busy', 'provider_failed')),
  after_hours boolean not null default false,
  provider text not null check (provider in ('vapi', 'retell', 'manual')),
  first_called_at timestamptz not null,
  last_called_at timestamptz not null,
  call_count integer not null default 1 check (call_count between 1 and 1000),
  state text not null default 'detected' check (state in (
    'detected', 'awaiting_eligibility', 'eligible', 'suppressed', 'scheduled', 'in_progress', 'awaiting_response',
    'recovered', 'completed_without_recovery', 'failed', 'canceled')),
  state_reason text check (state_reason ~ '^[a-z][a-z0-9_]{2,59}$'),
  state_changed_at timestamptz not null default now(),
  -- Optimistic concurrency: every state or ownership change names the version it started from.
  version integer not null default 1,
  next_action_at timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 20),
  last_attempt_at timestamptz,
  first_action_at timestamptz,
  response_deadline_at timestamptz,
  owner_kind text not null default 'unassigned' check (owner_kind in ('unassigned', 'human', 'ai')),
  owner_user_id uuid references users(id) on delete set null,
  owner_agent_id uuid,
  -- Moves on every change of owner or pause, so work prepared for one owner is refused after the case changed hands (the same fence the Inbox uses).
  owner_version integer not null default 0,
  paused_at timestamptz,
  paused_by uuid references users(id) on delete set null,
  recovered_via text check (recovered_via in ('customer_reply', 'appointment_booked', 'callback_completed', 'manual')),
  recovered_at timestamptz,
  resolved_at timestamptz,
  lease_owner text check (char_length(lease_owner) <= 100),
  lease_expires_at timestamptz,
  process_attempts integer not null default 0 check (process_attempts >= 0),
  last_error text check (char_length(last_error) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (contact_id, org_id) references contacts (id, org_id) on delete set null (contact_id),
  foreign key (conversation_id, org_id) references conversations (id, org_id) on delete set null (conversation_id),
  foreign key (owner_agent_id, org_id) references agent_instances (id, org_id) on delete set null (owner_agent_id),
  -- (The owner columns carry no "human needs a user" check: deleting the user or the AI employee sets the id to null, and that must not be refused.
  -- A case whose owner went away is treated as unassigned by the engine.)
  check (last_called_at >= first_called_at)
);
create trigger missed_call_cases_touch before update on missed_call_cases for each row execute function app.touch_updated_at();

-- One open case per caller number: a second missed call joins it instead of starting a second follow-up.
create unique index missed_call_cases_open_caller_idx on missed_call_cases (org_id, caller_number)
  where caller_number is not null and state not in ('recovered', 'completed_without_recovery', 'canceled', 'failed');
create index missed_call_cases_org_idx on missed_call_cases (org_id, last_called_at desc);
create index missed_call_cases_contact_idx on missed_call_cases (org_id, contact_id, last_called_at desc) where contact_id is not null;
create index missed_call_cases_conversation_idx on missed_call_cases (org_id, conversation_id) where conversation_id is not null;
-- What the scheduler job claims: due, not paused, not finished. A suppressed case is looked at again from time to time (a reason can go away) until it expires.
create index missed_call_cases_due_idx on missed_call_cases (next_action_at)
  where paused_at is null and state in ('detected', 'awaiting_eligibility', 'eligible', 'suppressed', 'scheduled', 'in_progress', 'awaiting_response');
create index missed_call_cases_lease_idx on missed_call_cases (lease_expires_at) where lease_owner is not null;

-- The calls a case holds. A call id belongs to exactly one case, so a redelivered or corrected provider event finds its case again.
create table missed_call_case_calls (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  case_id uuid not null,
  call_record_id uuid not null,
  classification text not null check (classification in ('ring_no_answer', 'voicemail', 'abandoned', 'busy', 'provider_failed')),
  after_hours boolean not null default false,
  called_at timestamptz not null,
  -- false once a late correction shows the call was answered after all: it no longer counts, and the case is re-evaluated.
  counted boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, call_record_id),
  foreign key (case_id, org_id) references missed_call_cases (id, org_id) on delete cascade,
  foreign key (call_record_id, org_id) references crm_call_records (id, org_id) on delete cascade
);
create trigger missed_call_case_calls_touch before update on missed_call_case_calls for each row execute function app.touch_updated_at();
create index missed_call_case_calls_case_idx on missed_call_case_calls (case_id, called_at);

-- ---------------------------------------------------------------------------
-- Actions
-- ---------------------------------------------------------------------------

create table missed_call_actions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  case_id uuid not null,
  kind text not null check (kind in ('task', 'notify', 'assign', 'message', 'ai_callback', 'appointment_setter', 'opportunity', 'follow_up')),
  channel text check (channel in ('sms', 'email')),
  status text not null default 'planned' check (status in ('planned', 'awaiting_approval', 'queued', 'sent', 'delivered', 'done', 'blocked', 'failed', 'skipped', 'canceled')),
  reason text check (reason ~ '^[a-z][a-z0-9_]{2,59}$'),
  -- At-most-once: the same action for the same case and attempt can only be recorded once.
  dedupe_key text not null check (char_length(dedupe_key) between 8 and 200),
  attempt_no integer not null default 0 check (attempt_no between 0 and 20),
  scheduled_for timestamptz,
  executed_at timestamptz,
  -- A drafted text waiting for a person's decision. Written by the system from the policy's own wording; never customer content.
  draft_body text check (char_length(draft_body) <= 1000),
  approved_by uuid references users(id) on delete set null,
  approved_at timestamptz,
  message_id uuid references conversation_messages(id) on delete set null,
  task_id uuid references tasks(id) on delete set null,
  actor_kind text not null default 'system' check (actor_kind in ('system', 'user', 'ai', 'workflow')),
  actor_user_id uuid references users(id) on delete set null,
  agent_id uuid references agent_instances(id) on delete set null,
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 2048),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, dedupe_key),
  foreign key (case_id, org_id) references missed_call_cases (id, org_id) on delete cascade
);
create trigger missed_call_actions_touch before update on missed_call_actions for each row execute function app.touch_updated_at();
create index missed_call_actions_case_idx on missed_call_actions (case_id, created_at);
create index missed_call_actions_message_idx on missed_call_actions (message_id) where message_id is not null;
create index missed_call_actions_open_idx on missed_call_actions (org_id, status) where status in ('planned', 'awaiting_approval', 'queued');

-- ---------------------------------------------------------------------------
-- History
-- ---------------------------------------------------------------------------

create table missed_call_case_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  case_id uuid not null,
  kind text not null check (kind ~ '^[a-z][a-z_]{2,39}$'),
  from_state text,
  to_state text,
  actor_kind text not null check (actor_kind in ('system', 'user', 'ai', 'workflow', 'provider', 'agency')),
  actor_user_id uuid references users(id) on delete set null,
  agent_id uuid references agent_instances(id) on delete set null,
  -- Ids, enums and short labels only. Never message text, names or numbers (this trail is not redacted when a contact is erased).
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 2048),
  created_at timestamptz not null default now(),
  foreign key (case_id, org_id) references missed_call_cases (id, org_id) on delete cascade
);
create index missed_call_case_events_case_idx on missed_call_case_events (case_id, id);
create index missed_call_case_events_org_idx on missed_call_case_events (org_id, id);
create trigger missed_call_case_events_immutable before update on missed_call_case_events for each row execute function app.immutable_row();

-- The recovery worker's safety-net sweep (a call whose case was not written) looks at recent inbound calls across workspaces.
create index crm_call_records_inbound_created_idx on crm_call_records (created_at desc) where direction = 'inbound';

-- ---------------------------------------------------------------------------
-- Row-level security: read under the signed-in member's call access, write only from trusted server code
-- ---------------------------------------------------------------------------

alter table missed_call_policies enable row level security;
alter table missed_call_cases enable row level security;
alter table missed_call_case_calls enable row level security;
alter table missed_call_actions enable row level security;
alter table missed_call_case_events enable row level security;

revoke all on missed_call_policies, missed_call_cases, missed_call_case_calls, missed_call_actions, missed_call_case_events from public, anon, authenticated;
grant select on missed_call_policies, missed_call_cases, missed_call_case_calls, missed_call_actions, missed_call_case_events to iaq_app_user;

create policy missed_call_policies_select on missed_call_policies for select to iaq_app_user
  using (org_id = ANY ((SELECT app.permitted_orgs('calls.view'::text))::uuid[]));
create policy missed_call_cases_select on missed_call_cases for select to iaq_app_user
  using (org_id = ANY ((SELECT app.permitted_orgs('calls.view'::text))::uuid[]));
create policy missed_call_case_calls_select on missed_call_case_calls for select to iaq_app_user
  using (org_id = ANY ((SELECT app.permitted_orgs('calls.view'::text))::uuid[]));
create policy missed_call_actions_select on missed_call_actions for select to iaq_app_user
  using (org_id = ANY ((SELECT app.permitted_orgs('calls.view'::text))::uuid[]));
create policy missed_call_case_events_select on missed_call_case_events for select to iaq_app_user
  using (org_id = ANY ((SELECT app.permitted_orgs('calls.view'::text))::uuid[]));

-- ---------------------------------------------------------------------------
-- Notification kind
-- ---------------------------------------------------------------------------

-- One kind for "a missed caller needs a person". The allow-list is read back from the live constraint and extended, never rewritten from a copy
-- (see 0083): a kind added by another migration, or by a branch merged around this one, is never dropped here.
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
  kinds := array(select distinct k from unnest(kinds || array['missed_call_follow_up']) as k order by k);
  alter table notifications drop constraint notifications_kind_check;
  execute 'alter table notifications add constraint notifications_kind_check check (kind in (' || (select string_agg(quote_literal(k), ', ' order by k) from unnest(kinds) as k) || '))';
end $$;
