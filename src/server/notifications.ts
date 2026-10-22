import "server-only";
import { withUser, type Queryable } from "@/server/db";
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
  | "conversation_assigned"
  | "conversation_new_inquiry"
  | "conversation_awaiting_reply"
  | "missed_call_follow_up"
  | "hot_lead_detected"
  | "web_chat_lead"
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
  | "crm_task_due"
  | "crm_booking_new"
  | "crm_calendar_sync"
  | "crm_workflow_failed"
  | "crm_webhook_failing"
  | "crm_blueprint_applied"
  | "support_assigned"
  | "support_status"
  | "support_escalated"
  | "support_sla";

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

/**
 * A direct notification is addressed to one person. Agency recipients of a client-scoped
 * notification are recorded as agency mail so a later loss of that client's access hides it.
 * Returns the notification id, or null when a dedupe key already announced the same thing.
 */
export async function notifyUser(db: Queryable, userId: string, orgId: string | null, n: NotificationInput): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `insert into notifications (audience, org_id, user_id, kind, severity, title, body, link, dedupe_key)
     select case
              when u.platform_role in ('agency_staff','agency_manager','agency_super_admin') and $2::uuid is not null then 'agency'
              when u.platform_role in ('agency_staff','agency_manager','agency_super_admin') then 'direct'
              when $2::uuid is null then 'direct'
              else 'client'
            end,
            $2, u.id, $3, $4, $5, $6, $7, $8
       from users u where u.id = $1
     on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing
     returning id`,
    [userId, orgId, n.kind, n.severity ?? "info", n.title.slice(0, 200), n.body?.slice(0, 1000) ?? null, safeLink(n.link), n.dedupeKey ?? null],
  );
  return rows[0]?.id ?? null;
}

export async function notifyOrgRoles(db: Queryable, orgId: string, roles: OrgRole[], n: NotificationInput) {
  await db.query(
    `insert into notifications (audience, org_id, user_id, kind, severity, title, body, link, dedupe_key)
     select 'client', $1, m.user_id, $3, $4, $5, $6, $7, $8 from organization_memberships m
     where m.org_id = $1 and m.status = 'active' and m.role = any($2::text[])
     on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing`,
    [orgId, roles, n.kind, n.severity ?? "info", n.title.slice(0, 200), n.body?.slice(0, 1000) ?? null, safeLink(n.link), n.dedupeKey ?? null],
  );
}

/**
 * Notifies agency users whose current client scope includes the tenant. The client organisation is
 * stored on the row even though the recipient is an agency user; read authorisation is re-evaluated
 * against the recipient's current scope, so revoking the assignment hides the history too.
 */
