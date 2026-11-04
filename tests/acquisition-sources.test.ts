import { describe, expect, it, vi } from "vitest";
import {
  buildOpenStreetMapQuery,
  parseOpenStreetMapResponse,
  searchOpenStreetMap,
  type GeographicBounds,
  type OpenStreetMapSourceConfig,
} from "@/server/leads/openstreetmap-source";
import {
  createCompanyWebsiteFetchPolicy,
  normalizeApprovedCompanyDomains,
  validateCompanyWebsiteTarget,
} from "@/server/leads/company-website-source";
import { analyzeWebsite, type PageFetcher } from "@/server/onboarding/website";

const BOUNDS: GeographicBounds = { south: 1.25, west: 103.7, north: 1.4, east: 103.9 };
const OSM_CONFIG: OpenStreetMapSourceConfig = {
  enabled: true,
  endpoint: "https://overpass-api.de/api/interpreter",
  approvedEndpointHosts: ["overpass-api.de"],
  userAgent: "iAcquireOS-acceptance/1.0 (owner-approved isolated test)",
  providerFeeUsdPerRequest: 0,
  perJobSpendCapUsd: 0,
  maxResults: 12,
};

describe("OpenStreetMap acceptance adapter", () => {
  it("builds a bounded, capped business POI query", () => {
    const query = buildOpenStreetMapQuery(BOUNDS, 12, 20);
    expect(query).toContain("[out:json][timeout:20]");
    expect(query).toContain("nwr[\"name\"][\"shop\"](1.25,103.7,1.4,103.9);");
    expect(query).toContain("out center tags 12;");
    expect(() => buildOpenStreetMapQuery({ ...BOUNDS, east: 106 }, 12)).toThrow("bounded local area");
    expect(() => buildOpenStreetMapQuery(BOUNDS, 51)).toThrow("between 1 and 50");
  });

  it("keeps stable OSM evidence IDs and drops unnamed, malformed, duplicate and unsafe website values", () => {
    const parsed = parseOpenStreetMapResponse({
      osm3s: { timestamp_osm_base: "2026-10-30T12:00:00Z" },
      elements: [
        { type: "way", id: 182, center: { lat: 1.33, lon: 103.82 }, tags: { name: "A & B Clinic", amenity: "clinic", "addr:city": "Singapore", website: "example.com" } },
        { type: "way", id: 182, tags: { name: "Duplicate" } },
        { type: "node", id: 77, lat: 1.3, lon: 103.8, tags: { name: "Unsafe", website: "https://127.0.0.1/" } },
        { type: "node", id: 78, tags: { shop: "bakery" } },
        { type: "other", id: 1, tags: { name: "Invalid type" } },
      ],
    }, 12);
    expect(parsed.dataTimestamp).toBe("2026-10-30T12:00:00.000Z");
    expect(parsed.candidates).toHaveLength(2);
    expect(parsed.candidates[0]).toMatchObject({
      osmType: "way",
      osmId: 182,
      businessName: "A & B Clinic",
      category: "clinic",
      websiteUrl: "https://example.com/",
      location: "Singapore",
      latitude: 1.33,
      longitude: 103.82,
      evidenceUrl: "https://www.openstreetmap.org/way/182",
      evidenceSource: "openstreetmap",
    });
    expect(parsed.candidates[1].websiteUrl).toBeNull();
  });

  it("does not request anything while disabled and enforces the exact endpoint allowlist", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ elements: [] }), { status: 200 }));
    await expect(searchOpenStreetMap({ ...OSM_CONFIG, enabled: false }, BOUNDS, fetcher as never)).rejects.toThrow("disabled");
    await expect(searchOpenStreetMap({ ...OSM_CONFIG, endpoint: "https://evil.example/api/interpreter" }, BOUNDS, fetcher as never)).rejects.toThrow("exact allowlist");
    await expect(searchOpenStreetMap({ ...OSM_CONFIG, providerFeeUsdPerRequest: 0.01, perJobSpendCapUsd: 0 }, BOUNDS, fetcher as never)).rejects.toThrow("per-job spend cap");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends one metered request and stops without retrying on throttling", async () => {
    const calls: Array<[URL, RequestInit]> = [];
    const fetcher = async (url: URL, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({
        osm3s: { timestamp_osm_base: "2026-10-30T12:00:00Z" },
        elements: [{ type: "node", id: 88, lat: 1.3, lon: 103.8, tags: { name: "Fixture Cafe", amenity: "cafe" } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const result = await searchOpenStreetMap(OSM_CONFIG, BOUNDS, fetcher);
    const [urlSeen, initSeen] = calls[0]!;
    expect(urlSeen?.toString()).toBe(OSM_CONFIG.endpoint);
    expect(initSeen?.method).toBe("POST");
    expect(initSeen?.redirect).toBe("error");
    expect(new Headers(initSeen?.headers).get("User-Agent")).toBe(OSM_CONFIG.userAgent);
    expect(decodeURIComponent(String(initSeen?.body).replace(/^data=/, ""))).toContain("out center tags 12;");
    expect(result).toMatchObject({
      attribution: "© OpenStreetMap contributors",
      license: "ODbL-1.0",
      usage: { requests: 1, providerFeeUsd: 0, infrastructureCostUsd: null },
      candidates: [{ businessName: "Fixture Cafe", evidenceUrl: "https://www.openstreetmap.org/node/88" }],
    });

    const throttled = vi.fn(async () => new Response("busy", { status: 429 }));
    await expect(searchOpenStreetMap(OSM_CONFIG, BOUNDS, throttled as never)).rejects.toThrow("will not be retried");
    expect(throttled).toHaveBeenCalledTimes(1);

    const oversized = vi.fn(async () => new Response("x".repeat(1_000_001), { status: 200 }));
    await expect(searchOpenStreetMap(OSM_CONFIG, BOUNDS, oversized as never)).rejects.toThrow("size limit");
    expect(oversized).toHaveBeenCalledTimes(1);
  });
});

describe("approved company website adapter policy", () => {
  it("requires HTTPS and an exact approved hostname", () => {
    expect(normalizeApprovedCompanyDomains(["Example.COM", "example.com"])).toEqual(["example.com"]);
    expect(validateCompanyWebsiteTarget("https://example.com/about", ["example.com"]).pathname).toBe("/about");
    expect(() => validateCompanyWebsiteTarget("https://www.example.com/", ["example.com"])).toThrow("exact domain");
    expect(() => validateCompanyWebsiteTarget("http://example.com/", ["example.com"])).toThrow("HTTPS");
    expect(() => normalizeApprovedCompanyDomains(["*.example.com"])).toThrow("without paths or wildcards");
    expect(() => normalizeApprovedCompanyDomains(["192.0.2.1"])).toThrow("valid public domain");
  });

  it("applies the same-host redirect rule, paces each host and enforces its request cap", async () => {
    const host = "source-policy-fixture.example";
    const wait = vi.fn(async () => undefined);
    const policy = createCompanyWebsiteFetchPolicy(
      { enabled: true, approvedDomains: [host], maxRequests: 2 },
      host,
      { now: () => 10_000, wait },
    );
    expect(policy.allowUrl?.(new URL("https://" + host + "/about"))).toBe(true);
    expect(policy.allowUrl?.(new URL("https://www." + host + "/about"))).toBe(false);
    expect(policy.allowUrl?.(new URL("http://" + host + "/about"))).toBe(false);
    await policy.beforeRequest?.(new URL("https://" + host + "/robots.txt"));
    await policy.beforeRequest?.(new URL("https://" + host + "/"));
    expect(policy.requestCount()).toBe(2);
    expect(wait).toHaveBeenCalledWith(1000);
    await expect(policy.beforeRequest?.(new URL("https://" + host + "/contact"))).rejects.toThrow("request cap");
  });

  it("fails closed when robots.txt cannot be checked", async () => {
    const fetcher: PageFetcher = async () => { throw new Error("fixture transport failed"); };
    await expect(analyzeWebsite(
      "https://robots-failure-fixture.example/",
      fetcher,
      { robotsFailureMode: "fail_closed" },
    )).rejects.toThrow("robots.txt");
  });
});
