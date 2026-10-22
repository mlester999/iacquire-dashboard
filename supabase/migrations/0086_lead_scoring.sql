-- AI-assisted lead scoring and prioritisation (Phase 2C foundation).
--
-- contacts.lead_score stays what it always was: a number a person, an import or the API sets. The engine never writes it. It writes the
-- `priority_*` columns beside it, and keeps every assessment it ever made, with the reasons, in lead_score_assessments.
--
-- Design rules:
--   * The score is a deterministic function of authorized CRM data (contact fields, custom fields, tags, conversations, calls, appointments,
--     deals) under the workspace's own criteria. An AI model may only extract enumerated signals from the customer's own messages; the points
--     for those signals come from rules, so the model never sets a number (src/lib/lead-scoring/*).
--   * Insufficient data is a label of its own (score null), never "cold" by omission.
--   * Every assessment stores its factors, what is missing, which factors came from rules and which from the model, the inputs' hash and the
--     moment its facts were read. An older snapshot can never replace a newer one (stale-result guard), and unchanged inputs create nothing.
--   * A person's override is a row of its own. The engine keeps assessing underneath it, but never writes over it; clearing it returns the
--     contact to the engine's latest assessment.
--   * Reassessment is queued, debounced and leased (lead_score_queue); daily AI usage is counted per workspace (lead_score_usage).
--   * The server is the only writer; the application role gets SELECT under row-level security.

-- ---------------------------------------------------------------------------
-- Profile: the workspace's own criteria
-- ---------------------------------------------------------------------------

create table lead_scoring_profiles (
  org_id uuid primary key references organizations(id) on delete cascade,
  enabled boolean not null default true,
  preset text not null default 'general' check (preset in ('general', 'real_estate', 'home_services', 'agency_b2b', 'custom')),
  -- The criteria that differ from the preset's: validated in code (src/lib/lead-scoring/criteria.ts), size-limited here.
  criteria jsonb not null default '{}'::jsonb check (jsonb_typeof(criteria) = 'object' and pg_column_size(criteria) <= 16384),
  hot_min smallint not null default 70 check (hot_min between 2 and 100),
  warm_min smallint not null default 40 check (warm_min between 1 and 99),
  -- Fewer known signals than this: the label is "insufficient data", not "cold".
  min_signals smallint not null default 3 check (min_signals between 1 and 10),
  -- Off until a founder or owner turns it on and a model is configured: the model only extracts signals; it never scores.
  ai_extraction_enabled boolean not null default false,
  ai_daily_limit integer not null default 100 check (ai_daily_limit between 0 and 5000),
  debounce_minutes integer not null default 10 check (debounce_minutes between 1 and 1440),
  version integer not null default 1,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (warm_min < hot_min)
);
create trigger lead_scoring_profiles_touch before update on lead_scoring_profiles for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- The contact's current priority (a summary of the latest accepted assessment)
-- ---------------------------------------------------------------------------

alter table contacts
  add column priority_score smallint check (priority_score between 0 and 100),
  add column priority_label text check (priority_label in ('hot', 'warm', 'cold', 'insufficient_data')),
  -- engine: the latest assessment. human: a person's override is in force (lead_score_overrides).
  add column priority_source text check (priority_source in ('engine', 'human')),
  add column priority_assessment_id uuid,
  add column priority_evaluated_at timestamptz,
  add column priority_reason text check (char_length(priority_reason) <= 240);
create index contacts_priority_idx on contacts (org_id, priority_label, priority_score desc nulls last) where deleted_at is null and priority_label is not null;

-- ---------------------------------------------------------------------------
-- History
-- ---------------------------------------------------------------------------

create table lead_score_assessments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null,
  -- 1, 2, 3 ... per contact, in the order assessments were accepted.
  seq integer not null check (seq >= 1),
  score smallint check (score between 0 and 100),
  label text not null check (label in ('hot', 'warm', 'cold', 'insufficient_data')),
  rule_points smallint not null default 0,
  ai_points smallint not null default 0,
  -- [{ key, label, dimension, points, maxPoints, direction, detail, source: 'rule' | 'ai', evidence: [{ kind, id, at }] }]
  factors jsonb not null default '[]'::jsonb check (jsonb_typeof(factors) = 'array' and pg_column_size(factors) <= 32768),
  -- [{ key, label, dimension }]: what would make the assessment better.
  missing jsonb not null default '[]'::jsonb check (jsonb_typeof(missing) = 'array' and pg_column_size(missing) <= 8192),
  dimensions jsonb not null default '{}'::jsonb check (jsonb_typeof(dimensions) = 'object' and pg_column_size(dimensions) <= 4096),
  known_signals smallint not null default 0 check (known_signals >= 0),
  summary text check (char_length(summary) <= 400),
  next_action jsonb not null default '{}'::jsonb check (jsonb_typeof(next_action) = 'object' and pg_column_size(next_action) <= 1024),
  engine_version text not null check (char_length(engine_version) between 1 and 40),
  profile_version integer not null check (profile_version >= 0),
  -- Hash of the normalised inputs. The same inputs under the same profile and engine create no new assessment.
  inputs_hash text not null check (char_length(inputs_hash) between 16 and 128),
  -- When the facts were read. An assessment whose snapshot is older than the current one is discarded, never written over it.
  facts_as_of timestamptz not null,
  trigger text check (char_length(trigger) <= 60),
  -- The enumerated signals a model extracted (intent, timeline, wants ...) with the ids of the messages they came from. Never message text.
  ai_signals jsonb check (ai_signals is null or (jsonb_typeof(ai_signals) = 'object' and pg_column_size(ai_signals) <= 4096)),
  ai_status text not null default 'not_used' check (ai_status in ('not_used', 'used', 'fallback', 'failed', 'skipped_limit')),
  ai_model text check (char_length(ai_model) <= 80),
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, contact_id, seq),
  foreign key (contact_id, org_id) references contacts (id, org_id) on delete cascade
);
create unique index lead_score_assessments_current_idx on lead_score_assessments (contact_id) where is_current;
create index lead_score_assessments_contact_idx on lead_score_assessments (org_id, contact_id, seq desc);
create index lead_score_assessments_org_idx on lead_score_assessments (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Human overrides
-- ---------------------------------------------------------------------------

create table lead_score_overrides (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null,
  label text not null check (label in ('hot', 'warm', 'cold')),
  score smallint check (score between 0 and 100),
  reason text not null check (char_length(btrim(reason)) between 3 and 300),
  set_by uuid references users(id) on delete set null,
  set_at timestamptz not null default now(),
  -- null: stays until a person clears it.
  expires_at timestamptz,
  cleared_at timestamptz,
  cleared_by uuid references users(id) on delete set null,
  clear_reason text check (char_length(clear_reason) <= 120),
  foreign key (contact_id, org_id) references contacts (id, org_id) on delete cascade
);
create unique index lead_score_overrides_active_idx on lead_score_overrides (contact_id) where cleared_at is null;
create index lead_score_overrides_org_idx on lead_score_overrides (org_id, set_at desc);

-- ---------------------------------------------------------------------------
-- Reassessment queue
-- ---------------------------------------------------------------------------

-- One row per contact that needs a new look. New information bumps `generation` and slides `not_before` forward (never past
-- first_requested_at + 60 minutes), so a burst of events becomes one assessment, and a result computed for an older generation is not final.
create table lead_score_queue (
  contact_id uuid primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  generation integer not null default 1 check (generation >= 1),
  trigger text not null check (char_length(trigger) <= 60),
  first_requested_at timestamptz not null default now(),
  requested_at timestamptz not null default now(),
  not_before timestamptz not null default now(),
  attempts integer not null default 0 check (attempts between 0 and 20),
  lease_owner text check (char_length(lease_owner) <= 100),
  lease_expires_at timestamptz,
  last_error text check (char_length(last_error) <= 300),
  foreign key (contact_id, org_id) references contacts (id, org_id) on delete cascade
);
create index lead_score_queue_due_idx on lead_score_queue (not_before) where lease_owner is null;
create index lead_score_queue_org_idx on lead_score_queue (org_id, not_before);
create index lead_score_queue_lease_idx on lead_score_queue (lease_expires_at) where lease_owner is not null;

-- ---------------------------------------------------------------------------
-- Daily usage (cost protection and the dashboard's honest counts)
-- ---------------------------------------------------------------------------

create table lead_score_usage (
  org_id uuid not null references organizations(id) on delete cascade,
  day date not null,
  assessments integer not null default 0 check (assessments >= 0),
  ai_calls integer not null default 0 check (ai_calls >= 0),
  ai_failures integer not null default 0 check (ai_failures >= 0),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  primary key (org_id, day)
);

-- ---------------------------------------------------------------------------
-- Row-level security: read under the member's own access, write only from trusted server code
-- ---------------------------------------------------------------------------

alter table lead_scoring_profiles enable row level security;
alter table lead_score_assessments enable row level security;
alter table lead_score_overrides enable row level security;
alter table lead_score_queue enable row level security;
alter table lead_score_usage enable row level security;

revoke all on lead_scoring_profiles, lead_score_assessments, lead_score_overrides, lead_score_queue, lead_score_usage from public, anon, authenticated;
grant select on lead_scoring_profiles, lead_score_assessments, lead_score_overrides, lead_score_queue, lead_score_usage to iaq_app_user;

create policy lead_scoring_profiles_select on lead_scoring_profiles for select to iaq_app_user
  using (org_id = ANY ((SELECT app.permitted_orgs('contacts.view'::text))::uuid[]));
create policy lead_score_assessments_select on lead_score_assessments for select to iaq_app_user
  using (org_id = ANY ((SELECT app.permitted_orgs('contacts.view'::text))::uuid[]));
create policy lead_score_overrides_select on lead_score_overrides for select to iaq_app_user
  using (org_id = ANY ((SELECT app.permitted_orgs('contacts.view'::text))::uuid[]));
create policy lead_score_queue_select on lead_score_queue for select to iaq_app_user
  using (org_id = ANY ((SELECT app.permitted_orgs('contacts.view'::text))::uuid[]));
create policy lead_score_usage_select on lead_score_usage for select to iaq_app_user
  using (org_id = ANY ((SELECT app.permitted_orgs('analytics.view'::text))::uuid[]));

-- ---------------------------------------------------------------------------
-- Notification kind
-- ---------------------------------------------------------------------------

-- One kind: a lead became hot. Read back from the live constraint and extended, never rewritten from a copy (see 0083 and 0085).
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
  kinds := array(select distinct k from unnest(kinds || array['hot_lead_detected']) as k order by k);
  alter table notifications drop constraint notifications_kind_check;
  execute 'alter table notifications add constraint notifications_kind_check check (kind in (' || (select string_agg(quote_literal(k), ', ' order by k) from unnest(kinds) as k) || '))';
end $$;