export async function notifyAgency(db: Queryable, orgId: string | null, n: NotificationInput) {
  await db.query(
    `insert into notifications (audience, org_id, user_id, kind, severity, title, body, link, dedupe_key)
     select 'agency', $1, u.id, $2, $3, $4, $5, $6, $7 from users u
     where u.status = 'active' and u.platform_role in ('agency_staff','agency_manager','agency_super_admin') and (
       ($1::uuid is null and coalesce(app.user_has_agency_permission(u.id,'agency.security.manage'),false))
       or ($1::uuid is not null and app.user_can_access_org(u.id,$1::uuid))
     )
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

export interface ListNotificationsOptions {
  limit?: number;
  /** Keyset cursor: only notifications strictly older than this instant (and id, for equal instants). */
  before?: string | null;
  beforeId?: string | null;
  hidden?: string[];
  /**
   * Client workspace scope. When set, notifications addressed to another workspace are excluded
   * (unscoped, account-level notifications remain visible). Agency feeds leave this unset because
   * their job is to see the clients in their assigned scope.
   */
  orgId?: string | null;
}

/**
 * The feed mode follows the authenticated account, not the route that happens to call it. An agency
 * account can hold client memberships from an earlier role; those must not turn its agency inbox into
 * a client feed. A client account is always client-scoped even while its active workspace is switching.
 */
async function notificationFeedScope(db: Queryable, userId: string, requestedOrgId: string | null) {
  const { rows } = await db.query<{ platform_role: string | null }>(
    "select platform_role from users where id = $1 and status = 'active'",
    [userId],
  );
  const role = rows[0]?.platform_role;
  const agency = Boolean(role && role !== "none");
  return { agency, orgId: agency ? null : requestedOrgId };
}

export async function listNotifications(userId: string, options: ListNotificationsOptions = {}) {
  // RLS on notifications already limits every row to the signed-in user and its current tenant scope;
  // the explicit predicates are a second boundary so a policy regression cannot become a data leak.
  const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 30)));
  const hidden = options.hidden ?? [];
  const before = options.before && !Number.isNaN(Date.parse(options.before)) ? new Date(options.before).toISOString() : null;
  const beforeId = options.beforeId && /^[0-9a-f-]{36}$/i.test(options.beforeId) ? options.beforeId : null;
  const requestedOrgId = options.orgId && /^[0-9a-f-]{36}$/i.test(options.orgId) ? options.orgId : null;
  return withUser(userId, async (db) => {
    const { agency, orgId } = await notificationFeedScope(db, userId, requestedOrgId);
    const feed = `(($7::boolean and audience in ('agency','direct') and app.notification_visible($4, audience, org_id))
      or (not $7::boolean and audience in ('client','direct')
          and ($6::uuid is null or org_id = $6::uuid or org_id is null)
          and app.notification_visible($4, audience, org_id)))`;
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
       where user_id = $4
         and (kind <> all($2::text[]) or severity = 'critical')
         and ${feed}
         and ($3::timestamptz is null or created_at < $3::timestamptz or (created_at = $3::timestamptz and id < $5::uuid))
       order by created_at desc, id desc
       limit $1`,
      [limit + 1, hidden, before, userId, beforeId, orgId, agency],
    );
    const unreadFeed = `(($4::boolean and audience in ('agency','direct') and app.notification_visible($2, audience, org_id))
      or (not $4::boolean and audience in ('client','direct')
          and ($3::uuid is null or org_id = $3::uuid or org_id is null)
          and app.notification_visible($2, audience, org_id)))`;
    const unread = await db.query<{ count: string }>(
      `select count(*)::text as count from notifications
       where user_id = $2 and read_at is null and (kind <> all($1::text[]) or severity = 'critical')
         and ${unreadFeed}`,
      [hidden, userId, orgId, agency],
    );
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return {
      items,
      unread: Number(unread.rows[0]?.count ?? 0),
      hasMore,
      nextBefore: hasMore && last ? new Date(last.created_at).toISOString() : null,
      nextBeforeId: hasMore && last ? last.id : null,
    };
  });
}

export async function markNotificationsRead(userId: string, ids: string[] | "all", opts: { orgId?: string | null } = {}) {
  const requestedOrgId = opts.orgId && /^[0-9a-f-]{36}$/i.test(opts.orgId) ? opts.orgId : null;
  await withUser(userId, async (db) => {
    const { agency, orgId } = await notificationFeedScope(db, userId, requestedOrgId);
    // RLS and this predicate use the same authorization function. A hidden row therefore cannot be
    // marked read through a guessed id, and "mark all" cannot clear another workspace's badge.
    if (agency) {
      if (ids === "all") {
        await db.query(
          `update notifications set read_at = now() where user_id = $1 and read_at is null
             and audience in ('agency','direct') and app.notification_visible($1, audience, org_id)`,
          [userId],
        );
      } else if (ids.length) {
        await db.query(
          `update notifications set read_at = now() where user_id = $1 and id = any($2::uuid[]) and read_at is null
             and audience in ('agency','direct') and app.notification_visible($1, audience, org_id)`,
          [userId, ids],
        );
      }
    } else if (ids === "all") {
      await db.query(
        `update notifications set read_at = now() where user_id = $1 and read_at is null
           and audience in ('client','direct') and ($2::uuid is null or org_id = $2::uuid or org_id is null)
           and app.notification_visible($1, audience, org_id)`,
        [userId, orgId],
      );
    } else if (ids.length) {
      await db.query(
        `update notifications set read_at = now() where user_id = $1 and id = any($3::uuid[]) and read_at is null
           and audience in ('client','direct') and ($2::uuid is null or org_id = $2::uuid or org_id is null)
           and app.notification_visible($1, audience, org_id)`,
        [userId, orgId, ids],
      );
    }
  });
}

export async function unreadCount(userId: string): Promise<number> {
  return withUser(userId, async (db) => {
    const { agency, orgId } = await notificationFeedScope(db, userId, null);
    const scope = agency
      ? `audience in ('agency','direct') and app.notification_visible($1, audience, org_id)`
      : `audience in ('client','direct') and ($2::uuid is null or org_id = $2::uuid or org_id is null)
         and app.notification_visible($1, audience, org_id)`;
    const params = agency ? [userId] : [userId, orgId];
    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from notifications where user_id = $1 and read_at is null and ${scope}`,
      params,
    );
    return Number(rows[0]?.count ?? 0);
  });
}
