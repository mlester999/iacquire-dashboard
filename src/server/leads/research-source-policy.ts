import "server-only";
import { z } from "zod";
import { isResearchSourceKey, type ResearchSourceKey } from "@/lib/lead-research-sources";
import type { Queryable } from "@/server/db";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { OrgContext } from "@/server/tenancy/context";
import { lockActiveWorkJobLease } from "@/server/workforce/jobs";
import {
  buildOpenStreetMapQuery,
  validateOpenStreetMapSourceConfig,
  validateGeographicBounds,
  type OpenStreetMapSourceConfig,
  type GeographicBounds,
} from "@/server/leads/openstreetmap-source";
import {
  normalizeApprovedCompanyDomains,
  validateCompanyWebsiteTarget,
  type CompanyWebsiteSourceConfig,
} from "@/server/leads/company-website-source";
import {
  FSA_DIRECTORY_MAX_DAILY_REQUESTS, fsaDirectoryApprovalCurrent, fsaDirectoryConfigSchema, fsaDirectoryRequestUrl,
  type FsaDirectoryConfig,
} from "@/server/leads/fsa-directory-source";

export type { ResearchSourceKey } from "@/lib/lead-research-sources";
type SourceTransport = "approved_source" | "synthetic_fixture";

export interface ResearchSourceHealth {
  lastCompletedRunAt: string | null;
  lastResponseAt: string | null;
  lastError: { at: string; httpStatus: number | null; invalidResponse?: true } | null;
}

const sourceSettingsSchema = z.object({
  enabled: z.boolean(),
  providerFeeUsdPerRequest: z.number().finite().min(0).max(1_000_000),
  perJobRequestCap: z.number().int().min(0).max(10_000),
  perDayRequestCap: z.number().int().min(0).max(100_000),
  perJobSpendCapUsd: z.number().finite().min(0).max(1_000_000),
  perDaySpendCapUsd: z.number().finite().min(0).max(1_000_000),
});

const openStreetMapConfigSchema = z.object({
  endpoint: z.string().url().max(500),
  approvedEndpointHosts: z.array(z.string().trim().min(1).max(253)).min(1).max(10),
  userAgent: z.string().trim().min(1).max(200),
  bounds: z.object({ south: z.number(), west: z.number(), north: z.number(), east: z.number() }),
  maxResults: z.number().int().min(1).max(50).default(25),
  timeoutSeconds: z.number().int().min(1).max(25).default(25),
});

const companyWebsiteConfigSchema = z.object({
  approvedDomains: z.array(z.string().trim().min(1).max(253)).min(1).max(100),
  maxRequests: z.number().int().min(1).max(20).default(8),
});

type SourceSettings = z.infer<typeof sourceSettingsSchema>;
type OpenStreetMapConfig = z.infer<typeof openStreetMapConfigSchema>;
type CompanyWebsiteConfig = z.infer<typeof companyWebsiteConfigSchema>;

export interface StoredResearchSourcePolicy extends SourceSettings {
  orgId: string;
  source: ResearchSourceKey;
  sourceConfig: OpenStreetMapConfig | CompanyWebsiteConfig | FsaDirectoryConfig;
  approvedBy: string | null;
  approvedAt: Date | null;
  approvedByActive?: boolean;
}

function parseSettings(value: unknown) {
  const parsed = sourceSettingsSchema.safeParse(value);
  if (!parsed.success) throw new AppError("invalid_input", "The source request and spend limits are invalid.");
  if (parsed.data.enabled && (parsed.data.perJobRequestCap < 1 || parsed.data.perDayRequestCap < 1)) {
    throw new AppError("invalid_input", "An enabled source needs a positive per-job and per-day request limit.");
  }
  if (parsed.data.perJobSpendCapUsd < parsed.data.providerFeeUsdPerRequest
    || parsed.data.perDaySpendCapUsd < parsed.data.providerFeeUsdPerRequest) {
    throw new AppError("invalid_input", "The per-job and per-day spend caps must cover one request at the configured fee.");
  }
  return parsed.data;
}

