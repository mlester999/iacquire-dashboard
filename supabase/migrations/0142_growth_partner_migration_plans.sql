-- An inert, tenant-scoped record of a proposed migration and its receipt from the workspace owner.
create table ai_growth_partner_migration_plans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  partner_id uuid not null,
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object' and pg_column_size(manifest) <= 65536),
  plan_digest text not null check (plan_digest ~ '^[a-f0-9]{64}$'),
  status text not null default 'pending_review' check (status in ('pending_review', 'approved', 'declined', 'withdrawn', 'superseded')),
  staged_by uuid references users(id) on delete set null,
  staged_at timestamptz not null default now(),
  owner_decision text check (owner_decision in ('approved', 'declined')),
  owner_decided_by uuid references users(id) on delete set null,
  owner_decided_at timestamptz,
  owner_decision_digest text,
  closed_at timestamptz,
  superseded_by uuid,
  unique (org_id, id),
  foreign key (partner_id, org_id) references ai_growth_partners (id, org_id) on delete cascade,
  foreign key (org_id, superseded_by) references ai_growth_partner_migration_plans (org_id, id) deferrable initially deferred,
  check (
    (owner_decision is null and owner_decided_by is null and owner_decision_digest is null and owner_decided_at is null)
    or (owner_decision is not null and owner_decision_digest is not null and owner_decision_digest = plan_digest and owner_decided_at is not null)
  ),
  check (case
    when status = 'pending_review' then owner_decision is null
    when status in ('approved', 'declined') then owner_decision is not null and owner_decision = status
    else owner_decision is distinct from 'declined'
  end),
  check ((status in ('declined', 'withdrawn', 'superseded')) = (closed_at is not null)),
  check ((status = 'superseded') = (superseded_by is not null)),
  check (superseded_by is distinct from id)
);

create unique index ai_growth_partner_migration_plans_current
  on ai_growth_partner_migration_plans (org_id)
  where status in ('pending_review', 'approved');

create index ai_growth_partner_migration_plans_history
  on ai_growth_partner_migration_plans (org_id, staged_at desc);

alter table ai_growth_partner_migration_plans enable row level security;
revoke all on ai_growth_partner_migration_plans from public, anon, authenticated, iaq_app_user, iaq_site_runtime;

comment on table ai_growth_partner_migration_plans is
  'Tenant-specific preparation and owner review evidence only. These records never activate, bind, schedule or retire a runtime.';
