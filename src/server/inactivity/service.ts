import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyAgency, notifyOrgRoles } from "@/server/notifications";
import type { SessionUser } from "@/server/auth/service";

/** An account is reviewed after this many days of genuine inactivity. Reviewing is not deleting: nothing here ever removes anything. */
export const INACTIVITY_DAYS = 180;
/** A reminder goes out when the review opens and again this many days later, up to three notices in all. */
export const NOTICE_GAP_DAYS = 30;
export const MAX_NOTICES = 3;

export interface ActivitySignal {
  at: Date;
  source: "sign_in" | "portal_action" | "customer_message" | "website_enquiry" | "payment" | "live_website" | "review_decision" | "created";
}

const DAY = 86_400_000;

/**
 * The most recent sign of a real business running on the workspace. A person signing in or acting, a customer writing in, a website enquiry,
 * or a payment all count. So does a live, healthy website: a legitimately working production site is business activity even if the owner has
 * not logged in for months. A decision by the agency to keep the account also restarts the clock.
 */
export async function latestActivity(db: Queryable, orgId: string, now = new Date()): Promise<ActivitySignal> {
  const live = await db.query("select 1 from website_publications where org_id = $1 and status = 'live' and health <> 'unhealthy' limit 1", [orgId]);
  if (live.rows[0]) return { at: now, source: "live_website" };
  const { rows } = await db.query<Record<string, Date | null>>(
    `select
       (select max(greatest(coalesce(s.last_seen_at, 'epoch'), coalesce(u.last_login_at, 'epoch'))) from organization_memberships m join users u on u.id = m.user_id
          left join auth_sessions s on s.user_id = u.id where m.org_id = $1 and m.status = 'active') as sign_in,
       (select max(created_at) from audit_logs where org_id = $1 and actor_kind = 'user') as portal_action,
       (select max(last_inbound_at) from conversations where org_id = $1) as customer_message,
       (select max(created_at) from website_form_submissions where org_id = $1) as website_enquiry,
       (select max(paid_at) from payments where org_id = $1 and status in ('paid', 'partially_refunded')) as payment,
       (select max(closed_at) from account_activity_reviews where org_id = $1 and status in ('reactivated', 'dismissed')) as review_decision,
       (select created_at from organizations where id = $1) as created`,
    [orgId],
  );
  const r = rows[0];
  const candidates: ActivitySignal[] = [];
  for (const k of ["sign_in", "portal_action", "customer_message", "website_enquiry", "payment", "review_decision"] as const) {
    const v = r[k];
    // Anything at or before 1970 is a missing value, not a real moment.
    if (v && new Date(v).getTime() > DAY) candidates.push({ source: k, at: new Date(v) });
  }
  if (r.created) candidates.push({ source: "created", at: new Date(r.created) });
  return candidates.sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? { at: now, source: "created" };
}

const NOTICE_BODY = (days: number, n: number) =>
  `Your workspace has been quiet for ${days} days. Nothing has been deleted, and nothing will be deleted without your say-so. ${n >= 2 ? "This is a reminder. " : ""}Sign in to keep it active, take your data with you at any time, or tell us if you'd like to leave. Your live website, if you have one, counts as activity.`;

/**
 * Looks for workspaces that have gone quiet. After 180 days with no sign of activity a review opens, the owner is told in plain words, and
 * a reminder follows after 30 and 60 more days. Activity at any point closes the review as reactivated. Reviews never delete, suspend or
 * disconnect anything; leaving is a separate, explicit process that needs the client's request or an agency decision.
 */
