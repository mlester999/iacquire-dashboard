-- AQi Phase 2 attachments. Private bytes live in Supabase Storage (or the local UPLOAD_DIR in
-- synthetic local mode); Postgres stores only bounded metadata/extracted text.
--
-- This migration is intentionally non-destructive. It widens the private-file bucket/size checks
-- and adds a new table. It is NOT applied to hosted Supabase by this work.

alter table private_files drop constraint if exists private_files_bucket_check;
alter table private_files add constraint private_files_bucket_check
  check (bucket in ('company-documents', 'support-attachments', 'project-files', 'project-uploads', 'portfolio-assets', 'brand-assets', 'aqi-attachments'));

alter table private_files drop constraint if exists private_files_size_bytes_check;
alter table private_files add constraint private_files_size_bytes_check
  check (size_bytes > 0 and size_bytes <= 52428800);

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

-- AQi files are private to the uploader even inside the same organization. The generic private-file
-- policy is intentionally not enough for chat media.
create or replace function app.file_access_allowed(p_bucket text, p_path text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.private_files f
    where f.bucket = p_bucket and f.storage_key = p_path and f.status = 'ready'
      and app.file_permission(f.org_id, f.bucket, false, f.visibility)
      and (f.bucket <> 'aqi-attachments' or f.uploaded_by = app.current_user_id())
  )
$$;
drop policy if exists private_files_select on private_files;
create policy private_files_select on private_files for select to iaq_app_user
  using (status = 'ready' and app.file_permission(org_id, bucket, false, visibility)
    and (bucket <> 'aqi-attachments' or uploaded_by = app.current_user_id()));

create table if not exists aqi_attachments (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references aqi_conversations(id) on delete cascade,
  message_id uuid references aqi_messages(id) on delete set null,
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  private_file_id uuid not null references private_files(id) on delete restrict,
  kind text not null check (kind in ('image', 'gif', 'document', 'video')),
  filename text not null check (char_length(filename) between 1 and 200),
  mime_type text not null check (char_length(mime_type) between 1 and 120),
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 52428800),
  status text not null default 'ready' check (status in ('processing', 'ready', 'failed', 'deleted')),
  extraction_status text not null default 'not_applicable' check (extraction_status in ('not_applicable', 'ready', 'failed', 'unsupported')),
  extracted_text text check (extracted_text is null or char_length(extracted_text) <= 200000),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  duration_seconds numeric(8,2) check (duration_seconds is null or duration_seconds > 0),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists aqi_attachments_conversation_idx on aqi_attachments (conversation_id, created_at);
create index if not exists aqi_attachments_message_idx on aqi_attachments (message_id);
create unique index if not exists aqi_attachments_file_unique on aqi_attachments (private_file_id);

alter table aqi_attachments enable row level security;
grant select, insert, update, delete on aqi_attachments to iaq_app_user;
create policy aqi_attachments_select on aqi_attachments for select to iaq_app_user
  using (user_id = app.current_user_id() and status <> 'deleted'
    and exists (select 1 from aqi_conversations c where c.id = conversation_id and c.user_id = app.current_user_id()));
create policy aqi_attachments_insert on aqi_attachments for insert to iaq_app_user
  with check (user_id = app.current_user_id() and status = 'ready'
    and exists (select 1 from aqi_conversations c where c.id = conversation_id and c.user_id = app.current_user_id()));
create policy aqi_attachments_update on aqi_attachments for update to iaq_app_user
  using (user_id = app.current_user_id() and exists (select 1 from aqi_conversations c where c.id = conversation_id and c.user_id = app.current_user_id()))
  with check (user_id = app.current_user_id());
create policy aqi_attachments_delete on aqi_attachments for delete to iaq_app_user
  using (user_id = app.current_user_id() and message_id is null);

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('aqi-attachments','aqi-attachments',false,52428800,array[
  'image/png','image/jpeg','image/webp','image/gif',
  'application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain','text/csv','video/mp4','video/webm'
])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
