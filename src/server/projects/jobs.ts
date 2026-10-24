import "server-only";
import { withSystem } from "@/server/db";
import { notifyAgency, notifyUser } from "@/server/notifications";

// Scheduled work for custom projects. Registered in src/server/ops/tick.ts, so it shares the scheduler's lease, heartbeats and failure handling.

/** The job gives up after this long and leaves the rest for the next run (the tick as a whole is cut off at 120 seconds, and the jobs after it wait). */
export const PROJECT_REVIEW_OVERDUE_BUDGET_MS = 20_000;
/** At most this many tasks of one workspace per run, so one busy workspace never starves another. */
const PER_WORKSPACE = 10;
const BATCH = 100;

const WHAT: Record<string, string> = {
  initial_review: "the first review",
  respond_to_client: "a reply to the client",
  prepare_quote: "the quote",
  review_decision: "confirming the accepted quote",
  review_change: "the first look at a change request",
};

interface Overdue {
  id: string;
  request_id: string;
  org_id: string;
  kind: string;
  due_at: Date;
  ref: string;
  assigned_to: string | null;
  org_name: string;
}

/**
 * Tells the team once about a review task that went past its time. The person the project is assigned to is told when they still work on that client and may see projects;
 * otherwise the team members who manage that client's projects are. A task is announced once however long it stays open (it is marked, and the notice carries the task and
 * its due time as its key), and the notice names the project and the client but repeats nothing a client wrote. It changes no task and contacts no client.
 * Returns how many tasks were announced.
 */
export async function runProjectReviewOverdue(opts: { budgetMs?: number; now?: Date } = {}): Promise<number> {
  const started = Date.now();
  const budget = opts.budgetMs ?? PROJECT_REVIEW_OVERDUE_BUDGET_MS;
  let announced = 0;
  for (let pass = 0; pass < 20 && Date.now() - started < budget; pass += 1) {
    const due = await withSystem(async (db) =>
      (await db.query<Overdue>(
        `select x.id, x.request_id, x.org_id, x.kind, x.due_at, x.ref, x.assigned_to, x.org_name from (
           select t.id, t.request_id, t.org_id, t.kind, t.due_at, r.ref, r.assigned_to, o.name as org_name,
                  row_number() over (partition by t.org_id order by t.due_at, t.id) as rn
           from project_review_tasks t
           join client_project_requests r on r.id = t.request_id and r.org_id = t.org_id
           join organizations o on o.id = t.org_id
           where t.status = 'open' and t.due_at is not null and t.due_at < $1 and t.overdue_notified_at is null
             and r.status not in ('cancelled', 'completed') and o.status not in ('suspended', 'archived')
         ) x where x.rn <= $2 order by x.rn, x.due_at limit $3`,
        [opts.now ?? new Date(), PER_WORKSPACE, BATCH],
      )).rows,
    );
    if (!due.length) break;
    for (const task of due) {
      if (Date.now() - started >= budget) return announced;
      try {
        const did = await withSystem(async (db) => {
          // Re-read under the task's own lock: someone may have finished it a moment ago, or another run may have announced it.
          const t = (await db.query<{ id: string }>("select id from project_review_tasks where id = $1 and status = 'open' and overdue_notified_at is null for update", [task.id])).rows[0];
          if (!t) return false;
          const notice = {
            kind: "project_review_overdue" as const,
            severity: "warning" as const,
            title: `${task.ref}: ${WHAT[task.kind] ?? "a review"} is overdue`,
            body: task.org_name,
            link: `/admin/projects/${task.request_id}`,
            dedupeKey: `project:${task.request_id}:review-overdue:${task.id}:${new Date(task.due_at).getTime()}`,
          };
          const owner = task.assigned_to
            ? (await db.query<{ ok: boolean }>(
                `select (u.status = 'active' and app.user_can_access_org(u.id, $2) and coalesce(app.user_has_agency_permission(u.id, 'projects.view'), false)) as ok from users u where u.id = $1`,
                [task.assigned_to, task.org_id],
              )).rows[0]?.ok === true
            : false;
          if (owner && task.assigned_to) await notifyUser(db, task.assigned_to, task.org_id, notice);
          else await notifyAgency(db, task.org_id, notice, { permission: "projects.manage" });
          await db.query("update project_review_tasks set overdue_notified_at = now() where id = $1", [task.id]);
          return true;
        });
        if (did) announced += 1;
      } catch {
        // One task that cannot be announced is left for the next run; the rest still are.
      }
    }
  }
  return announced;
}