export async function runInactivityReview(now = new Date()): Promise<{ opened: number; notified: number; reactivated: number }> {
  const out = { opened: 0, notified: 0, reactivated: 0 };
  const orgs = await withSystem((db) =>
    db.query<{ id: string; name: string }>(
      `select o.id, o.name from organizations o where o.kind = 'client' and o.status = 'active'
         and not exists (select 1 from offboarding_requests r where r.org_id = o.id and r.status in ('requested', 'shutdown', 'retention'))`,
    ),
  );
  for (const org of orgs.rows) {
    await withSystem(async (db) => {
      const signal = await latestActivity(db, org.id, now);
      const quietDays = Math.floor((now.getTime() - signal.at.getTime()) / DAY);
      const open = (await db.query<{ id: string; last_activity_at: Date; notices_sent: number; last_notice_at: Date | null }>("select id, last_activity_at, notices_sent, last_notice_at from account_activity_reviews where org_id = $1 and status = 'open' for update", [org.id])).rows[0];

      if (open) {
        // Anything since the review opened means the business is alive again.
        if (signal.at.getTime() > new Date(open.last_activity_at).getTime() + 60_000 && quietDays < INACTIVITY_DAYS) {
          await db.query("update account_activity_reviews set status = 'reactivated', closed_at = $2, closed_note = $3 where id = $1", [open.id, now.toISOString(), `Activity resumed (${signal.source.replace(/_/g, " ")}).`]);
          out.reactivated += 1;
          return;
        }
        const due = open.notices_sent < MAX_NOTICES && (!open.last_notice_at || now.getTime() - new Date(open.last_notice_at).getTime() >= NOTICE_GAP_DAYS * DAY);
        if (due) {
          const n = open.notices_sent + 1;
          await notifyOrgRoles(db, org.id, ["owner"], { kind: "account_inactivity_notice", severity: n >= 3 ? "warning" : "info", title: "Your workspace has been quiet for a while", body: NOTICE_BODY(quietDays, n), link: "/settings/data", dedupeKey: `inactivity:${open.id}:${n}` });
          await db.query("update account_activity_reviews set notices_sent = $2, last_notice_at = $3, inactive_days = $4 where id = $1", [open.id, n, now.toISOString(), quietDays]);
          out.notified += 1;
        } else {
          await db.query("update account_activity_reviews set inactive_days = $2 where id = $1", [open.id, quietDays]);
        }
        return;
      }
      if (quietDays < INACTIVITY_DAYS) return;
      const review = await db.query<{ id: string }>(
        "insert into account_activity_reviews (org_id, last_activity_at, inactive_days, notices_sent, last_notice_at) values ($1, $2, $3, 1, $4) on conflict do nothing returning id",
        [org.id, signal.at.toISOString(), quietDays, now.toISOString()],
      );
      if (!review.rows[0]) return;
      out.opened += 1;
      out.notified += 1;
      await notifyOrgRoles(db, org.id, ["owner"], { kind: "account_inactivity_notice", severity: "info", title: "Your workspace has been quiet for a while", body: NOTICE_BODY(quietDays, 1), link: "/settings/data", dedupeKey: `inactivity:${review.rows[0].id}:1` });
      await notifyAgency(db, org.id, { kind: "account_inactivity_notice", severity: "info", title: `${org.name} has been quiet for ${quietDays} days`, body: "A review is open. Nothing is deleted. Decide whether to keep the account, reach out, or help them leave.", link: `/admin/clients/${org.id}`, dedupeKey: `inactivity-agency:${review.rows[0].id}` });
      await recordAudit({ orgId: org.id, actorKind: "system", action: "inactivity.review_opened", targetType: "organization", targetId: org.id, result: "success", metadata: { quietDays, lastActivity: signal.source } }, db);
    });
  }
  return out;
}

export interface ReviewRow {
  id: string;
  orgId: string;
  orgName: string;
  status: "open" | "reactivated" | "offboarding" | "dismissed";
  inactiveDays: number;
  noticesSent: number;
  openedAt: string;
  closedAt: string | null;
  closedNote: string | null;
}

/** Open and recent reviews across the clients this person looks after. */
export async function listReviews(user: Pick<SessionUser, "id" | "platformRole">): Promise<ReviewRow[]> {
  if (user.platformRole === "none") throw new AppError("forbidden", "Only agency staff can view account reviews.");
  const { rows } = await withSystem((db) =>
    db.query<{ id: string; org_id: string; name: string; status: ReviewRow["status"]; inactive_days: number; notices_sent: number; opened_at: Date; closed_at: Date | null; closed_note: string | null }>(
      `select r.id, r.org_id, o.name, r.status, r.inactive_days, r.notices_sent, r.opened_at, r.closed_at, r.closed_note from account_activity_reviews r join organizations o on o.id = r.org_id
       where app.user_can_access_org($1,o.id) and (r.status = 'open' or r.closed_at > now() - interval '90 days') order by (r.status = 'open') desc, r.opened_at desc limit 100`,
      [user.id],
    ),
  );
  return rows.map((r) => ({ id: r.id, orgId: r.org_id, orgName: r.name, status: r.status, inactiveDays: r.inactive_days, noticesSent: r.notices_sent, openedAt: new Date(r.opened_at).toISOString(), closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null, closedNote: r.closed_note }));
}

/** The agency decides to keep the account as it is. The clock restarts from today; nothing changes for the client. */
export async function dismissReview(user: Pick<SessionUser, "id" | "platformRole">, reviewId: string, note: string): Promise<void> {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only super admins can close an account review.");
  const why = note.trim();
  if (why.length < 3 || why.length > 300) throw new AppError("invalid_input", "Say why, in 3 to 300 characters.");
  await withSystem(async (db) => {
    const res = await db.query<{ org_id: string }>("update account_activity_reviews set status = 'dismissed', closed_at = now(), closed_by = $2, closed_note = $3 where id = $1 and status = 'open' returning org_id", [reviewId, user.id, why]);
    if (!res.rows[0]) throw new AppError("not_found", "That review isn't open.");
    await recordAudit({ orgId: res.rows[0].org_id, actorUserId: user.id, actorKind: "agency", action: "inactivity.review_dismissed", targetType: "account_review", targetId: reviewId, result: "success", metadata: { note: why } }, db);
  });
}
