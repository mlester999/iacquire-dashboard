-- Rollback for 0049_aqi_attachments.sql. NOT a migration.
-- Refuses while attachment metadata or bytes may still be required. Export/purge deliberately first.
do $$
begin
  if exists (select 1 from aqi_attachments) then
    raise exception 'Rollback refused: AQi attachment metadata exists. Purge or export it deliberately first.';
  end if;
end $$;

drop table if exists aqi_attachments;
-- Hosted Supabase refuses a direct delete from its storage tables unless the transaction says it is intended; the setting lasts only for this transaction.
select set_config('storage.allow_delete_query', 'true', true);
delete from storage.buckets where id = 'aqi-attachments';
alter table private_files drop constraint if exists private_files_bucket_check;
alter table private_files add constraint private_files_bucket_check
  check (bucket in ('company-documents', 'support-attachments', 'project-files', 'project-uploads', 'portfolio-assets', 'brand-assets'));
alter table private_files drop constraint if exists private_files_size_bytes_check;
alter table private_files add constraint private_files_size_bytes_check
  check (size_bytes > 0 and size_bytes <= 10485760);
-- Restore the generic private-file read helper and policy (no AQi bucket remains after rollback).
create or replace function app.file_access_allowed(p_bucket text, p_path text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.private_files f where f.bucket = p_bucket and f.storage_key = p_path
    and f.status = 'ready' and app.file_permission(f.org_id, f.bucket, false, f.visibility))
$$;
drop policy if exists private_files_select on private_files;
create policy private_files_select on private_files for select to iaq_app_user
  using (status = 'ready' and app.file_permission(org_id, bucket, false, visibility));
-- The file_permission function is left widened for deployed schema compatibility; removing the
-- bucket is the rollback boundary.