function parseSourceConfig(source: ResearchSourceKey, value: unknown) {
  if (source === "fsa_directory") {
    const parsed = fsaDirectoryConfigSchema.safeParse(value);
    if (!parsed.success) throw new AppError("invalid_input", "Enter the FSA local authority ID, code and name, a valid approval expiry, and a page size from 1 to 20.");
    return parsed.data;
  }
  if (source === "openstreetmap") {
    const parsed = openStreetMapConfigSchema.safeParse(value);
    if (!parsed.success) throw new AppError("invalid_input", "OpenStreetMap needs an endpoint, exact host allowlist, User-Agent and bounded local area.");
    const bounds = validateGeographicBounds(parsed.data.bounds);
    // Reuse the adapter's exact endpoint, host and query limits during configuration review.
    const checked: OpenStreetMapSourceConfig = {
      enabled: true,
      endpoint: parsed.data.endpoint,
      approvedEndpointHosts: parsed.data.approvedEndpointHosts,
      userAgent: parsed.data.userAgent,
      providerFeeUsdPerRequest: 0,
      perJobSpendCapUsd: 0,
      maxResults: parsed.data.maxResults,
      timeoutSeconds: parsed.data.timeoutSeconds,
    };
    // Endpoint validation is intentionally delegated to the adapter without sending a request.
    validateOpenStreetMapSourceConfig(checked);
    buildOpenStreetMapQuery(bounds, checked.maxResults, checked.timeoutSeconds);
    return { ...parsed.data, bounds };
  }
  const parsed = companyWebsiteConfigSchema.safeParse(value);
  if (!parsed.success) throw new AppError("invalid_input", "Add a small, exact company website domain allowlist.");
  return { ...parsed.data, approvedDomains: normalizeApprovedCompanyDomains(parsed.data.approvedDomains) };
}

function policyRow(row: {
  org_id: string;
  source: string;
  enabled: boolean;
  source_config: unknown;
  provider_fee_usd_per_request: string | number;
  per_job_request_cap: number;
  per_day_request_cap: number;
  per_job_spend_cap_usd: string | number;
  per_day_spend_cap_usd: string | number;
  approved_by: string | null;
  approved_at: Date | null;
}): StoredResearchSourcePolicy {
  if (!isResearchSourceKey(row.source)) {
    throw new AppError("invalid_input", "The stored research source is not supported.");
  }
  const source = row.source;
  const sourceConfig = parseSourceConfig(source, row.source_config);
  const settings = parseSettings({
    enabled: row.enabled,
    providerFeeUsdPerRequest: Number(row.provider_fee_usd_per_request),
    perJobRequestCap: row.per_job_request_cap,
    perDayRequestCap: row.per_day_request_cap,
    perJobSpendCapUsd: Number(row.per_job_spend_cap_usd),
    perDaySpendCapUsd: Number(row.per_day_spend_cap_usd),
  });
  if (row.enabled && (!row.approved_by || !row.approved_at)) {
    throw new AppError("forbidden", "The source has no current approval and remains disabled.");
  }
  if (source !== "openstreetmap" && settings.providerFeeUsdPerRequest !== 0) {
    throw new AppError("forbidden", "This research source must use a $0.00 provider fee.");
  }
  return {
    orgId: row.org_id,
    source,
    ...settings,
    sourceConfig,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
  };
}

export function researchSourceApprovalCurrent(policy: StoredResearchSourcePolicy | null): boolean {
  if (!policy?.enabled || !policy.approvedAt) return false;
  return policy.source !== "fsa_directory" || (policy.approvedByActive !== false
    && fsaDirectoryApprovalCurrent(fsaDirectoryConfigSchema.parse(policy.sourceConfig), policy.approvedAt));
}

export async function hasApprovedDiscoverySource(db: Queryable, orgId: string) {
  return researchSourceApprovalCurrent(await getResearchSourcePolicy(db, orgId, "openstreetmap"))
    || researchSourceApprovalCurrent(await getResearchSourcePolicy(db, orgId, "fsa_directory"));
}

