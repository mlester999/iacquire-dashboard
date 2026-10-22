-- Rollback for 0085_missed_call_recovery.sql. NOT a migration: stop the scheduler's "missedCallRecovery" job first, review, and run in one transaction.
-- Refuses when recovery history exists, so a recovered or failed case, its actions and its audit trail are never dropped by accident.
-- A policy row that was only ever saved with the defaults (never activated) is configuration, not history, and goes with the tables.

do $$
begin
  if exists (select 1 from missed_call_cases)
     or exists (select 1 from missed_call_actions)
     or exists (select 1 from missed_call_case_events)
     or exists (select 1 from missed_call_policies where activated_at is not null) then
    raise exception 'Rollback refused: missed-call cases, actions, history or an activated policy exist. Export them deliberately first.';
  end if;
end $$;

drop index if exists crm_call_records_inbound_created_idx;

drop policy if exists missed_call_case_events_select on missed_call_case_events;
drop policy if exists missed_call_actions_select on missed_call_actions;
drop policy if exists missed_call_case_calls_select on missed_call_case_calls;
drop policy if exists missed_call_cases_select on missed_call_cases;
drop policy if exists missed_call_policies_select on missed_call_policies;

drop table missed_call_case_events;
drop table missed_call_actions;
drop table missed_call_case_calls;
drop table missed_call_cases;
drop table missed_call_policies;

-- The notification kind added by 0085 is removed from the live allow-list (every other kind is left exactly as it is). Refuses while a notification of
-- that kind exists, because the constraint would then reject the existing rows.
do $$
declare
  def text;
  kinds text[];
  literal text;
begin
  if exists (select 1 from notifications where kind = 'missed_call_follow_up') then
    raise exception 'Rollback refused: notifications of kind missed_call_follow_up exist. Delete or archive them first.';
  end if;
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
  kinds := array(select distinct k from unnest(kinds) as k where k <> 'missed_call_follow_up' order by k);
  alter table notifications drop constraint notifications_kind_check;
  execute 'alter table notifications add constraint notifications_kind_check check (kind in (' || (select string_agg(quote_literal(k), ', ' order by k) from unnest(kinds) as k) || '))';
end $$;

-- After a rollback the ledger row remains: delete it so the migration can be applied again.
--   delete from schema_migrations where version = '0085_missed_call_recovery';
