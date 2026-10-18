-- iAcquire Native CRM, Phase 6: a Setup Center that a native CRM client can complete, and the client's CRM setup guide.
--
-- Until now every client's checklist assumed GoHighLevel: "GHL sub-account created" was required for anyone who bought the CRM service and
-- the CRM snapshot, CRM asset and calendar steps waited on it, so a client on iAcquire's own CRM could never reach activation.
--
-- What this adds:
--   * A provider scope on setup steps (crm_provider: 'ghl', 'native' or null for both). A step scoped to a provider the workspace does not
--     use is treated exactly like a step outside the purchased services (service_excluded), so it never counts for or against the client and
--     its dependants no longer wait on it. The GoHighLevel location step is scoped to 'ghl': GoHighLevel clients keep it (and every step that
--     depends on it), native clients never see it. Hybrid workspaces use both providers, so they keep both kinds of step.
--   * The scope follows the workspace's CRM provider automatically: changing crm_workspaces.mode or a capability owner (client creation,
--     the initial choice in the setup guide, a provider switch) recomputes the steps' applicability in the same transaction, bumps the
--     checklist revision and, if a newly applicable required step is unfinished, cancels a pending final review.
--   * Two optional native steps, "SMS sender connected and tested" and "WhatsApp sender connected and tested", for clients with the CRM
--     service, verified only by the recorded result of a live capability test (src/server/setup/connectors.ts). They do not block
--     activation.
--   * Provider-neutral wording for the calendar step ("Calendar connected ..."). The CRM snapshot step's title follows whoever owns
--     pipelines: "CRM snapshot installed" while GoHighLevel does (existing and new GoHighLevel checklists alike), "CRM Blueprint applied"
--     otherwise; a provider change swaps it on unfinished steps of checklists that aren't activated.
--   * A GoHighLevel sub-account step that already had progress on a workspace 0027 made native is excluded but kept, with an internal
--     event recording it, so the agency can see which in-flight GoHighLevel work left the client's flow.
--   * crm_setup_guides: one row per client workspace with the answers and the exact step of the client's CRM setup guide (/crm/setup), so it
--     autosaves and resumes where the person left off. Statuses are never stored: they are computed from real rows each time.
--
-- As elsewhere in the CRM, the application role only reads its own workspace's rows (row-level security) and trusted server code writes
-- after authorizing the action. No permission is added: the guide uses crm.view to read, setup.respond (owner, admin) to edit and
-- crm.provider.manage (owner) for the initial provider choice. Rollback: supabase/rollbacks/0056_crm_setup_native.down.sql.

-- ---------------------------------------------------------------------------
-- Provider scope of a setup step
-- ---------------------------------------------------------------------------

alter table client_setup_template_tasks add column crm_provider text check (crm_provider in ('native', 'ghl'));
alter table client_setup_tasks add column crm_provider text check (crm_provider in ('native', 'ghl'));

-- Whether a workspace uses a CRM provider at all: native mode uses only iAcquire CRM, ghl mode only GoHighLevel, and a controlled hybrid
-- uses iAcquire CRM plus GoHighLevel when at least one capability is owned there. A client without a workspace row is native (the
-- application creates the row on demand as native).
create or replace function app.setup_crm_uses(p_org uuid, p_provider text) returns boolean
language sql stable set search_path = public, pg_temp
as $$
  select case coalesce((select w.mode from crm_workspaces w where w.org_id = p_org), 'native')
    when 'native' then p_provider = 'native'
    when 'ghl' then p_provider = 'ghl'
    else p_provider = 'native' or exists (select 1 from crm_capability_providers c where c.org_id = p_org and c.provider = 'ghl')
  end
$$;

-- Who owns one CRM capability, mirroring resolveCapabilities (src/server/crm/workspace.ts): the mode itself outside a hybrid; in a hybrid
-- the recorded owner, iAcquire CRM when none is recorded.
create or replace function app.setup_crm_owner(p_org uuid, p_capability text) returns text
language sql stable set search_path = public, pg_temp
as $$
  select case when w.mode = 'hybrid'
              then coalesce((select c.provider from crm_capability_providers c where c.org_id = p_org and c.capability = p_capability), 'native')
              else coalesce(w.mode, 'native') end
  from (select (select mode from crm_workspaces where org_id = p_org) as mode) w