export async function getResearchSourcePolicy(db: Queryable, orgId: string, source: ResearchSourceKey): Promise<StoredResearchSourcePolicy | null> {
  const { rows } = await db.query<{
    org_id: string; source: string; enabled: boolean; source_config: unknown;
    provider_fee_usd_per_request: string | number; per_job_request_cap: number; per_day_request_cap: number;
    per_job_spend_cap_usd: string | number; per_day_spend_cap_usd: string | number;
    approved_by: string | null; approved_at: Date | null;
  }>(
    `select org_id, source, enabled, source_config, provider_fee_usd_per_request,
            per_job_request_cap, per_day_request_cap, per_job_spend_cap_usd, per_day_spend_cap_usd,
            approved_by, approved_at
       from lead_research_source_settings where org_id = $1 and source = $2`,
    [orgId, source],
  );
  if (!rows[0]) return null;
  const policy = policyRow(rows[0]);
  if (source === "fsa_directory" && policy.enabled && policy.approvedBy) {
    policy.approvedByActive = await hasFsaDirectoryApprover(db, orgId, policy.approvedBy);
  }
  return policy;
}

/** Saves an explicit, tenant-scoped source policy. Enabling requires an explicit confirmation flag. */
export async function saveResearchSourcePolicy(
  ctx: OrgContext,
  source: ResearchSourceKey,
  input: SourceSettings & { activationAcknowledged?: boolean; sourceConfig: unknown },
): Promise<void> {
  if (!ctx.can("leads.research")) throw new AppError("forbidden", "Only workspace owners and admins can configure acquisition sources.");
  if (!isResearchSourceKey(source)) throw new AppError("invalid_input", "Choose a supported acquisition source.");
  const settings = parseSettings(input);
  const config = parseSourceConfig(source, input.sourceConfig);
  if (source !== "openstreetmap" && settings.providerFeeUsdPerRequest !== 0) {
    throw new AppError("invalid_input", "This research source must use a $0.00 provider fee.");
  }
  if (settings.enabled && input.activationAcknowledged !== true) {
    throw new AppError("forbidden", "Confirm that this source may make bounded, read-only requests before enabling it.");
  }
  const directory = source === "fsa_directory" ? fsaDirectoryConfigSchema.parse(config) : null;
  const approvedAt = new Date();
  if (directory && (ctx.org.kind !== "client" || ctx.org.isDemo || (ctx.role !== "owner" && ctx.role !== "admin"))) {
    throw new AppError("forbidden", "Only the client workspace's owners and admins can authorize this directory.");
  }
  if (directory && (settings.perJobRequestCap > 1 || settings.perDayRequestCap > FSA_DIRECTORY_MAX_DAILY_REQUESTS)) {
    throw new AppError("invalid_input", "The FSA directory allows at most one request per job and 12 per UTC day in this application.");
  }
  if (directory && settings.enabled && !fsaDirectoryApprovalCurrent(directory, approvedAt)) {
    throw new AppError("invalid_input", "Confirm the directory's terms and choose an approval expiry within 30 days.");
  }
  const configSummary = source === "openstreetmap"
    ? (() => {
        const osm = config as OpenStreetMapConfig;
        return { endpointHost: new URL(osm.endpoint).hostname, bounds: osm.bounds, maxResults: osm.maxResults };
      })()
    : directory ? {
        authorityId: directory.authorityId, authorityCode: directory.authorityCode, authorityName: directory.authorityName,
        maxResults: directory.maxResults, approvalExpiresOn: directory.approvalExpiresOn, rightsAcknowledged: directory.rightsAcknowledged,
        hasNameKeyword: Boolean(directory.nameKeyword),
      } : (() => {
        const websites = config as CompanyWebsiteConfig;
        return { approvedDomains: websites.approvedDomains, maxRequests: websites.maxRequests };
      })();

  await withSystem(async (db) => {
    if (directory && settings.enabled) await assertFsaDirectoryApprover(db, ctx.org.orgId, ctx.user.id);
    await db.query(
      `insert into lead_research_source_settings (
         org_id, source, enabled, source_config, provider_fee_usd_per_request,
         per_job_request_cap, per_day_request_cap, per_job_spend_cap_usd, per_day_spend_cap_usd,
         approved_by, approved_at, created_by, updated_by
       ) values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $10, $10)
       on conflict (org_id, source) do update set
         enabled = excluded.enabled,
         source_config = excluded.source_config,
         provider_fee_usd_per_request = excluded.provider_fee_usd_per_request,
         per_job_request_cap = excluded.per_job_request_cap,
         per_day_request_cap = excluded.per_day_request_cap,
         per_job_spend_cap_usd = excluded.per_job_spend_cap_usd,
         per_day_spend_cap_usd = excluded.per_day_spend_cap_usd,
         approved_by = excluded.approved_by,
         approved_at = excluded.approved_at,
         updated_by = excluded.updated_by,
         updated_at = now()`,
      [
        ctx.org.orgId, source, settings.enabled, JSON.stringify(config), settings.providerFeeUsdPerRequest,
        settings.perJobRequestCap, settings.perDayRequestCap, settings.perJobSpendCapUsd, settings.perDaySpendCapUsd,
        settings.enabled ? ctx.user.id : null, settings.enabled ? approvedAt : null,
      ],
    );
    await recordAudit({
      orgId: ctx.org.orgId,
      actorUserId: ctx.user.id,
      actorKind: "user",
      action: "leads.research_source_policy_saved",
      targetType: "lead_research_source_policy",
      targetId: source,
      result: "success",
      metadata: {
        enabled: settings.enabled,
        config: configSummary,
        providerFeeUsdPerRequest: settings.providerFeeUsdPerRequest,
        perJobRequestCap: settings.perJobRequestCap,
        perDayRequestCap: settings.perDayRequestCap,
        perJobSpendCapUsd: settings.perJobSpendCapUsd,
        perDaySpendCapUsd: settings.perDaySpendCapUsd,
      },
    }, db);
  });
}

