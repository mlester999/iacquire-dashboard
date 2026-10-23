-- Phase 5F/5G: reputation follow-through. A low private score adds a person's follow-up, never anything else.
--
--   * customer_feedback: which scale the answer was on (one to five, or zero to ten), whether it was low (decided when it arrived, from that workspace's settings, so
--     changing a threshold later never rewrites history), the inbox escalation it raised, who acknowledged and resolved it and when, and the one reminder sent
--     when nobody acknowledged it in time, and the survey form submission it came from.
--   * crm_review_requests: the kind of ask (a review request or a satisfaction survey), its scale, and two more ways a request can start (a retention program step,
--     a batch). The token hash stays unreadable by the application role.
--   * reputation_settings: one row per workspace that changed anything (absent means the defaults): the thresholds, the acknowledgement time, and the optional assists.
--   * review_request_batches and review_request_batch_items: an owner-approved ask to many customers at a set pace, chosen only by a completed service; and
--     crm_review_requests.batch_id, which says which batch a request came from.
--   * Three permissions (reviews.view, reviews.respond, reviews.reply_publish) and six notification kinds. Nothing here reads or writes a review site.
--
-- Additive. The only existing rows touched are customer_feedback rows that were already escalated by the old rule (rating of two or less): their new low_score
-- flag is set to match. Every new table is workspace-keyed with composite foreign keys, has row-level security, and gives the application role SELECT only: every
-- write runs in trusted server code after its own authorization check.

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------

-- View: the whole client team and the agency's staff and managers (they read, as they can read contacts). Respond (draft and submit a reply, once public reviews
-- exist): the people who write to customers, plus the agency's managers: they draft, they never approve or post. Publish (approve and post a reply under the
-- business's name): the client's owner and manager only.
insert into role_permissions (role, permission) values
  ('owner', 'reviews.view'), ('admin', 'reviews.view'), ('member', 'reviews.view'), ('sales_rep', 'reviews.view'), ('support', 'reviews.view'), ('viewer', 'reviews.view'),
  ('appointment_setter', 'reviews.view'), ('agency_staff', 'reviews.view'), ('agency_manager', 'reviews.view'),
  ('owner', 'reviews.respond'), ('admin', 'reviews.respond'), ('member', 'reviews.respond'), ('sales_rep', 'reviews.respond'), ('support', 'reviews.respond'),
  ('agency_manager', 'reviews.respond'), ('agency_super_admin', 'reviews.respond'),
  ('owner', 'reviews.reply_publish'), ('admin', 'reviews.reply_publish')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

create table reputation_settings (
  org_id uuid primary key references organizations(id) on delete cascade,
  -- A one-to-five rating at or below this is low private feedback; so is a zero-to-ten score at or below the detractor level. Both are decided when the feedback arrives.
  escalate_at_or_below smallint not null default 2 check (escalate_at_or_below between 1 and 3),
  nps_detractor_max smallint not null default 6 check (nps_detractor_max between 4 and 7),
  acknowledge_within_hours integer not null default 24 check (acknowledge_within_hours between 1 and 168),
  public_review_alert_at_or_below smallint not null default 3 check (public_review_alert_at_or_below between 1 and 4),
  -- Off until someone turns it on. Even on, a reply draft is started by a person, labelled AI-drafted, and approved and posted by a person: there is no auto-reply.
  ai_replies_enabled boolean not null default false,
  reply_style_note text check (char_length(reply_style_note) <= 600),
  sla_reminders_enabled boolean not null default true,
  -- A daily internal notice about finished appointments with no recorded outcome. Nothing is ever marked attended for anyone.
  outcome_nudges_enabled boolean not null default false,
  -- A daily internal reminder (a task and a notice for the team, never a message to a customer) that a customer account on the retention page renews within 30, 14 or 7 days.
  renewal_reminders_enabled boolean not null default false,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null
);

-- ---------------------------------------------------------------------------
-- Private feedback: scale, follow-up, escalation
-- ---------------------------------------------------------------------------

alter table customer_feedback
  add column scale text not null default 'csat5' check (scale in ('csat5', 'nps10')),
  add column nps_score smallint check (nps_score between 0 and 10),
  add column low_score boolean not null default false,
  add column escalation_id uuid,
  add column acknowledged_at timestamptz,
  add column acknowledged_by uuid references users(id) on delete set null,
  add column resolved_at timestamptz,
  add column resolved_by uuid references users(id) on delete set null,
  add column resolution_note text check (char_length(resolution_note) <= 600),
  add column sla_notified_at timestamptz,
  -- The survey form submission an answer came from (source 'survey'): one submission makes at most one answer, and its answers are erased with the person's.
  add column form_submission_id uuid;

