import "server-only";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { parseCsv, CsvError } from "@/lib/crm/csv";
import { LEAD_LIST_HEADERS, LEAD_LIST_MAX_BYTES, LEAD_LIST_MAX_ROWS } from "@/lib/lead-list-upload";
import { targetingSchema, type Targeting } from "@/lib/leads-targeting";
import { recordAudit } from "@/server/audit";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { lockLeadIntake, normalizeDomain, type LeadQualification } from "@/server/leads/research-contract";
import { consumeRateLimit } from "@/server/security/rate-limit";
import type { OrgContext } from "@/server/tenancy/context";
import { appendWorkEvent, createWorkJob, getWorkJob } from "@/server/workforce/jobs";

const SOURCE = "tenant_upload";
const UPLOAD_RATE = { name: "leads:upload", limit: 10, windowSeconds: 3600 };
const REQUIRED_HEADERS = ["business_name", "website", "source_url"] as const;
const UPLOAD_TITLE = "Workspace CSV lead list";
const countryNames = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });

type Candidate = {
  business_name: string;
  website: string;
  domain: string;
  source_url: string;
  industry: string | null;
  region: string | null;
  country: string | null;
};

function field(value: string, max: number, label: string, row: number) {
  if (value.length > max || /\p{Cc}/u.test(value)) {
    throw new AppError("invalid_input", `Record ${row} has an invalid ${label}. Use a single line of up to ${max} characters.`);
  }
  return value.normalize("NFC");
}

function publicUrl(value: string, label: string, max: number, row: number) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("invalid_input", `Record ${row} needs a public HTTPS ${label}.`);
  }
  if (!/^https:\/\//i.test(value) || url.protocol !== "https:" || /[\s\\]/u.test(value) || /\p{Cc}/u.test(value)
    || url.username || url.password || !url.hostname.includes(".") || url.hostname.endsWith(".")
    || isIP(url.hostname) || /\.(?:local|internal|localhost)$/i.test(url.hostname) || url.toString().length > max) {
    throw new AppError("invalid_input", `Record ${row} needs a public HTTPS ${label} of up to ${max} characters.`);
  }
  return url.toString();
}

function parseLeadList(csv: string): Candidate[] {
  if (typeof csv !== "string" || Buffer.byteLength(csv, "utf8") > LEAD_LIST_MAX_BYTES) {
    throw new AppError("invalid_input", "Choose a CSV of up to 256 KB.");
  }
  let parsed: ReturnType<typeof parseCsv>;
  try {
    parsed = parseCsv(csv, { maxRows: LEAD_LIST_MAX_ROWS, maxColumns: LEAD_LIST_HEADERS.length, maxCellLength: 500, requireMatchingColumns: true });
  } catch (error) {
    if (error instanceof CsvError) throw new AppError("invalid_input", error.message);
    throw error;
  }
  const headers = parsed.headers.map((name) => name.toLowerCase());
  const allowed = new Set<string>(LEAD_LIST_HEADERS);
  if (headers.some((name) => !allowed.has(name)) || REQUIRED_HEADERS.some((name) => !headers.includes(name))) {
    throw new AppError("invalid_input", "Use the CSV template columns. Business name, website and source URL are required. Remove contact details and all other columns.");
  }
  if (!parsed.rows.length) throw new AppError("invalid_input", "Add at least one business below the CSV header.");

  return parsed.rows.map((row, index) => {
    const record = index + 1;
    const value = (header: string) => row[headers.indexOf(header)] ?? "";
    const name = field(value("business_name"), 200, "business name", record);
    if (!name) throw new AppError("invalid_input", `Record ${record} needs a business name.`);
    const website = publicUrl(value("website"), "website", 300, record);
    const country = value("country").toUpperCase();
    if (country && (!/^[A-Z]{2}$/.test(country) || !countryNames.of(country))) {
      throw new AppError("invalid_input", `Record ${record} needs a two-letter country code such as US or PH, or a blank value.`);
    }
    return {
      business_name: name,
      website,
      domain: normalizeDomain(website)!,
      source_url: publicUrl(value("source_url"), "source URL", 500, record),
      industry: field(value("industry"), 120, "industry", record) || null,
      region: field(value("region"), 100, "region", record) || null,
      country: country || null,
    };
  });
}

const normalized = (value: string | null) => value?.normalize("NFKC").trim().toLowerCase() ?? "";

