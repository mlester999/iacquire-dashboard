import "server-only";
import { runReadOnlyReviewJob, reviewFinding, type ReviewCheck } from "@/server/workforce/read-only-review";
import type { WorkJobRow } from "@/server/workforce/jobs";

const samples = (value: unknown) => (Array.isArray(value) ? (value as string[]).filter((item) => typeof item === "string") : []);

const missingContactDetails: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count,
            coalesce(array_agg(coalesce(nullif(display_name, ''), 'Unnamed contact') order by created_at asc), '{}') as samples
       from contacts
      where org_id = $1 and deleted_at is null and email is null and phone is null
        and created_at >= now() - interval '90 days'`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "contacts_missing_details",
    severity: "info",
    title: `${count} recent contact${count === 1 ? " has" : "s have"} no email or phone`,
    detail: "The record exists but neither contact method is stored, which can block follow-up. The cause is not inferred.",
    count,
    samples: samples(rows[0]?.samples),
    evidenceHref: "/crm/contacts",
    recommendedAction: "Check the original source and add a verified contact detail, or mark the record as incomplete.",
    requiresApproval: false,
  });
};

const companiesMissingDetails: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number; samples: string[] }>(
    `select count(*)::int as count, coalesce(array_agg(name order by name asc), '{}') as samples
       from crm_companies
      where org_id = $1 and deleted_at is null and domain is null and website is null`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "companies_missing_web",
    severity: "warning",
    title: `${count} compan${count === 1 ? "y has" : "ies have"} no domain or website`,
    detail: "Without a domain, duplicate detection and company verification are weaker.",
    count,
    samples: samples(rows[0]?.samples),
    evidenceHref: "/crm/companies",
    recommendedAction: "Add the verified official domain or website, or confirm the company has neither.",
    requiresApproval: false,
  });
};

const duplicateCompanies: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ groups: number; samples: string[] }>(
    `select count(*)::int as groups, coalesce(array_agg(name order by name asc), '{}') as samples
       from (
         select lower(btrim(name)) as key, min(name) as name, count(*) as n
           from crm_companies
          where org_id = $1 and deleted_at is null
          group by 1 having count(*) > 1
       ) duplicates`,
    [job.org_id],
  );
  const groups = Number(rows[0]?.groups ?? 0);
  if (!groups) return null;
  return reviewFinding({
    key: "duplicate_companies",
    severity: "warning",
    title: `${groups} possible duplicate company name${groups === 1 ? "" : "s"}`,
    detail: "More than one active company shares the same normalised name. A person must decide whether they are the same business.",
    count: groups,
    samples: samples(rows[0]?.samples),
    evidenceHref: "/crm/companies",
    recommendedAction: "Compare the records and merge only after confirming they are the same business.",
    requiresApproval: false,
  });
};

const duplicateContactNames: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ groups: number; samples: string[] }>(
    `select count(*)::int as groups, coalesce(array_agg(name order by name asc), '{}') as samples
       from (
         select lower(btrim(display_name)) as key, min(display_name) as name, count(*) as n
           from contacts
          where org_id = $1 and deleted_at is null and btrim(display_name) <> ''
          group by 1 having count(*) > 1
       ) duplicates`,
    [job.org_id],
  );
  const groups = Number(rows[0]?.groups ?? 0);
  if (!groups) return null;
  return reviewFinding({
    key: "duplicate_contact_names",
    severity: "info",
    title: `${groups} shared contact name${groups === 1 ? "" : "s"}`,
    detail: "Shared names are not proof of a duplicate. They are a review prompt because identity matches must use a verified email or phone, not a name.",
    count: groups,
    samples: samples(rows[0]?.samples),
    evidenceHref: "/crm/contacts",
    recommendedAction: "Check verified identities before merging; never merge on name alone.",
    requiresApproval: false,
  });
};

const unverifiedIdentities: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number }>(
    "select count(*)::int as count from contact_identities where org_id = $1 and verified = false",
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "unverified_identities",
    severity: "info",
    title: `${count} contact identit${count === 1 ? "y is" : "ies are"} unverified`,
    detail: "An unverified email or phone cannot be used to prove two records are the same person.",
    count,
    samples: [],
    evidenceHref: "/crm/contacts",
    recommendedAction: "Verify through an approved source before using the identity for deduplication or outreach.",
    requiresApproval: false,
  });
};

export async function runCrmQualityReviewJob(job: WorkJobRow, _context: { workerId: string; controller: AbortController }): Promise<void> {
  return runReadOnlyReviewJob(job, {
    capability: "crm_quality_review",
    allowedRoles: ["crm_manager"],
    scanningMessage: "Reading persisted CRM contacts, companies and verified identities…",
    analyzingMessage: "Assessing data-quality gaps and preparing recommended fixes…",
    checks: [missingContactDetails, companiesMissingDetails, duplicateCompanies, duplicateContactNames, unverifiedIdentities],
    limitations: "Only CRM records stored in this workspace were read. No provider was contacted and no record or identity was changed.",
    subject: "CRM quality",
  });
}
