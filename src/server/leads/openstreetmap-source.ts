import "server-only";
import { AppError } from "@/server/errors";
import { parsePublicUrl } from "@/server/onboarding/website";

const MAX_BOUNDS_SPAN = 1.5;
const MAX_RESULTS = 50;
const ATTRIBUTION = "© OpenStreetMap contributors";

export interface GeographicBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface OpenStreetMapSourceConfig {
  enabled: boolean;
  endpoint: string;
  approvedEndpointHosts: string[];
  userAgent: string;
  /** Set from the reviewed fee for one request to the selected endpoint. */
  providerFeeUsdPerRequest: number;
  /** Maximum provider fee this isolated research job may incur. */
  perJobSpendCapUsd: number;
  maxResults?: number;
  timeoutSeconds?: number;
}

export interface OpenStreetMapCandidate {
  osmType: "node" | "way" | "relation";
  osmId: number;
  businessName: string;
  category: string | null;
  websiteUrl: string | null;
  location: string | null;
  latitude: number | null;
  longitude: number | null;
  evidenceUrl: string;
  evidenceSource: "openstreetmap";
}

export interface OpenStreetMapResearchResult {
  candidates: OpenStreetMapCandidate[];
  attribution: string;
  license: "ODbL-1.0";
  dataTimestamp: string | null;
  retrievedAt: string;
  usage: {
    requests: 1;
    providerFeeUsd: number;
    infrastructureCostUsd: null;
  };
}

function validCoordinate(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

export function validateGeographicBounds(bounds: GeographicBounds): GeographicBounds {
  const values = [bounds.south, bounds.west, bounds.north, bounds.east];
  if (!values.every(Number.isFinite)
    || !validCoordinate(bounds.south, -90, 90)
    || !validCoordinate(bounds.north, -90, 90)
    || !validCoordinate(bounds.west, -180, 180)
    || !validCoordinate(bounds.east, -180, 180)
    || bounds.south >= bounds.north
    || bounds.west >= bounds.east
    || bounds.north - bounds.south > MAX_BOUNDS_SPAN
    || bounds.east - bounds.west > MAX_BOUNDS_SPAN) {
    throw new AppError("invalid_input", "Choose a valid, bounded local area for OpenStreetMap research.");
  }
  return bounds;
}

function queryNumber(value: number): string {
  return value.toFixed(5).replace(/0+$/, "").replace(/\.$/, "");
}

/** Builds one bounded POI query. The selected categories avoid a general-purpose map export. */
export function buildOpenStreetMapQuery(bounds: GeographicBounds, maxResults = 25, timeoutSeconds = 25): string {
  const area = validateGeographicBounds(bounds);
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) {
    throw new AppError("invalid_input", "OpenStreetMap result limits must be between 1 and 50.");
  }
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 25) {
    throw new AppError("invalid_input", "OpenStreetMap query timeouts must be between 1 and 25 seconds.");
  }
  const bbox = `(${queryNumber(area.south)},${queryNumber(area.west)},${queryNumber(area.north)},${queryNumber(area.east)})`;
  return [
    `[out:json][timeout:${timeoutSeconds}];`,
    "(",
    `  nwr["name"]["shop"]${bbox};`,
    `  nwr["name"]["office"]${bbox};`,
    `  nwr["name"]["craft"]${bbox};`,
    `  nwr["name"]["amenity"~"^(bank|cafe|clinic|dentist|doctors|restaurant|veterinary)$"]${bbox};`,
    ");",
    `out center tags ${maxResults};`,
  ].join("\n");
}

function safeWebsiteHint(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 500) return null;
  const raw = value.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".")) return null;
  try {
    return parsePublicUrl(url.toString()).toString();
  } catch {
    return null;
  }
}

function cleanTag(tags: Record<string, unknown>, key: string, max = 180): string | null {
  const value = tags[key];
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return clean || null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeCoordinate(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && validCoordinate(value, min, max) ? value : null;
}

function safeObjectId(type: unknown, id: unknown): { type: OpenStreetMapCandidate["osmType"]; id: number } | null {
  if ((type !== "node" && type !== "way" && type !== "relation") || typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null;
  return { type, id };
}

/** Parses only business-name features and preserves the source object's stable OSM identity. */
export function parseOpenStreetMapResponse(payload: unknown, maxResults = 25): { candidates: OpenStreetMapCandidate[]; dataTimestamp: string | null } {
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) {
    throw new AppError("invalid_input", "OpenStreetMap result limits must be between 1 and 50.");
  }
  const root = asRecord(payload);
  if (!root || !Array.isArray(root.elements)) throw new AppError("upstream_error", "OpenStreetMap returned an unexpected response.");
  const osm3s = asRecord(root.osm3s);
  const timestamp = typeof osm3s?.timestamp_osm_base === "string" && !Number.isNaN(Date.parse(osm3s.timestamp_osm_base))
    ? new Date(osm3s.timestamp_osm_base).toISOString()
    : null;
  const candidates: OpenStreetMapCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of root.elements) {
    if (candidates.length >= maxResults) break;
    const element = asRecord(raw);
    if (!element) continue;
    const identity = safeObjectId(element.type, element.id);
    const tags = asRecord(element.tags);
    const businessName = tags ? cleanTag(tags, "name", 200) : null;
    if (!identity || !tags || !businessName) continue;
    const key = `${identity.type}/${identity.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const center = asRecord(element.center);
    const latitude = safeCoordinate(element.lat, -90, 90) ?? safeCoordinate(center?.lat, -90, 90);
    const longitude = safeCoordinate(element.lon, -180, 180) ?? safeCoordinate(center?.lon, -180, 180);
    const address = ["addr:housenumber", "addr:street", "addr:city", "addr:postcode"]
      .map((tag) => cleanTag(tags, tag, 100))
      .filter(Boolean)
      .join(" ");
    const category = ["shop", "office", "craft", "amenity"].map((tag) => cleanTag(tags, tag, 80)).find(Boolean) ?? null;
    const websiteUrl = safeWebsiteHint(tags.website ?? tags["contact:website"] ?? tags.url);
    candidates.push({
      osmType: identity.type,
      osmId: identity.id,
      businessName,
      category,
      websiteUrl,
      location: address || null,
      latitude,
      longitude,
      evidenceUrl: `https://www.openstreetmap.org/${identity.type}/${identity.id}`,
      evidenceSource: "openstreetmap",
    });
  }
  return { candidates, dataTimestamp: timestamp };
}

