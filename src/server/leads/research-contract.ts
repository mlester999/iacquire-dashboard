import "server-only";
import { z } from "zod";
import type { Queryable } from "@/server/db";
import type { WorkJobStage } from "@/server/workforce/jobs";
import type { Targeting } from "@/lib/leads-targeting";

// ---------------------------------------------------------------------------
// Research output contract. The model proposes; the server validates and writes.
// ---------------------------------------------------------------------------

const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .refine((value) => /^https?:\/\/[^\s]+\.[^\s]+/.test(value), "URL");

const publicContactSchema = z.object({
  name: z.string().trim().max(120).optional().nullable(),
  role: z.string().trim().max(120).optional().nullable(),
  email: z.string().trim().max(320).optional().nullable(),
  phone: z.string().trim().max(40).optional().nullable(),
  source_url: httpsUrl.optional().nullable(),
});

export const researchLeadSchema = z.object({
  business_name: z.string().trim().min(1).max(200),
  website: z.string().trim().max(300).optional().nullable(),
  industry: z.string().trim().max(120).optional().nullable(),
  location: z.string().trim().max(200).optional().nullable(),
  evidence: z
    .array(z.object({ url: httpsUrl, observed_at: z.string().max(40).optional().nullable(), summary: z.string().trim().max(500).optional().nullable() }))
    .max(10)
    .default([]),
  buying_signals: z.array(z.string().trim().max(200)).max(10).default([]),
  qualification_summary: z.string().trim().max(2000).optional().nullable(),
  public_contact: publicContactSchema.optional().nullable(),
  score: z
    .object({
      service_fit: z.number().optional(),
      problem_evidence: z.number().optional(),
      buying_intent: z.number().optional(),
      market_fit: z.number().optional(),
      source_quality: z.number().optional(),
    })
    .default({}),
});
const researchOutputSchema = z.object({ leads: z.array(z.unknown()).max(50) });
export type ResearchLead = z.infer<typeof researchLeadSchema>;

export const SCORE_MAX = { service_fit: 30, problem_evidence: 25, buying_intent: 20, market_fit: 15, source_quality: 10 } as const;

export function normalizeScore(raw: Partial<Record<keyof typeof SCORE_MAX, number>>, evidenceCount: number) {
  const out = {} as Record<keyof typeof SCORE_MAX, number>;
  for (const key of Object.keys(SCORE_MAX) as Array<keyof typeof SCORE_MAX>) {
    const value = Number(raw[key] ?? 0);
    out[key] = Math.max(0, Math.min(SCORE_MAX[key], Number.isFinite(value) ? Math.round(value) : 0));
  }
  // Points that claim evidence require cited sources.
  if (evidenceCount === 0) {
    out.problem_evidence = 0;
    out.buying_intent = 0;
    out.source_quality = 0;
  }
  return { breakdown: out, total: Object.values(out).reduce((a, b) => a + b, 0) };
}

export function normalizeDomain(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`);
    return url.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** Extracts the JSON payload from an agent answer (bare JSON or a fenced ```json block). */
export function parseResearchOutput(output: string) {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { leads: [] as ResearchLead[], rejected: 0, error: "The Lead Hunter's answer wasn't in the expected format." };
  }
  const top = researchOutputSchema.safeParse(parsed);
  if (!top.success) return { leads: [] as ResearchLead[], rejected: 0, error: "The Lead Hunter's answer wasn't in the expected format." };
  const leads: ResearchLead[] = [];
  let rejected = 0;
  for (const item of top.data.leads.slice(0, 20)) {
    const result = researchLeadSchema.safeParse(item);
    if (!result.success) {
      rejected++;
      continue;
    }
    // Public contact information is accepted only with a source URL that states it. Anything else
    // is discarded rather than guessed or inferred.
    const contact = result.data.public_contact;
    if (contact && !contact.source_url) result.data.public_contact = null;
    leads.push(result.data);
  }
  return { leads, rejected, error: null as string | null };
}

export function researchPrompt(prompt: string, targeting: Targeting, campaign: "business" | "influencer") {
  return [
    `Research request from the business owner: ${prompt}`,
    "",
    "Targeting rules (client-provided data):",
    JSON.stringify(campaign === "influencer" ? { ...targeting, influencer: targeting.influencer } : { ...targeting, influencer: undefined }),
    "",
    "Use only approved public sources (company websites, official registries, public business pages). Do not scrape personal profiles, do not message anyone, and do not guess contact details.",
    "Return at most 20 candidates. Only include evidence you actually observed, with its URL. If you cannot find evidence, say so in qualification_summary and leave evidence empty.",
    "Public contact details are optional. Include them only when a cited public source states them; always include that source_url. Never guess an email address, phone number or person's name.",
    "Respond with JSON only, in this exact shape:",
    '```json\n{"leads":[{"business_name":"","website":"","industry":"","location":"","evidence":[{"url":"https://…","observed_at":"ISO-8601","summary":""}],"buying_signals":[""],"qualification_summary":"","public_contact":{"name":"","role":"","email":"","phone":"","source_url":"https://…"},"score":{"service_fit":0,"problem_evidence":0,"buying_intent":0,"market_fit":0,"source_quality":0}}]}\n```',
    `Score maxima: service_fit ${SCORE_MAX.service_fit}, problem_evidence ${SCORE_MAX.problem_evidence}, buying_intent ${SCORE_MAX.buying_intent}, market_fit ${SCORE_MAX.market_fit}, source_quality ${SCORE_MAX.source_quality}. A score is a research priority, not consent or confirmed interest.`,
    "If you cannot verify a requested candidate, omit it and explain the limitation in qualification_summary. Never invent a business to reach the requested quantity.",
  ].join("\n");
}

