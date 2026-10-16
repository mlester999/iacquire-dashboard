-- iAcquire Native CRM, sales core (phase 2a): native pipelines and stages, native opportunities, stage history, and CRM tasks.
--
-- crm_pipelines and crm_opportunities were a read-through cache of GoHighLevel. They now hold both kinds of row, told apart by
-- `provider`. GoHighLevel rows keep their exact shape and the existing sync keeps working unchanged (it inserts provider 'ghl' by
-- default). Native rows use normalized stages and real foreign keys to contacts and companies.
-- Rollback: supabase/rollbacks/0028_crm_sales.down.sql.

-- ---------------------------------------------------------------------------
-- Pipelines
-- ---------------------------------------------------------------------------

alter table crm_pipelines
  add column provider text not null default 'ghl' check (provider in ('native', 'ghl')),
  add column description text check (char_length(description) <= 300),
  add column position integer not null default 0,
  add column is_default boolean not null default false,
  add column archived_at timestamptz,
  add column created_by uuid references users(id) on delete set null,
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now();
alter table crm_pipelines alter column ghl_pipeline_id drop not null;
alter table crm_pipelines add constraint crm_pipelines_ghl_id check (provider <> 'ghl' or ghl_pipeline_id is not null);
-- Length rules apply to native rows only, so no existing GoHighLevel cache row can fail them.
alter table crm_pipelines add constraint crm_pipelines_name_len check (provider <> 'native' or char_length(btrim(name)) between 1 and 80);
alter table crm_pipelines add constraint crm_pipelines_id_org unique (id, org_id);
create unique index crm_pipelines_one_default on crm_pipelines (org_id) where is_default and provider = 'native' and archived_at is null;
create unique index crm_pipelines_native_name on crm_pipelines (org_id, lower(name)) where provider = 'native' and archived_at is null;
create trigger crm_pipelines_touch before update on crm_pipelines for each row execute function app.touch_updated_at();

create table crm_pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  pipeline_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  position integer not null,
  -- open stages hold active deals; reaching a won or lost stage closes the deal with that outcome.
  kind text not null default 'open' check (kind in ('open', 'won', 'lost')),
  -- Optional, for the weighted forecast. Without it the forecast simply leaves the stage out (it is not guessed).
  probability integer check (probability between 0 and 100),
  color text check (color ~ '^#[0-9a-f]{6}$'),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  unique (id, pipeline_id),
  foreign key (pipeline_id, org_id) references crm_pipelines (id, org_id) on delete cascade
);
create unique index crm_pipeline_stages_name on crm_pipeline_stages (pipeline_id, lower(name)) where archived_at is null;
create index crm_pipeline_stages_pipeline_idx on crm_pipeline_stages (pipeline_id, position);
create trigger crm_pipeline_stages_touch before update on crm_pipeline_stages for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Opportunities
-- ---------------------------------------------------------------------------