$$;

-- Recomputes which of one workspace's steps apply: outside the purchased services, or scoped to a provider the workspace doesn't use.
-- It also keeps the CRM snapshot step's title with whoever owns pipelines: "CRM snapshot installed" while GoHighLevel does, "CRM Blueprint
-- applied" otherwise (the same signal that picks the step's check, src/server/setup/connectors.ts). Only the two default titles swap, and
-- never on a completed step, an activated checklist or a title the agency renamed.
-- Returns how many steps changed. Callers bump the revision (mutateSetup does; the provider trigger below does it itself).
create or replace function app.refresh_setup_applicability(p_org uuid) returns integer
language plpgsql set search_path = public, pg_temp
as $$
declare
  v_changed integer;
  v_titles integer;
begin
  update client_setup_tasks t
     set service_excluded = x.excluded
    from (
      select s.id,
             ((s.service is not null and not (s.service = any(i.services)))
              or (s.crm_provider is not null and not app.setup_crm_uses(s.org_id, s.crm_provider))) as excluded
      from client_setup_tasks s join client_setup_instances i on i.id = s.instance_id
      where s.org_id = p_org
    ) x
   where t.id = x.id and t.service_excluded is distinct from x.excluded;
  get diagnostics v_changed = row_count;
  update client_setup_tasks t
     set title = x.want
    from (
      select s.id, case when app.setup_crm_owner(s.org_id, 'pipelines') = 'ghl' then 'CRM snapshot installed' else 'CRM Blueprint applied' end as want
      from client_setup_tasks s join client_setup_instances i on i.id = s.instance_id
      where s.org_id = p_org and s.template_key = 'crm_snapshot' and s.status <> 'completed' and i.state <> 'activated'
        and s.title in ('CRM snapshot installed', 'CRM Blueprint applied')
    ) x
   where t.id = x.id and t.title <> x.want;
  get diagnostics v_titles = row_count;
  return v_changed + v_titles;
end
$$;

-- Keeps the checklist in step with the CRM provider, whichever code path changed it.
create or replace function app.setup_follow_crm_provider() returns trigger
language plpgsql set search_path = public, pg_temp
as $$
declare
  v_org uuid;
  v_instance uuid;
  v_state text;
  v_changed integer;
begin
  if tg_op = 'DELETE' then v_org := old.org_id; else v_org := new.org_id; end if;
  select id, state into v_instance, v_state from client_setup_instances where org_id = v_org for update;
  if v_instance is null then
    return null;
  end if;
  v_changed := app.refresh_setup_applicability(v_org);
  if v_changed > 0 then
    if v_state = 'ready_for_review' and exists (
      select 1 from client_setup_tasks t where t.instance_id = v_instance and t.required and not t.hidden and not t.service_excluded
        and t.completion_mode <> 'activation' and t.status <> 'completed'
    ) then
      update client_setup_instances set state = 'in_setup', ready_for_review_at = null, ready_for_review_by = null where id = v_instance;
      insert into client_setup_task_events (org_id, instance_id, actor_kind, event, reason, visibility)
      values (v_org, v_instance, 'system', 'sent_back', 'Final review was cancelled: the CRM provider changed and a required setup step now applies.', 'internal');
    end if;
    insert into client_setup_task_events (org_id, instance_id, actor_kind, event, visibility, metadata)
    values (v_org, v_instance, 'system', 'services_changed', 'internal', jsonb_build_object('reason', 'crm_provider', 'steps', v_changed));
    update client_setup_instances set revision = revision + 1 where id = v_instance;
  end if;
  return null;
end
$$;
create trigger crm_workspaces_setup_scope after insert or update of mode on crm_workspaces
  for each row execute function app.setup_follow_crm_provider();
create trigger crm_capability_providers_setup_scope after insert or update or delete on crm_capability_providers
  for each row execute function app.setup_follow_crm_provider();

-- ---------------------------------------------------------------------------
-- The default checklist
-- ---------------------------------------------------------------------------

-- The GoHighLevel location applies only where GoHighLevel is used. Its dependants (the CRM snapshot step, the calendar step and the final
-- system check) keep depending on it: for a GoHighLevel client nothing changes, and for a native client the step is not applicable, so it
-- no longer holds anything back (an excluded prerequisite never counts as unmet).
update client_setup_template_tasks set crm_provider = 'ghl' where key = 'ghl_subaccount';

