import "server-only";
import { z } from "zod";
import { FSA_DIRECTORY_ATTRIBUTION, FSA_DIRECTORY_NAME } from "@/lib/lead-research-sources";
import { providerRequest } from "@/server/calendars/adapters/http";
import { AppError } from "@/server/errors";
import type { ResearchSourceUsageTracker } from "./research-source-policy";

const API_ORIGIN = "https://api.ratings.food.gov.uk";
const RECORD_ORIGIN = "https://ratings.food.gov.uk";
const API_CATEGORY = { id: 1, label: "Restaurant/Cafe/Canteen" } as const;
const INDUSTRY = "Restaurant, café or canteen";
const MAX_PAGE_SIZE = 20;
const MAX_APPROVAL_MS = 30 * 24 * 60 * 60 * 1000;
export const FSA_DIRECTORY_MAX_DAILY_REQUESTS = 12;

const plainName = /^[\p{L}\p{M}\p{N} .’'&+()\-]+$/u;
export const fsaDirectoryConfigSchema = z.object({
  authorityId: z.number().int().min(1).max(9999),
  authorityCode: z.string().trim().regex(/^[A-Za-z0-9]{1,12}$/),
  authorityName: z.string().trim().min(2).max(100).regex(plainName),
  nameKeyword: z.string().trim().max(40).refine((value) => !value || (plainName.test(value) && /\p{L}/u.test(value))).default(""),
  maxResults: z.number().int().min(1).max(MAX_PAGE_SIZE),
  approvalExpiresOn: z.iso.date(),
  rightsAcknowledged: z.boolean(),
}).strict();

export type FsaDirectoryConfig = z.infer<typeof fsaDirectoryConfigSchema>;

export function fsaDirectoryApprovalCurrent(config: FsaDirectoryConfig, approvedAt: Date, now = Date.now()) {
  const expiresAt = Date.parse(`${config.approvalExpiresOn}T00:00:00.000Z`);
  return config.rightsAcknowledged && expiresAt > now && expiresAt > approvedAt.getTime()
    && expiresAt - approvedAt.getTime() <= MAX_APPROVAL_MS;
}

/** Only the approved authority, the FSA restaurant category and one bounded page can reach the provider. */
export function fsaDirectoryRequestUrl(config: FsaDirectoryConfig): URL {
  const url = new URL("/Establishments", API_ORIGIN);
  url.searchParams.set("localAuthorityId", String(config.authorityId));
  url.searchParams.set("businessTypeId", String(API_CATEGORY.id));
  url.searchParams.set("pageNumber", "1");
  url.searchParams.set("pageSize", String(config.maxResults));
  if (config.nameKeyword) url.searchParams.set("name", config.nameKeyword);
  return url;
}

const responseRecord = z.object({
  FHRSID: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  BusinessName: z.string().trim().min(2).max(160).regex(plainName).refine((name) => /\p{L}/u.test(name)),
  BusinessType: z.string(),
  BusinessTypeID: z.number().int(),
  LocalAuthorityCode: z.string(),
  LocalAuthorityName: z.string(),
  PostCode: z.string(),
});
const fullPostcode = /^(?:[A-Z]{1,2}\d[A-Z\d]?|GIR)\s*\d[A-Z]{2}$/iu;

export function parseFsaDirectoryResponse(raw: unknown, config: FsaDirectoryConfig) {
  const envelope = z.object({ establishments: z.array(z.unknown()).max(config.maxResults) }).safeParse(raw);
  if (!envelope.success) throw new AppError("upstream_error", "The FSA directory did not return a valid bounded page.");
  const records = envelope.data.establishments.map((item) => responseRecord.safeParse(item)).flatMap((item) => item.success ? [item.data] : []);
  if (envelope.data.establishments.length && !records.length) throw new AppError("upstream_error", "The FSA directory did not return usable business records.");
  const seen = new Set<number>();
  const keyword = config.nameKeyword.toLocaleLowerCase("en-GB");
  return records.flatMap((row) => {
    // The FSA publishes only the outward postcode for protected private addresses.
    if (row.LocalAuthorityCode !== config.authorityCode || row.LocalAuthorityName !== config.authorityName
      || row.BusinessType !== API_CATEGORY.label || row.BusinessTypeID !== API_CATEGORY.id
      || !fullPostcode.test(row.PostCode.trim()) || seen.has(row.FHRSID)
      || (keyword && !row.BusinessName.toLocaleLowerCase("en-GB").includes(keyword))) return [];
    seen.add(row.FHRSID);
    return [{
      businessName: row.BusinessName,
      industry: INDUSTRY,
      location: config.authorityName,
      evidenceUrl: new URL(`/business/${row.FHRSID}`, RECORD_ORIGIN).href,
      summary: `The FSA directory lists this establishment as a restaurant, café or canteen in ${config.authorityName}. Buying intent and first-party details require review. ${FSA_DIRECTORY_ATTRIBUTION}`,
    }];
  });
}

export type FsaDirectoryFetcher = (url: URL) => Promise<{ status: number; text: string }>;

const fetchFsaDirectoryPage: FsaDirectoryFetcher = (url) => providerRequest(null, url.href, [API_ORIGIN], {
  headers: { "x-api-version": "2", "Accept-Language": "en-GB" },
  maxBytes: 262_144,
  timeoutMs: 6000,
}, FSA_DIRECTORY_NAME);

export async function searchFsaDirectory(config: FsaDirectoryConfig, usage: ResearchSourceUsageTracker, fetcher = fetchFsaDirectoryPage) {
  const url = fsaDirectoryRequestUrl(config);
  const usageId = await usage.reserveRequest(url);
  let response: Awaited<ReturnType<FsaDirectoryFetcher>>;
  try {
    response = await fetcher(url);
  } catch {
    await usage.finishRequest(usageId, { responseReceived: false, httpStatus: null });
    throw new AppError("upstream_error", "The FSA directory request could not be completed. No retry was attempted.");
  }
  let candidates: ReturnType<typeof parseFsaDirectoryResponse> | null = null;
  if (response.status >= 200 && response.status < 300) {
    try {
      candidates = parseFsaDirectoryResponse(JSON.parse(response.text), config);
    } catch {
      // Only a valid bounded payload establishes provider health.
    }
  }
  await usage.finishRequest(usageId, { responseReceived: true, httpStatus: response.status, metadata: { validPayload: candidates !== null } });
  if (!candidates) {
    throw new AppError("upstream_error", response.status === 429
      ? "The FSA directory asked us to slow down. The request stopped and will not be retried."
      : "The FSA directory did not return a usable result. No retry was attempted.");
  }
  return { candidates, retrievedAt: new Date().toISOString() };
}
