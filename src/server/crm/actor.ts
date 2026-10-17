import "server-only";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import type { OrgContext } from "@/server/tenancy/context";
import type { SessionUser } from "@/server/auth/service";
import { PERMISSION_MATRIX, type Permission } from "@/lib/permissions";

/**
 * Who is acting on a client's CRM. Every CRM service takes an actor instead of trusting an organization ID from a request:
 *
 *  - member: a person in the client's own workspace. Permissions are their role plus per-person overrides. Reads run under
 *    row-level security (withUser) as a second layer.
 *  - agency: iAcquire staff inside an audited, time-limited support session the server found for this exact client. Read-only
 *    unless a super admin opened a write session.
 *  - agent: a client's own AI employee calling a CRM tool with a server-issued token (phase 4).
 *  - api: an integration key with explicit scopes (phase 4).
 *  - system: background work the server started itself (workflows, imports, booking pages) for one organization.
 *
 * Whatever the kind, `orgId` comes from the server's own lookup, never from the request body.
 */
export type CrmActorKind = "member" | "agency" | "agent" | "api" | "system";

export interface CrmActor {
  kind: CrmActorKind;
  orgId: string;
  orgName: string;
  timezone: string;
  userId: string | null;
  agentId: string | null;
  apiKeyId: string | null;
  supportSessionId: string | null;
  supportMode: "read" | "write" | null;
  label: string;
  can(permission: Permission): boolean;
}

/** What an agency person may do in a read-only support session. Never exports, deletes or sends. */
export const AGENCY_READ_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  "crm.view", "contacts.view", "companies.view", "sales.view", "appointments.view", "inbox.view", "inbox.view_all", "workflows.view", "analytics.view", "calls.view", "team.view",
]);

/** A support write session adds scoped maintenance. Bulk sends, full data exports and permission administration remain client-controlled. */
export const AGENCY_WRITE_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  ...AGENCY_READ_PERMISSIONS,
  "contacts.create", "contacts.edit", "contacts.assign", "contacts.merge", "contacts.import",
  "companies.create", "companies.edit", "companies.delete", "tags.manage", "fields.manage", "smartlists.share",
  "pipelines.manage", "opportunities.create", "opportunities.edit", "opportunities.reopen", "calendars.manage", "appointments.book", "appointments.manage",
  "notes.write", "inbox.reply", "inbox.notes", "inbox.assign", "tasks.manage", "workflows.manage", "templates.manage", "campaigns.manage", "forms.manage", "reviews.manage", "analytics.export", "crm.provider.manage",
]);

const AGENCY_MEMBER_WRITE_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  ...AGENCY_WRITE_PERMISSIONS,
  "contacts.delete", "contacts.export", "contacts.bulk", "companies.delete", "opportunities.delete",
]);

async function agencyPermissionSet(userId: string, db?: Queryable): Promise<Set<Permission>> {
  const permissions = Object.keys(PERMISSION_MATRIX) as Permission[];
  const read = (q: Queryable) => q.query<{ permission: string }>(
    `select p.permission from unnest($2::text[]) as p(permission)
     where coalesce(app.user_has_agency_permission($1,p.permission),false)`,
    [userId, permissions],
  );
  const { rows } = db ? await read(db) : await withSystem(read);
  return new Set(rows.map((row) => row.permission).filter((permission): permission is Permission => permission in PERMISSION_MATRIX));
}

export function memberActor(ctx: OrgContext): CrmActor {
  if (ctx.org.kind !== "client") throw new AppError("invalid_input", "The CRM belongs to client workspaces.");
  return {
    kind: "member",
    orgId: ctx.org.orgId,
    orgName: ctx.org.name,
    timezone: ctx.org.timezone,
    userId: ctx.user.id,
    agentId: null,
    apiKeyId: null,
    supportSessionId: null,
    supportMode: null,
    label: ctx.user.fullName || ctx.user.email,
    can: (p) => ctx.can(p),
  };
}

