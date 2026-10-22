import "server-only";
import { runReadOnlyReviewJob, reviewFinding, type ReviewCheck } from "@/server/workforce/read-only-review";
import type { WorkJobRow } from "@/server/workforce/jobs";

// The Appointment Setter's read-only look at missed-call recovery. It reads persisted cases and the policy and reports what a person should act on.
// It changes nothing, contacts nobody and never claims a call-back happened: whatever it says comes from rows the recovery engine wrote.

const samples = (value: unknown) => (Array.isArray(value) ? (value as string[]).filter((item) => typeof item === "string").slice(0, 5) : []);
const OPEN = "('detected', 'awaiting_eligibility', 'eligible', 'suppressed', 'scheduled', 'in_progress', 'awaiting_response')";
const who = "coalesce(nullif(k.display_name, ''), 'A caller without a name')";

const waitingOnTeam: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce((array_agg(${who} order by c.first_called_at asc))[1:5], '{}') as samples
       from missed_call_cases c left join contacts k on k.id = c.contact_id and k.org_id = c.org_id
      where c.org_id = $1 and c.state in ${OPEN} and c.first_called_at < now() - interval '1 hour' and c.owner_kind = 'unassigned'`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "missed_calls_without_owner",
    severity: "warning",
    title: `${count} missed call${count === 1 ? " has" : "s have"} had no owner for over an hour`,
    detail: "Nobody is responsible for calling these customers back.",
    count,
    samples: samples(rows[0]?.samples),
    evidenceHref: "/crm/calls?tab=recovery&group=needs_you",
    recommendedAction: "Give each missed call an owner, or close it if the customer was already reached.",
    requiresApproval: false,
  });
};

const draftsWaiting: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number }>(
    `select count(distinct a.case_id)::int as count from missed_call_actions a join missed_call_cases c on c.id = a.case_id and c.org_id = a.org_id
      where a.org_id = $1 and a.kind = 'message' and a.status = 'awaiting_approval' and a.created_at < now() - interval '2 hours' and c.state in ${OPEN}`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "recovery_drafts_waiting",
    severity: "warning",
    title: `${count} follow-up text${count === 1 ? " is" : "s are"} waiting for approval for over two hours`,
    detail: "Each caller is waiting on a teammate to approve or discard the drafted text.",
    count,
    samples: [],
    evidenceHref: "/crm/calls?tab=recovery",
    recommendedAction: "Approve, edit or discard each draft, or call the customer instead.",
    requiresApproval: false,
  });
};

const failedFollowUps: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce((array_agg(${who} order by c.state_changed_at desc))[1:5], '{}') as samples
       from missed_call_cases c left join contacts k on k.id = c.contact_id and k.org_id = c.org_id
      where c.org_id = $1 and c.state = 'failed' and c.state_changed_at > now() - interval '7 days'`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "recovery_failed",
    severity: "warning",
    title: `${count} missed-call follow-up${count === 1 ? "" : "s"} failed in the last 7 days`,
    detail: "The follow-up text could not be sent or the case could not be worked. These callers were not reached by the system.",
    count,
    samples: samples(rows[0]?.samples),
    evidenceHref: "/crm/calls?tab=recovery&group=closed",
    recommendedAction: "Call each customer back, then check the text channel and sending switch under recovery settings.",
    requiresApproval: false,
  });
};

const recoveryOff: ReviewCheck = async (db, job) => {
  const policy = (await db.query<{ enabled: boolean }>("select enabled from missed_call_policies where org_id = $1", [job.org_id])).rows[0];
  if (policy?.enabled) return null;
  const { rows } = await db.query<{ count: number }>(
    "select count(*)::int as count from missed_call_cases where org_id = $1 and first_called_at > now() - interval '7 days'",
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "recovery_off_with_missed_calls",
    severity: "info",
    title: `${count} call${count === 1 ? " was" : "s were"} missed in the last 7 days while recovery is off`,
    detail: "Missed calls are listed, but nobody is told and no call-back task is created while recovery is switched off.",
    count,
    samples: [],
    evidenceHref: "/crm/calls?tab=recovery-settings",
    recommendedAction: "Switch recovery on in team-only mode to get a call-back task and a notice for each missed call. Nothing is sent to customers in that mode.",
    requiresApproval: false,
  });
};

export async function runMissedCallReviewJob(job: WorkJobRow, _context: { workerId: string; controller: AbortController }): Promise<void> {
  return runReadOnlyReviewJob(job, {
    capability: "missed_call_review",
    allowedRoles: ["appointment_setter"],
    scanningMessage: "Reading missed-call cases, the follow-up actions that were recorded and the recovery policy…",
    analyzingMessage: "Working out which missed calls need a person…",
    checks: [waitingOnTeam, draftsWaiting, failedFollowUps, recoveryOff],
    limitations: "Only missed-call records stored in this workspace were read. No customer was contacted, no call was placed and no case, task or message was changed.",
    subject: "Missed calls",
  });
}