function configuredEndpoint(config: OpenStreetMapSourceConfig): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    throw new AppError("invalid_input", "Choose an approved OpenStreetMap endpoint before running research.");
  }
  if (!Array.isArray(config.approvedEndpointHosts) || config.approvedEndpointHosts.length === 0) {
    throw new AppError("invalid_input", "Choose an exact OpenStreetMap endpoint hostname allowlist.");
  }
  const host = endpoint.hostname.toLowerCase().replace(/\.$/, "");
  const allowed = config.approvedEndpointHosts
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase().replace(/\.$/, ""));
  if (endpoint.protocol !== "https:"
    || endpoint.username
    || endpoint.password
    || endpoint.port
    || endpoint.search
    || endpoint.hash
    || endpoint.pathname !== "/api/interpreter"
    || !allowed.includes(host)) {
    throw new AppError("forbidden", "The OpenStreetMap endpoint is not in this acceptance test's exact allowlist.");
  }
  if (!config.userAgent.trim() || config.userAgent.length > 200 || /[\r\n]/.test(config.userAgent)) {
    throw new AppError("invalid_input", "Configure an identifying User-Agent for the selected OpenStreetMap endpoint.");
  }
  return endpoint;
}

export type OverpassFetcher = (url: URL, init: RequestInit) => Promise<Response>;
const MAX_RESPONSE_BYTES = 1_000_000;

async function readLimitedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new AppError("upstream_error", "OpenStreetMap returned an empty response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new AppError("upstream_error", "OpenStreetMap's response exceeded the size limit and was discarded.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AppError("upstream_error", "OpenStreetMap returned invalid JSON. The response was not used.");
    }
  } finally {
    reader.releaseLock();
  }
}

/** Makes exactly one bounded request and never retries a denied or failed call. */
export async function searchOpenStreetMap(
  config: OpenStreetMapSourceConfig,
  bounds: GeographicBounds,
  fetcher: OverpassFetcher = fetch,
): Promise<OpenStreetMapResearchResult> {
  if (config.enabled !== true) throw new AppError("forbidden", "OpenStreetMap research is disabled for this workspace.");
  if (!Number.isFinite(config.providerFeeUsdPerRequest)
    || config.providerFeeUsdPerRequest < 0
    || !Number.isFinite(config.perJobSpendCapUsd)
    || config.perJobSpendCapUsd < config.providerFeeUsdPerRequest) {
    throw new AppError("forbidden", "Set the selected endpoint's reviewed request fee and a sufficient per-job spend cap before running research.");
  }
  const endpoint = configuredEndpoint(config);
  const maxResults = config.maxResults ?? 25;
  const timeoutSeconds = config.timeoutSeconds ?? 25;
  const query = buildOpenStreetMapQuery(bounds, maxResults, timeoutSeconds);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  let response: Response;
  let payload: unknown;
  try {
    response = await fetcher(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        "User-Agent": config.userAgent,
        Accept: "application/json",
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
      cache: "no-store",
      redirect: "error",
    });
    if (response.ok) payload = await readLimitedJson(response);
    else await response.body?.cancel().catch(() => undefined);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("upstream_error", "OpenStreetMap could not complete this bounded research request. No retry was attempted.");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new AppError("upstream_error", response.status === 429
      ? "OpenStreetMap asked us to slow down. The request stopped and will not be retried."
      : "OpenStreetMap did not complete this bounded research request. No retry was attempted.");
  }
  const parsed = parseOpenStreetMapResponse(payload, maxResults);
  return {
    ...parsed,
    attribution: ATTRIBUTION,
    license: "ODbL-1.0",
    retrievedAt: new Date().toISOString(),
    usage: { requests: 1, providerFeeUsd: config.providerFeeUsdPerRequest, infrastructureCostUsd: null },
  };
}
