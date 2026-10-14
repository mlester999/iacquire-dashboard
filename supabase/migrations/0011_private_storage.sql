-- Private Supabase files and scoped Realtime authorization. Additive; no existing data is deleted.
-- The app's Data API remains closed. Storage writes go through authorized server APIs only.
alter table users add constraint users_auth_user_fk foreign key (auth_user_id) references auth.users(id);

-- Only an explicitly verified recovery link can authorize a password reset. Generic OTP
-- authentication (e.g. email verification) is deliberately insufficient.
create table auth_recovery_sessions (
  session_id uuid primary key,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table auth_recovery_sessions enable row level security;
revoke all on auth_recovery_sessions from public, anon, authenticated, iaq_app_user;

-- JWT callers must never override their identity with an app.user_id setting.
create or replace function app.current_user_id() returns uuid
language sql stable
as $$
  select case when current_setting('role', true) in ('authenticated', 'anon')
    then app.profile_id_for_auth_user()
    else coalesce(nullif(current_setting('app.user_id', true), '')::uuid, app.profile_id_for_auth_user()) end
$$;

create table private_files (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  bucket text not null check (bucket in ('company-documents', 'support-attachments', 'project-files')),
  storage_key text not null,
  filename text not null check (char_length(filename) between 1 and 200),
  mime_type text not null,
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  visibility text not null default 'client' check (visibility in ('client', 'internal')),
  status text not null default 'staged' check (status in ('staged', 'ready', 'deleted')),
  uploaded_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  unique (bucket, storage_key),
  check (split_part(storage_key, '/', 1) = org_id::text),
  check (storage_key !~ '(^|/)\.\.(/|$)' and storage_key !~ '[\\[:cntrl:]]')
);
create index private_files_org_idx on private_files(org_id, created_at desc) where status = 'ready';
alter table private_files enable row level security;
revoke all on private_files from public, anon, authenticated;

create or replace function app.file_permission(p_org uuid, p_bucket text, p_write boolean, p_visibility text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (p_visibility = 'client' or app.staff_assigned(p_org)) and
    case p_bucket
      when 'company-documents' then app.has_permission(p_org, case when p_write then 'knowledge.edit' else 'knowledge.view' end)
      when 'support-attachments' then app.has_permission(p_org, 'support.use') or app.staff_assigned(p_org)
      when 'project-files' then case when p_write then app.staff_assigned(p_org) else app.has_permission(p_org, 'setup.view') end
      else false end,
    false)
$$;
create or replace function app.file_access_allowed(p_bucket text, p_path text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.private_files f where f.bucket = p_bucket and f.storage_key = p_path
    and f.status = 'ready' and app.file_permission(f.org_id, f.bucket, false, f.visibility))
$$;
grant select on private_files to iaq_app_user;
create policy private_files_select on private_files for select to iaq_app_user
  using (status = 'ready' and app.file_permission(org_id, bucket, false, visibility));

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values
  ('company-documents','company-documents',false,10485760,array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain','text/markdown','text/csv']),
  ('support-attachments','support-attachments',false,10485760,array['application/pdf','image/png','image/jpeg','text/plain']),
  ('project-files','project-files',false,10485760,array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/png','image/jpeg','text/plain','text/markdown','text/csv'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy iaq_private_files_read on storage.objects for select to authenticated
  using (app.file_access_allowed(bucket_id, name));
-- No browser INSERT/UPDATE/DELETE policy: server endpoints validate permissions and contents.

create or replace function app.setup_topic_allowed(p_topic text) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare v_org uuid;
begin
  if p_topic !~ '^setup:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  v_org := substring(p_topic from 7)::uuid;
  return app.has_permission(v_org, 'setup.view');
end
$$;
create policy iaq_setup_realtime_read on realtime.messages for select to authenticated
  using (extension = 'broadcast' and app.setup_topic_allowed(realtime.topic()));

revoke all on all functions in schema app from public;
grant usage on schema app to authenticated;
grant execute on function app.current_user_id(), app.profile_id_for_auth_user(),
  app.file_access_allowed(text,text), app.setup_topic_allowed(text) to authenticated;
grant execute on function app.file_permission(uuid,text,boolean,text), app.file_access_allowed(text,text), app.setup_topic_allowed(text) to iaq_app_user;
-- New server metadata stays off PostgREST even on projects with permissive default grants.
revoke all on private_files from anon, authenticated;

create table support_attachments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  ticket_id uuid not null,
  private_file_id uuid not null,
  visibility text not null default 'client' check (visibility in ('client','internal')),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (ticket_id,org_id) references support_tickets(id,org_id) on delete cascade,
  foreign key (private_file_id,org_id) references private_files(id,org_id),
  unique(private_file_id)
);
create index support_attachments_ticket_idx on support_attachments(ticket_id,created_at);
alter table support_attachments enable row level security;
revoke all on support_attachments from public,anon,authenticated;
grant select on support_attachments to iaq_app_user;
create policy support_attachments_select on support_attachments for select to iaq_app_user
  using ((app.has_permission(org_id,'support.use') or app.staff_assigned(org_id))
    and (visibility='client' or app.staff_assigned(org_id)));