function qualifyUpload(candidate: Candidate, targeting: Targeting): LeadQualification {
  const countryName = candidate.country ? countryNames.of(candidate.country) ?? null : null;
  const location = [candidate.region, countryName].filter(Boolean).join(", ");
  const fields = new Set([candidate.domain, candidate.business_name, candidate.industry, candidate.region, candidate.country, countryName, location].map(normalized));
  const exclusion = targeting.excluded.find((term) => fields.has(normalized(term)));
  if (exclusion) {
    return {
      state: "disqualified",
      reasons: [`An uploaded field matches the workspace exclusion “${exclusion}”.`],
      recommended_next_action: "Compare the source with the exclusion before deciding whether to revise your targeting rules.",
    };
  }

  const reasons = ["The workspace supplied a source link. iAcquireOS has not checked the page or confirmed the business details."];
  const match = (fieldValue: string | null, filters: string[], label: string) => {
    if (!filters.length) return;
    if (!fieldValue) reasons.push(`The CSV did not provide a ${label} to compare with targeting.`);
    else if (filters.some((term) => normalized(term) === normalized(fieldValue))) reasons.push(`The uploaded ${label} matches a saved targeting rule.`);
    else reasons.push(`The uploaded ${label} has no exact match in the saved targeting rules.`);
  };
  match(candidate.industry, targeting.industries, "industry");
  match(candidate.region, targeting.regions, "region");
  const countries = targeting.countries.map((term) => normalized(term) === normalized(candidate.country) ? countryName ?? term : term);
  match(countryName, countries, "country");
  if (targeting.keywords.length || targeting.minimumCriteria || targeting.servicesNeeded.length || targeting.businessSize !== "any") {
    reasons.push("Review other fit criteria against the source before approving the candidate.");
  }
  return { state: "evidence_backed", reasons, recommended_next_action: "Verify the workspace-supplied source and decide whether the business fits before approving it." };
}

type UploadResult = { requestId: string; added: number; duplicates: number; disqualified: number };