-- A zero-to-ten answer carries no star rating, and a star rating carries no zero-to-ten score.
alter table customer_feedback add constraint customer_feedback_nps_scale_check check (scale = 'nps10' or nps_score is null);
alter table customer_feedback add constraint customer_feedback_csat_scale_check check (scale = 'csat5' or rating is null);
-- An answer from a customer says something: a score or a comment. (Hand-recorded feedback from before this migration is exempt.)
alter table customer_feedback add constraint customer_feedback_has_content_check check (source = 'manual' or rating is not null or nps_score is not null or comment is not null);
alter table customer_feedback add constraint customer_feedback_resolved_check check (resolved_at is null or follow_up_status = 'resolved');
alter table customer_feedback add constraint customer_feedback_escalation_fk foreign key (escalation_id, org_id) references human_escalations (id, org_id) on delete set null (escalation_id);
alter table customer_feedback add constraint customer_feedback_submission_fk foreign key (form_submission_id, org_id) references crm_form_submissions (id, org_id) on delete set null (form_submission_id);
alter table customer_feedback add constraint customer_feedback_submission_source_check check (form_submission_id is null or source = 'survey');
create unique index customer_feedback_submission_idx on customer_feedback (org_id, form_submission_id) where form_submission_id is not null;

-- Feedback that the old rule had already escalated (a rating of two or less, which always made a task) was low by the rule in force then.
update customer_feedback set low_score = true where escalated_task_id is not null;

create index customer_feedback_contact_idx on customer_feedback (org_id, contact_id, received_at desc) where contact_id is not null;
-- The Satisfaction view and the feedback list read a workspace's answers for a period, newest first.
create index customer_feedback_period_idx on customer_feedback (org_id, received_at desc);
-- The reminder job's work list: low feedback nobody has acknowledged and nobody was reminded about.
create index customer_feedback_sla_idx on customer_feedback (org_id, received_at) where low_score and sla_notified_at is null and follow_up_status in ('new', 'escalated');

-- ---------------------------------------------------------------------------
-- Review requests: the kind of ask, and where it came from
-- ---------------------------------------------------------------------------

alter table crm_review_requests
  add column kind text not null default 'review' check (kind in ('review', 'survey')),
  add column scale text not null default 'csat5' check (scale in ('csat5', 'nps10'));

alter table crm_review_requests drop constraint if exists crm_review_requests_requested_via_check;
alter table crm_review_requests add constraint crm_review_requests_requested_via_check check (requested_via in ('manual', 'workflow', 'api', 'program', 'batch'));

-- ---------------------------------------------------------------------------
-- Review request batches: one approved ask to many customers, sent at a set pace
-- ---------------------------------------------------------------------------

-- A batch asks the customers for whom a service was completed in a window (an appointment marked attended, a deal won, a customer since). Who is in it never depends on how
-- they felt: the criteria column can hold only the keys listed below, so no application bug can store a rating, a score, a comment, a status or an escalation as a way to choose
-- people. The owner approves the exact wording, criteria, channel and pace (approved_hash), and the scheduler stops the batch if any of it changes. Nothing is sent by this
-- migration, and nothing runs until the workspace's batch switch is on.
create table review_request_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  -- draft: being prepared. awaiting_approval: asked of the owner. approved: waiting for the scheduler to start it. sending: people are asked at the set pace.
  -- paused: held by a person, or by itself (credits, the channel, a missing link). completed: everyone was handled. cancelled: ended by a person. stopped: ended by the
  -- system because the approved wording or values no longer stand; it cannot be resumed.
  status text not null default 'draft' check (status in ('draft', 'awaiting_approval', 'approved', 'sending', 'paused', 'completed', 'cancelled', 'stopped')),
  kind text not null default 'review' check (kind in ('review', 'survey')),
  scale text not null default 'csat5' check (scale in ('csat5', 'nps10')),
  channel text not null check (channel in ('email', 'sms', 'whatsapp')),
  template_id uuid,
  criteria jsonb not null check (
    jsonb_typeof(criteria) = 'object' and pg_column_size(criteria) <= 4096
    and (criteria - array['source', 'from', 'to', 'calendarIds', 'appointmentTypeIds', 'pipelineId']) = '{}'::jsonb
    and coalesce(criteria ->> 'source', '') in ('appointments_showed', 'deals_won', 'customers_since')
  ),
  rate_per_minute integer not null default 10 check (rate_per_minute between 1 and 60),
  estimate jsonb not null default '{}'::jsonb check (jsonb_typeof(estimate) = 'object' and pg_column_size(estimate) <= 4096),
  counts jsonb not null default '{}'::jsonb check (jsonb_typeof(counts) = 'object' and pg_column_size(counts) <= 4096),
  approval_id uuid references approval_requests(id) on delete set null,
  approved_hash text check (approved_hash ~ '^[0-9a-f]{64}$'),
  -- What the owner approved, as the hash was made from it (the wording's version and hash, the criteria, the channel, the pace, the business values the wording uses).
  approved_binding jsonb check (jsonb_typeof(approved_binding) = 'object' and pg_column_size(approved_binding) <= 8192),
  requested_by uuid references users(id) on delete set null,
  requested_at timestamptz,
  approved_by uuid references users(id) on delete set null,
  approved_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_by uuid references users(id) on delete set null,
  unique (id, org_id),
  foreign key (template_id, org_id) references crm_message_templates (id, org_id) on delete set null (template_id),
  check ((approved_hash is null) = (approved_binding is null)),
  check (status not in ('approved', 'sending', 'paused', 'completed') or approved_hash is not null)
);
create index review_request_batches_org_idx on review_request_batches (org_id, created_at desc);
-- The scheduler's work list: approved batches waiting to start and batches being sent.
create index review_request_batches_due_idx on review_request_batches (status) where status in ('approved', 'sending');
create trigger review_request_batches_touch before update on review_request_batches for each row execute function app.touch_updated_at();

