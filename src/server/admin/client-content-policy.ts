import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyAgency } from "@/server/notifications";
import type { SessionUser } from "@/server/auth/service";

// Founder decision D70 (docs/roadmap/phases-3-to-7/decisions.md): should assigned agency staff need an audited support session to read a client's approvals, activity log, shared
// knowledge and leads, as they already do for CRM, inbox, calls and analytics? The founder has NOT decided. This is the switch that makes the stricter rule available. It is OFF, and
// while it is off nothing about what anyone can read changes. Turning it on is a Super Admin's act with a written reason, and is in the audit log with who and when. The rule itself
// lives in the database (app.has_permission and app.permitted_orgs, migration 0112), so it covers every reader, not only the screens that remember to ask.

export const CLIENT_CONTENT_PERMISSIONS = ["approvals.view", "activity.view", "knowledge.view", "leads.view"] as const;

export interface ClientContentPolicy {
  /** On: agency staff need an active support session on the client to read its approvals, activity, knowledge and leads. Off (the default): they read them as assigned. */
  sessionRequired: boolean;
  changedAt: string | null;
  changedByName: string | null;
  note: string | null;
}

export async function getClientContentPolicy(): Promise<ClientContentPolicy> {
  return withSystem(async (db) => {
    const r = (await db.query<{ enabled: boolean; changed_at: Date | null; full_name: string | null; note: string | null }>(
      `select s.enabled, s.changed_at, u.full_name, s.note from agency_policy_switches s left join users u on u.id = s.changed_by where s.key = 'client_content_needs_support_session'`,
    )).rows[0];
    return { sessionRequired: r?.enabled === true, changedAt: r?.changed_at ? new Date(r.changed_at).toISOString() : null, changedByName: r?.full_name ?? null, note: r?.note ?? null };
  });
}

/** Whether one agency person may read this client's content right now, and why not when they may not. */
export interface ClientContentAccess {
  /** The stricter rule is switched on. */
  sessionRequired: boolean;
  /** The person has an active read or write support session on this client. */
  hasSession: boolean;
  /** Whether content may be shown. Always true while the rule is off, which is the default. */
  permitted: boolean;
}

/**
 * The same question the database answers for row-level security (app.has_permission with the switch on), asked by a reader that does not go through it:
 * the admin screens read with trusted server access, so they must ask themselves. One query, no cached state, so a session that has just ended stops working
 * immediately. `db` is the caller's connection so this joins the read it belongs to.
 */
export async function clientContentAccess(db: { query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> }, userId: string, orgId: string): Promise<ClientContentAccess> {
  const row = (await db.query<{ required: boolean; has_session: boolean }>(
    `select coalesce((select enabled from agency_policy_switches where key = 'client_content_needs_support_session'), false) as required,
            exists (select 1 from crm_support_sessions s where s.org_id = $2 and s.user_id = $1 and s.ended_at is null and s.expires_at > now()) as has_session`,
    [userId, orgId],
  )).rows[0];
  const sessionRequired = row?.required === true;
  const hasSession = row?.has_session === true;
  return { sessionRequired, hasSession, permitted: !sessionRequired || hasSession };
}

/** What a screen or tool shows in place of a client's content it may not read right now. */
export const CONTENT_WITHHELD_NOTICE = "Hidden until you open a support session on this client.";

/** For a reader that spans clients (the AQi Operations tools): whether the stricter rule is on, and the clients this person holds an active support session on. */
export interface ContentSessionScope {
  sessionRequired: boolean;
  /** Whether this person may read this client's content right now. Always true while the rule is off, which is the default. */
  permits: (orgId: string) => boolean;
}

export async function contentSessionScope(db: { query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> }, userId: string): Promise<ContentSessionScope> {
  const row = (await db.query<{ required: boolean; orgs: string[] | null }>(
    `select coalesce((select enabled from agency_policy_switches where key = 'client_content_needs_support_session'), false) as required,
            (select array_agg(distinct s.org_id::text) from crm_support_sessions s where s.user_id = $1 and s.ended_at is null and s.expires_at > now()) as orgs`,
    [userId],
  )).rows[0];
  const sessionRequired = row?.required === true;
  const held = new Set(row?.orgs ?? []);
  return { sessionRequired, permits: (orgId) => !sessionRequired || held.has(orgId) };
}

/**
 * A Super Admin turns the stricter rule on or off, saying why. Changing it to what it already is changes nothing and writes nothing. The staff are told, so nobody learns of the change by
 * being refused.
 */
export async function setClientContentPolicy(user: Pick<SessionUser, "id" | "platformRole">, input: { sessionRequired: boolean; note: string }): Promise<ClientContentPolicy> {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only a Super Admin can change who may read a client's approvals, activity, knowledge and leads.");
  const note = (input.note ?? "").trim();
  if (note.length < 10) throw new AppError("invalid_input", "Say why you are changing this (at least 10 characters). It is kept in the audit log.");
  if (typeof input.sessionRequired !== "boolean") throw new AppError("invalid_input", "Choose on or off.");
  await withSystem(async (db) => {
    const me = (await db.query<{ ok: boolean }>("select (status = 'active' and platform_role = 'agency_super_admin') as ok from users where id = $1", [user.id])).rows[0];
    if (!me?.ok) throw new AppError("forbidden", "Only a Super Admin can change this; authorization has changed.");
    // No row means off. The first change makes the row; later ones update it.
    const was = { enabled: (await db.query<{ enabled: boolean }>("select enabled from agency_policy_switches where key = 'client_content_needs_support_session' for update")).rows[0]?.enabled ?? false };
    if (was.enabled === input.sessionRequired) return;
    await db.query(
      `insert into agency_policy_switches (key, enabled, changed_by, changed_at, note) values ('client_content_needs_support_session', $1, $2, now(), $3)
       on conflict (key) do update set enabled = excluded.enabled, changed_by = excluded.changed_by, changed_at = excluded.changed_at, note = excluded.note`,
      [input.sessionRequired, user.id, note.slice(0, 400)],
    );
    const agency = (await db.query<{ id: string }>("select id from organizations where kind = 'agency' limit 1")).rows[0]?.id ?? null;
    await recordAudit({
      orgId: agency, actorUserId: user.id, actorKind: "agency", action: input.sessionRequired ? "agency_policy.client_content_session_required" : "agency_policy.client_content_session_not_required",
      targetType: "agency_policy_switch", result: "success", metadata: { from: was.enabled, to: input.sessionRequired, note: note.slice(0, 200), permissions: [...CLIENT_CONTENT_PERMISSIONS] },
    }, db);
    await notifyAgency(db, null, {
      kind: "system", severity: "info",
      title: input.sessionRequired ? "Client approvals, activity, knowledge and leads now need a support session" : "Client approvals, activity, knowledge and leads no longer need a support session",
      body: input.sessionRequired
        ? "Open a support session on the client (with a reason) to read them. CRM, inbox, calls and analytics already worked this way."
        : "Assigned staff read them as before. CRM, inbox, calls and analytics still need a support session.",
      link: "/admin/team", dedupeKey: `agency-policy:client-content:${input.sessionRequired}:${new Date().toISOString().slice(0, 13)}`,
    });
  });
  return getClientContentPolicy();
}
