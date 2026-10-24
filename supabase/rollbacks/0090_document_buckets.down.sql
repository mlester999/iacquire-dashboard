-- Rollback for 0090_document_buckets.sql. NOT a migration: review, and run in one transaction.
-- Refuses when a file is stored in either bucket, so a proposal PDF, a signed copy or a staff attachment is never orphaned by accident.

do $$
begin
  if exists (select 1 from private_files where bucket in ('proposal-documents', 'staff-messages')) then
    raise exception 'Rollback refused: files are stored in the proposal-documents or staff-messages buckets. Export them deliberately first.';
  end if;
end $$;

-- Hosted Supabase refuses a direct delete from its storage tables unless the transaction says it is deliberate.
select set_config('storage.allow_delete_query', 'true', true);
delete from storage.buckets where id in ('proposal-documents', 'staff-messages');

alter table private_files drop constraint if exists private_files_bucket_check;
alter table private_files add constraint private_files_bucket_check
  check (bucket in ('company-documents', 'support-attachments', 'project-files', 'project-uploads', 'portfolio-assets', 'brand-assets', 'aqi-attachments', 'social-media'));

-- Back to 0089's definition: it has no proposal-documents or staff-messages branch, so the support-session rule 0090 puts on an agency person's access to proposal documents
-- goes with the branch, and every earlier bucket answers exactly as it did.
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
      when 'social-media' then app.has_permission(p_org, case when p_write then 'social.create' else 'social.view' end)
      else false end,
    false)
$$;

-- After a rollback the ledger row remains: delete it so the migration can be applied again.
--   delete from schema_migrations where version = '0090_document_buckets';
