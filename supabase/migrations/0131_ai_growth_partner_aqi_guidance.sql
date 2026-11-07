-- Publish the single-partner AQi guidance into the versioned tutorial library.
--
-- AQi reads published tutorial versions from the database. Updating only the TypeScript starter
-- definitions would leave existing workspaces seeing the old six-employee walkthroughs.
-- Upgrade only the untouched version-1 starter definitions. Customized tutorials are preserved.
-- Existing progress and tutorial events remain as historical evidence; no user state is deleted.

set local lock_timeout = '5s';

do $$
declare
  seed record;
  current_tutorial record;
  new_version_id uuid;
begin
  for seed in
    select *
      from jsonb_to_recordset($seed$
        [
          {
            "slug": "getting-started",
            "legacy_title": "Getting started with iAcquireOS",
            "legacy_description": "A short tour of the workspace, your AI team and where to get help.",
            "definition": {
              "title": "Getting started with iAcquireOS",
              "description": "A short tour of the workspace, your AI Growth Partner and where to get help.",
              "category": "Getting started",
              "roles": [],
              "routePrefix": "/overview",
              "priority": 10,
              "aliases": ["get started", "getting started", "new to iacquireos", "quick tour", "platform tour", "show me around"],
              "keywords": ["tour", "welcome", "overview", "dashboard", "start", "navigation"],
              "steps": [
                {"key":"overview","title":"This is your workspace","body":"Overview brings your pipeline, appointments and AI Growth Partner together. Every number here comes from real workspace data.","targetId":"overview.hero","route":"/overview"},
                {"key":"metrics","title":"The numbers that matter","body":"These tiles show what needs attention right now. Select a tile to open the page behind it.","targetId":"overview.kpis","route":"/overview"},
                {"key":"workforce-nav","title":"Meet your AI Growth Partner","body":"Open AI Growth Partner from the navigation to see its saved setup, Business Brain and current availability.","targetId":"nav.workforce","route":null,"advance":"click"},
                {"key":"partner","title":"One partner, one Business Brain","body":"This page shows the saved partner identity, Business Brain facts and whether a runtime or permanent conversation is connected.","targetId":"growth-partner.header","route":"/growth-partner"},
                {"key":"support-nav","title":"Help is always available","body":"Support is in the navigation. Select it to see how to reach the iAcquire team.","targetId":"nav.support","route":null,"advance":"click"},
                {"key":"support","title":"Start a real conversation","body":"This is the real Support page. A request is only created when you send it; AQi cannot create one for you.","targetId":"support.new-ticket","route":"/support"}
              ],
              "completion": {"kind":"finish"}
            }
          },
          {
            "slug": "navigate-dashboard",
            "legacy_title": "Navigating your dashboard",
            "legacy_description": "Understand the overview tiles, next actions and AI team panel.",
            "definition": {
              "title": "Navigating your dashboard",
              "description": "Understand the overview tiles, next actions and AI Growth Partner panel.",
              "category": "Getting started",
              "roles": [],
              "routePrefix": "/overview",
              "priority": 20,
              "aliases": ["navigate the dashboard", "dashboard tour", "where is everything", "understand the dashboard"],
              "keywords": ["dashboard", "overview", "metrics", "navigation", "tiles"],
              "steps": [
                {"key":"kpis","title":"Start with the tiles","body":"Each tile is a real count. A dash means the data source is not connected yet, not zero.","targetId":"overview.kpis","route":"/overview"},
                {"key":"actions","title":"Then check next actions","body":"This panel lists the most useful next steps for this workspace right now.","targetId":"overview.next-actions","route":"/overview"},
                {"key":"team","title":"Your AI Growth Partner is one click away","body":"Open the Growth Partner to review its setup and Business Brain. Its connected conversation is available from the partner page.","targetId":"overview.ai-team","route":"/overview"}
              ],
              "completion": {"kind":"finish"}
            }
          },
          {
            "slug": "view-ai-employees",
            "legacy_title": "Viewing your AI employees",
            "legacy_description": "Meet the AI workforce, understand status and open an employee.",
            "definition": {
              "title": "Viewing your AI Growth Partner",
              "description": "Review the single partner identity, Business Brain and connected conversation.",
              "category": "AI Growth Partner",
              "roles": ["owner", "admin", "member", "sales_rep", "support", "appointment_setter"],
              "routePrefix": "/growth-partner",
              "priority": 70,
              "aliases": ["view my growth partner", "where is my ai growth partner", "ai workforce", "growth partner setup", "configure my growth partner"],
              "keywords": ["ai", "growth", "partner", "business brain", "workforce", "agent"],
              "steps": [
                {"key":"workforce-nav","title":"Open AI Growth Partner","body":"AI Growth Partner is in the main navigation. Select it to continue.","targetId":"nav.workforce","route":null,"advance":"click"},
                {"key":"brain","title":"Review the Business Brain","body":"Review business facts, their sources and confirmation status. The same brain grounds work across all six capability areas.","targetId":"growth-partner.brain","route":"/growth-partner"},
                {"key":"conversation","title":"Open the permanent conversation","body":"Use the Growth Partner conversation to keep one shared history across acquisition, sales, appointments, CRM, operations and analytics.","targetId":"growth-partner.conversation","route":"/growth-partner/conversation"}
              ],
              "completion": {"kind":"finish"}
            }
          }
        ]
      $seed$::jsonb) as x(slug text, legacy_title text, legacy_description text, definition jsonb)
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

    -- Version 1 plus the original notes and copy identify only the untouched migration seed.
    if current_tutorial.tutorial_status <> 'published'
       or current_tutorial.version <> 1
       or current_tutorial.version_status <> 'published'
       or current_tutorial.notes is distinct from 'Starter library'
       or current_tutorial.definition->>'title' is distinct from seed.legacy_title
       or current_tutorial.definition->>'description' is distinct from seed.legacy_description then
      continue;
    end if;

    -- An existing draft or archived version may belong to a Super Admin's work. Leave it intact.
    if exists (
      select 1 from aqi_tutorial_versions
       where tutorial_id = current_tutorial.tutorial_id and version = 2
    ) then
      continue;
    end if;

    update aqi_tutorial_versions
       set status = 'archived'
     where id = current_tutorial.version_id;

    insert into aqi_tutorial_versions (tutorial_id, version, status, definition, notes, published_at)
    values (current_tutorial.tutorial_id, 2, 'published', seed.definition,
            'AI Growth Partner guidance migration 0131', now())
    returning id into new_version_id;

    update aqi_tutorials
       set title = seed.definition->>'title',
           description = seed.definition->>'description',
           category = seed.definition->>'category',
           audience = array(select jsonb_array_elements_text(seed.definition->'roles')),
           route_prefix = seed.definition->>'routePrefix',
           priority = (seed.definition->>'priority')::integer,
           status = 'published',
           published_version_id = new_version_id
     where id = current_tutorial.tutorial_id;
  end loop;
end
$$;