async function hasFsaDirectoryApprover(db: Queryable, orgId: string, userId: string, lock = false) {
  const { rows } = await db.query(
    `select 1 from organization_memberships m
       join organizations o on o.id = m.org_id
       join users u on u.id = m.user_id
      where m.org_id = $1 and m.user_id = $2 and m.status = 'active' and u.status = 'active'
        and m.role in ('owner', 'admin') and o.kind = 'client' and o.status in ('active', 'onboarding') and not o.is_demo
      ${lock ? "for share of m, o, u" : ""}`,
    [orgId, userId],
  );
  return rows.length > 0;
}

async function assertFsaDirectoryApprover(db: Queryable, orgId: string, userId: string) {
  if (!await hasFsaDirectoryApprover(db, orgId, userId, true)) {
    throw new AppError("forbidden", "The FSA directory needs approval from an active workspace owner or admin.");
  }
}

export interface SourceRequestReservation {
  usageId: string;
  policy: StoredResearchSourcePolicy;
}

function safeRequestUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError("invalid_input", "The source request URL is invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new AppError("forbidden", "Research sources must use HTTPS without embedded credentials.");
  }
  // Keep the request path for auditability; drop query and fragment data that might contain tokens.
  return `${url.origin}${url.pathname}`.slice(0, 1000);
}

/**
 * Locks the tenant's policy row and reserves one request before network access. Pending and failed
 * attempts remain charged against request and spend caps, so retries cannot evade the limits.
 */
