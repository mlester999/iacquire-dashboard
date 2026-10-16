import "server-only";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { env } from "@/server/env";
import type { OrgRole } from "@/lib/permissions";
import { NOTIFICATION_GROUPS } from "@/lib/notification-groups";

export type NotificationKind =
  | "agent_task_completed"
  | "lead_awaiting_approval"
  | "booking_confirmed"
  | "workflow_failure"
  | "knowledge_update_ready"
  | "support_reply"
  | "support_ticket_created"
  | "integration_disconnected"
  | "usage_limit_approaching"
  | "approval_requested"
  | "approval_decided"
  | "agent_status"
  | "system"
  | "setup_milestone"
  | "setup_action_required"
  | "setup_issue"
  | "setup_ready"
  | "project_submitted"
  | "project_update"
  | "project_quote"
  | "project_decision"
  | "project_message"
  | "maintenance_update"
  | "billing_payment_received"
  | "billing_payment_failed"
  | "billing_low_balance"
  | "billing_credits_exhausted"
  | "billing_budget_warning"
  | "billing_reconciliation"
  | "escalation_action_required"
  | "escalation_fyi"
  | "escalation_claimed"
  | "escalation_unclaimed"
  | "message_blocked"
  | "message_failed"
  | "website_published"
  | "website_publish_failed"
  | "domain_verified"
  | "domain_renewal_due"
  | "domain_issue"
  | "incident_opened"
  | "incident_recovered"
  | "integration_reconnect_required"
  | "account_inactivity_notice"
  | "booking_cancelled"
  | "booking_rescheduled"
  | "booking_conflict"
  | "booking_needs_action"
  | "retention_attention"
  | "fair_use_notice"
  | "offboarding_update"
  | "crm_import_finished"
  | "crm_assigned"
  | "crm_support_access"
  | "crm_task_due";

export interface NotificationInput {
  kind: NotificationKind;
  severity?: "info" | "success" | "warning" | "critical";
  title: string;
  body?: string;
  /** Internal path only, e.g. "/approvals". */
  link?: string;
  /** Repeats with the same key for the same person are dropped, so an alert is sent once per condition. */
  dedupeKey?: string;
}

function safeLink(link?: string) {
  return link && /^\/[A-Za-z0-9/_?=&%.-]*$/.test(link) ? link : null;
}

export async function notifyUser(db: Queryable, userId: string, orgId: string | null, n: NotificationInput) {
  await db.query(
    `insert into notifications (org_id, user_id, kind, severity, title, body, link, dedupe_key) values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing`,
    [orgId, userId, n.kind, n.severity ?? "info", n.title.slice(0, 200), n.body?.slice(0, 1000) ?? null, safeLink(n.link), n.dedupeKey ?? null],
  );
}

export async function notifyOrgRoles(db: Queryable, orgId: string, roles: OrgRole[], n: NotificationInput) {
  await db.query(
    `insert into notifications (org_id, user_id, kind, severity, title, body, link, dedupe_key)
     select $1, m.user_id, $3, $4, $5, $6, $7, $8 from organization_memberships m
     where m.org_id = $1 and m.status = 'active' and m.role = any($2::text[])
     on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing`,
    [orgId, roles, n.kind, n.severity ?? "info", n.title.slice(0, 200), n.body?.slice(0, 1000) ?? null, safeLink(n.link), n.dedupeKey ?? null],
  );
}

/** Notifies agency staff assigned to the tenant plus all super admins. */
export async function notifyAgency(db: Queryable, orgId: string | null, n: NotificationInput) {
  await db.query(
    `insert into notifications (org_id, user_id, kind, severity, title, body, link, dedupe_key)
     select null, u.id, $2, $3, $4, $5, $6, $7 from users u
     where u.status = 'active' and (u.platform_role = 'agency_super_admin'
       or (u.platform_role = 'agency_staff' and $1::uuid is not null
           and exists (select 1 from staff_assignments s where s.user_id = u.id and s.org_id = $1::uuid)))
     on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing`,
    [orgId, n.kind, n.severity ?? "info", n.title.slice(0, 200), n.body?.slice(0, 1000) ?? null, safeLink(n.link), n.dedupeKey ?? null],
  );
}

/**
 * Optional external alert for agency staff. Returns the real delivery outcome; the in-app
 * inbox remains the source of truth whether or not Slack is configured.
 */
export async function sendAgencySlackAlert(text: string): Promise<"not_configured" | "sent" | "failed"> {
  const url = env().SLACK_SUPPORT_WEBHOOK_URL;
  if (!url) return "not_configured";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.slice(0, 2000) }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

/** Notification kinds hidden by the user's preferences. Critical items are never hidden. */
export async function hiddenKinds(userId: string, orgId: string | null): Promise<string[]> {
  if (!orgId) return [];
  const { rows } = await withUser(userId, (db) =>
    db.query<{ prefs: Record<string, boolean> }>("select prefs from notification_preferences where user_id = $1 and org_id = $2", [userId, orgId]),
  );
  const prefs = rows[0]?.prefs ?? {};
  return NOTIFICATION_GROUPS.flatMap((g) => (prefs[g.key] === false ? [...g.kinds] : []));
}

export async function listNotifications(userId: string, limit = 30, hidden: string[] = []) {
  return withUser(userId, async (db) => {
    const { rows } = await db.query<{
      id: string;
      kind: NotificationKind;
      severity: string;
      title: string;
      body: string | null;
      link: string | null;
      read_at: Date | null;
      created_at: Date;
    }>(
      `select id, kind, severity, title, body, link, read_at, created_at from notifications
       where (kind <> all($2::text[]) or severity = 'critical') order by created_at desc limit $1`,
      [limit, hidden],
    );
    const unread = await db.query<{ count: string }>(
      "select count(*)::text as count from notifications where read_at is null and (kind <> all($1::text[]) or severity = 'critical')",
      [hidden],
    );
    return { items: rows, unread: Number(unread.rows[0]?.count ?? 0) };
  });
}

export async function markNotificationsRead(userId: string, ids: string[] | "all") {
  await withUser(userId, async (db) => {
    if (ids === "all") await db.query("update notifications set read_at = now() where read_at is null");
    else if (ids.length) await db.query("update notifications set read_at = now() where id = any($1::uuid[]) and read_at is null", [ids]);
  });
}

export async function unreadCount(userId: string): Promise<number> {
  const { rows } = await withSystem((db) =>
    db.query<{ count: string }>("select count(*)::text as count from notifications where user_id = $1 and read_at is null", [userId]),
  );
  return Number(rows[0]?.count ?? 0);
}
