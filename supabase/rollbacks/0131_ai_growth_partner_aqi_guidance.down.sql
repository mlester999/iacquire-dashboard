-- Roll back the AQi guidance version only while the migration-created version has no user
-- progress or analytics. Keep the seeded version-1 definition and all user evidence intact.

set local lock_timeout = '5s';

do $$
declare
  tutorial_row record;
  previous_version record;
begin
  if exists (
    select 1
      from aqi_tutorial_versions v
      join aqi_tutorials t on t.id = v.tutorial_id
      join aqi_tutorial_progress p on p.tutorial_id = t.id and p.tutorial_version = v.version
     where t.slug in ('getting-started', 'navigate-dashboard', 'view-ai-employees')
       and v.version = 2
       and v.notes = 'AI Growth Partner guidance migration 0131'
  ) or exists (
    select 1
      from aqi_tutorial_versions v
      join aqi_tutorials t on t.id = v.tutorial_id
      join aqi_tutorial_events e on e.tutorial_id = t.id and e.tutorial_version = v.version
     where t.slug in ('getting-started', 'navigate-dashboard', 'view-ai-employees')
       and v.version = 2
       and v.notes = 'AI Growth Partner guidance migration 0131'
  ) then
    raise exception 'Refusing to roll back 0131: AQi progress or events exist for the new guidance. Archive it in AQi Management instead.';
  end if;

  for tutorial_row in
    select t.id as tutorial_id, t.slug, t.status as tutorial_status, t.published_version_id,
           v.id as new_version_id, v.status as new_version_status, v.notes as new_version_notes
      from aqi_tutorials t
      join aqi_tutorial_versions v on v.tutorial_id = t.id and v.version = 2
     where t.slug in ('getting-started', 'navigate-dashboard', 'view-ai-employees')
       and v.notes = 'AI Growth Partner guidance migration 0131'
     for update of t, v
  loop
    if tutorial_row.published_version_id is distinct from tutorial_row.new_version_id
       or tutorial_row.new_version_status <> 'published'
       or tutorial_row.tutorial_status <> 'published' then
      raise exception 'Refusing to roll back 0131: tutorial % changed after the migration.', tutorial_row.slug;
    end if;

    if exists (
      select 1 from aqi_tutorial_versions
       where tutorial_id = tutorial_row.tutorial_id and version > 2
    ) then
      raise exception 'Refusing to roll back 0131: tutorial % has later version history.', tutorial_row.slug;
    end if;

    select id as version_id, definition
      into previous_version
      from aqi_tutorial_versions
     where tutorial_id = tutorial_row.tutorial_id
       and version = 1
       and status = 'archived'
       and notes = 'Starter library'
     for update;

    if not found then
      raise exception 'Refusing to roll back 0131: original starter version for % is unavailable.', tutorial_row.slug;
    end if;

    delete from aqi_tutorial_versions where id = tutorial_row.new_version_id;
    update aqi_tutorial_versions set status = 'published' where id = previous_version.version_id;
    update aqi_tutorials
       set title = previous_version.definition->>'title',
           description = previous_version.definition->>'description',
           category = previous_version.definition->>'category',
           audience = array(select jsonb_array_elements_text(previous_version.definition->'roles')),
           route_prefix = previous_version.definition->>'routePrefix',
           priority = (previous_version.definition->>'priority')::integer,
           status = 'published',
           published_version_id = previous_version.version_id
     where id = tutorial_row.tutorial_id;
  end loop;

  -- A migration-created version with a changed pointer is evidence of later editing. Refuse to
  -- silently leave a partial rollback or remove the historical version.
  if exists (
    select 1
      from aqi_tutorials t
      join aqi_tutorial_versions v on v.tutorial_id = t.id
     where t.slug in ('getting-started', 'navigate-dashboard', 'view-ai-employees')
       and v.version = 2
       and v.notes = 'AI Growth Partner guidance migration 0131'
  ) then
    raise exception 'Refusing to roll back 0131: a migrated tutorial was changed after publication.';
  end if;
end
$$;