export async function reserveResearchSourceRequest(input: {
  orgId: string;
  jobId: string;
  requestId: string;
  source: ResearchSourceKey;
  requestUrl: string;
  transport?: SourceTransport;
  workerId?: string;
}): Promise<SourceRequestReservation> {
  const requestUrl = safeRequestUrl(input.requestUrl);
  return withSystem(async (db) => {
    if (input.workerId && !await lockActiveWorkJobLease(db, { jobId: input.jobId, orgId: input.orgId, workerId: input.workerId })) {
      throw new AppError("conflict", "The research job lease is no longer active. No new request was made.");
    }
    const { rows } = await db.query<{
      org_id: string; source: string; enabled: boolean; source_config: unknown;
      provider_fee_usd_per_request: string | number; per_job_request_cap: number; per_day_request_cap: number;
      per_job_spend_cap_usd: string | number; per_day_spend_cap_usd: string | number;
      approved_by: string | null; approved_at: Date | null;
    }>(
      `select org_id, source, enabled, source_config, provider_fee_usd_per_request,
              per_job_request_cap, per_day_request_cap, per_job_spend_cap_usd, per_day_spend_cap_usd,
              approved_by, approved_at
         from lead_research_source_settings
        where org_id = $1 and source = $2
        for update`,
      [input.orgId, input.source],
    );
    if (!rows[0]) throw new AppError("forbidden", "This source is not configured for the workspace.");
    const policy = policyRow(rows[0]);
    if (!policy.enabled) throw new AppError("forbidden", "This research source is disabled for the workspace.");
    if (policy.orgId !== input.orgId || !policy.approvedBy || !researchSourceApprovalCurrent(policy)) {
      throw new AppError("forbidden", "This source has no current workspace approval.");
    }
    const { rows: request } = await db.query(
      `select 1 from lead_research_requests where org_id = $1 and id = $2 and work_job_id = $3`,
      [input.orgId, input.requestId, input.jobId],
    );
    if (!request.length) throw new AppError("forbidden", "The source request belongs to a different research job.");

    // The accounting boundary is also a destination allowlist. A caller cannot use the budget
    // reservation API as a proxy to an unapproved host, even if it never invokes the research
    // adapters that repeat these checks before making a request.
    if (input.source === "openstreetmap") {
      const config = openStreetMapConfigSchema.parse(policy.sourceConfig);
      const endpoint = validateOpenStreetMapSourceConfig({
        enabled: true,
        endpoint: config.endpoint,
        approvedEndpointHosts: config.approvedEndpointHosts,
        userAgent: config.userAgent,
        providerFeeUsdPerRequest: policy.providerFeeUsdPerRequest,
        perJobSpendCapUsd: policy.perJobSpendCapUsd,
        maxResults: config.maxResults,
        timeoutSeconds: config.timeoutSeconds,
      });
      if (requestUrl !== `${endpoint.origin}${endpoint.pathname}`) {
        throw new AppError("forbidden", "This request does not match the exact approved OpenStreetMap endpoint.");
      }
    } else if (input.source === "fsa_directory") {
      const expected = fsaDirectoryRequestUrl(fsaDirectoryConfigSchema.parse(policy.sourceConfig));
      if (input.requestUrl !== expected.href || policy.perJobRequestCap > 1 || policy.perDayRequestCap > FSA_DIRECTORY_MAX_DAILY_REQUESTS) {
        throw new AppError("forbidden", "This request does not match the approved FSA directory destination, filters and limits.");
      }
      await assertFsaDirectoryApprover(db, input.orgId, policy.approvedBy);
    } else {
      const config = companyWebsiteConfigSchema.parse(policy.sourceConfig);
      validateCompanyWebsiteTarget(input.requestUrl, config.approvedDomains);
    }

    const utcDayStart = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    const usage = await db.query<{
      job_requests: number;
      day_requests: number;
      job_spend: string;
      day_spend: string;
      next_sequence: number;
      source_in_progress: boolean;
    }>(
      `select
         count(*) filter (where work_job_id = $2)::int as job_requests,
         count(*) filter (where created_at >= $3)::int as day_requests,
         coalesce(sum(provider_fee_usd) filter (where work_job_id = $2), 0)::text as job_spend,
         coalesce(sum(provider_fee_usd) filter (where created_at >= $3), 0)::text as day_spend,
         coalesce(max(sequence), 0)::int + 1 as next_sequence,
         count(*) filter (where status = 'reserved' and created_at > now() - interval '30 seconds') > 0 as source_in_progress
       from lead_research_source_usage
       where org_id = $1 and source = $4`,
      [input.orgId, input.jobId, utcDayStart, input.source],
    );
    const totals = usage.rows[0];
    const fee = policy.providerFeeUsdPerRequest;
    if (!totals) throw new AppError("forbidden", "The source request budget could not be verified.");
    if (input.source === "fsa_directory" && totals.source_in_progress) {
      throw new AppError("conflict", "The workspace has an FSA directory request in progress.");
    }
    if (totals.job_requests >= policy.perJobRequestCap) {
      throw new AppError("forbidden", "This research job has reached its approved per-job request cap.");
    }
    if (totals.day_requests >= policy.perDayRequestCap) {
      throw new AppError("forbidden", "This workspace has reached its approved per-day request cap.");
    }
    if (Number(totals.job_spend) + fee > policy.perJobSpendCapUsd
      || Number(totals.day_spend) + fee > policy.perDaySpendCapUsd) {
      throw new AppError("forbidden", "This research source would exceed its approved spend cap.");
    }

    const policySnapshot = {
      source: policy.source,
      transport: input.transport ?? null,
      sourceConfig: policy.sourceConfig,
      providerFeeUsdPerRequest: policy.providerFeeUsdPerRequest,
      perJobRequestCap: policy.perJobRequestCap,
      perDayRequestCap: policy.perDayRequestCap,
      perJobSpendCapUsd: policy.perJobSpendCapUsd,
      perDaySpendCapUsd: policy.perDaySpendCapUsd,
      approvedBy: policy.approvedBy,
      approvedAt: policy.approvedAt?.toISOString() ?? null,
    };
    const { rows: reservation } = await db.query<{ id: string }>(
      `insert into lead_research_source_usage (
         org_id, work_job_id, research_request_id, source, sequence, status, request_url,
         provider_fee_usd, policy_snapshot
       ) values ($1, $2, $3, $4, $5, 'reserved', $6, $7, $8::jsonb)
       returning id`,
      [input.orgId, input.jobId, input.requestId, input.source, totals.next_sequence, requestUrl, fee, JSON.stringify(policySnapshot)],
    );
    return { usageId: reservation[0].id, policy };
  });
}

