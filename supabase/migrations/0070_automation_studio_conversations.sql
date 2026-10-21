-- Automation Studio: the conversation each workflow keeps with its AI Automation Builder, and the trail of changes to its working copy.
--
--   * automation_studio_messages: what the person said and what the builder answered, for one workflow. It is the workflow's own history, so
--     leaving and coming back continues where it stopped. An assistant message that changed the workflow records exactly which validated
--     operations it applied, what changed, and the draft revisions either side. Nothing here is ever sent to a customer.
--   * automation_studio_changes: the working copy after every change made through Automation Studio (by hand, by the builder, by a restored
--     version), newest 100 kept per workflow. It is what the editor's undo history is rebuilt from after a reload and what "version history"
--     lists for the working copy; published versions (crm_workflow_versions) stay the rollback points for what actually runs.
--
-- Both are written by trusted server code only (row-level security grants read to people who can see the workspace's automations). Deleting a
-- workflow deletes its messages and changes with it. Rollback: supabase/rollbacks/0070_automation_studio_conversations.down.sql.

create table automation_studio_messages (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  workflow_id uuid not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 12000),
  -- The step the person had selected when they wrote it (a reference by key, so "make this one wait longer" means something).
  node_key text check (char_length(node_key) <= 60),
  -- user: pending (not answered yet) or answered. assistant: applied (changed the workflow), answered (no change), clarification (asked a
  -- question), refused (a change was proposed and refused by validation; nothing changed), error (the builder could not answer).
  status text not null default 'answered' check (status in ('pending', 'answered', 'applied', 'clarification', 'refused', 'error')),
  operations jsonb check (operations is null or (jsonb_typeof(operations) = 'array' and pg_column_size(operations) <= 65536)),
  changes jsonb check (changes is null or (jsonb_typeof(changes) = 'array' and pg_column_size(changes) <= 65536)),
  revision_before integer check (revision_before >= 1),
  revision_after integer check (revision_after >= 1),
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (workflow_id, org_id) references crm_workflows (id, org_id) on delete cascade
);
create index automation_studio_messages_workflow_idx on automation_studio_messages (workflow_id, id);

create table automation_studio_changes (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  workflow_id uuid not null,
  -- 1, 2, 3… per workflow.
  seq integer not null check (seq >= 1),
  source text not null check (source in ('manual', 'ai', 'restore', 'template', 'undo', 'redo')),
  label text not null check (char_length(label) between 1 and 300),
  -- The working copy after the change.
  definition jsonb not null check (jsonb_typeof(definition) = 'object' and pg_column_size(definition) <= 131072),
  content_hash text check (content_hash ~ '^[0-9a-f]{64}$'),
  revision integer not null check (revision >= 1),
  message_id bigint references automation_studio_messages(id) on delete set null,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workflow_id, seq),
  foreign key (workflow_id, org_id) references crm_workflows (id, org_id) on delete cascade
);

alter table automation_studio_messages enable row level security;
alter table automation_studio_changes enable row level security;
revoke all on automation_studio_messages, automation_studio_changes from public, anon, authenticated, iaq_site_runtime;
grant select on automation_studio_messages, automation_studio_changes to iaq_app_user;

create policy automation_studio_messages_select on automation_studio_messages for select to iaq_app_user
  using (org_id = any ((select app.permitted_orgs('workflows.view'))::uuid[]));
create policy automation_studio_changes_select on automation_studio_changes for select to iaq_app_user
  using (org_id = any ((select app.permitted_orgs('workflows.view'))::uuid[]));
