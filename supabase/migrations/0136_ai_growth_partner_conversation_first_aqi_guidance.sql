-- Publish the conversation-first navigation copy in AQi's versioned starter tutorials.
-- Only untouched version-2 guidance from migration 0131 is advanced. Customized guidance and
-- any tutorial with later history are preserved. Existing progress and events remain historical.

set local lock_timeout = '5s';

do $$
declare
  seed record;
  current_tutorial record;
  new_version_id uuid;
  new_definition jsonb;
begin
  for seed in
    select *
      from jsonb_to_recordset($seed$
        [
          {
            "slug": "getting-started",
            "step_index": 2,
            "previous_body": "Open AI Growth Partner from the navigation to see its saved setup, Business Brain and current availability.",
            "body": "Open AI Growth Partner from the navigation to enter your permanent conversation. The next step opens its Control Center and Business Brain."
          },
          {
            "slug": "view-ai-employees",
            "step_index": 0,
            "previous_body": "AI Growth Partner is in the main navigation. Select it to continue.",
            "body": "AI Growth Partner in the main navigation opens your permanent conversation. Select it to continue."
          }
        ]
      $seed$::jsonb) as x(slug text, step_index integer, previous_body text, body text)
  loop
    select t.id as tutorial_id,
           t.status as tutorial_status,
           t.published_version_id,
           v.id as version_id,
           v.version,
           v.status as version_status,
           v.notes,
           v.definition
      into current_tutorial
      from aqi_tutorials t
      join aqi_tutorial_versions v on v.id = t.published_version_id
     where t.slug = seed.slug
     for update of t, v;

    if not found then
      continue;
    end if;

    if current_tutorial.tutorial_status <> 'published'
       or current_tutorial.version <> 2
       or current_tutorial.version_status <> 'published'
       or current_tutorial.notes is distinct from 'AI Growth Partner guidance migration 0131'
       or current_tutorial.definition->'steps'->seed.step_index->>'key' is distinct from 'workforce-nav'
       or current_tutorial.definition->'steps'->seed.step_index->>'body' is distinct from seed.previous_body then
      continue;
    end if;

    -- Do not reuse a version number if any later draft or archived record already exists.
    if exists (
      select 1 from aqi_tutorial_versions
       where tutorial_id = current_tutorial.tutorial_id and version >= 3
    ) then
      continue;
    end if;

    new_definition := jsonb_set(
      current_tutorial.definition,
      array['steps', seed.step_index::text, 'body'],
      to_jsonb(seed.body),
      false
    );

    update aqi_tutorial_versions
       set status = 'archived'
     where id = current_tutorial.version_id;

    insert into aqi_tutorial_versions (tutorial_id, version, status, definition, notes, published_at)
    values (current_tutorial.tutorial_id, 3, 'published', new_definition,
            'AI Growth Partner conversation-first guidance migration 0136', now())
    returning id into new_version_id;

    update aqi_tutorials
       set title = new_definition->>'title',
           description = new_definition->>'description',
           category = new_definition->>'category',
           audience = array(select jsonb_array_elements_text(new_definition->'roles')),
           route_prefix = new_definition->>'routePrefix',
           priority = (new_definition->>'priority')::integer,
           status = 'published',
           published_version_id = new_version_id
     where id = current_tutorial.tutorial_id;
  end loop;
end
$$;
