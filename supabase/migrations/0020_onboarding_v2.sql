-- Adaptive onboarding (questionnaire v2) and brand assets.
-- Additive: the earlier nested answers in onboarding_responses.data are kept and used to prefill.

-- ---------------------------------------------------------------------------
-- Session state lives on the existing onboarding_responses row
-- ---------------------------------------------------------------------------

alter table onboarding_responses drop constraint onboarding_responses_current_step_check;
alter table onboarding_responses add constraint onboarding_responses_current_step_check check (current_step between 1 and 6);

alter table onboarding_responses
  add column questionnaire_version integer not null default 1 check (questionnaire_version >= 1),
  -- The exact question to resume on, held by the server so any device or session continues in the same place.
  add column current_question_id text check (char_length(current_question_id) <= 80),
  add column status text not null default 'draft' check (status in ('draft', 'submitted')),
  add column submitted_at timestamptz,
  add column revision integer not null default 0 check (revision >= 0);

-- Anyone who already finished the earlier flow counts as submitted.
update onboarding_responses set status = 'submitted', submitted_at = completed_at where completed_at is not null;

-- ---------------------------------------------------------------------------
-- One row per answered (or deliberately skipped) question
-- ---------------------------------------------------------------------------

create table onboarding_answers (
  org_id uuid not null references organizations(id) on delete cascade,
  question_id text not null check (question_id ~ '^[a-z][a-z0-9_.:-]{1,79}$'),
  value jsonb not null default 'null'::jsonb check (pg_column_size(value) <= 16384),
  skipped boolean not null default false,
  -- Where the answer came from. AI and website-derived text is a suggestion until the owner confirms it.
  source text not null default 'user' check (source in ('user', 'ai_suggestion', 'website_analysis', 'prefill')),
  needs_confirmation boolean not null default false,
  answered_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (org_id, question_id),
  check (not (skipped and needs_confirmation))
);
create trigger onboarding_answers_touch before update on onboarding_answers for each row execute function app.touch_updated_at();

alter table onboarding_answers enable row level security;
revoke all on onboarding_answers from public, anon, authenticated;
grant select, insert, update, delete on onboarding_answers to iaq_app_user;
create policy onboarding_answers_select on onboarding_answers for select to iaq_app_user using (app.can_access_org(org_id));
create policy onboarding_answers_insert on onboarding_answers for insert to iaq_app_user with check (app.has_permission(org_id, 'workspace.manage_profile'));
create policy onboarding_answers_update on onboarding_answers for update to iaq_app_user
  using (app.has_permission(org_id, 'workspace.manage_profile')) with check (app.has_permission(org_id, 'workspace.manage_profile'));
create policy onboarding_answers_delete on onboarding_answers for delete to iaq_app_user using (app.has_permission(org_id, 'workspace.manage_profile'));

-- Contact details and a second brand colour collected in onboarding.
alter table company_profiles
  add column contact_email text check (char_length(contact_email) <= 320),
  add column contact_phone text check (contact_phone is null or contact_phone ~ '^\+[1-9][0-9]{6,14}$'),
  add column location text not null default '' check (char_length(location) <= 200),
  add column brand_accent_color text check (brand_accent_color ~ '^#[0-9a-fA-F]{6}$');

-- ---------------------------------------------------------------------------
-- Brand assets: logos, photos and reference images. Bytes stay in a private bucket.
-- ---------------------------------------------------------------------------

alter table private_files drop constraint private_files_bucket_check;
alter table private_files add constraint private_files_bucket_check
  check (bucket in ('company-documents', 'support-attachments', 'project-files', 'project-uploads', 'portfolio-assets', 'brand-assets'));

create or replace function app.file_permission(p_org uuid, p_bucket text, p_write boolean, p_visibility text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (p_visibility = 'client' or app.staff_assigned(p_org)) and
    case p_bucket
      when 'company-documents' then app.has_permission(p_org, case when p_write then 'knowledge.edit' else 'knowledge.view' end)
      when 'support-attachments' then app.has_permission(p_org, 'support.use') or app.staff_assigned(p_org)
      when 'project-files' then case when p_write then app.staff_assigned(p_org) else app.has_permission(p_org, 'setup.view') end
      when 'project-uploads' then app.has_permission(p_org, case when p_write then 'projects.request' else 'projects.view' end) or app.staff_assigned(p_org)
      when 'portfolio-assets' then app.is_agency_admin()
      when 'brand-assets' then app.has_permission(p_org, case when p_write then 'workspace.manage_profile' else 'workspace.view' end)
      else false end,
    false)
$$;
grant execute on function app.file_permission(uuid,text,boolean,text) to iaq_app_user;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('brand-assets','brand-assets',false,10485760,array['image/png','image/jpeg','image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create table org_assets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  kind text not null check (kind in ('logo', 'image', 'reference')),
  private_file_id uuid not null,
  -- Optional transparent-background variant. The original is always kept.
  processed_file_id uuid,
  processing_status text not null default 'none' check (processing_status in ('none', 'processed', 'failed', 'unsupported')),
  processing_note text check (char_length(processing_note) <= 300),
  use_variant text not null default 'original' check (use_variant in ('original', 'processed')),
  width integer check (width > 0),
  height integer check (height > 0),
  alt_text text not null default '' check (char_length(alt_text) <= 200),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (private_file_id, org_id) references private_files (id, org_id),
  foreign key (processed_file_id, org_id) references private_files (id, org_id),
  unique (id, org_id),
  check (use_variant = 'original' or processed_file_id is not null)
);
create index org_assets_org_idx on org_assets (org_id, kind, created_at desc) where deleted_at is null;

alter table org_assets enable row level security;
revoke all on org_assets from public, anon, authenticated;
grant select on org_assets to iaq_app_user;
create policy org_assets_select on org_assets for select to iaq_app_user using (deleted_at is null and app.has_permission(org_id, 'workspace.view'));

-- ---------------------------------------------------------------------------
-- Knowledge provenance: which text was written by onboarding and has not been edited since.
-- A re-submission may refresh exactly those sections; anything edited in the Knowledge Center is never overwritten.
-- ---------------------------------------------------------------------------

alter table company_knowledge add column seeded_hash text check (seeded_hash ~ '^[0-9a-f]{64}$');
