import "server-only";
import net from "node:net";
import { AppError } from "@/server/errors";
import {
  analyzeWebsite,
  fetchPublicPageWithPolicy,
  parsePublicUrl,
  type PageFacts,
  type PublicPageFetchPolicy,
} from "@/server/onboarding/website";

const MAX_REQUESTS = 20;
const DEFAULT_REQUESTS = 8;
const MIN_HOST_INTERVAL_MS = 1000;
const nextHostRequestAt = new Map<string, number>();

export interface CompanyWebsiteSourceConfig {
  enabled: boolean;
  /** Exact hostnames only. A host does not implicitly approve its www or subdomains. */
  approvedDomains: string[];
  maxRequests?: number;
}

export interface CompanyWebsiteEvidence {
  provider: "company_website";
  domain: string;
  pages: PageFacts[];
  observedAt: string;
  unverified: true;
  usage: {
    requests: number;
    providerFeeUsd: 0;
    infrastructureCostUsd: null;
  };
}

function normalizeApprovedDomain(raw: string): string {
  const value = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!value || value.includes("*") || value.includes("/") || value.includes("@") || value.includes(":")) {
    throw new AppError("invalid_input", "Company website approvals must be exact hostnames without paths or wildcards.");
  }
  if (net.isIP(value)) throw new AppError("invalid_input", "A company website approval must be a valid public domain name.");
  let url: URL;
  try {
    url = parsePublicUrl("https://" + value);
  } catch {
    throw new AppError("invalid_input", "A company website approval must be a valid public domain name.");
  }
  if (url.hostname !== value || !value.includes(".")) {
    throw new AppError("invalid_input", "A company website approval must be a valid public domain name.");
  }
  return url.hostname.toLowerCase().replace(/\.$/, "");
}

export function normalizeApprovedCompanyDomains(domains: string[]): string[] {
  if (!Array.isArray(domains) || domains.length === 0 || domains.length > 100) {
    throw new AppError("invalid_input", "Add an exact company website domain before enabling this source.");
  }
  return [...new Set(domains.map(normalizeApprovedDomain))];
}

export function validateCompanyWebsiteTarget(rawUrl: string, approvedDomains: string[]): URL {
  const approved = normalizeApprovedCompanyDomains(approvedDomains);
  const url = parsePublicUrl(rawUrl);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || !approved.includes(host)) {
    throw new AppError("forbidden", "This website is not HTTPS on an exact domain approved for this acceptance test.");
  }
  return url;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Creates a request policy whose redirect checks, pacing and request cap apply to every hop. */
export function createCompanyWebsiteFetchPolicy(
  config: CompanyWebsiteSourceConfig,
  targetHost: string,
  dependencies: { now?: () => number; wait?: (ms: number) => Promise<void> } = {},
): PublicPageFetchPolicy & { requestCount: () => number } {
  if (config.enabled !== true) throw new AppError("forbidden", "Company website research is disabled for this workspace.");
  const host = normalizeApprovedDomain(targetHost);
  const approved = normalizeApprovedCompanyDomains(config.approvedDomains);
  if (!approved.includes(host)) throw new AppError("forbidden", "This company website domain is not approved for this acceptance test.");
  const maxRequests = config.maxRequests ?? DEFAULT_REQUESTS;
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > MAX_REQUESTS) {
    throw new AppError("invalid_input", "Company website request limits must be between 1 and 20.");
  }
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? sleep;
  let requests = 0;

  return {
    allowUrl: (url) => url.protocol === "https:" && url.hostname.toLowerCase().replace(/\.$/, "") === host,
    beforeRequest: async (url) => {
      if (url.protocol !== "https:" || url.hostname.toLowerCase().replace(/\.$/, "") !== host) {
        throw new AppError("forbidden", "This company website redirected outside its approved HTTPS domain.");
      }
      if (requests >= maxRequests) throw new AppError("forbidden", "The approved company website request cap was reached.");
      requests += 1;
      const current = now();
      const reservedAt = Math.max(current, nextHostRequestAt.get(host) ?? current);
      nextHostRequestAt.set(host, reservedAt + MIN_HOST_INTERVAL_MS);
      if (reservedAt > current) await wait(reservedAt - current);
    },
    requestCount: () => requests,
  };
}

/**
 * Reads a small set of pages from one approved company domain. Network redirects are checked before
 * following them, robots.txt failures stop the run, and the result remains explicitly unverified.
 */
export async function researchApprovedCompanyWebsite(
  rawUrl: string,
  config: CompanyWebsiteSourceConfig,
): Promise<CompanyWebsiteEvidence> {
  if (config.enabled !== true) throw new AppError("forbidden", "Company website research is disabled for this workspace.");
  const start = validateCompanyWebsiteTarget(rawUrl, config.approvedDomains);
  const policy = createCompanyWebsiteFetchPolicy(config, start.hostname);
  const result = await analyzeWebsite(
    start.toString(),
    (url) => fetchPublicPageWithPolicy(url, policy),
    { robotsFailureMode: "fail_closed" },
  );
  return {
    provider: "company_website",
    domain: start.hostname.toLowerCase().replace(/\.$/, ""),
    pages: result.pages,
    observedAt: result.analyzedAt,
    unverified: true,
    usage: {
      requests: policy.requestCount(),
      providerFeeUsd: 0,
      infrastructureCostUsd: null,
    },
  };
}
