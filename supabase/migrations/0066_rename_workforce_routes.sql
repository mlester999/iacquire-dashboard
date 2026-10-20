-- 0066: the client page "AI Workforce" (/workforce) is now "AI Employees" (/employees), and the agency page /admin/workforce is
-- /admin/employees. AQi's stored guidance names those routes, so it follows: suggested questions, walkthroughs (route and the
-- route strings inside each published definition) and contextual tips. No schema change; rows already pointing elsewhere are untouched.
-- The old URLs redirect in the application. Rollback: supabase/rollbacks/0066_rename_workforce_routes.down.sql.

update aqi_suggested_questions
set route_prefix = regexp_replace(route_prefix, '^/(admin/)?workforce', '/\1employees')
where route_prefix ~ '^/(admin/)?workforce(/|$)';

update aqi_tutorials
set route_prefix = regexp_replace(route_prefix, '^/(admin/)?workforce', '/\1employees')
where route_prefix ~ '^/(admin/)?workforce(/|$)';

update aqi_contextual_tips
set route_prefix = regexp_replace(route_prefix, '^/(admin/)?workforce', '/\1employees')
where route_prefix ~ '^/(admin/)?workforce(/|$)';

update aqi_tutorial_versions
set definition = replace(replace(definition::text, '"/admin/workforce', '"/admin/employees'), '"/workforce', '"/employees')::jsonb
where definition::text like '%"/workforce%' or definition::text like '%"/admin/workforce%';