/// ---------------------------------------------------------------------------
// Duplicate detection and qualification evidence
// ---------------------------------------------------------------------------

export interface DuplicateMatch {
  kind: "lead" | "crm_company";
  id: string;
  label: string;
  domain: string | null;
}

export interface DuplicateResult {
  status: "no_match" | "possible_duplicate" | "duplicate";
  matches: DuplicateMatch[];
}

/**
 * Compares a candidate with the tenant's existing lead records and native CRM companies. A domain
 * match is a duplicate; an exact normalised-name match is a possible duplicate that a person must
 * resolve. The query is tenant-scoped and only returns the minimum identifying fields.
 */
export async function findLeadDuplicates(
  db: Queryable,
  orgId: string,
  candidate: { business_name: string; website?: string | null },
): Promise<DuplicateResult> {
  const domain = normalizeDomain(candidate.website);
  const name = candidate.business_name.trim();
  if (!domain && !name) return { status: "no_match", matches: [] };
  const { rows } = await db.query<{ kind: "lead" | "crm_company"; id: string; label: string; domain: string | null }>(
    `select * from (
       select 'lead'::text as kind, id::text as id, business_name as label, domain
         from leads
        where org_id = $1
          and (($2 <> '' and domain = $2) or ($3 <> '' and lower(business_name) = lower($3)))
       union all
       select 'crm_company'::text as kind, id::text as id, name as label, domain::text as domain
         from crm_companies
        where org_id = $1 and deleted_at is null
          and (($2 <> '' and domain::text = $2) or ($3 <> '' and lower(name) = lower($3)))
     ) matches
     limit 10`,
    [orgId, domain ?? "", name],
  );
  if (!rows.length) return { status: "no_match", matches: [] };
  const domainMatch = domain !== null && rows.some((row) => row.domain?.toLowerCase() === domain);
  return { status: domainMatch ? "duplicate" : "possible_duplicate", matches: rows };
}

export interface LeadQualification {
  state: "evidence_backed" | "needs_evidence" | "duplicate" | "possible_duplicate";
  reasons: string[];
}

/** Explains why a candidate is ready for review or needs more evidence. Never invents a pass mark. */
export function qualifyCandidate(lead: ResearchLead, duplicates: DuplicateResult): LeadQualification {
  const reasons: string[] = [];
  if (duplicates.status === "duplicate") {
    reasons.push("An existing lead or CRM company has the same domain.");
    return { state: "duplicate", reasons };
  }
  if (duplicates.status === "possible_duplicate") {
    reasons.push("A lead or CRM company has the same name but no matching domain; a person must resolve it.");
    return { state: "possible_duplicate", reasons };
  }
  if (lead.evidence.length === 0) reasons.push("No source URL supports this candidate yet.");
  if (!lead.website) reasons.push("No website was verified.");
  if (!lead.qualification_summary) reasons.push("No qualification reasoning was provided.");
  if (reasons.length) return { state: "needs_evidence", reasons };
  return { state: "evidence_backed", reasons: ["At least one cited source, a website and a qualification explanation are present."] };
}

/** Maps a real Hermes tool event to a genuine research stage. No event means no stage change. */
export function stageForTool(tool: string, phase: "started" | "completed"): WorkJobStage | null {
  const name = tool.toLowerCase();
  if (/web[._-]?search|search|browse|serp|discover/.test(name)) return "searching";
  if (/web[._-]?extract|fetch|scrape|crawl|read[._-]?url|visit/.test(name)) return phase === "started" ? "reviewing" : "extracting";
  return null;
}

export function progressForTool(tool: string, phase: "started" | "completed", failed = false): Record<string, number> | null {
  if (phase !== "completed" || failed) return null;
  const name = tool.toLowerCase();
  if (/web[._-]?search|search|browse|serp|discover/.test(name)) return { searches: 1 };
  if (/web[._-]?extract|fetch|scrape|crawl|read[._-]?url|visit/.test(name)) return { pagesReviewed: 1 };
  return null;
}
