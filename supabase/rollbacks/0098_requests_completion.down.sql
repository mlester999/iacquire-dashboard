-- Rollback for 0098_requests_completion.sql. NOT a migration: review and run in one transaction.
-- Refuses when the feature has been used, so a client's history is never dropped by accident: a Request a Change request (or anything filed under its categories), a change
-- request, its recorded decision or the scope it added, a prerequisite, a mention, a triage record, a survey, a warranty or revision count recorded on a project, a timeline
-- entry or notification log row of the new kinds, or a notification of one of the five new kinds. Export those deliberately first.
-- Dropped without a question, because they carry no history: the retry keys on project requests and project messages, the settings switches (surveys, AI triage, project
-- review target, prerequisites) and the two notification rules, which are configuration.
-- Request a Change is switched on per workspace by a Super Admin (an org_features row, feature 'request_changes'; 0098 itself adds none). The guard above has already refused if any
-- of its data exists, so the switch rows carry no history and are deleted below. The purge exception 0098 gave 0015's quote_approvals trigger is taken away again.

do $$
begin
  if exists (select 1 from support_tickets where request_type = 'change' or category in ('change_ai_employee', 'change_website', 'change_automation', 'change_integration', 'change_project', 'change_other')) then
    raise exception 'Rollback refused: Request a Change requests exist. Export them deliberately first.';
  end if;
  if exists (select 1 from support_ticket_change) then
    raise exception 'Rollback refused: change classifications exist. Export them first.';
  end if;
  if exists (select 1 from project_change_orders) or exists (select 1 from project_change_order_decisions) or exists (select 1 from project_scope_amendments) then
    raise exception 'Rollback refused: project change requests, their recorded decisions or the scope they added exist. Export them first; a declined or withdrawn change is kept for good.';
  end if;
  if exists (select 1 from project_prerequisites) then
    raise exception 'Rollback refused: project prerequisites exist. Export them first.';
  end if;
  if exists (select 1 from client_projects where warranty_days is not null or warranty_ends_on is not null or revisions_included is not null or revisions_used > 0) then
    raise exception 'Rollback refused: a warranty window or a revision count is recorded on a project. Export it first.';
  end if;
  if exists (select 1 from support_message_mentions) then
    raise exception 'Rollback refused: mentions exist. Export them first.';
  end if;
  if exists (select 1 from support_ticket_ai_triage) then
    raise exception 'Rollback refused: triage records exist. Export them first.';
  end if;
  if exists (select 1 from support_surveys) then
    raise exception 'Rollback refused: satisfaction surveys exist. Export them first.';
  end if;
  if exists (select 1 from support_ticket_events where kind in ('mentioned', 'change_classified', 'survey_answered', 'ai_triage_applied')) then
    raise exception 'Rollback refused: timeline entries of the new kinds exist. Export them first.';
  end if;
  if exists (select 1 from support_notification_log where event_kind in ('staff_mention', 'survey_requested')) then
    raise exception 'Rollback refused: the delivery log holds notices of the new kinds. Export it first.';
  end if;
  if exists (select 1 from notifications where kind in ('support_mention', 'support_survey', 'project_change_order', 'project_prerequisite', 'project_review_overdue')) then
    raise exception 'Rollback refused: notifications of the new kinds exist. Delete or archive them first.';
  end if;
end $$;

-- New tables (their policies and triggers go with them), then the functions the triggers used -------------------------------------------------
drop table support_surveys;
drop function app.support_surveys_guard();
drop table support_ticket_ai_triage;
drop table support_message_mentions;
drop function app.support_message_mention_guard();
alter table support_messages drop constraint support_messages_mention_target_key;
drop table project_prerequisites;
drop function app.project_prerequisites_guard();
drop table project_scope_amendments;
drop function app.project_scope_amendments_guard();
drop table project_change_order_decisions;
drop function app.project_change_order_decisions_guard();

-- Columns that pointed at change orders, then the change orders themselves --------------------------------------------------------------------
alter table project_files drop column change_order_id;
alter table project_messages drop column change_order_id, drop column client_message_id;
drop table project_change_orders;
drop function app.project_change_order_guard();
drop sequence project_change_order_ref_seq;
drop table support_ticket_change;
drop function app.support_ticket_change_guard();

-- The recorded quote decisions of 0015 go back to having no way out, exactly as 0015 wrote the function.
create or replace function app.quote_approvals_append_only() returns trigger
language plpgsql
as $$
begin
  raise exception 'quote_approvals is append-only' using errcode = 'insufficient_privilege';
end
$$;

