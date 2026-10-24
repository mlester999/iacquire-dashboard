import "server-only";
import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import type { OrgContext } from "@/server/tenancy/context";
import type { SessionUser } from "@/server/auth/service";
import { connectorsFor, connectorSummary } from "@/server/setup/connectors";
import { fleetHealth } from "@/lib/setup/health";
import type { CrmMode } from "@/lib/crm/types";
import {
  assertAgencyAccess,
  clientTitle,
  ensureInstanceStandalone,
  ensureSetupInstance,
  iso,
  lockAgencySetupAccess,
  TASK_COLUMNS,
  type TaskRow,
} from "@/server/setup/core";
import {
  CHECK_KEYS,
  computeProgress,
  estimateCompletion,
  evaluateReadiness,
  isApplicable,
  STATUS_LABEL,
  unmetDependencies,
  type AgencyCheckView,
  type AgencyEventView,
  type AgencySetupSnapshot,
  type AgencyTaskView,
  type CheckKey,
  type CheckStatus,
  type ClientAction,
  type ClientSetupSnapshot,
  type ClientTaskView,
  type InstanceState,
  type RuleTask,
  type Section,
  type SetupService,
  type TaskStatus,
} from "@/lib/setup";

// ---------------------------------------------------------------------------
// Client portal
// ---------------------------------------------------------------------------

type ClientEventRow = { task_id: string | null; event: string; from_status: TaskStatus | null; to_status: TaskStatus | null; body: string | null; created_at: Date };

function clientEventText(e: ClientEventRow): string {
  const note = e.body?.trim();
  switch (e.event) {
    case "status_changed":
      return `${e.to_status ? STATUS_LABEL[e.to_status] : "Updated"}${note ? ` — ${note}` : ""}`;
    case "reopened":
      return `Reopened${note ? ` — ${note}` : ""}`;
    case "client_responded":
      return note ? `You replied — ${note}` : "You replied";
    default:
      return note ?? "Updated";
  }
}

/**
 * Everything the client may see, read through row-level security with column grants that omit
 * staff-only fields (assignee, internal notes, verification detail). The `section` of each step is
 * the one the client should see it under: a step that needs their input appears under
 * "We need a few things from you" for as long as it is waiting.
 */