export function systemActor(org: { id: string; name?: string; timezone?: string }, label = "iAcquire"): CrmActor {
  return { kind: "system", orgId: org.id, orgName: org.name ?? "", timezone: org.timezone ?? "UTC", userId: null, agentId: null, apiKeyId: null, supportSessionId: null, supportMode: null, label, can: () => true };
}

export function assertCan(actor: CrmActor, permission: Permission, message?: string) {
  if (!actor.can(permission)) {
    if (actor.kind === "agency" && actor.supportMode === "read") throw new AppError("forbidden", "This support session is read-only. A super admin can open a write session with a reason.");
    throw new AppError("forbidden", message ?? "Your role doesn't allow this. Ask a workspace owner for access.");
  }
}

/** New create grants are separate for people, while existing API and agent credentials keep their edit scope. */
export function assertCanCreate(actor: CrmActor, permission: "contacts.create" | "companies.create" | "opportunities.create") {
  if (actor.kind === "member" || actor.kind === "agency") {
    assertCan(actor, permission);
    return;
  }
  const legacyEditPermission = permission.replace(".create", ".edit") as Permission;
  assertCan(actor, legacyEditPermission);
}

/** Audit columns for an actor. */
export function auditActor(actor: CrmActor): { actorKind: "user" | "agency" | "agent" | "system"; actorUserId: string | null; agentInstanceId: string | null } {
  const kind = actor.kind === "member" ? "user" : actor.kind === "api" ? "system" : actor.kind;
  return { actorKind: kind, actorUserId: actor.userId, agentInstanceId: actor.agentId };
}

/** Activity/event actor columns. */
export function eventActor(actor: CrmActor): { kind: "user" | "agency" | "agent" | "system" | "api"; id: string | null } {
  if (actor.kind === "member") return { kind: "user", id: actor.userId };
  if (actor.kind === "agency") return { kind: "agency", id: actor.userId };
  if (actor.kind === "agent") return { kind: "agent", id: actor.agentId };
  if (actor.kind === "api") return { kind: "api", id: actor.apiKeyId };
  return { kind: "system", id: null };
}

/**
 * Reads. A client member reads under row-level security, so a missing org filter in a query still cannot reach another tenant.
 * Other actors were authorized in code for exactly one organization and every query names it.
 */
export function crmRead<T>(actor: CrmActor, fn: (db: Queryable) => Promise<T>): Promise<T> {
  if (actor.kind === "member" && actor.userId) return withUser(actor.userId, fn);
  return withSystem(fn);
}

/** Writes run as trusted server code after the caller has authorized the actor. */
export function crmWrite<T>(actor: CrmActor, fn: (db: Queryable) => Promise<T>): Promise<T> {
  void actor;
  return withSystem(fn);
}

// ---------------------------------------------------------------------------
// Agency support sessions
// ---------------------------------------------------------------------------

export interface SupportSession {
  id: string;
  mode: "read" | "write";
  reason: string;
  startedAt: string;
  expiresAt: string;
}

const READ_MINUTES = 60;
const WRITE_MINUTES = 30;

/**
 * Whether an agency person may work on this client: super admins on every client, staff only where assigned. The same rule as
 * tenancy's agencyCanAccessOrg, kept here so CRM services (and scripts and workers) never import request-bound code.
 */
export async function agencyCanAccessClient(user: Pick<SessionUser, "id" | "platformRole">, orgId: string): Promise<boolean> {
  if (user.platformRole === "none") return false;
  const { rows } = await withSystem((db) => db.query<{ allowed: boolean }>(
    "select app.user_can_access_org($1,$2) as allowed",
    [user.id, orgId],
  ));
  return rows[0]?.allowed === true;
}

async function clientOrg(db: Queryable, orgId: string) {
  const { rows } = await db.query<{ id: string; name: string; timezone: string; kind: string; status: string }>("select id, name, timezone, kind, status from organizations where id = $1", [orgId]);
  const org = rows[0];
  if (!org || org.kind !== "client") throw new AppError("not_found", "Client not found.");
  return org;
}

