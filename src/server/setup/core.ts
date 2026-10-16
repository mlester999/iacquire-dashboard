import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles, type NotificationInput } from "@/server/notifications";
import { sendEmail } from "@/server/email";
import { env } from "@/server/env";
import { agencyCanAccessOrg } from "@/server/tenancy/context";
import type { SessionUser } from "@/server/auth/service";
import { publishSetupChange } from "@/server/setup/hub";
import { publishSetupRevision } from "@/server/setup/realtime";
import { evaluateReadiness, type CheckKey, type CheckStatus, type InstanceState, type RuleTask, type SetupService, type TaskStatus, type CompletionMode } from "@/lib/setup";

export interface InstanceRow {
  id: string;
  org_id: string;
  state: InstanceState;
  services: SetupService[];
  responsible_user_id: string | null;
  revision: number;
}

export interface TaskRow {
  id: string;
  org_id: string;
  template_key: string | null;
  title: string;
  client_title: string | null;
  description: string;
  completion_notice: string | null;
  section: "agency" | "client";
  completion_mode: CompletionMode;
  check_key: CheckKey | null;
  service: SetupService | null;
  status: TaskStatus;
  required: boolean;
  hidden: boolean;
  service_excluded: boolean;
  requires_evidence: boolean;
  requires_client_response: boolean;
  sort_order: number;
  assigned_to: string | null;
  estimated_completion_at: string | null;
  client_note: string | null;
  blocked_reason: string | null;
  completion_note: string | null;
  client_action: { type: string; label: string; instructions: string } | null;
  client_response: Record<string, unknown> | null;
  client_responded_at: Date | null;
  completed_at: Date | null;
  completed_by: string | null;
  completion_source: "agency" | "connector" | "attestation" | "activation" | null;
  verified_at: Date | null;
  verified_detail: string | null;
  updated_at: Date;
}

/** Every column the agency side reads (the client side uses a narrower, RLS-granted list). */
export const TASK_COLUMNS = `t.id, t.org_id, t.template_key, t.title, t.client_title, t.description, t.completion_notice, t.section,
  t.completion_mode, t.check_key, t.service, t.status, t.required, t.hidden, t.service_excluded, t.requires_evidence,
  t.requires_client_response, t.sort_order, t.assigned_to, to_char(t.estimated_completion_at, 'YYYY-MM-DD') as estimated_completion_at,
  t.client_note, t.blocked_reason, t.completion_note, t.client_action, t.client_response, t.client_responded_at, t.completed_at,
  t.completed_by, t.completion_source, t.verified_at, t.verified_detail, t.updated_at`;

export const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

/**
 * Creates the tenant's checklist from the default template the first time it is needed. Idempotent,
 * and only ever for client organizations: the agency's own workspace has no client setup.
 */