update client_setup_template_tasks set
  title = 'CRM Blueprint applied',
  description = 'We apply your industry CRM Blueprint: pipeline stages, tags, fields, forms and message templates built for client acquisition. For workspaces that keep GoHighLevel, this is the master snapshot installed in your location.'
where key = 'crm_snapshot';

update client_setup_template_tasks set
  title = 'Calendar connected and appointment availability checked',
  client_title = 'Your calendar is connected',
  description = 'We connect the calendar you already use (Google, Microsoft 365, CalDAV or a calendar feed), or set up your iAcquire calendar, so your AI Appointment Setter only offers times that are really free.',
  client_action = '{"type":"external","label":"Connect your calendar","instructions":"Connect the calendar we should use (iAcquire CRM: CRM → Calendar Connections; GoHighLevel workspaces: the authorization link we send you), or tell us you will use the iAcquire calendar only. Then let us know it is done."}'::jsonb
where key = 'calendar';

-- The senders belong to the CRM's conversations, so they apply only to clients who bought the CRM service (a website-only client never
-- sees them).
insert into client_setup_template_tasks
  (template_id, key, title, client_title, description, completion_notice, section, completion_mode, check_key, service,
   required, requires_evidence, requires_client_response, client_action, depends_on, sort_order, crm_provider)
select t.id, v.key, v.title, v.client_title, v.description, v.completion_notice, 'agency', 'verified', v.check_key, v.service,
       false, false, false, null, '{}'::text[], v.sort_order, 'native'
from client_setup_templates t
cross join (values
  ('sms_sender', 'SMS sender connected and tested', 'Your SMS sender is connected',
   'We connect your business texting number and run a live capability test with the provider. The test sends nothing.',
   'Your SMS sender passed its test', 'sms_sender', 'crm', 92),
  ('whatsapp_sender', 'WhatsApp sender connected and tested', 'Your WhatsApp sender is connected',
   'We connect your WhatsApp Business number and run a live capability test with Meta. The test sends nothing.',
   'Your WhatsApp sender passed its test', 'whatsapp_sender', 'crm', 94)
) as v(key, title, client_title, description, completion_notice, check_key, service, sort_order)
where t.is_default;

-- ---------------------------------------------------------------------------
-- Existing checklists that are not activated yet (activated ones keep their history exactly as it was)
-- ---------------------------------------------------------------------------

update client_setup_tasks t set crm_provider = tt.crm_provider
from client_setup_instances i join client_setup_template_tasks tt on tt.template_id = i.template_id
where i.id = t.instance_id and i.state <> 'activated' and tt.key = t.template_key and tt.crm_provider is not null;

insert into client_setup_tasks
  (org_id, instance_id, template_key, title, client_title, description, completion_notice, section, completion_mode, check_key, service,
   required, requires_evidence, requires_client_response, client_action, sort_order, service_excluded, crm_provider)
select i.org_id, i.id, tt.key, tt.title, tt.client_title, tt.description, tt.completion_notice, tt.section, tt.completion_mode, tt.check_key, tt.service,
       tt.required, tt.requires_evidence, tt.requires_client_response, tt.client_action, tt.sort_order,
       (tt.service is not null and not (tt.service = any(i.services))) or (tt.crm_provider is not null and not app.setup_crm_uses(i.org_id, tt.crm_provider)),
       tt.crm_provider
from client_setup_instances i join client_setup_template_tasks tt on tt.template_id = i.template_id
where i.state <> 'activated' and tt.key in ('sms_sender', 'whatsapp_sender')
  and not exists (select 1 from client_setup_tasks x where x.instance_id = i.id and x.template_key = tt.key);

-- Native workspaces get the provider-neutral wording; GoHighLevel workspaces keep the step titles they were given.
update client_setup_tasks t set
  title = 'CRM Blueprint applied',
  description = (select tt.description from client_setup_template_tasks tt join client_setup_templates tp on tp.id = tt.template_id and tp.is_default where tt.key = 'crm_snapshot')