/** Reads requests made under the current approval. Fixture and pre-provenance rows cannot establish provider health. */
export async function getResearchSourceHealth(db: Queryable, policy: StoredResearchSourcePolicy): Promise<ResearchSourceHealth> {
  const empty = { lastCompletedRunAt: null, lastResponseAt: null, lastError: null };
  if (!researchSourceApprovalCurrent(policy) || !policy.approvedAt) return empty;
  const { rows } = await db.query<{
    last_run_at: Date | null;
    last_response_at: Date | null;
    last_error_at: Date | null;
    error_http_status: number | null;
    invalid_response: boolean | null;
  }>(
    `with observed as (
       select u.id, u.work_job_id, u.completed_at, u.http_status,
              (u.status = 'responded' and u.http_status between 200 and 299
               and (u.source <> 'fsa_directory' or u.result_metadata ->> 'validPayload' = 'true')
               and (u.source <> 'openstreetmap' or u.result_metadata ->> 'validPayload' is distinct from 'false')) as success,
              (u.source in ('openstreetmap', 'fsa_directory') and u.http_status between 200 and 299
               and u.result_metadata ->> 'validPayload' = 'false') as invalid_response,
              (u.status = 'transport_failed' or (u.source in ('openstreetmap', 'fsa_directory') and u.http_status >= 400)
                or (u.source in ('openstreetmap', 'fsa_directory') and u.result_metadata ->> 'validPayload' = 'false')
                or u.http_status in (401, 403, 408, 410, 429) or u.http_status >= 500) as failed
         from lead_research_source_usage u
        where u.org_id = $1 and u.source = $2 and u.completed_at is not null and u.created_at >= $3::timestamptz
          and u.policy_snapshot ->> 'transport' = 'approved_source'
          and u.policy_snapshot ->> 'approvedAt' = $4
     ), last_error as (
       select completed_at, http_status, invalid_response from observed where failed order by completed_at desc, id desc limit 1
     )
     select (select max(j.finished_at) from observed o
                join ai_work_jobs j on j.id = o.work_job_id and j.org_id = $1
               where o.success and j.status = 'completed') as last_run_at,
            (select max(completed_at) from observed where success) as last_response_at,
            (select completed_at from last_error) as last_error_at,
            (select http_status from last_error) as error_http_status,
            (select invalid_response from last_error) as invalid_response`,
    [policy.orgId, policy.source, policy.approvedAt, policy.approvedAt.toISOString()],
  );
  const row = rows[0];
  if (!row) return empty;
  return {
    lastCompletedRunAt: row.last_run_at?.toISOString() ?? null,
    lastResponseAt: row.last_response_at?.toISOString() ?? null,
    lastError: row.last_error_at ? {
      at: row.last_error_at.toISOString(), httpStatus: row.error_http_status,
      ...(row.invalid_response ? { invalidResponse: true as const } : {}),
    } : null,
  };
}

