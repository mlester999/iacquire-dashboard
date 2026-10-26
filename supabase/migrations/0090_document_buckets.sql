-- Phase 5 and 6: the two private-file buckets the next modules need, added once so no later migration has to re-create app.file_permission.
--
--   * proposal-documents: the PDF of each frozen proposal version, signed copies and signing certificates. Read needs proposals.view, write proposals.create. An agency person
--     (staff, manager or Super Admin) also needs an active support session on that client, as for a customer's details in the CRM.
--   * staff-messages: attachments in the agency's internal staff Messages. Writes need an agency user holding agency.messages.use, on the agency workspace.
--     Reads are false for every browser: the server route checks the person's membership of the conversation, then reads through the private-file service.
--     These files are stored with visibility 'client' so the rule above is the only gate; the rule, not the visibility, keeps them agency-only.
--
-- The permissions named here are created by the migrations of the modules that use them (until then has_permission answers false, so the buckets are inert).
-- app.file_permission below is 0089's definition with two more branches; every earlier bucket's rule is unchanged (see tests/document-buckets-migration.test.ts).

alter table private_files drop constraint if exists private_files_bucket_check;
alter table private_files add constraint private_files_bucket_check
  check (bucket in ('company-documents', 'support-attachments', 'project-files', 'project-uploads', 'portfolio-assets', 'brand-assets', 'aqi-attachments', 'social-media', 'proposal-documents', 'staff-messages'));

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
      -- A frozen proposal, a signed copy and a certificate hold the customer's name, email and signature. The client's own people need only the permission; an agency person
      -- (staff, manager or Super Admin) must also have an active support session on this client, the audited-session rule the CRM follows for a customer's details. A read session
      -- opens reading; only a write session opens writing. (The proposals tables keep their read policy as built: see the header of 0091.)
      when 'proposal-documents' then
        app.has_permission(p_org, case when p_write then 'proposals.create' else 'proposals.view' end)
        and (
          not app.is_agency_staff()
          or exists (
            select 1 from public.crm_support_sessions s
            where s.org_id = p_org and s.user_id = app.current_user_id() and s.ended_at is null and s.expires_at > now()
              and (s.mode = 'write' or (s.mode = 'read' and not p_write))
          )
        )
      -- Staff messages belong to the agency workspace. Browsers never read them directly: a server route checks the person's membership of the conversation first.
      when 'staff-messages' then
        p_write and app.is_agency_staff()
        and exists (select 1 from public.organizations o where o.id = p_org and o.kind = 'agency')
        and app.user_has_agency_permission(app.current_user_id(), 'agency.messages.use')
      else false end,
    false)
$$;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values
  ('proposal-documents', 'proposal-documents', false, 10485760, array['application/pdf', 'image/png', 'image/jpeg']),
  ('staff-messages', 'staff-messages', false, 10485760, array['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain', 'text/csv', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