alter table crm_opportunities
  add column provider text not null default 'ghl' check (provider in ('native', 'ghl')),
  add column pipeline_ref uuid,
  add column stage_ref uuid,
  add column contact_id uuid,
  add column company_id uuid,
  add column currency text check (currency ~ '^[A-Z]{3}$'),
  add column expected_close_date date,
  add column lost_reason text check (char_length(lost_reason) <= 300),
  add column assigned_user_id uuid references users(id) on delete set null,
  add column description text check (char_length(description) <= 2000),
  add column probability integer check (probability between 0 and 100),
  add column created_by uuid references users(id) on delete set null,
  add column created_via text check (created_via in ('manual', 'import', 'form', 'booking', 'api', 'agent', 'workflow', 'ghl_migration')),
  add column closed_at timestamptz,
  add column stage_entered_at timestamptz,
  add column archived_at timestamptz,
  add column version integer not null default 1,
  -- Set by automated creators (forms, bookings, workflows, the API) so a retry returns the same deal instead of a second one.
  add column idempotency_key text check (char_length(idempotency_key) between 8 and 200),
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now();
alter table crm_opportunities alter column ghl_opportunity_id drop not null;
create unique index crm_opportunities_idempotency on crm_opportunities (org_id, idempotency_key) where idempotency_key is not null;
alter table crm_opportunities add constraint crm_opportunities_ghl_id check (provider <> 'ghl' or ghl_opportunity_id is not null);
alter table crm_opportunities add constraint crm_opportunities_native_shape check (provider <> 'native' or (pipeline_ref is not null and stage_ref is not null and currency is not null and stage_entered_at is not null));
alter table crm_opportunities add constraint crm_opportunities_native_closed check (provider <> 'native' or ((status = 'open') = (closed_at is null)));
alter table crm_opportunities add constraint crm_opportunities_native_status check (provider <> 'native' or status in ('open', 'won', 'lost'));
alter table crm_opportunities add constraint crm_opportunities_value check (provider <> 'native' or monetary_value is null or monetary_value >= 0);
alter table crm_opportunities add constraint crm_opportunities_name_len check (provider <> 'native' or char_length(btrim(name)) between 1 and 200);
alter table crm_opportunities add constraint crm_opportunities_id_org unique (id, org_id);
alter table crm_opportunities add foreign key (pipeline_ref, org_id) references crm_pipelines (id, org_id);
alter table crm_opportunities add foreign key (stage_ref, org_id) references crm_pipeline_stages (id, org_id);
-- The stage always belongs to the opportunity's own pipeline.
alter table crm_opportunities add foreign key (stage_ref, pipeline_ref) references crm_pipeline_stages (id, pipeline_id);
alter table crm_opportunities add foreign key (contact_id, org_id) references contacts (id, org_id) on delete set null (contact_id);
alter table crm_opportunities add foreign key (company_id, org_id) references crm_companies (id, org_id) on delete set null (company_id);
create index crm_opportunities_board_idx on crm_opportunities (org_id, pipeline_ref, stage_ref) where provider = 'native' and archived_at is null;
create index crm_opportunities_contact_idx on crm_opportunities (org_id, contact_id) where contact_id is not null;
create index crm_opportunities_owner_idx on crm_opportunities (org_id, assigned_user_id) where provider = 'native';
create trigger crm_opportunities_touch before update on crm_opportunities for each row execute function app.touch_updated_at();

-- Every stage or status change, in order. Stage aging and conversion reports are computed from this, never estimated.
create table crm_opportunity_history (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  opportunity_id uuid not null,
  from_stage uuid,
  to_stage uuid,
  from_status text,
  to_status text not null check (to_status in ('open', 'won', 'lost')),
  seconds_in_previous integer check (seconds_in_previous >= 0),
  actor_kind text not null check (actor_kind in ('user', 'agency', 'agent', 'system', 'api')),
  actor_user_id uuid references users(id) on delete set null,
  changed_at timestamptz not null default now(),
  foreign key (opportunity_id, org_id) references crm_opportunities (id, org_id) on delete cascade
);
create index crm_opportunity_history_opp_idx on crm_opportunity_history (opportunity_id, id);
create index crm_opportunity_history_org_idx on crm_opportunity_history (org_id, changed_at);
create trigger crm_opportunity_history_immutable before update on crm_opportunity_history for each row execute function app.immutable_row();

