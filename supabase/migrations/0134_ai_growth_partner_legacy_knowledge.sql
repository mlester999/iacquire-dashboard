-- 0134: reviewed, tenant-scoped snapshots of approved knowledge from retained role profiles.
-- The source notes and documents stay untouched. Imported snapshots are not used by the Partner
-- until an owner or admin explicitly approves them.

create table ai_growth_partner_legacy_knowledge (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null,
  org_id uuid not null,
  source_type text not null check (source_type in ('employee_note', 'reference_document')),
  source_record_id uuid not null,
  source_version text not null check (char_length(source_version) between 1 and 120),
  source_role_key text check (source_role_key is null or source_role_key in (
    'operations_manager', 'lead_hunter', 'appointment_setter', 'sales_assistant', 'crm_manager', 'performance_analyst'
  )),
  title text not null check (char_length(title) between 1 and 200),
  content text not null check (char_length(content) between 1 and 40000),
  status text not null default 'pending_review' check (status in ('pending_review', 'approved', 'rejected')),
  created_by uuid references users(id) on delete set null,
  reviewed_by uuid references users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, partner_id, source_type, source_record_id, source_version),
  constraint ai_growth_partner_legacy_knowledge_partner_fk
    foreign key (partner_id, org_id) references ai_growth_partners (id, org_id) on delete cascade,
  constraint ai_growth_partner_legacy_knowledge_review_state check (
    (status = 'pending_review' and reviewed_at is null and reviewed_by is null)
    or (status in ('approved', 'rejected') and reviewed_at is not null)
  )
);

create index ai_growth_partner_legacy_knowledge_queue_idx
  on ai_growth_partner_legacy_knowledge (org_id, partner_id, status, created_at desc);

alter table ai_growth_partner_legacy_knowledge enable row level security;
revoke all on ai_growth_partner_legacy_knowledge from public, anon, authenticated, iaq_site_runtime;
grant select on ai_growth_partner_legacy_knowledge to iaq_app_user;

create policy ai_growth_partner_legacy_knowledge_select on ai_growth_partner_legacy_knowledge
  for select to iaq_app_user
  using (org_id = any ((select app.permitted_orgs('agents.use'::text))::uuid[]));

comment on table ai_growth_partner_legacy_knowledge is
  'Immutable source snapshots imported from retained client role profiles. Pending and rejected snapshots never enter the AI Growth Partner context.';