export async function activeSupportSession(user: Pick<SessionUser, "id">, orgId: string, db?: Queryable): Promise<SupportSession | null> {
  const run = async (q: Queryable) => {
    const { rows } = await q.query<{ id: string; mode: "read" | "write"; reason: string; started_at: Date; expires_at: Date }>(
      `select id, mode, reason, started_at, expires_at from crm_support_sessions
       where org_id = $1 and user_id = $2 and ended_at is null and expires_at > now() order by started_at desc limit 1`,
      [orgId, user.id],
    );
    const r = rows[0];
    return r ? { id: r.id, mode: r.mode, reason: r.reason, startedAt: new Date(r.started_at).toISOString(), expiresAt: new Date(r.expires_at).toISOString() } : null;
  };
  return db ? run(db) : withSystem(run);
}

/**
 * Opens a support session on one client's CRM. Staff must be assigned, and write sessions require an explicit CRM write grant.
 * The reason is recorded, the access is audited, and for a write session the client's owner and managers are told.
 */
export async function startSupportSession(user: SessionUser, orgId: string, input: { mode: "read" | "write"; reason: string }): Promise<SupportSession> {
  if (user.platformRole === "none") throw new AppError("forbidden", "Agency access is required.");
  if (!(await agencyCanAccessClient(user, orgId))) throw new AppError("forbidden", "You are not assigned to this client.");
  const capability = input.mode === "write" ? "agency.crm.manage" : "agency.crm.read";
  const canOpen = await withSystem((db) => db.query<{ allowed: boolean }>(
    "select coalesce(app.user_has_agency_permission($1,$2),false) as allowed",
    [user.id, capability],
  ));
  if (canOpen.rows[0]?.allowed !== true) throw new AppError("forbidden", input.mode === "write" ? "Only agency super admins can open a session that changes client records unless CRM write access was explicitly granted." : "Your role does not allow a CRM support session.");
  const reason = input.reason.trim();
  if (reason.length < 5) throw new AppError("invalid_input", "Say why you need access (at least 5 characters). The client can see it.");
  return withSystem(async (db) => {
    const org = await clientOrg(db, orgId);
    await db.query("update crm_support_sessions set ended_at = now() where org_id = $1 and user_id = $2 and ended_at is null", [orgId, user.id]);
    const minutes = input.mode === "write" ? WRITE_MINUTES : READ_MINUTES;
    const { rows } = await db.query<{ id: string; started_at: Date; expires_at: Date }>(
      `insert into crm_support_sessions (org_id, user_id, mode, reason, expires_at) values ($1, $2, $3, $4, now() + make_interval(mins => $5::int))
       returning id, started_at, expires_at`,
      [orgId, user.id, input.mode, reason.slice(0, 500), minutes],
    );
    await recordAudit({ orgId, actorUserId: user.id, actorKind: "agency", action: "crm.support_session_started", targetType: "crm_support_session", targetId: rows[0].id, result: "success", metadata: { mode: input.mode, reason: reason.slice(0, 200) } }, db);
    if (input.mode === "write") {
      await notifyOrgRoles(db, orgId, ["owner", "admin"], {
        kind: "crm_support_access",
        severity: "info",
        title: "iAcquire support is making changes in your CRM",
        body: `${user.fullName || user.email}: ${reason.slice(0, 160)} (for up to ${minutes} minutes).`,
        link: "/crm/settings/access",
        dedupeKey: `crm-support:${rows[0].id}`,
      });
    }
    void org;
    return { id: rows[0].id, mode: input.mode, reason, startedAt: new Date(rows[0].started_at).toISOString(), expiresAt: new Date(rows[0].expires_at).toISOString() };
  });
}

export async function endSupportSession(user: Pick<SessionUser, "id">, orgId: string): Promise<void> {
  await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>("update crm_support_sessions set ended_at = now() where org_id = $1 and user_id = $2 and ended_at is null returning id", [orgId, user.id]);
    for (const r of rows) await recordAudit({ orgId, actorUserId: user.id, actorKind: "agency", action: "crm.support_session_ended", targetType: "crm_support_session", targetId: r.id, result: "success" }, db);
  });
}