export async function getClientSetupSnapshot(ctx: OrgContext): Promise<ClientSetupSnapshot | null> {
  if (ctx.org.kind !== "client") return null;
  if (!ctx.can("setup.view")) throw new AppError("forbidden", "You don't have access to the setup center.");
  const ensured = await ensureInstanceStandalone(ctx.org.orgId);
  if (!ensured) return null;

  const data = await withUser(ctx.user.id, async (db) => {
    const inst = await db.query<{ state: InstanceState; revision: number; activated_at: Date | null; updated_at: Date }>(
      "select state, revision::int as revision, activated_at, updated_at from client_setup_instances where org_id = $1",
      [ctx.org.orgId],
    );
    const tasks = await db.query<{
      id: string;
      title: string;
      client_title: string | null;
      description: string;
      section: Section;
      completion_mode: "manual" | "verified" | "activation";
      status: TaskStatus;
      required: boolean;
      hidden: boolean;
      service_excluded: boolean;
      sort_order: number;
      estimated_completion_at: string | null;
      client_note: string | null;
      blocked_reason: string | null;
      completion_note: string | null;
      client_action: ClientAction | null;
      client_response: { decision?: string | null } | null;
      client_responded_at: Date | null;
      completed_at: Date | null;
      updated_at: Date;
    }>(
      `select id, title, client_title, description, section, completion_mode, status, required, hidden, service_excluded, sort_order,
              to_char(estimated_completion_at, 'YYYY-MM-DD') as estimated_completion_at, client_note, blocked_reason, completion_note,
              client_action, client_response, client_responded_at, completed_at, updated_at
       from client_setup_tasks where org_id = $1 order by sort_order`,
      [ctx.org.orgId],
    );
    const deps = await db.query<{ task_id: string; depends_on_task_id: string }>("select task_id, depends_on_task_id from client_setup_task_dependencies where org_id = $1", [ctx.org.orgId]);
    const atts = await db.query<{ id: string; task_id: string; label: string; url: string; kind: string }>(
      "select id, task_id, label, url, kind from client_setup_task_attachments where org_id = $1 order by created_at",
      [ctx.org.orgId],
    );
    const events = await db.query<ClientEventRow>(
      "select task_id, event, from_status, to_status, body, created_at from client_setup_task_events where org_id = $1 order by created_at desc, id desc limit 300",
      [ctx.org.orgId],
    );
    const permission = await db.query<{ can_respond: boolean }>("select app.has_permission($1, 'setup.respond') as can_respond", [ctx.org.orgId]);
    return { inst: inst.rows[0], tasks: tasks.rows, deps: deps.rows, atts: atts.rows, events: events.rows, canRespond: permission.rows[0].can_respond };
  });
  if (!data.inst) return null;

  // Whether a check is failing is staff-only data; the client only learns that something needs attention.
  const { rows: failing } = await withSystem((db) =>
    db.query<{ n: number }>(
      `select count(*)::int as n from client_setup_checks c
       where c.org_id = $1 and c.status = 'failed' and c.check_key in (
         select t.check_key from client_setup_tasks t where t.org_id = $1 and t.completion_mode = 'verified' and not t.hidden and not t.service_excluded)`,
      [ctx.org.orgId],
    ),
  );

  const depMap = new Map<string, string[]>();
  for (const d of data.deps) depMap.set(d.task_id, [...(depMap.get(d.task_id) ?? []), d.depends_on_task_id]);
  const rule: Array<RuleTask & { estimatedCompletionAt: string | null }> = data.tasks.map((t) => ({
    id: t.id,
    title: clientTitle(t),
    status: t.status,
    required: t.required,
    hidden: t.hidden,
    serviceExcluded: t.service_excluded,
    completionMode: t.completion_mode,
    checkKey: null,
    dependsOn: depMap.get(t.id) ?? [],
    estimatedCompletionAt: t.estimated_completion_at,
  }));
  const byId = new Map(rule.map((r) => [r.id, r]));
  const canRespond = data.canRespond;

  const tasks: ClientTaskView[] = data.tasks
    .filter((t) => isApplicable({ hidden: t.hidden, serviceExcluded: t.service_excluded }))
    .map((t) => {
      const me = byId.get(t.id)!;
      const unmet = unmetDependencies(me, byId);
      const open = t.status === "waiting_for_client" && Boolean(t.client_action);
      const previewLinks = data.atts.filter((a) => a.task_id === t.id && (a.kind === "website_preview" || a.kind === "instructions")).map((a) => ({ label: a.label, url: a.url }));
      return {
        id: t.id,
        title: clientTitle(t),
        description: t.description,
        section: t.section === "client" || open ? "client" : "agency",
        status: t.status,
        isActivation: t.completion_mode === "activation",
        required: t.required,
        completedAt: iso(t.completed_at),
        completionNote: t.completion_note,
        clientNote: t.client_note,
        blockedReason: t.blocked_reason,
        estimatedCompletionAt: t.status === "completed" ? null : t.estimated_completion_at,
        updatedAt: new Date(t.updated_at).toISOString(),
        waitingOn: unmet.map((u) => u.title),
        action: t.client_action
          ? {
              ...t.client_action,
              available: open && canRespond && !unmet.length,
              unavailableReason: !open ? null : !canRespond ? "Ask a workspace owner or admin to respond to this." : unmet.length ? "We need to finish an earlier step first." : null,
              previewLinks,
            }
          : null,
        responded: t.client_responded_at ? { at: new Date(t.client_responded_at).toISOString(), decision: t.client_response?.decision ?? null } : null,
        attachments: data.atts.filter((a) => a.task_id === t.id).map((a) => ({ id: a.id, label: a.label, url: a.url, kind: a.kind })),
        history: data.events
          .filter((e) => e.task_id === t.id)
          .slice(0, 4)
          .map((e) => ({ at: new Date(e.created_at).toISOString(), text: clientEventText(e) })),
      };
    });

  const visibleRule = rule.filter(isApplicable);
  const progress = computeProgress(visibleRule);
  const lastUpdated = [data.inst.updated_at, ...data.tasks.map((t) => t.updated_at)].map((d) => new Date(d).getTime()).reduce((a, b) => Math.max(a, b), 0);

  return {
    scope: ctx.org.orgId,
    revision: data.inst.revision,
    generatedAt: new Date().toISOString(),
    orgName: ctx.org.name,
    state: data.inst.state,
    activatedAt: iso(data.inst.activated_at),
    progress,
    estimatedCompletion: estimateCompletion(visibleRule),
    lastUpdatedAt: new Date(lastUpdated).toISOString(),
    finalCheckIssue: (failing[0]?.n ?? 0) > 0,
    canRespond,
    needsAttention: tasks.filter((t) => t.action?.available).length,
    tasks,
  };
}

