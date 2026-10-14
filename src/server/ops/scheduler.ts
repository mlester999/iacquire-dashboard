import "server-only";
import { withSystem } from "@/server/db";
import { env } from "@/server/env";
import { recordUnhealthy } from "@/server/ops/incidents";

export interface SchedulerFreshness {
  state: "never_ran" | "fresh" | "stale";
  lastFinishedAt: string | null;
  minutesSince: number | null;
  thresholdMinutes: number;
}

/** Whether the scheduler's last completed run is recent enough. "Never ran" is reported as itself, not as healthy or failed. */
export async function schedulerFreshness(now = new Date()): Promise<SchedulerFreshness> {
  const threshold = env().SCHEDULER_STALE_MINUTES;
  const { rows } = await withSystem((db) => db.query<{ last: Date | null }>("select last_finished_at as last from worker_job_runs where job_name = 'tick'"));
  const last = rows[0]?.last ? new Date(rows[0].last) : null;
  if (!last) return { state: "never_ran", lastFinishedAt: null, minutesSince: null, thresholdMinutes: threshold };
  const minutes = Math.floor((now.getTime() - last.getTime()) / 60_000);
  return { state: minutes > threshold ? "stale" : "fresh", lastFinishedAt: last.toISOString(), minutesSince: minutes, thresholdMinutes: threshold };
}

/**
 * Called from outside the scheduler (the public liveness probe and agency pages), because the scheduler cannot report its own death.
 * It only ever opens or refreshes an incident; the scheduler's own next run closes it, which is the proof it recovered.
 */
export async function observeSchedulerFreshness(now = new Date()): Promise<SchedulerFreshness> {
  const f = await schedulerFreshness(now);
  if (f.state === "stale") {
    await withSystem((db) =>
      recordUnhealthy(db, {
        key: "scheduler:stale", source: "scheduler", orgId: null, subject: "tick", severity: "critical",
        title: "Scheduled jobs have stopped running",
        detail: `The scheduler last completed a run ${f.minutesSince} minutes ago (it should run at least every ${f.thresholdMinutes}).`,
        evidence: { lastFinishedAt: f.lastFinishedAt, minutesSince: f.minutesSince },
        safeActions: ["Replies are not sent, follow-ups are not prepared and credit reservations are not released while the scheduler is stopped."],
        guidance: "Check the scheduler that calls /api/internal/tick (Supabase cron, hosting cron or n8n) and that CRON_SECRET still matches.",
      }),
    );
  }
  return f;
}