from client_setup_instances i
where i.id = t.instance_id and i.state <> 'activated' and t.template_key = 'crm_snapshot' and t.title = 'CRM snapshot installed'
  and not app.setup_crm_uses(t.org_id, 'ghl');
update client_setup_tasks t set
  title = tt.title, client_title = tt.client_title, description = tt.description,
  client_action = case when t.status = 'waiting_for_client' then t.client_action else tt.client_action end
from client_setup_instances i, client_setup_template_tasks tt join client_setup_templates tp on tp.id = tt.template_id and tp.is_default
where i.id = t.instance_id and i.state <> 'activated' and t.template_key = 'calendar' and tt.key = 'calendar'
  and t.title = 'Google Calendar connected and appointment availability checked' and not app.setup_crm_uses(t.org_id, 'ghl');

-- In-flight GoHighLevel work the re-scoping below sets aside. 0027 made every client without a GoHighLevel location mapping native,
-- including clients whose sub-account was still being created, so their "GHL sub-account created" step is about to be excluded. Nothing is
-- deleted (its status, notes, attachments and history stay, and choosing GoHighLevel brings it back), but the agency gets a record per
-- step, written now because afterwards the exclusion no longer shows what changed.
insert into client_setup_task_events (org_id, instance_id, task_id, actor_kind, event, reason, visibility, metadata)
select t.org_id, t.instance_id, t.id, 'system', 'services_changed',
       'GoHighLevel sub-account step no longer applies: this workspace is on iAcquire CRM (the 0027 default for clients without a GoHighLevel location). Its progress is kept. To restore it, choose GoHighLevel in the CRM setup guide while the CRM has no records, or switch providers in Settings → CRM Provider.',
       'internal',
       jsonb_build_object('reason', 'crm_provider', 'migration', '0037', 'template_key', 'ghl_subaccount', 'status', t.status)
from client_setup_tasks t join client_setup_instances i on i.id = t.instance_id
where i.state <> 'activated' and t.template_key = 'ghl_subaccount' and not t.service_excluded
  and not app.setup_crm_uses(t.org_id, 'ghl')
  and (t.status <> 'pending' or t.client_note is not null or t.blocked_reason is not null or t.completion_note is not null
       or exists (select 1 from client_setup_task_attachments a where a.task_id = t.id));

select app.refresh_setup_applicability(i.org_id) from client_setup_instances i where i.state <> 'activated';

insert into client_setup_task_events (org_id, instance_id, actor_kind, event, visibility, metadata)
select i.org_id, i.id, 'system', 'template_expanded', 'internal', '{"migration":"0037","existing_history_preserved":true}'::jsonb
from client_setup_instances i where i.state <> 'activated';
update client_setup_instances set revision = revision + 1 where state <> 'activated';

-- ---------------------------------------------------------------------------
-- The client's CRM setup guide
-- ---------------------------------------------------------------------------

create table crm_setup_guides (
  org_id uuid primary key references organizations(id) on delete cascade,
  -- The step the person was on, so the guide resumes exactly there.
  current_step text not null default 'provider' check (current_step in (
    'provider', 'blueprint', 'fields', 'pipelines', 'tags', 'calendar', 'scheduling', 'communications', 'workflows', 'ai_roles', 'verify', 'review')),
  -- Answers that adapt the guide ({ "appointments": true, "calendarSource": "google", "channels": ["email", "sms"] }), validated by the server.
  answers jsonb not null default '{}'::jsonb check (jsonb_typeof(answers) = 'object' and pg_column_size(answers) <= 4096),
  -- Bumped on every save, so a second open tab can tell its view is stale.
  revision integer not null default 1 check (revision >= 1),
  provider_chosen_at timestamptz,
  provider_chosen_by uuid references users(id) on delete set null,
  -- When an owner or admin told iAcquire the workspace is ready for final review. The client never activates anything itself.
  ready_requested_at timestamptz,
  ready_requested_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger crm_setup_guides_touch before update on crm_setup_guides for each row execute function app.touch_updated_at();

alter table crm_setup_guides enable row level security;
revoke all on crm_setup_guides from public, anon, authenticated, iaq_site_runtime;
grant select on crm_setup_guides to iaq_app_user;
create policy crm_setup_guides_select on crm_setup_guides for select to iaq_app_user using (app.has_permission(org_id, 'crm.view'));
