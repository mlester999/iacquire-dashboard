-- Rollback for 0066_rename_workforce_routes: points AQi's stored guidance back at /workforce and /admin/workforce.
-- Run it only together with the release that serves those routes again.

update aqi_suggested_questions
set route_prefix = regexp_replace(route_prefix, '^/(admin/)?employees', '/\1workforce')
where route_prefix ~ '^/(admin/)?employees(/|$)';

update aqi_tutorials
set route_prefix = regexp_replace(route_prefix, '^/(admin/)?employees', '/\1workforce')
where route_prefix ~ '^/(admin/)?employees(/|$)';

update aqi_contextual_tips
set route_prefix = regexp_replace(route_prefix, '^/(admin/)?employees', '/\1workforce')
where route_prefix ~ '^/(admin/)?employees(/|$)';

update aqi_tutorial_versions
set definition = replace(replace(definition::text, '"/admin/employees', '"/admin/workforce'), '"/employees', '"/workforce')::jsonb
where definition::text like '%"/employees%' or definition::text like '%"/admin/employees%';
