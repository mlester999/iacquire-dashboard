-- Rollback for 0089_social_media_manager.sql. NOT a migration: stop the scheduler's social jobs first, review, and run in one transaction.
-- Refuses when the social media manager has been used (an account, a post, a media file, a campaign, an AI run or a job exists), so a connected account,
-- a post's history or a client's media is never dropped by accident. An unused settings row is configuration and goes with its table.

do $$
begin
  if exists (select 1 from social_accounts)
     or exists (select 1 from social_posts)
     or exists (select 1 from social_media_assets)
     or exists (select 1 from social_campaigns)
     or exists (select 1 from social_ai_runs)
     or exists (select 1 from social_publish_jobs)
     or exists (select 1 from private_files where bucket = 'social-media') then
    raise exception 'Rollback refused: social accounts, posts, media, campaigns, AI runs, publishing jobs or stored media files exist. Export them deliberately first.';
  end if;
  if exists (select 1 from notifications where kind in ('social_approval_requested', 'social_approval_decided', 'social_post_published', 'social_post_failed', 'social_account_attention')) then
    raise exception 'Rollback refused: social notifications exist. Delete or archive them first.';
  end if;
end $$;

drop policy if exists social_post_metrics_select on social_post_metrics;
drop policy if exists social_publish_jobs_select on social_publish_jobs;
drop policy if exists social_post_events_select on social_post_events;
drop policy if exists social_posts_select on social_posts;
drop policy if exists social_ai_runs_select on social_ai_runs;
drop policy if exists social_media_assets_select on social_media_assets;
drop policy if exists social_campaigns_select on social_campaigns;
drop policy if exists social_accounts_select on social_accounts;
drop policy if exists social_settings_select on social_settings;

drop table social_post_metrics;
drop table social_publish_jobs;
drop table social_post_events;
drop table social_posts;
drop table social_ai_runs;
drop table social_media_assets;
drop table social_campaigns;
drop table social_oauth_states;
drop table social_accounts;
drop table social_settings;

delete from role_permissions where permission in ('social.view', 'social.create', 'social.approve', 'social.publish', 'social.connect', 'social.settings');

-- The bucket and its rule, back to 0049's.
delete from storage.buckets where id = 'social-media';
alter table private_files drop constraint if exists private_files_bucket_check;
alter table private_files add constraint private_files_bucket_check
  check (bucket in ('company-documents', 'support-attachments', 'project-files', 'project-uploads', 'portfolio-assets', 'brand-assets', 'aqi-attachments'));

create or replace function app.file_permission(p_org uuid, p_bucket text, p_write boolean, p_visibility text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (p_visibility = 'client' or app.staff_assigned(p_org)) and
    case p_bucket
      when 'company-documents' then app.has_permission(p_org, case when p_write then 'knowledge.edit' else 'knowledge.view' end)
      when 'support-attachments' then
        case when app.is_agency_staff() then
          app.user_can_access_org(app.current_user_id(), p_org)
          and app.user_has_agency_permission(app.current_user_id(), case when p_write then 'agency.support.manage' else 'agency.support.view' end)
          and (p_visibility = 'client' or p_visibility = 'internal')
        else p_visibility = 'client' and app.has_permission(p_org, 'support.use') end
      when 'project-files' then case when p_write then app.staff_assigned(p_org) else app.has_permission(p_org, 'setup.view') end
      when 'project-uploads' then
        case when app.is_agency_staff() then
          app.staff_assigned(p_org)
          and app.user_can_access_org(app.current_user_id(), p_org)
          and app.user_has_agency_permission(app.current_user_id(), 'projects.view')
          and app.user_has_agency_permission(app.current_user_id(), case when p_write then 'projects.manage' else 'projects.view' end)
        else app.has_permission(p_org, case when p_write then 'projects.request' else 'projects.view' end) end
      when 'portfolio-assets' then app.is_agency_admin()
      when 'brand-assets' then app.has_permission(p_org, case when p_write then 'workspace.manage_profile' else 'workspace.view' end)
      when 'aqi-attachments' then
        not app.is_agency_staff() and app.has_permission(p_org, 'agents.use')
      else false end,
    false)
$$;

-- The notification kinds added by 0089 are removed from the live allow-list (every other kind is left exactly as it is).
do $$
declare
  def text;
  kinds text[];
  literal text;
begin
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
  kinds := array(select distinct k from unnest(kinds) as k where k not in ('social_approval_requested', 'social_approval_decided', 'social_post_published', 'social_post_failed', 'social_account_attention') order by k);
  alter table notifications drop constraint notifications_kind_check;
  execute 'alter table notifications add constraint notifications_kind_check check (kind in (' || (select string_agg(quote_literal(k), ', ' order by k) from unnest(kinds) as k) || '))';
end $$;

-- After a rollback the ledger row remains: delete it so the migration can be applied again.
--   delete from schema_migrations where version = '0089_social_media_manager';
