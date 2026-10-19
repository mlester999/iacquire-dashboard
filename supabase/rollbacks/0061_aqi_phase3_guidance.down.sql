-- Rollback for 0061_aqi_phase3_guidance.
--
-- This rollback is deliberately conservative: user progress, tutorial analytics and uploaded
-- platform-knowledge documents are evidence, not cache. Export or delete them deliberately before
-- running this file. The guard stops the rollback rather than destroying a person's progress.
do $$
begin
  if exists (select 1 from aqi_tutorial_progress) then
    raise exception 'Refusing to roll back 0061: tutorial progress exists. Export it first.';
  end if;
  if exists (select 1 from aqi_tutorial_events) then
    raise exception 'Refusing to roll back 0061: tutorial analytics events exist. Export them first.';
  end if;
  if exists (select 1 from aqi_knowledge_documents where status <> 'deleted') then
    raise exception 'Refusing to roll back 0061: platform knowledge documents exist. Archive them first.';
  end if;
end
$$;

drop table if exists aqi_tutorial_events;
drop table if exists aqi_tutorial_progress;
drop table if exists aqi_contextual_tips;
drop table if exists aqi_user_preferences;

alter table aqi_knowledge_entries drop constraint if exists aqi_knowledge_source_document_fk;
alter table aqi_knowledge_entries drop column if exists source_document_id;
alter table aqi_knowledge_entries drop column if exists source_kind;
alter table aqi_knowledge_entries drop column if exists freshness_days;
alter table aqi_knowledge_entries drop column if exists review_note;
alter table aqi_knowledge_entries drop column if exists reviewed_by;
alter table aqi_knowledge_entries drop column if exists next_review_at;
alter table aqi_knowledge_entries drop column if exists last_reviewed_at;
drop index if exists aqi_knowledge_review_idx;

drop table if exists aqi_knowledge_documents;

alter table aqi_tutorials drop constraint if exists aqi_tutorials_published_version_fk;
drop table if exists aqi_tutorial_versions;
drop table if exists aqi_tutorials;

drop index if exists aqi_usage_kind_created_idx;
alter table aqi_usage_events drop column if exists intent;
alter table aqi_usage_events drop column if exists metadata;
alter table aqi_usage_events drop constraint if exists aqi_usage_events_kind_check;
alter table aqi_usage_events add constraint aqi_usage_events_kind_check
  check (kind in ('message', 'feedback', 'config_publish', 'reservation', 'rate_limit'));