// ---------------------------------------------------------------------------
// Agency
// ---------------------------------------------------------------------------

export async function getAgencySetupSnapshot(admin: SessionUser, orgId: string): Promise<AgencySetupSnapshot> {
  await assertAgencyAccess(admin, orgId);
  if (!(await withSystem(async (db) => { await lockAgencySetupAccess(db, admin, orgId); return ensureSetupInstance(db, orgId, admin.id); }))) throw new AppError("not_found", "Client not found.");

  const d = await withSystem(async (db) => {
    await lockAgencySetupAccess(db, admin, orgId);
    const org = await db.query<{ id: string; name: string; status: string; onboarding_completed_at: Date | null; timezone: string }>(
      "select id, name, status, onboarding_completed_at, timezone from organizations where id = $1",
      [orgId],
    );
    const inst = await db.query<{
      state: InstanceState;
      services: SetupService[];
      responsible_user_id: string | null;
      revision: number;
      ready_for_review_at: Date | null;
      activated_at: Date | null;
    }>("select state, services, responsible_user_id, revision::int as revision, ready_for_review_at, activated_at from client_setup_instances where org_id = $1", [orgId]);
    const tasks = await db.query<TaskRow>(`select ${TASK_COLUMNS} from client_setup_tasks t where t.org_id = $1 order by t.section, t.sort_order`, [orgId]);
    const deps = await db.query<{ task_id: string; depends_on_task_id: string }>("select task_id, depends_on_task_id from client_setup_task_dependencies where org_id = $1", [orgId]);
    const atts = await db.query<{ id: string; task_id: string; label: string; url: string; kind: string; visibility: "internal" | "client"; created_at: Date }>(
      "select id, task_id, label, url, kind, visibility, created_at from client_setup_task_attachments where org_id = $1 order by created_at",
      [orgId],
    );
    const events = await db.query<{
      id: string;
      task_id: string | null;
      created_at: Date;
      actor_user_id: string | null;
      actor_kind: "agency" | "client" | "system";
      event: string;
      from_status: TaskStatus | null;
      to_status: TaskStatus | null;
      body: string | null;
      reason: string | null;
      visibility: "internal" | "client";
    }>(
      `select id::text, task_id, created_at, actor_user_id, actor_kind, event, from_status, to_status, body, reason, visibility
       from client_setup_task_events where org_id = $1 order by created_at desc, id desc limit 300`,
      [orgId],
    );
    const checks = await db.query<{
      check_key: CheckKey;
      status: CheckStatus;
      detail: string | null;
      source: "connector" | "attestation" | null;
      checked_at: Date | null;
      attested_by: string | null;
      evidence_url: string | null;
      note: string | null;
    }>("select check_key, status, detail, source, checked_at, attested_by, evidence_url, note from client_setup_checks where org_id = $1", [orgId]);
    const jobs = await db.query<{ id: string; status: string }>("select id, status from provisioning_jobs where org_id = $1 and status in ('failed', 'running')", [orgId]);
    const staff = await db.query<{ id: string; name: string; role: "agency_staff" | "agency_manager" | "agency_super_admin" }>(
      `select u.id, coalesce(nullif(u.full_name, ''), u.email::text) as name, u.platform_role as role from users u
       where u.status = 'active' and u.platform_role in ('agency_super_admin','agency_manager','agency_staff')
         and app.user_can_access_org(u.id,$1)
       order by u.platform_role desc, name`,
      [orgId],
    );
    const ids = [...new Set([...events.rows.map((e) => e.actor_user_id), ...tasks.rows.map((t) => t.completed_by), ...checks.rows.map((c) => c.attested_by)].filter((x): x is string => Boolean(x)))];
    const names = ids.length
      ? await db.query<{ id: string; name: string }>("select id, coalesce(nullif(full_name, ''), email::text) as name from users where id = any($1::uuid[])", [ids])
      : { rows: [] as Array<{ id: string; name: string }> };
    const connectors = await connectorsFor(db, orgId);
    const payment = await db.query<{ status: string | null; cleared: boolean }>(
      "select (select b.setup_payment_status from billing_accounts b where b.org_id = $1) as status, app.setup_payment_cleared($1) as cleared", [orgId],
    );
    return { org: org.rows[0], inst: inst.rows[0], tasks: tasks.rows, deps: deps.rows, atts: atts.rows, events: events.rows, checks: checks.rows, jobs: jobs.rows, staff: staff.rows, names: new Map(names.rows.map((n) => [n.id, n.name])), connectors, payment: payment.rows[0] };
  });
  if (!d.org || !d.inst) throw new AppError("not_found", "Client not found.");

  const depMap = new Map<string, string[]>();
  for (const x of d.deps) depMap.set(x.task_id, [...(depMap.get(x.task_id) ?? []), x.depends_on_task_id]);
  const rule: Array<RuleTask & { estimatedCompletionAt: string | null }> = d.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    required: t.required,
    hidden: t.hidden,
    serviceExcluded: t.service_excluded,
    completionMode: t.completion_mode,
    checkKey: t.check_key,
    dependsOn: depMap.get(t.id) ?? [],
    estimatedCompletionAt: t.estimated_completion_at,
  }));
  const byId = new Map(rule.map((r) => [r.id, r]));
  const checkStatus = Object.fromEntries(d.checks.map((c) => [c.check_key, c.status])) as Partial<Record<CheckKey, CheckStatus>>;
  const readiness = evaluateReadiness({ state: d.inst.state, tasks: rule, checks: checkStatus, payment: { cleared: d.payment.cleared === true } });
  if (d.jobs.length) {
    readiness.canActivate = false;
    readiness.blockers.push({ code: "job_needs_attention", message: `${d.jobs.length} preparation job${d.jobs.length === 1 ? " is" : "s are"} failed or running. Review the provisioning history before agency approval.` });
  }

  const tasks: AgencyTaskView[] = d.tasks.map((t) => ({
    id: t.id,
    templateKey: t.template_key,
    title: t.title,
    clientTitle: t.client_title,
    description: t.description,
    section: t.section,
    completionMode: t.completion_mode,
    checkKey: t.check_key,
    service: t.service,
    crmProvider: t.crm_provider,
    status: t.status,
    required: t.required,
    hidden: t.hidden,
    serviceExcluded: t.service_excluded,
    requiresEvidence: t.requires_evidence,
    requiresClientResponse: t.requires_client_response,
    sortOrder: t.sort_order,
    assignedTo: t.assigned_to,
    estimatedCompletionAt: t.estimated_completion_at,
    clientNote: t.client_note,
    blockedReason: t.blocked_reason,
    completionNote: t.completion_note,
    clientAction: t.client_action as ClientAction | null,
    clientResponse: t.client_response as AgencyTaskView["clientResponse"],
    clientRespondedAt: iso(t.client_responded_at),
    completedAt: iso(t.completed_at),
    completedBy: t.completed_by ? d.names.get(t.completed_by) ?? "Former team member" : null,
    completionSource: t.completion_source,
    verifiedAt: iso(t.verified_at),
    verifiedDetail: t.verified_detail,
    updatedAt: new Date(t.updated_at).toISOString(),
    dependsOn: depMap.get(t.id) ?? [],
    unmetDependencies: unmetDependencies(byId.get(t.id)!, byId).map((u) => u.id),
    attachments: d.atts.filter((a) => a.task_id === t.id).map((a) => ({ id: a.id, label: a.label, url: a.url, kind: a.kind, visibility: a.visibility, createdAt: new Date(a.created_at).toISOString() })),
  }));

  const applicableChecks = [...new Set(d.tasks.filter((t) => t.check_key && isApplicable({ hidden: t.hidden, serviceExcluded: t.service_excluded })).map((t) => t.check_key as CheckKey))];
  const checks: AgencyCheckView[] = CHECK_KEYS.filter((k) => applicableChecks.includes(k)).map((key) => {
    const row = d.checks.find((c) => c.check_key === key);
    const sum = connectorSummary(key, d.connectors);
    return {
      key,
      label: sum.label,
      status: row?.status ?? "unverified",
      detail: row?.detail ?? (sum.implemented ? null : sum.note),
      source: row?.source ?? null,
      checkedAt: iso(row?.checked_at),
      attestedBy: row?.attested_by ? d.names.get(row.attested_by) ?? "Former team member" : null,
      evidenceUrl: row?.evidence_url ?? null,
      note: row?.note ?? null,
      connectorImplemented: sum.implemented,
      connectorNote: sum.note,
      appliesTo: d.tasks.filter((t) => t.check_key === key).map((t) => t.title),
    };
  });

  const events: AgencyEventView[] = d.events.map((e) => ({
    id: e.id,
    taskId: e.task_id,
    at: new Date(e.created_at).toISOString(),
    actor: e.actor_user_id ? d.names.get(e.actor_user_id) ?? "Former team member" : null,
    actorKind: e.actor_kind,
    event: e.event,
    fromStatus: e.from_status,
    toStatus: e.to_status,
    body: e.body,
    reason: e.reason,
    visibility: e.visibility,
  }));

  return {
    scope: orgId,
    revision: d.inst.revision,
    generatedAt: new Date().toISOString(),
    org: { id: d.org.id, name: d.org.name, status: d.org.status, onboardingCompletedAt: iso(d.org.onboarding_completed_at), timezone: d.org.timezone },
    state: d.inst.state,
    services: d.inst.services,
    responsibleUserId: d.inst.responsible_user_id,
    readyForReviewAt: iso(d.inst.ready_for_review_at),
    activatedAt: iso(d.inst.activated_at),
    progress: computeProgress(rule),
    estimatedCompletion: estimateCompletion(rule.filter(isApplicable)),
    readiness,
    tasks,
    events,
    checks,
    staff: d.staff,
    canActivate: admin.platformRole === "agency_super_admin" && readiness.canActivate,
    payment: { status: d.payment.status ?? "not_invoiced", cleared: d.payment.cleared === true },
  };
}