export async function ensureSetupInstance(db: Queryable, orgId: string, actorUserId: string | null = null): Promise<{ id: string; created: boolean } | null> {
  const { rows: org } = await db.query<{ kind: string }>("select kind from organizations where id = $1", [orgId]);
  if (org[0]?.kind !== "client") return null;
  const existing = await db.query<{ id: string }>("select id from client_setup_instances where org_id = $1", [orgId]);
  if (existing.rows[0]) return { id: existing.rows[0].id, created: false };

  const ins = await db.query<{ id: string }>(
    "insert into client_setup_instances (org_id, template_id) select $1, id from client_setup_templates where is_default on conflict (org_id) do nothing returning id",
    [orgId],
  );
  if (!ins.rows[0]) {
    const again = await db.query<{ id: string }>("select id from client_setup_instances where org_id = $1", [orgId]);
    return again.rows[0] ? { id: again.rows[0].id, created: false } : null;
  }
  const instanceId = ins.rows[0].id;
  await db.query(
    `insert into client_setup_tasks (org_id, instance_id, template_key, title, client_title, description, completion_notice, section,
       completion_mode, check_key, service, required, requires_evidence, requires_client_response, client_action, sort_order, service_excluded)
     select $1, $2, tt.key, tt.title, tt.client_title, tt.description, tt.completion_notice, tt.section, tt.completion_mode, tt.check_key,
            tt.service, tt.required, tt.requires_evidence, tt.requires_client_response, tt.client_action, tt.sort_order,
            tt.service is not null and not (tt.service = any(i.services))
     from client_setup_template_tasks tt join client_setup_templates t on t.id = tt.template_id and t.is_default
     join client_setup_instances i on i.id = $2`,
    [orgId, instanceId],
  );
  await db.query(
    `insert into client_setup_task_dependencies (org_id, task_id, depends_on_task_id)
     select $1, t.id, d.id
     from client_setup_template_tasks tt
     join client_setup_templates tp on tp.id = tt.template_id and tp.is_default
     join client_setup_tasks t on t.instance_id = $2 and t.template_key = tt.key
     cross join lateral unnest(tt.depends_on) as dep(key)
     join client_setup_tasks d on d.instance_id = $2 and d.template_key = dep.key`,
    [orgId, instanceId],
  );
  await recordSetupEvent(db, { orgId, instanceId, actorUserId, actorKind: actorUserId ? "agency" : "system", event: "instance_created", visibility: "internal" });
  await recordAudit({ orgId, actorUserId, actorKind: actorUserId ? "agency" : "system", action: "setup.instance_created", targetType: "setup", targetId: instanceId, result: "success" }, db);
  return { id: instanceId, created: true };
}

/** Ensures every client workspace has a checklist. Safe to run repeatedly (startup, deploys). Returns the workspaces it created one for. */
export async function backfillSetupInstances(): Promise<string[]> {
  const { rows } = await withSystem((db) =>
    db.query<{ id: string }>(
      "select o.id from organizations o where o.kind = 'client' and not exists (select 1 from client_setup_instances i where i.org_id = o.id)",
    ),
  );
  const created: string[] = [];
  for (const r of rows) {
    const res = await withSystem((db) => ensureSetupInstance(db, r.id));
    if (res?.created) created.push(r.id);
  }
  return created;
}

export async function ensureInstanceStandalone(orgId: string, actorUserId: string | null = null) {
  return withSystem((db) => ensureSetupInstance(db, orgId, actorUserId));
}

export async function getSetupRevision(orgId: string): Promise<number | null> {
  const { rows } = await withSystem((db) => db.query<{ revision: number }>("select revision::int as revision from client_setup_instances where org_id = $1", [orgId]));
  return rows[0]?.revision ?? null;
}

// ---------------------------------------------------------------------------
// Reading the rules inputs
// ---------------------------------------------------------------------------

export async function loadRuleTasks(db: Queryable, orgId: string): Promise<RuleTask[]> {
  const { rows } = await db.query<{
    id: string;
    title: string;
    status: TaskStatus;
    required: boolean;
    hidden: boolean;
    service_excluded: boolean;
    completion_mode: CompletionMode;
    check_key: CheckKey | null;
    depends_on: string[] | null;
  }>(
    `select t.id, t.title, t.status, t.required, t.hidden, t.service_excluded, t.completion_mode, t.check_key,
            (select array_agg(d.depends_on_task_id) from client_setup_task_dependencies d where d.task_id = t.id) as depends_on
     from client_setup_tasks t where t.org_id = $1 order by t.sort_order`,
    [orgId],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    required: r.required,
    hidden: r.hidden,
    serviceExcluded: r.service_excluded,
    completionMode: r.completion_mode,
    checkKey: r.check_key,
    dependsOn: r.depends_on ?? [],
  }));
}

export async function loadCheckStatuses(db: Queryable, orgId: string): Promise<Partial<Record<CheckKey, CheckStatus>>> {
  const { rows } = await db.query<{ check_key: CheckKey; status: CheckStatus }>("select check_key, status from client_setup_checks where org_id = $1", [orgId]);
  return Object.fromEntries(rows.map((r) => [r.check_key, r.status]));
}

