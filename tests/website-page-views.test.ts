import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSiteRuntime, withSystem, withUser } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { isSiteDocumentRequest, recordSitePageView } from "@/server/sites/runtime";
import { websitePageViewReport } from "@/server/attribution/page-views";
import { prepareEmployeeEvidence } from "@/server/workforce/employee-evidence";
import { AI_GROWTH_PARTNER_ROLE_KEY } from "@/lib/agents";
import { saveOnboardingStep } from "@/server/onboarding/service";
import { createWebsite, publishWebsite } from "@/server/websites/service";
import { ensureGrowthPartnerRuntime } from "@/server/workforce/service";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";

const HOST = "page-view-co.sites.test.example";
const DOWN = readFileSync("supabase/rollbacks/0135_website_page_views.down.sql", "utf8");

function statements(sql: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let inside = false;
  for (const raw of sql.split("\n")) {
    const line = raw.replace("\r", "");
    if (!inside && (!line.trim() || line.trim().startsWith("--"))) continue;
    current.push(line);
    if (line.split("$$").length % 2 === 0) inside = !inside;
    if (!inside && line.trimEnd().endsWith(";")) {
      out.push(current.join("\n"));
      current = [];
    }
  }
  return out;
}

let org: Awaited<ReturnType<typeof createOrg>>;
let owner: Awaited<ReturnType<typeof createUser>>;
let otherOrg: Awaited<ReturnType<typeof createOrg>>;
let otherOwner: Awaited<ReturnType<typeof createUser>>;

beforeAll(async () => {
  process.env.SITES_PROBE_ORIGIN = "http://127.0.0.1:9";
  process.env.SITES_BASE_DOMAIN = "sites.test.example";
  resetEnvCache();
  org = await createOrg({ name: "Page View Co" });
  owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  await withSystem((db) => ensureGrowthPartnerRuntime(org.id, db));
  const ctx = ctxFor(owner, org, "owner");
  await saveOnboardingStep(ctx, { answers: {
    "a.business_name": { value: "Page View Co" }, "a.industry": { value: "home_services" }, "a.description": { value: "We help local customers." },
    "a.contact_email": { value: "hello@page-view.test" }, "b.services": { value: "Repairs" },
  } });
  await createWebsite(ctx, { templateKey: "corp.summit" });
  const publication = async () => (await withSystem((db) => db.query<{ id: string }>("select published_publication_id as id from websites where org_id = $1", [org.id]))).rows[0].id;
  await publishWebsite(ctx, { acknowledgeClaims: true }, { probe: async () => ({ status: 200, body: `<i data-site-publication="${await publication()}"></i>` }) });

  otherOrg = await createOrg({ name: "Other Page View Co" });
  otherOwner = await createUser();
  await addMember(otherOrg.id, otherOwner.id, "owner");
});

afterAll(() => {
  delete process.env.SITES_PROBE_ORIGIN;
  delete process.env.SITES_BASE_DOMAIN;
  resetEnvCache();
});