// ---------------------------------------------------------------------------
// Admin client list
// ---------------------------------------------------------------------------

export type HealthLevel = "healthy" | "issue" | "partial" | "not_connected";

export interface ClientSetupRow {
  id: string;
  name: string;
  slug: string;
  orgStatus: string;
  isDemo: boolean;
  createdAt: string;
  onboardingCompletedAt: string | null;
  contact: { name: string; email: string } | null;
  services: SetupService[];
  setup: {
    started: boolean;
    state: InstanceState | null;
    percent: number | null;
    completed: number;
    total: number;
    clientActions: number;
    blocked: number;
    outstanding: number;
    blockers: string[];
  };
  responsible: { id: string; name: string } | null;
  health: { level: HealthLevel; agentsOnline: number; agentsEnabled: number; ghl: string | null; calendar: string | null; n8n: string | null; failedChecks: number; failingAgents: number };
  openTickets: number;
  lastActivityAt: string | null;
}

export async function listClientSetupOverview(user: SessionUser): Promise<ClientSetupRow[]> {
  if (user.platformRole === "none") throw new AppError("forbidden", "Agency access is required.");
  const { rows } = await withSystem(async (db) => {
    const current = await db.query<{ platform_role: string }>("select platform_role from users where id = $1 and status = 'active' for share", [user.id]);
    const role = current.rows[0]?.platform_role;
    if (!role || role === "none" || role !== user.platformRole) throw new AppError("forbidden", "Agency authorization has changed. Sign in again.");
    return db.query<{
      id: string;
      name: string;
      slug: string;
      status: string;
      is_demo: boolean;
      created_at: Date;
      onboarding_completed_at: Date | null;
      contact_name: string | null;
      contact_email: string | null;
      services: SetupService[] | null;
      instance_id: string | null;
      state: InstanceState | null;
      responsible_user_id: string | null;
      responsible_name: string | null;
      total: number | null;
      completed: number | null;
      waiting: number | null;
      blocked: number | null;
      outstanding: number | null;
      blockers: string[] | null;
      last_task_at: Date | null;
      agents_online: number;
      agents_enabled: number;
      agents_failing: number;
      ghl_status: string | null;
      calendar_status: string | null;
      n8n_status: string | null;
      crm_mode: CrmMode | null;
      native_records: number;
      failed_checks: number;
      open_tickets: number;
      last_audit_at: Date | null;
    }>(
      `select o.id, o.name, o.slug, o.status, o.is_demo, o.created_at, o.onboarding_completed_at,
              i.id as instance_id, i.state, i.services, i.responsible_user_id, ru.full_name as responsible_name,
              contact.contact_name, contact.contact_email,
              p.total, p.completed, p.waiting, p.blocked, p.outstanding, p.blockers, p.last_task_at,
              (select count(*)::int from agent_instances a where a.org_id = o.id and a.enabled and a.status in ('online', 'busy') and a.last_health_check_at is not null and a.last_health_ok = true) as agents_online,
              (select count(*)::int from agent_instances a where a.org_id = o.id and a.enabled) as agents_enabled,
              (select count(*)::int from agent_instances a where a.org_id = o.id and a.enabled and a.status in ('error', 'offline')) as agents_failing,
              (select g.status from ghl_location_mappings g where g.org_id = o.id) as ghl_status,
              (select s.status from integration_status s where s.org_id = o.id and s.provider = 'ghl_calendar') as calendar_status,
              (select s.status from integration_status s where s.org_id = o.id and s.provider = 'n8n') as n8n_status,
              (select w.mode from crm_workspaces w where w.org_id = o.id) as crm_mode,
              (select count(*)::int from contacts c where c.org_id = o.id and c.deleted_at is null)
                + (select count(*)::int from crm_pipelines p where p.org_id = o.id and p.provider = 'native' and p.archived_at is null)
                + (select count(*)::int from crm_calendars cal where cal.org_id = o.id and cal.status = 'active' and cal.archived_at is null) as native_records,
              (select count(*)::int from client_setup_checks c where c.org_id = o.id and c.status = 'failed') as failed_checks,
              (select count(*)::int from support_tickets t where t.org_id = o.id and t.status in ('new', 'open', 'in_progress')) as open_tickets,
              (select max(l.created_at) from audit_logs l where l.org_id = o.id and l.action <> 'agent.health_check') as last_audit_at
       from organizations o
       left join client_setup_instances i on i.org_id = o.id
       left join users ru on ru.id = i.responsible_user_id
       left join lateral (
         select coalesce(nullif(u.full_name, ''), u.email::text) as contact_name, u.email::text as contact_email
         from organization_memberships m join users u on u.id = m.user_id and u.status = 'active'
         where m.org_id = o.id and m.status = 'active' and m.role = 'owner'
         order by m.created_at, m.user_id limit 1
       ) contact on true
       left join lateral (
         select count(*) filter (where t.required and t.completion_mode <> 'activation')::int as total,
                count(*) filter (where t.required and t.completion_mode <> 'activation' and t.status = 'completed')::int as completed,
                count(*) filter (where t.status = 'waiting_for_client' and t.completion_mode <> 'activation')::int as waiting,
                count(*) filter (where t.status = 'blocked')::int as blocked,
                count(*) filter (where t.status <> 'completed' and t.completion_mode <> 'activation')::int as outstanding,
                array_agg(t.title order by t.sort_order) filter (where t.status = 'blocked') as blockers,
                max(t.updated_at) as last_task_at
         from client_setup_tasks t where t.org_id = o.id and not t.hidden and not t.service_excluded
       ) p on i.id is not null
       where o.kind = 'client'
         and app.user_can_access_org($1,o.id)
       order by o.created_at desc`,
      [user.id],
    );
  });
  return rows.map((r) => {
    const level = fleetHealth({
      agentsOnline: r.agents_online,
      agentsEnabled: r.agents_enabled,
      failedChecks: r.failed_checks,
      failingAgents: r.agents_failing,
      ghl: r.ghl_status,
      calendar: r.calendar_status,
      n8n: r.n8n_status,
      crmMode: r.crm_mode,
      setupState: r.state,
      nativeRecords: r.native_records,
    });
    const last = [r.last_task_at, r.last_audit_at].filter(Boolean).map((d) => new Date(d as Date).getTime());
    const total = r.total ?? 0;
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      orgStatus: r.status,
      isDemo: r.is_demo,
      createdAt: new Date(r.created_at).toISOString(),
      onboardingCompletedAt: iso(r.onboarding_completed_at),
      contact: r.contact_email ? { name: r.contact_name || r.contact_email, email: r.contact_email } : null,
      services: r.services ?? [],
      setup: {
        started: Boolean(r.instance_id),
        state: r.state,
        percent: total ? Math.round(((r.completed ?? 0) / total) * 100) : null,
        completed: r.completed ?? 0,
        total,
        clientActions: r.waiting ?? 0,
        blocked: r.blocked ?? 0,
        outstanding: r.outstanding ?? 0,
        blockers: r.blockers ?? [],
      },
      responsible: r.responsible_user_id ? { id: r.responsible_user_id, name: r.responsible_name || "Team member" } : null,
      health: {
        level,
        agentsOnline: r.agents_online,
        agentsEnabled: r.agents_enabled,
        ghl: r.ghl_status,
        calendar: r.calendar_status,
        n8n: r.n8n_status,
        failedChecks: r.failed_checks,
        failingAgents: r.agents_failing,
      },
      openTickets: r.open_tickets,
      lastActivityAt: last.length ? new Date(Math.max(...last)).toISOString() : null,
    };
  });
}