-- The request a batch made carries its batch, so the Requests list can say where it came from.
alter table crm_review_requests add column batch_id uuid;
alter table crm_review_requests add constraint crm_review_requests_batch_fk foreign key (batch_id, org_id) references review_request_batches (id, org_id) on delete set null (batch_id);
create index crm_review_requests_batch_idx on crm_review_requests (org_id, batch_id) where batch_id is not null;

-- One row per customer in a batch, written when the batch starts: left out with the reason, still waiting, asked (queued), or failed.
create table review_request_batch_items (
  org_id uuid not null,
  batch_id uuid not null,
  contact_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'queued', 'excluded', 'failed')),
  -- Why someone was left out or failed (no_address, suppressed, no_consent, recently_requested, held_by_person, ...); a refusal with no code of its own is blocked:<reason>.
  reason text check (char_length(reason) <= 120),
  -- The completed service that put them in the batch: the attended appointment or the won deal, and when it happened.
  appointment_id uuid,
  opportunity_id uuid,
  fact_at timestamptz,
  request_id uuid,
  queued_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (batch_id, contact_id),
  foreign key (batch_id, org_id) references review_request_batches (id, org_id) on delete cascade,
  foreign key (contact_id, org_id) references contacts (id, org_id) on delete cascade,
  foreign key (appointment_id, org_id) references appointment_refs (id, org_id) on delete set null (appointment_id),
  foreign key (opportunity_id, org_id) references crm_opportunities (id, org_id) on delete set null (opportunity_id),
  foreign key (request_id, org_id) references crm_review_requests (id, org_id) on delete set null (request_id)
);
create index review_request_batch_items_status_idx on review_request_batch_items (batch_id, status);
create index review_request_batch_items_contact_idx on review_request_batch_items (org_id, contact_id);

-- The application role reads these columns of a request (the token hash stays out of reach).
grant select (kind, scale, batch_id) on crm_review_requests to iaq_app_user;

-- ---------------------------------------------------------------------------
-- Row-level security: read under the signed-in member's access, write only from trusted server code
-- ---------------------------------------------------------------------------

alter table reputation_settings enable row level security;
revoke all on reputation_settings from public, anon, authenticated;
grant select on reputation_settings to iaq_app_user;
create policy reputation_settings_select on reputation_settings for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('reviews.view'::text))::uuid[]));

alter table review_request_batches enable row level security;
revoke all on review_request_batches from public, anon, authenticated;
grant select on review_request_batches to iaq_app_user;
create policy review_request_batches_select on review_request_batches for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('reviews.view'::text))::uuid[]));

alter table review_request_batch_items enable row level security;
revoke all on review_request_batch_items from public, anon, authenticated;
grant select on review_request_batch_items to iaq_app_user;
create policy review_request_batch_items_select on review_request_batch_items for select to iaq_app_user using (org_id = ANY ((SELECT app.permitted_orgs('reviews.view'::text))::uuid[]));

-- ---------------------------------------------------------------------------
-- Notification kinds
-- ---------------------------------------------------------------------------

-- Read back from the live constraint and extended, never rewritten from a copy (see 0083, 0087 and 0089).
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
  kinds := array(select distinct k from unnest(kinds || array['feedback_follow_up_overdue', 'review_needs_reply', 'review_reply_requested', 'review_reply_decided', 'review_reply_failed', 'review_connection_attention']) as k order by k);
  alter table notifications drop constraint notifications_kind_check;
  execute 'alter table notifications add constraint notifications_kind_check check (kind in (' || (select string_agg(quote_literal(k), ', ' order by k) from unnest(kinds) as k) || '))';
end $$;
