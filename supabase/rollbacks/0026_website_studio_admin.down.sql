-- Rollback for 0026_website_studio_admin.sql. NOT a migration: the Supabase CLI does not run this folder. Review it, take a backup, stop the sites
-- runtime and the portal's website screens first, and run it in one transaction (the test in tests/website-migration-0026.test.ts proves it executes
-- on a fully migrated local database and removes every object 0026 added).
--
-- Order matters: first refuse to continue if data exists that the older schema cannot hold, then remove what 0026 added, then restore what it changed.

do $$
begin
  if exists (select 1 from websites where template_key !~ '^[a-z]+\.[a-z]+$')
     or exists (select 1 from website_versions where template_key !~ '^[a-z]+\.[a-z]+$')
     or exists (select 1 from website_publications where template_key !~ '^[a-z]+\.[a-z]+$') then
    raise exception 'Rollback refused: a website, version or publication uses a template key that the older schema cannot store (for example custom.my-template). Move those sites to a built-in template first.';
  end if;
  if exists (select 1 from website_versions where source in ('checkpoint', 'ai', 'restore', 'template')) then
    raise exception 'Rollback refused: website_versions holds checkpoint, ai, restore or template versions. Re-label them as editor versions first (update website_versions set source = ''editor'' where source in (''checkpoint'', ''ai'', ''restore'', ''template'')); version rows are otherwise immutable, so do this deliberately.';
  end if;
end $$;

-- New tables (their policies, indexes and triggers go with them).
drop table if exists website_comments;
drop table if exists website_components;
drop table if exists website_patterns;
drop table if exists website_template_versions;
drop table if exists website_templates;

-- New columns.
alter table website_form_submissions drop column if exists purpose, drop column if exists form_id;
alter table org_assets drop column if exists folder;
drop index if exists websites_archived_idx;
alter table websites drop column if exists archived_at, drop column if exists edit_lock_user, drop column if exists edit_lock_name, drop column if exists edit_lock_expires;

-- The enquiry function goes back to the version from 0021 (fourteen arguments, no purpose or form id).
drop function if exists app.submit_site_form(text, text, text, text, text, text, text, boolean, boolean, text, text, jsonb, text, text, text, text);
create or replace function app.submit_site_form(
  p_host text, p_page text, p_name text, p_email text, p_phone text, p_service text, p_message text,
  p_consent boolean, p_marketing boolean, p_consent_text text, p_ip_hash text, p_utm jsonb, p_referrer text, p_dedupe text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  s record;
  v_id uuid;
begin
  select * into s from app.site_by_host(p_host) limit 1;
  if not found then return jsonb_build_object('status', 'unknown_host'); end if;
  if coalesce((s.content -> 'form' ->> 'enabled')::boolean, false) is not true then return jsonb_build_object('status', 'disabled'); end if;
  if p_consent is not true then return jsonb_build_object('status', 'consent_required'); end if;
  insert into website_form_submissions (org_id, website_id, publication_id, host, page_slug, name, email, phone, service, message, consent, marketing_opt_in, consent_text, utm, referrer, ip_hash, dedupe_key)
  values (s.org_id, s.website_id, s.publication_id, lower(p_host), left(p_page, 40), left(p_name, 120), nullif(left(p_email, 320), ''), nullif(left(p_phone, 30), ''), nullif(left(p_service, 60), ''),
          left(p_message, 2000), true, coalesce(p_marketing, false), left(p_consent_text, 300), coalesce(p_utm, '{}'::jsonb), nullif(left(p_referrer, 300), ''), left(p_ip_hash, 80), p_dedupe)
  on conflict (website_id, dedupe_key) do nothing
  returning id into v_id;
  if v_id is null then return jsonb_build_object('status', 'duplicate'); end if;
  insert into website_usage_daily (website_id, org_id, day, form_submissions) values (s.website_id, s.org_id, (now() at time zone 'utc')::date, 1)
  on conflict (website_id, day) do update set form_submissions = website_usage_daily.form_submissions + 1;
  return jsonb_build_object('status', 'ok', 'id', v_id);
end $$;
revoke all on function app.submit_site_form(text, text, text, text, text, text, text, boolean, boolean, text, text, jsonb, text, text) from public;
grant execute on function app.submit_site_form(text, text, text, text, text, text, text, boolean, boolean, text, text, jsonb, text, text) to iaq_site_runtime;

-- Constraints go back to what 0021 allowed.
alter table websites drop constraint if exists websites_template_key_check;
alter table websites add constraint websites_template_key_check check (template_key ~ '^[a-z]+\.[a-z]+$');
alter table website_versions drop constraint if exists website_versions_template_key_check;
alter table website_versions add constraint website_versions_template_key_check check (template_key ~ '^[a-z]+\.[a-z]+$');
alter table website_publications drop constraint if exists website_publications_template_key_check;
alter table website_publications add constraint website_publications_template_key_check check (template_key ~ '^[a-z]+\.[a-z]+$');
alter table website_versions drop constraint if exists website_versions_source_check;
alter table website_versions add constraint website_versions_source_check check (source in ('editor', 'generated', 'submit', 'publish', 'rollback'));

-- Permissions added by 0026.
delete from role_permissions where permission in ('website.templates.design', 'website.templates.publish', 'website.review');