describe("published website page-load measurement", () => {
  it("counts browser document navigations and excludes subresources, RSC and non-GET requests", () => {
    expect(isSiteDocumentRequest({ method: "GET", destination: "document", mode: "navigate", accept: "text/html" })).toBe(true);
    expect(isSiteDocumentRequest({ method: "GET", destination: null, mode: null, accept: "text/html,application/xhtml+xml" })).toBe(true);
    expect(isSiteDocumentRequest({ method: "GET", destination: "image", mode: "no-cors", accept: "image/avif" })).toBe(false);
    expect(isSiteDocumentRequest({ method: "GET", destination: "empty", mode: "cors", accept: "text/x-component" })).toBe(false);
    expect(isSiteDocumentRequest({ method: "HEAD", destination: "document", mode: "navigate", accept: "text/html" })).toBe(false);
    expect(isSiteDocumentRequest({ method: "POST", destination: "document", mode: "navigate", accept: "text/html" })).toBe(false);
  });

  it("persists only tenant-scoped daily aggregates, normalized campaign values and the referring host", async () => {
    await recordSitePageView({
      host: HOST,
      pageSlug: "home",
      utm: { utm_source: "Google Ads", utm_medium: "CPC", utm_campaign: "Roofing Spring 2026", utm_term: "private search text" },
      referrer: "https://search.example/search?email=person@example.net&token=secret",
    });
    await recordSitePageView({
      host: HOST,
      pageSlug: "about",
      utm: { utm_source: "person@example.net", utm_campaign: "valid-campaign" },
      referrer: "https://page-view-co.sites.test.example/about?private=value",
    });
    await recordSitePageView({ host: "unverified.example.test", pageSlug: "home", utm: { utm_source: "forged" } });
    await recordSitePageView({ host: HOST, pageSlug: "thanks", utm: { utm_source: "google" } });

    const day = new Date().toISOString().slice(0, 10);
    const aggregate = await withSystem((db) => db.query<{ page_views: string }>("select page_views::text from website_usage_daily where org_id = $1 and day = $2::date", [org.id, day]));
    expect(aggregate.rows[0]?.page_views).toBe("2");
    const details = await withSystem((db) => db.query<{
      page_slug: string; utm_source: string; utm_medium: string; utm_campaign: string; referrer_host: string; page_views: string;
    }>("select page_slug, utm_source, utm_medium, utm_campaign, referrer_host, page_views::text from website_page_views_daily where org_id = $1 and day = $2::date order by page_slug", [org.id, day]));
    expect(details.rows).toEqual([
      { page_slug: "about", utm_source: "", utm_medium: "", utm_campaign: "valid-campaign", referrer_host: "", page_views: "1" },
      { page_slug: "home", utm_source: "google-ads", utm_medium: "cpc", utm_campaign: "roofing-spring-2026", referrer_host: "search.example", page_views: "1" },
    ]);
    expect(JSON.stringify(details.rows)).not.toMatch(/private|person@example|token=|search\?/i);
  });

  it("reports the same daily page-load count to an authorized owner and hides it from another tenant", async () => {
    const startsAt = new Date(Date.now() - 86_400_000);
    const endsAt = new Date(Date.now() + 60_000);
    const visible = await withUser(owner.id, (db) => websitePageViewReport(db, org.id, startsAt, endsAt));
    const foreign = await withUser(otherOwner.id, (db) => websitePageViewReport(db, org.id, startsAt, endsAt));
    expect(visible.total).toBe(2);
    expect(visible.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ page: "home", source: "google-ads", medium: "cpc", campaign: "roofing-spring-2026", referringHost: "search.example", pageLoads: 1 }),
      expect.objectContaining({ page: "about", source: null, medium: null, campaign: "valid-campaign", referringHost: null, pageLoads: 1 }),
    ]));
    expect(foreign).toEqual({ total: 0, rows: [] });
  });

  it("makes the recorded page-load and campaign evidence available in the one Growth Partner snapshot", async () => {
    const prepared = await prepareEmployeeEvidence(ctxFor(owner, org, "owner"), {
      agentId: await agentId(org.id, AI_GROWTH_PARTNER_ROLE_KEY),
      roleKey: AI_GROWTH_PARTNER_ROLE_KEY,
      now: new Date(),
    });
    const performance = prepared.evidence.sections.find((section) => section.id === "performance");
    expect(performance).toBeDefined();
    expect(performance?.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ measure: "Published website page loads", value: 2 }),
      expect.objectContaining({ measure: expect.stringContaining("google-ads"), value: 1 }),
    ]));
    expect(JSON.stringify(performance)).toContain("no unique visitors");
  });

  it("keeps the runtime table surface restricted and refuses a data-losing rollback", async () => {
    await expect(withSiteRuntime((db) => db.query("select * from website_page_views_daily"))).rejects.toThrow(/permission denied/i);
    await expect(withSiteRuntime((db) => db.query("insert into website_page_views_daily (website_id, org_id, day, page_slug) values (gen_random_uuid(), gen_random_uuid(), current_date, 'home')"))).rejects.toThrow(/permission denied/i);

    await expect(withSystem(async (db) => {
      for (const statement of statements(DOWN)) await db.query(statement);
    })).rejects.toThrow(/Rollback refused: website page-view aggregates exist/);
    const remains = await withSystem((db) => db.query<{ page_views: string }>("select sum(page_views)::text as page_views from website_usage_daily where org_id = $1", [org.id]));
    expect(remains.rows[0]?.page_views).toBe("2");
  });
});
