-- Rollback for 0086_lead_scoring.sql. NOT a migration: stop the scheduler's "leadScoreReassessment" job first, review, and run in one transaction.
-- Refuses when assessments, overrides or a customised profile exist, so a person's override or the workspace's criteria are never dropped by accident.

do $$
begin
  if exists (select 1 from lead_score_assessments)
     or exists (select 1 from lead_score_overrides)
     or exists (select 1 from lead_scoring_profiles where criteria <> '{}'::jsonb or ai_extraction_enabled or preset <> 'general' or hot_min <> 70 or warm_min <> 40 or min_signals <> 3)
     or exists (select 1 from contacts where priority_label is not null) then
    raise exception 'Rollback refused: lead assessments, overrides, a customised scoring profile or contact priorities exist. Export them deliberately first.';
  end if;
end $$;

drop policy if exists lead_score_usage_select on lead_score_usage;
drop policy if exists lead_score_queue_select on lead_score_queue;
drop policy if exists lead_score_overrides_select on lead_score_overrides;
drop policy if exists lead_score_assessments_select on lead_score_assessments;
drop policy if exists lead_scoring_profiles_select on lead_scoring_profiles;

drop table lead_score_usage;
drop table lead_score_queue;
drop table lead_score_overrides;
drop table lead_score_assessments;
drop table lead_scoring_profiles;

drop index if exists contacts_priority_idx;
alter table contacts
  drop column if exists priority_reason,
  drop column if exists priority_evaluated_at,
  drop column if exists priority_assessment_id,
  drop column if exists priority_source,
  drop column if exists priority_label,
  drop column if exists priority_score;

-- The notification kind added by 0086 is removed from the live allow-list; every other kind is left exactly as it is.
do $$
declare
  def text;
  kinds text[];
  literal text;
begin
  if exists (select 1 from notifications where kind = 'hot_lead_detected') then
    raise exception 'Rollback refused: notifications of kind hot_lead_detected exist. Delete or archive them first.';
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
  kinds := array(select distinct k from unnest(kinds) as k where k <> 'hot_lead_detected' order by k);
  alter table notifications drop constraint notifications_kind_check;
  execute 'alter table notifications add constraint notifications_kind_check check (kind in (' || (select string_agg(quote_literal(k), ', ' order by k) from unnest(kinds) as k) || '))';
end $$;

-- After a rollback the ledger row remains: delete it so the migration can be applied again.
--   delete from schema_migrations where version = '0086_lead_scoring';
