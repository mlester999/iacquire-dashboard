-- Rollback for 0064_aqi_feature_tours.
--
-- These are new starter tours. Existing progress is evidence of a person's work, so the guard
-- refuses to delete a tour that anyone has started or completed. Archive it in AQi Management
-- instead if it should disappear from the library.

do $$
begin
  if exists (
    select 1 from aqi_tutorial_progress p
    join aqi_tutorials t on t.id = p.tutorial_id
    where t.slug in ('setup-workspace', 'ask-aqi', 'manage-tasks', 'build-workflow', 'manage-website', 'read-analytics')
  ) then
    raise exception 'Refusing to roll back 0064: tutorial progress exists for one of the new tours. Archive it instead.';
  end if;
  if exists (
    select 1 from aqi_tutorial_events e
    join aqi_tutorials t on t.id = e.tutorial_id
    where t.slug in ('setup-workspace', 'ask-aqi', 'manage-tasks', 'build-workflow', 'manage-website', 'read-analytics')
  ) then
    raise exception 'Refusing to roll back 0064: tutorial analytics exist for one of the new tours. Archive it instead.';
  end if;
end
$$;

update aqi_tutorials
set published_version_id = null
where slug in ('setup-workspace', 'ask-aqi', 'manage-tasks', 'build-workflow', 'manage-website', 'read-analytics');

delete from aqi_contextual_tips
where slug in ('setup-help', 'aqi-help', 'tasks-help', 'workflows-help', 'website-help', 'analytics-help');

delete from aqi_tutorial_versions
where tutorial_id in (
  select id from aqi_tutorials
  where slug in ('setup-workspace', 'ask-aqi', 'manage-tasks', 'build-workflow', 'manage-website', 'read-analytics')
);

delete from aqi_tutorials
where slug in ('setup-workspace', 'ask-aqi', 'manage-tasks', 'build-workflow', 'manage-website', 'read-analytics');