/** A manual intake action. No runtime, provider, CRM write or messaging transport is invoked. */
export async function saveLeadListUpload(ctx: OrgContext, csv: string, acknowledged: boolean): Promise<UploadResult & { repeated: boolean }> {
  if (!ctx.can("leads.research")) throw new AppError("forbidden", "Only workspace owners and admins can upload lead lists.");
  if (ctx.org.isDemo) throw new AppError("forbidden", "Workspace uploads are unavailable in the demo.");
  if (acknowledged !== true) throw new AppError("invalid_input", "Confirm your workspace is allowed to use this business list.");

  const candidates = parseLeadList(csv);
  const digest = createHash("sha256").update(JSON.stringify([ctx.org.orgId, candidates])).digest("hex");
  const limit = await consumeRateLimit(UPLOAD_RATE, ctx.org.orgId);
  if (!limit.allowed) throw new AppError("rate_limited", "Too many lead-list uploads this hour.", { retryAfterSeconds: limit.retryAfterSeconds });

  return withSystem(async (db) => {
    const partner = await db.query<{ agent_id: string; conversation_id: string }>(
      `select a.id as agent_id, c.id as conversation_id
         from ai_growth_partners p
         join agent_instances a on a.id = p.runtime_agent_instance_id and a.org_id = p.org_id and a.role_key = 'growth_partner'
         join chat_conversations c on c.growth_partner_id = p.id and c.agent_instance_id = a.id and c.org_id = p.org_id and c.deleted_at is null
        where p.org_id = $1 limit 2`,
      [ctx.org.orgId],
    );
    if (partner.rows.length !== 1) throw new AppError("conflict", "Set up the permanent AI Growth Partner conversation before uploading a lead list.");
    const { agent_id: agentId, conversation_id: conversationId } = partner.rows[0];
    const job = await createWorkJob(db, {
      orgId: ctx.org.orgId, agentId, conversationId, requestedBy: ctx.user.id,
      capability: "lead_list_upload", title: UPLOAD_TITLE, idempotencyKey: `lead-list:${digest}`, maxAttempts: 1,
      input: { source: SOURCE, submittedRows: candidates.length },
    });
    if (!job.created) {
      const previous = await getWorkJob(db, ctx.org.orgId, job.id);
      if (previous?.status !== "completed") throw new AppError("conflict", "This lead list could not be confirmed. Check the activity before retrying.");
      return { ...(previous.result as UploadResult), repeated: true };
    }

    await lockLeadIntake(db, ctx.org.orgId);
    const profile = await db.query<{ criteria: unknown }>("select criteria from lead_targeting_profiles where org_id = $1", [ctx.org.orgId]);
    const targeting = targetingSchema.safeParse(profile.rows[0]?.criteria ?? {});
    if (!targeting.success) throw new AppError("conflict", "Review and save your targeting rules before uploading this list.");

    const domains = new Set(candidates.map((candidate) => candidate.domain));
    const names = new Set(candidates.map((candidate) => normalized(candidate.business_name)));
    const existing = await db.query<{ domain: string | null; name: string }>(
      `select domain, business_name as name from leads
        where org_id = $1 and (domain = any($2::text[]) or lower(business_name) = any($3::text[]))
       union
       select domain::text, name from crm_companies
        where org_id = $1 and deleted_at is null and (domain::text = any($2::text[]) or lower(name) = any($3::text[]))`,
      [ctx.org.orgId, [...domains], [...names]],
    );
    const existingDomains = new Set(existing.rows.map((row) => row.domain));
    const existingNames = new Set(existing.rows.map((row) => normalized(row.name)));
    const accepted = [];
    let disqualified = 0;
    for (const candidate of candidates) {
      const name = normalized(candidate.business_name);
      if (existingDomains.has(candidate.domain) || existingNames.has(name)) continue;
      existingDomains.add(candidate.domain);
      existingNames.add(name);
      const qualification = qualifyUpload(candidate, targeting.data);
      if (qualification.state === "disqualified") disqualified++;
      accepted.push({
        ...candidate,
        location: [candidate.region, candidate.country ? countryNames.of(candidate.country) : null].filter(Boolean).join(", ") || null,
        evidence: [{ url: candidate.source_url, source: SOURCE, region: candidate.region, country: candidate.country }],
        qualification_state: qualification.state,
        qualification_reasons: qualification.reasons,
        recommended_next_action: qualification.recommended_next_action,
      });
    }

    const request = await db.query<{ id: string }>(
      `insert into lead_research_requests (org_id, requested_by, prompt, campaign_type, criteria, status, result_count, work_job_id, agent_role, completed_at)
       values ($1, $2, $3, 'business', $4::jsonb, 'completed', $5, $6, 'growth_partner', now()) returning id`,
      [ctx.org.orgId, ctx.user.id, UPLOAD_TITLE, JSON.stringify({ source: SOURCE, targeting: targeting.data }), accepted.length, job.id],
    );
    const requestId = request.rows[0].id;
    await db.query(
      `insert into leads (org_id, research_request_id, business_name, website, domain, industry, location, source_platform,
                         evidence, duplicate_status, qualification_state, qualification_reasons, recommended_next_action)
       select $1, $2, candidate.business_name, candidate.website, candidate.domain, candidate.industry, candidate.location, $3,
              candidate.evidence, 'no_match', candidate.qualification_state, candidate.qualification_reasons, candidate.recommended_next_action
         from jsonb_to_recordset($4::jsonb) as candidate(business_name text, website text, domain text, industry text, location text,
           evidence jsonb, qualification_state text, qualification_reasons text[], recommended_next_action text)`,
      [ctx.org.orgId, requestId, SOURCE, JSON.stringify(accepted)],
    );
    const result = { requestId, added: accepted.length, duplicates: candidates.length - accepted.length, disqualified };
    const summary = `${result.added} added for review · ${result.duplicates} duplicate matches skipped · ${result.disqualified} matched a targeting exclusion.`;
    await db.query(
      `update ai_work_jobs set status = 'completed', stage = 'completed', result_count = $3, result = $4::jsonb,
                               result_summary = $5, started_at = now(), finished_at = now() where id = $1 and org_id = $2`,
      [job.id, ctx.org.orgId, result.added, JSON.stringify(result), summary],
    );
    await appendWorkEvent(db, { jobId: job.id, orgId: ctx.org.orgId, kind: "evidence", stage: "completed", message: summary });
    await recordAudit({
      orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "leads.list_uploaded", result: "success",
      targetType: "lead_research_request", targetId: requestId,
      metadata: { workJobId: job.id, source: SOURCE, rightsAcknowledged: true, added: result.added, duplicateMatchesSkipped: result.duplicates, disqualified },
    }, db);
    return { ...result, repeated: false };
  });
}