/** An agency actor for one client, only while the person holds an active support session for it. */
export async function agencyActor(user: SessionUser, orgId: string): Promise<CrmActor> {
  if (user.platformRole === "none") throw new AppError("forbidden", "Agency access is required.");
  if (!(await agencyCanAccessClient(user, orgId))) throw new AppError("forbidden", "You are not assigned to this client.");
  return withSystem(async (db) => {
    const org = await clientOrg(db, orgId);
    const session = await activeSupportSession(user, orgId, db);
    if (!session) throw new AppError("forbidden", "Open a support session for this client first. Access is time-limited and recorded.");
    const write = session.mode === "write";
    const permissions = await agencyPermissionSet(user.id, db);
    const accessPermission = write ? "agency.crm.manage" : "agency.crm.read";
    if (!permissions.has(accessPermission)) throw new AppError("forbidden", "Your CRM support permission has changed. Start a new authorized session.");
    const allowed = user.platformRole === "agency_super_admin"
      ? (write ? AGENCY_WRITE_PERMISSIONS : AGENCY_READ_PERMISSIONS)
      : write ? AGENCY_MEMBER_WRITE_PERMISSIONS : AGENCY_READ_PERMISSIONS;
    return {
      kind: "agency",
      orgId: org.id,
      orgName: org.name,
      timezone: org.timezone,
      userId: user.id,
      agentId: null,
      apiKeyId: null,
      supportSessionId: session.id,
      supportMode: write ? "write" : "read",
      label: `${user.fullName || user.email} (iAcquire)`,
      can: (p) => allowed.has(p) && (user.platformRole === "agency_super_admin" || permissions.has(p)),
    } satisfies CrmActor;
  });
}

/** Records that an agency person looked at a part of a client's CRM. Called by agency pages; harmless for other actors. */
export async function auditSupportView(actor: CrmActor, section: string, targetId?: string) {
  if (actor.kind !== "agency") return;
  await recordAudit({ orgId: actor.orgId, actorUserId: actor.userId, actorKind: "agency", action: "crm.support_view", targetType: "crm_section", targetId: targetId ?? section, result: "success", metadata: { section, sessionId: actor.supportSessionId } });
}

export interface SupportSessionLogEntry {
  id: string;
  person: string;
  mode: "read" | "write";
  reason: string;
  startedAt: string;
  endedAt: string | null;
  expiresAt: string;
  active: boolean;
  views: number;
  changes: number;
}

/**
 * The client's own record of agency access to their CRM: who opened a support session, why, for how long, and how many pages they viewed
 * and changes they made during it. Shown to the client's owner and managers.
 */
export async function listSupportSessionsForClient(actor: CrmActor, limit = 50): Promise<SupportSessionLogEntry[]> {
  assertCan(actor, "activity.view");
  // Trusted read after the check above: agency people aren't members of the client's workspace, so the user-scoped path can't see their names.
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; person: string | null; email: string; mode: "read" | "write"; reason: string; started_at: Date; ended_at: Date | null; expires_at: Date; user_id: string; views: string; changes: string }>(
      `select s.id, nullif(u.full_name, '') as person, u.email::text as email, s.mode, s.reason, s.started_at, s.ended_at, s.expires_at, s.user_id,
              (select count(*) from audit_logs a where a.org_id = s.org_id and a.actor_user_id = s.user_id and a.action = 'crm.support_view' and a.metadata->>'sessionId' = s.id::text)::text as views,
              (select count(*) from crm_activities ca where ca.org_id = s.org_id and ca.actor_kind = 'agency' and ca.actor_user_id = s.user_id
                 and ca.occurred_at between s.started_at and coalesce(s.ended_at, least(s.expires_at, now())))::text as changes
       from crm_support_sessions s join users u on u.id = s.user_id where s.org_id = $1 order by s.started_at desc limit $2`,
      [actor.orgId, Math.min(200, limit)],
    );
    const now = Date.now();
    return rows.map((r) => ({
      id: r.id, person: r.person ?? r.email, mode: r.mode, reason: r.reason, startedAt: new Date(r.started_at).toISOString(), endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
      expiresAt: new Date(r.expires_at).toISOString(), active: !r.ended_at && new Date(r.expires_at).getTime() > now, views: Number(r.views), changes: Number(r.changes),
    }));
  });
}
