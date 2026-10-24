-- Rollback for 0100_demo_funnel.sql. NOT a migration: stop the scheduler's demo jobs and switch the demo off (DEMO_ENABLED, then demo_settings.enabled) first, review, and run in one transaction.
-- Refuses when the demo funnel has been used (a prospect exists, whether or not its details were erased: its row, transcript, sessions and timeline are the record of who asked for a demo),
-- so a lead, a conversation or a conversion is never dropped by accident. The settings row and the daily counters are configuration and statistics, not people: they go with their tables.

do $$
begin
  if exists (select 1 from demo_prospects)
     or exists (select 1 from demo_messages)
     or exists (select 1 from demo_events)
     or exists (select 1 from demo_sessions)
     or exists (select 1 from demo_verifications) then
    raise exception 'Rollback refused: demo prospects, their transcripts, sessions, links or timelines exist. Export them deliberately first (or let the retention job clear them).';
  end if;
  if exists (select 1 from notifications where kind in ('demo_prospect_verified', 'demo_consultation_requested', 'demo_budget_reached')) then
    raise exception 'Rollback refused: demo notifications exist. Delete or archive them first.';
  end if;
end $$;

drop table demo_events;
drop function app.demo_event_guard();
drop table demo_messages;
drop table demo_sessions;
drop table demo_verifications;
drop table demo_prospects;
drop table demo_usage_days;
drop table demo_settings;

delete from role_permissions where permission in ('agency.prospects.view', 'agency.prospects.manage');

-- The notification kinds added by 0100 are removed from the live allow-list (every other kind is left exactly as it is).
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
  kinds := array(select distinct k from unnest(kinds) as k where k not in ('demo_prospect_verified', 'demo_consultation_requested', 'demo_budget_reached') order by k);
  alter table notifications drop constraint notifications_kind_check;
  execute 'alter table notifications add constraint notifications_kind_check check (kind in (' || (select string_agg(quote_literal(k), ', ' order by k) from unnest(kinds) as k) || '))';
end $$;

-- After a rollback the ledger row remains: delete it so the migration can be applied again.
--   delete from schema_migrations where version = '0100_demo_funnel';
