import "server-only";
import { withSystem } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles, notifyUser } from "@/server/notifications";

// Two scheduler jobs, both internal: they tell the TEAM something and never write to a customer. Like every job they run only when the scheduler does and, in a staged start,
// only when named in SCHEDULER_JOBS_ONLY (src/server/ops/tick.ts). Each is gated again per workspace by its own setting (reputation_settings), and each is safe to run twice.

/**
 * Low feedback older than this is left alone by the reminder: it predates the reminder (or the team has plainly moved on), and the first run in a workspace must not
 * announce months of old items at once.
 */
export const SLA_LOOKBACK_DAYS = 14;
export const SLA_BATCH = 100;

/**
 * Reminds the team ONCE about low private feedback that nobody has acknowledged within the workspace's time (24 hours unless it chose otherwise). The owner and managers
 * are told, and so is the person the follow-up task is assigned to. Feedback counts as acknowledged when someone marked it acknowledged or resolved, when its task was
 * finished, or when a person took its inbox escalation. Returns how many items were announced.
 *
 * Each item is claimed with a row lock and marked in the same transaction as its notices, so two overlapping ticks cannot both announce it; a workspace that switched the
 * reminder off, or is not active, is skipped.
 */
export async function runFeedbackSla(opts: { now?: Date; limit?: number } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; org_id: string; contact_name: string | null; received_at: Date; hours: number; assignee: string | null }>(
      `select f.id, f.org_id, c.display_name as contact_name, f.received_at, coalesce(s.acknowledge_within_hours, 24) as hours, t.assigned_user_id as assignee
       from customer_feedback f
       join organizations o on o.id = f.org_id and o.status = 'active'
       left join reputation_settings s on s.org_id = f.org_id
       left join contacts c on c.id = f.contact_id and c.org_id = f.org_id and c.deleted_at is null
       left join human_escalations e on e.id = f.escalation_id and e.org_id = f.org_id
       left join tasks t on t.id = f.escalated_task_id and t.org_id = f.org_id
       where f.low_score and f.sla_notified_at is null and f.acknowledged_at is null and f.follow_up_status in ('new', 'escalated')
         and coalesce(s.sla_reminders_enabled, true)
         and f.received_at <= $1::timestamptz - make_interval(hours => coalesce(s.acknowledge_within_hours, 24))
         and f.received_at > $1::timestamptz - make_interval(days => $2::int)
         and (e.id is null or e.status not in ('claimed', 'resolved'))
       order by f.received_at limit $3 for update of f skip locked`,
      [now.toISOString(), SLA_LOOKBACK_DAYS, Math.min(SLA_BATCH, opts.limit ?? SLA_BATCH)],
    );
    for (const f of rows) {
      await db.query("update customer_feedback set sla_notified_at = $3 where id = $1 and org_id = $2", [f.id, f.org_id, now.toISOString()]);
      const waited = Math.max(f.hours, Math.floor((now.getTime() - new Date(f.received_at).getTime()) / 3_600_000));
      const note = {
        kind: "feedback_follow_up_overdue" as const, severity: "warning" as const, title: "Low feedback is waiting for a follow-up",
        // The customer's words are not repeated here: this can be emailed. The name and the wait are enough to find it.
        body: `${f.contact_name || "A customer"} gave low private feedback about ${waited} hours ago and nobody has acknowledged it yet.`,
        link: "/crm/reviews?tab=feedback", dedupeKey: `feedback-sla:${f.id}`,
      };
      await notifyOrgRoles(db, f.org_id, ["owner", "admin"], note);
      if (f.assignee) await notifyUser(db, f.assignee, f.org_id, note);
      await recordAudit({ orgId: f.org_id, actorKind: "system", action: "reputation.sla_reminder_sent", targetType: "customer_feedback", targetId: f.id, result: "success", metadata: { hours: f.hours } }, db);
    }
    return rows.length;
  });
}

/** An appointment is ignored until it ended this long ago, and after it ended more than this many days ago. */
export const OUTCOME_GRACE_HOURS = 2;
export const OUTCOME_LOOKBACK_DAYS = 14;

/**
 * Once a day, tells the owner and managers of each workspace that switched it on how many finished appointments have no recorded outcome. Only a person can mark an
 * appointment attended (or a no-show), and every follow-up that starts from "attended" depends on that, so a missing outcome means a missing follow-up. This job counts
 * and announces; it NEVER marks anything attended, because that would invent an outcome. Returns how many workspaces had such appointments (a second run on the same
 * day tells nobody twice: the notice is keyed per workspace and day).
 */
export async function runOutcomeNudge(opts: { now?: Date } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const day = now.toISOString().slice(0, 10);
  return withSystem(async (db) => {
    const { rows } = await db.query<{ org_id: string; pending: string }>(
      `select a.org_id, count(*)::text as pending
       from appointment_refs a join reputation_settings s on s.org_id = a.org_id and s.outcome_nudges_enabled
       join organizations o on o.id = a.org_id and o.status = 'active'
       where a.status in ('new', 'confirmed') and a.end_at <= $1::timestamptz - make_interval(hours => $2::int) and a.end_at > $1::timestamptz - make_interval(days => $3::int)
       group by a.org_id`,
      [now.toISOString(), OUTCOME_GRACE_HOURS, OUTCOME_LOOKBACK_DAYS],
    );
    for (const w of rows) {
      const n = Number(w.pending);
      await notifyOrgRoles(db, w.org_id, ["owner", "admin"], {
        kind: "booking_needs_action", severity: "info", title: `Record how ${n} appointment${n === 1 ? "" : "s"} went`,
        body: "Appointments that have ended stay open until someone marks them attended or a no-show. Follow-ups after a visit only start once you do.",
        link: "/appointments", dedupeKey: `outcome-nudge:${w.org_id}:${day}`,
      });
    }
    return rows.length;
  });
}
