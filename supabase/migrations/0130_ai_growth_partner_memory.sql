-- 0130: tenant-owned, inspectable memory for the unified AI Growth Partner.
-- This is application database memory, separate from the Hermes runtime's native memory store.
create table ai_growth_partner_memories (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null,
  org_id uuid not null,
  kind text not null check (kind in ('preference', 'decision', 'goal', 'working_context')),
  content text not null check (length(btrim(content)) between 1 and 1000),
  content_fingerprint varchar(64) not null check (content_fingerprint ~ '^[0-9a-f]{64}$'),
  revision integer not null default 1 check (revision > 0),
  source_message_id uuid references chat_messages(id) on delete set null,
  created_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_growth_partner_memories_partner_tenant_fk
    foreign key (partner_id, org_id) references ai_growth_partners (id, org_id) on delete cascade,
  constraint ai_growth_partner_memories_content_unique
    unique (org_id, partner_id, content_fingerprint)
);

create index ai_growth_partner_memories_recent_idx
  on ai_growth_partner_memories (org_id, partner_id, updated_at desc);

alter table ai_growth_partner_memories enable row level security;
revoke all on ai_growth_partner_memories from public, anon, authenticated, iaq_site_runtime;
grant select on ai_growth_partner_memories to iaq_app_user;
create policy ai_growth_partner_memories_select on ai_growth_partner_memories for select to iaq_app_user
  using (org_id = any ((select app.permitted_orgs('agents.use'::text))::uuid[]));

comment on table ai_growth_partner_memories is
  'Editable tenant-scoped AI Growth Partner notes stored by the application. These are separate from Hermes native memory and are always passed as untrusted context.';
comment on column ai_growth_partner_memories.content_fingerprint is
  'SHA-256 of normalized content for same-tenant duplicate prevention; memory contents are never included in audit metadata.';