// ---------------------------------------------------------------------------
// Events, notifications, revisions
// ---------------------------------------------------------------------------

export interface SetupEventInput {
  orgId: string;
  instanceId: string;
  taskId?: string | null;
  actorUserId?: string | null;
  actorKind: "agency" | "client" | "system";
  event: string;
  fromStatus?: TaskStatus | null;
  toStatus?: TaskStatus | null;
  body?: string | null;
  reason?: string | null;
  visibility?: "internal" | "client";
  metadata?: Record<string, unknown>;
}

export async function recordSetupEvent(db: Queryable, e: SetupEventInput) {
  await db.query(
    `insert into client_setup_task_events (org_id, instance_id, task_id, actor_user_id, actor_kind, event, from_status, to_status, body, reason, visibility, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      e.orgId,
      e.instanceId,
      e.taskId ?? null,
      e.actorUserId ?? null,
      e.actorKind,
      e.event,
      e.fromStatus ?? null,
      e.toStatus ?? null,
      e.body?.slice(0, 2000) ?? null,
      e.reason?.slice(0, 2000) ?? null,
      e.visibility ?? "internal",
      JSON.stringify(e.metadata ?? {}),
    ],
  );
}

export interface TxHelpers {
  /** Runs after the transaction commits (email, live pushes) so it can never observe uncommitted rows. */
  after(fn: () => Promise<void>): void;
  notifyClient(n: NotificationInput): Promise<void>;
}

/**
 * Setup email is optional and conservative: it is only attempted when a real email provider is
 * configured and the recipient has explicitly opted in. The outbox records what the provider
 * accepted; nothing here ever claims a message was delivered.
 */
async function emailOptedInRecipients(orgId: string): Promise<string[]> {
  const e = env();
  if (e.EMAIL_PROVIDER !== "resend" || !e.RESEND_API_KEY) return [];
  const { rows } = await withSystem((db) =>
    db.query<{ email: string }>(
      `select u.email::text as email from organization_memberships m
       join users u on u.id = m.user_id and u.status = 'active' and u.email_verified_at is not null
       join notification_preferences p on p.user_id = m.user_id and p.org_id = m.org_id
       where m.org_id = $1 and m.status = 'active' and m.role in ('owner', 'admin') and p.prefs->>'setupEmails' = 'true'`,
      [orgId],
    ),
  );
  return rows.map((r) => r.email);
}

function helpers(orgId: string, db: Queryable, afterQueue: Array<() => Promise<void>>): TxHelpers {
  return {
    after: (fn) => void afterQueue.push(fn),
    async notifyClient(n) {
      await notifyOrgRoles(db, orgId, ["owner", "admin"], n);
      afterQueue.push(async () => {
        const to = await emailOptedInRecipients(orgId);
        for (const addr of to) {
          await sendEmail({ to: addr, template: "setup_update", subject: n.title, text: `${n.title}${n.body ? `\n\n${n.body}` : ""}\n\nOpen your Setup Center: ${new URL("/setup", env().APP_URL).toString()}`, tone: n.severity });
        }
      });
    },
  };
}

/**
 * Runs one setup mutation atomically against the tenant's instance row (locked, so concurrent
 * staff edits serialize), then bumps the revision, re-checks that a final review is still valid,
 * and — only after commit — pushes the change to open browsers.
 */
export async function mutateSetup<T>(orgId: string, fn: (db: Queryable, inst: InstanceRow, h: TxHelpers) => Promise<T>): Promise<{ result: T; revision: number }> {
  const afterQueue: Array<() => Promise<void>> = [];
  const out = await withSystem(async (db) => {
    await ensureSetupInstance(db, orgId);
    const { rows } = await db.query<InstanceRow>(
      "select id, org_id, state, services, responsible_user_id, revision::int as revision from client_setup_instances where org_id = $1 for update",
      [orgId],
    );
    const inst = rows[0];
    if (!inst) throw new AppError("not_found", "Client setup not found.");
    const result = await fn(db, inst, helpers(orgId, db, afterQueue));
    await reconcileReviewState(db, inst);
    const bumped = await db.query<{ revision: number }>("update client_setup_instances set revision = revision + 1 where id = $1 returning revision::int as revision", [inst.id]);
    return { result, revision: bumped.rows[0].revision };
  });
  publishSetupChange(orgId, out.revision);
  await publishSetupRevision(orgId,out.revision);
  for (const job of afterQueue) {
    try {
      await job();
    } catch {
      if (process.env.NODE_ENV !== "test") console.error("[iacquire] setup follow-up failed; review the notification provider configuration.");
    }
  }
  return out;
}

/** A change that invalidates final review (reopened, blocked or new required step) sends it back. */
async function reconcileReviewState(db: Queryable, inst: InstanceRow) {
  const { rows } = await db.query<{ state: InstanceState }>("select state from client_setup_instances where id = $1", [inst.id]);
  if (rows[0]?.state !== "ready_for_review") return;
  const tasks = await loadRuleTasks(db, inst.org_id);
  const readiness = evaluateReadiness({ state: "in_setup", tasks, checks: {} });
  if (!readiness.taskBlockers.length) return;
  await db.query("update client_setup_instances set state = 'in_setup', ready_for_review_at = null, ready_for_review_by = null where id = $1", [inst.id]);
  await recordSetupEvent(db, {
    orgId: inst.org_id,
    instanceId: inst.id,
    actorKind: "system",
    event: "sent_back",
    reason: `Final review was cancelled because: ${readiness.taskBlockers[0].message}`,
    visibility: "internal",
  });
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/** Agency staff may manage assigned clients; super admins may manage any. Never trusts a client-supplied tenant. */
export async function assertAgencyAccess(admin: SessionUser, orgId: string, level: "staff" | "super_admin" = "staff") {
  const current = await withSystem((db) => db.query<{ platform_role: string }>("select platform_role from users where id = $1 and status = 'active'", [admin.id]));
  const actualRole = current.rows[0]?.platform_role;
  if (!actualRole || actualRole === "none" || actualRole !== admin.platformRole) throw new AppError("forbidden", "Agency access is required; authorization has changed. Sign in again.");
  if (admin.platformRole === "none") throw new AppError("forbidden", "Agency access is required.");
  if (level === "super_admin" && admin.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only super admins can do this.");
  if (!(await agencyCanAccessOrg(admin, orgId))) throw new AppError("not_found", "Client not found.");
}

/** Hold role and assignment authorization for the duration of a privileged setup write. */
export async function lockAgencySetupAccess(db: Queryable, admin: SessionUser, orgId: string) {
  const { rows } = await db.query<{ platform_role: string }>("select platform_role from users where id=$1 and status='active' for share", [admin.id]);
  const role=rows[0]?.platform_role;
  if (!role || role==="none" || role!==admin.platformRole) throw new AppError("forbidden", "Agency authorization has changed. Sign in again.");
  if (role==="agency_staff") {
    const assignment=await db.query("select 1 from staff_assignments where user_id=$1 and org_id=$2 for share", [admin.id,orgId]);
    if (!assignment.rows.length) throw new AppError("forbidden", "You are no longer assigned to this client.");
  }
}

/** Cached page context cannot authorize an owner/admin response after a membership change. */
export async function lockClientSetupResponse(db: Queryable, userId: string, orgId: string) {
  const { rows }=await db.query(
    `select 1 from organization_memberships m join users u on u.id=m.user_id join organizations o on o.id=m.org_id
     where m.user_id=$1 and m.org_id=$2 and m.status='active' and u.status='active' and o.status not in ('suspended','archived')
       and exists(select 1 from role_permissions rp where rp.role=m.role and rp.permission='setup.respond')
     for share of m,u,o`, [userId,orgId],
  );
  if (!rows.length) throw new AppError("forbidden", "Only current workspace owners and admins can respond to setup requests.");
}

export function clientTitle(t: { title: string; client_title: string | null }) {
  return t.client_title?.trim() || t.title;
}