/** Finalizes a reserved attempt. A timeout remains charged because the provider may have received it. */
export async function finishResearchSourceRequest(input: {
  orgId: string;
  usageId: string;
  responseReceived: boolean;
  httpStatus: number | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (input.httpStatus !== null && (!Number.isInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599)) {
    throw new AppError("invalid_input", "The source response status is invalid.");
  }
  await withSystem(async (db) => {
    const { rows } = await db.query<{ status: string }>(
      `update lead_research_source_usage
          set status = $3, http_status = $4, result_metadata = $5::jsonb, completed_at = now()
        where id = $1 and org_id = $2 and status = 'reserved'
        returning status`,
      [input.usageId, input.orgId, input.responseReceived ? "responded" : "transport_failed", input.httpStatus, JSON.stringify(input.metadata ?? {})],
    );
    if (!rows[0]) {
      const existing = await db.query<{ status: string }>(
        "select status from lead_research_source_usage where id = $1 and org_id = $2",
        [input.usageId, input.orgId],
      );
      if (!existing.rows[0]) throw new AppError("not_found", "Source usage reservation not found.");
      if (existing.rows[0].status !== (input.responseReceived ? "responded" : "transport_failed")) {
        throw new AppError("conflict", "The source usage reservation was already finalized differently.");
      }
    }
  });
}

export interface ResearchSourceUsageTracker {
  reserveRequest(url: URL): Promise<string>;
  finishRequest(usageId: string, result: { responseReceived: boolean; httpStatus: number | null; metadata?: Record<string, unknown> }): Promise<void>;
}

export async function getResearchSourceUsageForJob(db: Queryable, orgId: string, jobId: string) {
  const { rows } = await db.query<{
    source: ResearchSourceKey;
    requests: number;
    provider_fee_usd: string;
    reserved: number;
    transport_failed: number;
  }>(
    `select source, count(*)::int as requests,
            coalesce(sum(provider_fee_usd), 0)::text as provider_fee_usd,
            count(*) filter (where status = 'reserved')::int as reserved,
            count(*) filter (where status = 'transport_failed')::int as transport_failed
       from lead_research_source_usage
      where org_id = $1 and work_job_id = $2
      group by source
      order by case source when 'openstreetmap' then 0 else 1 end, source`,
    [orgId, jobId],
  );
  return rows.map((row) => ({
    source: row.source,
    requests: row.requests,
    providerFeeUsd: Number(row.provider_fee_usd),
    reserved: row.reserved,
    transportFailed: row.transport_failed,
  }));
}

export function createResearchSourceUsageTracker(input: {
  orgId: string;
  jobId: string;
  requestId: string;
  source: ResearchSourceKey;
  transport: SourceTransport;
  workerId?: string;
}): ResearchSourceUsageTracker {
  return {
    reserveRequest: async (url) => (await reserveResearchSourceRequest({ ...input, requestUrl: url.toString() })).usageId,
    finishRequest: async (usageId, result) => finishResearchSourceRequest({ ...input, usageId, ...result }),
  };
}

export function toOpenStreetMapAdapterConfig(policy: StoredResearchSourcePolicy): OpenStreetMapSourceConfig {
  if (policy.source !== "openstreetmap" || !policy.enabled) throw new AppError("forbidden", "OpenStreetMap research is disabled for this workspace.");
  const config = openStreetMapConfigSchema.parse(policy.sourceConfig);
  return {
    enabled: true,
    endpoint: config.endpoint,
    approvedEndpointHosts: config.approvedEndpointHosts,
    userAgent: config.userAgent,
    providerFeeUsdPerRequest: policy.providerFeeUsdPerRequest,
    perJobSpendCapUsd: policy.perJobSpendCapUsd,
    maxResults: config.maxResults,
    timeoutSeconds: config.timeoutSeconds,
  };
}

export function toCompanyWebsiteAdapterConfig(policy: StoredResearchSourcePolicy): CompanyWebsiteSourceConfig {
  if (policy.source !== "company_website" || !policy.enabled) throw new AppError("forbidden", "Company website research is disabled for this workspace.");
  const config = companyWebsiteConfigSchema.parse(policy.sourceConfig);
  return { enabled: true, approvedDomains: config.approvedDomains, maxRequests: config.maxRequests };
}

export function openStreetMapBounds(policy: StoredResearchSourcePolicy): GeographicBounds {
  if (policy.source !== "openstreetmap") throw new AppError("invalid_input", "OpenStreetMap bounds are not configured for this source.");
  return validateGeographicBounds(openStreetMapConfigSchema.parse(policy.sourceConfig).bounds);
}