create table crm_opportunity_tags (
  org_id uuid not null references organizations(id) on delete cascade,
  opportunity_id uuid not null,
  tag_id uuid not null,
  added_by uuid references users(id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (opportunity_id, tag_id),
  foreign key (opportunity_id, org_id) references crm_opportunities (id, org_id) on delete cascade,
  foreign key (tag_id, org_id) references crm_tags (id, org_id) on delete cascade
);
create index crm_opportunity_tags_tag_idx on crm_opportunity_tags (org_id, tag_id);

-- Activity rows can now point at native opportunities.
alter table crm_activities add foreign key (opportunity_id, org_id) references crm_opportunities (id, org_id) on delete cascade;

-- Notes on native opportunities use record_type 'opportunity' and the opportunity's uuid as record_id (as before).

-- ---------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------

alter table tasks add constraint tasks_id_org unique (id, org_id);
alter table tasks
  add column priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  add column contact_id uuid,
  add column company_id uuid,
  add column opportunity_id uuid,
  add column appointment_id uuid,
  add column remind_at timestamptz,
  add column reminded_at timestamptz,
  add column completed_by uuid references users(id) on delete set null,
  add column updated_at timestamptz not null default now();
alter table tasks drop constraint tasks_status_check;
alter table tasks add constraint tasks_status_check check (status in ('open', 'in_progress', 'done', 'cancelled'));
alter table tasks drop constraint tasks_category_check;
alter table tasks add constraint tasks_category_check check (category in ('general', 'follow_up', 'retention', 'sales', 'setup', 'crm', 'appointment'));
alter table tasks drop constraint tasks_source_check;
alter table tasks add constraint tasks_source_check check (source in ('user', 'agent', 'system', 'workflow'));
alter table tasks add foreign key (contact_id, org_id) references contacts (id, org_id) on delete set null (contact_id);
alter table tasks add foreign key (company_id, org_id) references crm_companies (id, org_id) on delete set null (company_id);
alter table tasks add foreign key (opportunity_id, org_id) references crm_opportunities (id, org_id) on delete set null (opportunity_id);
alter table tasks add foreign key (appointment_id, org_id) references appointment_refs (id, org_id) on delete set null (appointment_id);
-- Checked for new and changed rows; existing rows are not re-validated.
alter table tasks add constraint tasks_done_shape check ((status = 'done') = (completed_at is not null) or status = 'cancelled') not valid;
create index tasks_contact_idx on tasks (org_id, contact_id) where contact_id is not null;
create index tasks_opportunity_idx on tasks (org_id, opportunity_id) where opportunity_id is not null;
create index tasks_assignee_idx on tasks (org_id, assigned_user_id, status, due_at);
create index tasks_reminder_idx on tasks (remind_at) where reminded_at is null and status in ('open', 'in_progress');
create trigger tasks_touch before update on tasks for each row execute function app.touch_updated_at();

-- A task about a customer is visible only to people who can see contacts (agency staff cannot, outside a support session).
drop policy tasks_select on tasks;
create policy tasks_select on tasks for select to iaq_app_user using (
  app.can_access_org(org_id) and (contact_id is null or app.has_permission(org_id, 'contacts.view')));

create table crm_task_comments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  task_id uuid not null,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  author_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (task_id, org_id) references tasks (id, org_id) on delete cascade
);
create index crm_task_comments_task_idx on crm_task_comments (task_id, created_at);

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table crm_pipeline_stages enable row level security;
alter table crm_opportunity_history enable row level security;
alter table crm_opportunity_tags enable row level security;
alter table crm_task_comments enable row level security;
revoke all on crm_pipeline_stages, crm_opportunity_history, crm_opportunity_tags, crm_task_comments from public, anon, authenticated;
grant select on crm_pipeline_stages, crm_opportunity_history, crm_opportunity_tags, crm_task_comments to iaq_app_user;
create policy crm_pipeline_stages_select on crm_pipeline_stages for select to iaq_app_user using (app.has_permission(org_id, 'sales.view'));
create policy crm_opportunity_history_select on crm_opportunity_history for select to iaq_app_user using (app.has_permission(org_id, 'sales.view'));
create policy crm_opportunity_tags_select on crm_opportunity_tags for select to iaq_app_user using (app.has_permission(org_id, 'sales.view'));
create policy crm_task_comments_select on crm_task_comments for select to iaq_app_user using (
  deleted_at is null and exists (select 1 from tasks t where t.id = task_id and t.org_id = crm_task_comments.org_id));

-- Opportunities: agency staff keep reading GoHighLevel caches as before; native deals follow sales.view.
drop policy crm_opportunities_select on crm_opportunities;
create policy crm_opportunities_select on crm_opportunities for select to iaq_app_user using (app.has_permission(org_id, 'sales.view') and archived_at is null);
