import "server-only";
import { runReadOnlyReviewJob, reviewFinding, type ReviewCheck } from "@/server/workforce/read-only-review";
import type { WorkJobRow } from "@/server/workforce/jobs";

const samples = (value: unknown) => (Array.isArray(value) ? (value as string[]).filter((item) => typeof item === "string") : []);

const staleDeals: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce(array_agg(name order by coalesce(stage_entered_at, updated_at) asc), '{}') as samples
       from crm_opportunities
      where org_id = $1 and status = 'open' and archived_at is null
        and coalesce(stage_entered_at, remote_updated_at, updated_at) < now() - interval '14 days'`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "stale_open_deals",
    severity: "warning",
    title: `${count} open deal${count === 1 ? "" : "s"} ${count === 1 ? "has" : "have"} not moved for 14 days`,
    detail: "A long stay in the same stage can mean the follow-up was missed. The review does not infer why.",
    count,
    samples: samples(rows[0]?.samples),
    evidenceHref: "/crm/pipelines",
    recommendedAction: "Review the last recorded activity and set a real next step or close the deal honestly.",
    requiresApproval: false,
  });
};

const missingValue: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce(array_agg(name order by created_at asc), '{}') as samples
       from crm_opportunities
      where org_id = $1 and status = 'open' and archived_at is null and monetary_value is null`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "open_deals_without_value",
    severity: "info",
    title: `${count} open deal${count === 1 ? " has" : "s have"} no value`,
    detail: "Pipeline totals cannot include a deal without a value. This is a data gap, not an estimate prompt.",
    count,
    samples: samples(rows[0]?.samples),
    evidenceHref: "/crm/pipelines",
    recommendedAction: "Ask the owner for an approved value, or leave it blank and exclude it from value reporting.",
    requiresApproval: false,
  });
};

const missingOwner: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce(array_agg(name order by created_at asc), '{}') as samples
       from crm_opportunities
      where org_id = $1 and status = 'open' and archived_at is null
        and assigned_user_id is null and (assigned_to is null or btrim(assigned_to) = '')`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "open_deals_without_owner",
    severity: "warning",
    title: `${count} open deal${count === 1 ? " has" : "s have"} no owner`,
    detail: "An unowned deal has no clear person responsible for the next step.",
    count,
    samples: samples(rows[0]?.samples),
    evidenceHref: "/crm/pipelines",
    recommendedAction: "Assign an owner who can act, or close the deal if nobody owns it.",
    requiresApproval: false,
  });
};

const passedCloseDate: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce(array_agg(name order by expected_close_date asc), '{}') as samples
       from crm_opportunities
      where org_id = $1 and status = 'open' and archived_at is null
        and expected_close_date is not null and expected_close_date < current_date`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "open_deals_past_close_date",
    severity: "warning",
    title: `${count} open deal${count === 1 ? " has" : "s have"} passed the expected close date`,
    detail: "The recorded close date is in the past and the deal remains open.",
    count,
    samples: samples(rows[0]?.samples),
    evidenceHref: "/crm/pipelines",
    recommendedAction: "Update the close date with a real forecast, or close the deal with the correct outcome.",
    requiresApproval: false,
  });
};

const noContactLink: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce(array_agg(name order by created_at asc), '{}') as samples
       from crm_opportunities
      where org_id = $1 and status = 'open' and archived_at is null
        and contact_id is null and company_id is null
        and (contact_label is null or btrim(contact_label) = '')`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "open_deals_without_contact",
    severity: "info",
    title: `${count} open deal${count === 1 ? " has" : "s have"} no linked person or company`,
    detail: "The deal cannot be traced to a customer record, which weakens follow-up and reporting.",
    count,
    samples: samples(rows[0]?.samples),
    evidenceHref: "/crm/pipelines",
    recommendedAction: "Link the correct person or company, or confirm this is an intentionally anonymous deal.",
    requiresApproval: false,
  });
};

export async function runPipelineReviewJob(job: WorkJobRow, _context: { workerId: string; controller: AbortController }): Promise<void> {
  return runReadOnlyReviewJob(job, {
    capability: "pipeline_review",
    allowedRoles: ["sales_assistant"],
    scanningMessage: "Reading persisted sales opportunities and their recorded stage history…",
    analyzingMessage: "Assessing pipeline hygiene and preparing recommended next actions…",
    checks: [staleDeals, missingValue, missingOwner, passedCloseDate, noContactLink],
    limitations: "Only opportunities stored in this workspace were read. No provider was contacted and no deal, stage or owner was changed.",
    subject: "Pipeline",
  });
}