-- Columns and keys added to existing tables ---------------------------------------------------------------------------------------------------
alter table client_projects drop constraint client_projects_revisions_check;
alter table client_projects drop constraint client_projects_warranty_check;
alter table client_projects drop column warranty_days, drop column warranty_ends_on, drop column revisions_included, drop column revisions_used;
alter table client_projects drop constraint client_projects_request_currency_key;
alter table client_project_requests drop column idempotency_key;
drop index project_review_tasks_due_idx;
alter table project_review_tasks drop column overdue_notified_at;
drop index support_tickets_resolved_idx;

alter table support_tickets drop constraint support_tickets_project_org_fkey;
alter table support_tickets add constraint support_tickets_project_id_fkey foreign key (project_id) references client_project_requests (id) on delete set null;

alter table support_settings drop constraint support_settings_project_target_check;
alter table support_settings
  drop column surveys_enabled, drop column survey_delay_hours, drop column ai_triage_enabled, drop column project_review_target_hours,
  drop column show_project_targets_to_clients, drop column project_prerequisites_enabled;
delete from support_notification_rules where event_kind in ('staff_mention', 'survey_requested');
delete from org_features where feature = 'request_changes';

-- The values 0098 added are removed from the live lists (every other value is left exactly as it is, in its place) -----------------------------
do $$
declare
  spec record;
  def text;
  vals text[];
begin
  for spec in
    select * from (values
      ('support_tickets', 'support_tickets_request_type_check', 'request_type', array['change'], 2),
      ('support_tickets', 'support_tickets_category_check', 'category', array['change_ai_employee', 'change_website', 'change_automation', 'change_integration', 'change_project', 'change_other'], 15),
      ('support_ticket_events', 'support_ticket_events_kind_check', 'kind', array['mentioned', 'change_classified', 'survey_answered', 'ai_triage_applied'], 10),
      ('support_notification_rules', 'support_notification_rules_event_kind_check', 'event_kind', array['staff_mention', 'survey_requested'], 8),
      ('support_notification_log', 'support_notification_log_event_kind_check', 'event_kind', array['staff_mention', 'survey_requested'], 8)
    ) as s(tbl, con, col, extra, minimum)
  loop
    select pg_get_constraintdef(c.oid) into def from pg_constraint c where c.conname = spec.con and c.conrelid = spec.tbl::regclass;
    if def is null then
      raise exception '% not found', spec.con;
    end if;
    vals := array(select m[1] from regexp_matches(def, '''([a-z0-9_]+)''::text', 'g') as m);
    if vals is null or cardinality(vals) < spec.minimum then
      raise exception 'could not read the current values from % (read %); refusing to rewrite it', spec.con, coalesce(cardinality(vals), 0);
    end if;
    vals := array(select v from unnest(vals) with ordinality as t(v, o) where not (v = any(spec.extra)) order by o);
    execute format('alter table %I drop constraint %I', spec.tbl, spec.con);
    execute format('alter table %I add constraint %I check (%I in (%s))', spec.tbl, spec.con, spec.col,
      (select string_agg(quote_literal(v), ', ' order by o) from unnest(vals) with ordinality as t(v, o)));
  end loop;
end $$;

-- The notification kinds added by 0098 are removed from the live allow-list (every other kind is left exactly as it is) -----------------------
do $$
declare
  def text;
  kinds text[];
  literal text;
begin
  select pg_get_constraintdef(c.oid) into def from pg_constraint c where c.conname = 'notifications_kind_check' and c.conrelid = 'notifications'::regclass;
  if def is null then
    raise exception 'notifications_kind_check not found';
  end if;
  kinds := array(select m[1] from regexp_matches(def, '''([a-z0-9_]+)''::text', 'g') as m);
  if cardinality(kinds) = 0 then
    literal := substring(def from '''\{([^}]*)\}''::text\[\]');
    if literal is not null then
      kinds := string_to_array(literal, ',');
    end if;
  end if;
  if kinds is null or cardinality(kinds) < 20 then
    raise exception 'could not read the current notification kinds (read %); refusing to rewrite them', coalesce(cardinality(kinds), 0);
  end if;
  kinds := array(select distinct k from unnest(kinds) as k where k not in ('support_mention', 'support_survey', 'project_change_order', 'project_prerequisite', 'project_review_overdue') order by k);
  alter table notifications drop constraint notifications_kind_check;
  execute 'alter table notifications add constraint notifications_kind_check check (kind in (' || (select string_agg(quote_literal(k), ', ' order by k) from unnest(kinds) as k) || '))';
end $$;

-- After a rollback the ledger row remains: delete it so the migration can be applied again.
--   delete from schema_migrations where version = '0098_requests_completion';
