import "server-only";
import { runReadOnlyReviewJob, reviewFinding, type ReviewCheck } from "@/server/workforce/read-only-review";
import type { WorkJobRow } from "@/server/workforce/jobs";

// The Sales Assistant's read-only look at lead priority. It reads the scores the engine already wrote and what has happened to those leads since;
// it never scores anyone itself, never changes a priority and never contacts a lead.

const samples = (value: unknown) => (Array.isArray(value) ? (value as string[]).filter((item) => typeof item === "string").slice(0, 5) : []);
const who = "coalesce(nullif(k.display_name, ''), 'A lead without a name')";

const hotNotContacted: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce((array_agg(${who} order by k.priority_evaluated_at asc))[1:5], '{}') as samples
       from contacts k
      where k.org_id = $1 and k.deleted_at is null and k.priority_label = 'hot' and k.priority_evaluated_at < now() - interval '24 hours'
        and not exists (select 1 from conversation_messages m join conversations v on v.id = m.conversation_id and v.org_id = m.org_id
                         where m.org_id = k.org_id and v.contact_id = k.id and m.direction = 'outbound' and m.status in ('sent', 'delivered', 'read') and m.created_at > k.priority_evaluated_at - interval '24 hours')
        and not exists (select 1 from crm_call_records r where r.org_id = k.org_id and r.contact_id = k.id and r.direction = 'outbound' and coalesce(r.started_at, r.created_at) > k.priority_evaluated_at - interval '24 hours')
        and not exists (select 1 from tasks t where t.org_id = k.org_id and t.contact_id = k.id and t.status in ('open', 'in_progress'))`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "hot_leads_not_followed_up",
    severity: "warning",
    title: `${count} hot lead${count === 1 ? " has" : "s have"} no follow-up recorded since ${count === 1 ? "it" : "they"} turned hot`,
    detail: "No message or call to them and no open task was found. A lead can have been contacted somewhere that is not recorded here.",
    count,
    samples: samples(rows[0]?.samples),
    evidenceHref: "/crm/contacts",
    recommendedAction: "Contact each lead or create a task, and say why in the lead's notes.",
    requiresApproval: false,
  });
};

const hotNoOwner: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce((array_agg(${who} order by k.created_at asc))[1:5], '{}') as samples
       from contacts k where k.org_id = $1 and k.deleted_at is null and k.priority_label in ('hot', 'warm') and k.assigned_user_id is null and k.lead_status not in ('customer', 'unqualified', 'inactive')`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "priority_leads_without_owner",
    severity: "warning",
    title: `${count} hot or warm lead${count === 1 ? " has" : "s have"} no owner`,
    detail: "Promising leads without an owner depend on someone noticing them.",
    count,
    samples: samples(rows[0]?.samples),
    evidenceHref: "/crm/contacts",
    recommendedAction: "Assign an owner, or set up a lead assignment rule.",
    requiresApproval: false,
  });
};

const mostlyUnknown: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ total: number; unknown: number }>(
    `select count(*)::int as total, count(*) filter (where priority_label = 'insufficient_data')::int as unknown
       from contacts where org_id = $1 and deleted_at is null and priority_label is not null`,
    [job.org_id],
  );
  const total = Number(rows[0]?.total ?? 0);
  const unknown = Number(rows[0]?.unknown ?? 0);
  if (total < 10 || unknown / total < 0.5) return null;
  return reviewFinding({
    key: "mostly_insufficient_data",
    severity: "info",
    title: `${unknown} of ${total} assessed leads have too little information to score`,
    detail: "Insufficient data is not the same as Cold: the rules found fewer signals than the minimum, so no score was given.",
    count: unknown,
    samples: [],
    evidenceHref: "/crm/settings/lead-scoring",
    recommendedAction: "Capture more on each lead (how they found you, what they want, timing), or lower the signals needed under lead scoring settings.",
    requiresApproval: false,
  });
};

const backlog: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number; oldest: Date | null }>(
    "select count(*)::int as count, min(not_before) as oldest from lead_score_queue where org_id = $1 and not_before < now() - interval '1 hour'",
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "scoring_backlog",
    severity: "info",
    title: `${count} lead${count === 1 ? " is" : "s are"} waiting to be scored again for over an hour`,
    detail: "Scores update when the platform's scheduler runs. If it has not run recently, priorities shown may be out of date.",
    count,
    samples: [],
    evidenceHref: "/crm/settings/lead-scoring",
    recommendedAction: "Check with your agency that the scheduler is running.",
    requiresApproval: false,
  });
};

export async function runLeadPriorityReviewJob(job: WorkJobRow, _context: { workerId: string; controller: AbortController }): Promise<void> {
  return runReadOnlyReviewJob(job, {
    capability: "lead_priority_review",
    allowedRoles: ["sales_assistant"],
    scanningMessage: "Reading lead priorities that were already assessed and what happened to those leads since…",
    analyzingMessage: "Working out which promising leads need a person…",
    checks: [hotNotContacted, hotNoOwner, mostlyUnknown, backlog],
    limitations: "Only the stored priorities and records in this workspace were read. No lead was scored, contacted or changed.",
    subject: "Lead priority",
  });
}
