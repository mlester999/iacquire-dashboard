-- Roll back only the untouched 0136 tutorial versions when they have no user evidence.
-- Keep all prior guidance versions, progress, and events intact.

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
     where t.slug in ('getting-started', 'view-ai-employees')
       and v.version = 3
       and v.notes = 'AI Growth Partner conversation-first guidance migration 0136'
  ) or exists (
    select 1
      from aqi_tutorial_versions v
      join aqi_tutorials t on t.id = v.tutorial_id
      join aqi_tutorial_events e on e.tutorial_id = t.id and e.tutorial_version = v.version
     where t.slug in ('getting-started', 'view-ai-employees')
       and v.version = 3
       and v.notes = 'AI Growth Partner conversation-first guidance migration 0136'
  ) then
    raise exception 'Refusing to roll back 0136: AQi progress or events exist for the conversation-first guidance. Archive it in AQi Management instead.';
  end if;

  for tutorial_row in
    select t.id as tutorial_id, t.slug, t.status as tutorial_status, t.published_version_id,
           v.id as new_version_id, v.status as new_version_status, v.notes as new_version_notes
      from aqi_tutorials t
      join aqi_tutorial_versions v on v.tutorial_id = t.id and v.version = 3
     where t.slug in ('getting-started', 'view-ai-employees')
       and v.notes = 'AI Growth Partner conversation-first guidance migration 0136'
     for update of t, v
  loop
    if tutorial_row.published_version_id is distinct from tutorial_row.new_version_id
       or tutorial_row.new_version_status <> 'published'
       or tutorial_row.tutorial_status <> 'published' then
      raise exception 'Refusing to roll back 0136: tutorial % changed after the migration.', tutorial_row.slug;
    end if;

    if exists (
      select 1 from aqi_tutorial_versions
       where tutorial_id = tutorial_row.tutorial_id and version > 3
    ) then
      raise exception 'Refusing to roll back 0136: tutorial % has later version history.', tutorial_row.slug;
    end if;

    select id as version_id, definition
      into previous_version
      from aqi_tutorial_versions
     where tutorial_id = tutorial_row.tutorial_id
       and version = 2
       and status = 'archived'
       and notes = 'AI Growth Partner guidance migration 0131'
     for update;

    if not found then
      raise exception 'Refusing to roll back 0136: prior 0131 version for % is unavailable.', tutorial_row.slug;
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

  if exists (
    select 1
      from aqi_tutorial_versions v
      join aqi_tutorials t on t.id = v.tutorial_id
     where t.slug in ('getting-started', 'view-ai-employees')
       and v.version = 3
       and v.notes = 'AI Growth Partner conversation-first guidance migration 0136'
  ) then
    raise exception 'Refusing to roll back 0136: a migrated tutorial changed after publication.';
  end if;
end
$$;
