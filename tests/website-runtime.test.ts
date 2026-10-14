import * as React from "react";
import sharp from "sharp";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { createAsset } from "@/server/assets/service";
import { saveOnboardingStep } from "@/server/onboarding/service";
import { SiteRenderer } from "@/components/website/site-renderer";
import { routeRequest, siteContentSecurityPolicy, type DeploymentRole } from "@/lib/site-routing";
import { handleEnquiry, errorPage } from "@/server/sites/enquiry";
import { checkFormToken, hashClient, issueFormToken } from "@/server/sites/form-token";
import { clearSiteCache, loadSiteAsset, recordUsage, flushUsage, resolveSite, siteAssets } from "@/server/sites/runtime";
import { assetResolver } from "@/server/sites/render";
import { createWebsite, getDraft, publishWebsite, saveDraft } from "@/server/websites/service";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";

describe("deciding which requests are the portal's and which are a customer's site", () => {
  const route = (role: DeploymentRole, host: string | null, pathname: string) => routeRequest({ role, hostHeader: host, pathname, portalHosts: ["app.iacquire.com"] });

  it("never exposes the internal site routes to a visitor, whatever the deployment", () => {
    for (const role of ["portal", "sites", "both"] as const) {
      for (const path of ["/site-runtime", "/site-runtime/evil.example/p", "/site-runtime/x/form"]) expect(route(role, "anything.example", path), `${role} ${path}`).toEqual({ kind: "block" });
    }
  });

  it("treats every request as the portal's on a portal deployment", () => {
    expect(route("portal", "app.iacquire.com", "/overview")).toEqual({ kind: "portal" });
    expect(route("portal", "roof-co.sites.iacquire.com", "/")).toEqual({ kind: "portal" }); // misrouted site traffic never reaches site code here
  });

  it("treats every request as a site's on a sites deployment, including the portal's own paths", () => {
    expect(route("sites", "roof-co.sites.iacquire.com", "/")).toMatchObject({ kind: "site", host: "roof-co.sites.iacquire.com", target: "/site-runtime/roof-co.sites.iacquire.com/p", isForm: false });
    expect(route("sites", "ROOF-CO.sites.iacquire.com:443", "/about")).toMatchObject({ host: "roof-co.sites.iacquire.com", target: "/site-runtime/roof-co.sites.iacquire.com/p/about" });
    // Portal paths are just (missing) pages on a site host. They never reach portal code.
    for (const path of ["/admin", "/login", "/overview", "/api/internal/tick", "/api/webhooks/paymongo", "/settings/billing"]) {
      expect(route("sites", "x.example.com", path), path).toMatchObject({ kind: "site", target: expect.stringContaining("/site-runtime/x.example.com/p/") });
    }
    expect(route("sites", null, "/")).toEqual({ kind: "block" });
    expect(route("sites", "", "/")).toEqual({ kind: "block" });
  });

  it("maps the site's special addresses", () => {
    expect(route("sites", "a.example.com", "/__iaq/form")).toMatchObject({ target: "/site-runtime/a.example.com/form", isForm: true });
    expect(route("sites", "a.example.com", "/_a/" + "ab".repeat(32))).toMatchObject({ target: `/site-runtime/a.example.com/asset/${"ab".repeat(32)}` });
    expect(route("sites", "a.example.com", "/_a/x/../../admin")).toMatchObject({ target: "/site-runtime/a.example.com/asset/x" }); // only the first segment is ever used
    expect(route("sites", "a.example.com", "/robots.txt")).toMatchObject({ target: "/site-runtime/a.example.com/robots" });
    expect(route("sites", "a.example.com", "/sitemap.xml")).toMatchObject({ target: "/site-runtime/a.example.com/sitemap" });
    expect(route("sites", "a.example.com", "/_next/static/chunks/app.js")).toEqual({ kind: "pass" });
  });

  it("in development, keeps the portal's own hosts and sends every other host to the site runtime", () => {
    for (const host of ["localhost:3100", "127.0.0.1:3100", "app.iacquire.com", "APP.iacquire.com", null, ""]) expect(route("both", host, "/overview"), String(host)).toEqual({ kind: "portal" });
    expect(route("both", "acme.sites.localhost:3100", "/")).toMatchObject({ kind: "site", host: "acme.sites.localhost" });
    expect(route("both", "customer.example.com", "/pricing")).toMatchObject({ kind: "site" });
  });

  it("gives public sites a strict policy with no third parties", () => {
    const csp = siteContentSecurityPolicy("N0NCE", false);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' 'nonce-N0NCE' 'strict-dynamic'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).not.toMatch(/unsafe-eval|http:|https:/);
    expect(csp).toContain("style-src 'self';"); // inline <style> is not allowed in production
    expect(siteContentSecurityPolicy("n", true)).toContain("'unsafe-eval'");
  });
});

describe("the spam-control token", () => {
  const now = 1_800_000_000_000;
  it("accepts a token that is old enough and fresh enough, for the host it was issued to", () => {
    const t = issueFormToken("a.example.com", now);
    expect(checkFormToken("a.example.com", t, now + 3_000)).toEqual({ ok: true });
    expect(checkFormToken("a.example.com", t, now + 1_000)).toEqual({ ok: false, reason: "too_fast" });
    expect(checkFormToken("a.example.com", t, now + 7 * 3600_000)).toEqual({ ok: false, reason: "expired" });
    expect(checkFormToken("b.example.com", t, now + 3_000)).toEqual({ ok: false, reason: "forged" }); // can't be reused on another site
  });
  it("rejects missing, malformed and tampered tokens", () => {
    const t = issueFormToken("a.example.com", now);
    const [ts, mac] = t.split(".");
    expect(checkFormToken("a.example.com", undefined, now)).toMatchObject({ reason: "missing" });
    expect(checkFormToken("a.example.com", "garbage", now + 3000)).toMatchObject({ reason: "malformed" });
    expect(checkFormToken("a.example.com", `${Number(ts) - 10000}.${mac}`, now + 20000)).toMatchObject({ reason: "forged" }); // back-dating
    expect(checkFormToken("a.example.com", `${ts}.${mac.slice(0, -2)}xx`, now + 3000)).toMatchObject({ reason: "forged" });
    expect(hashClient("203.0.113.9")).toMatch(/^[0-9a-f]{40}$/);
    expect(hashClient("203.0.113.9")).not.toContain("203");
  });
});

// ---------------------------------------------------------------------------

type Person = { id: string; email: string };
let org: Awaited<ReturnType<typeof createOrg>>;
let owner: Person;
const HOST = "enquiry-co.sites.test.example";
const as = () => ctxFor(owner, org, "owner");
const tokenAt = (t: number) => issueFormToken(HOST, t);

beforeAll(async () => {
  process.env.SITES_PROBE_ORIGIN = "http://127.0.0.1:9";
  process.env.SITES_BASE_DOMAIN = "sites.test.example";
  resetEnvCache();
  org = await createOrg({ name: "Enquiry Co" });
  owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  await saveOnboardingStep(as(), {
    answers: {
      "a.business_name": { value: "Enquiry Co" }, "a.industry": { value: "other" }, "a.description": { value: "We help people with their enquiries." }, "a.contact_email": { value: "hi@enquiry.test" },
      "b.services": { value: "Consulting, Support" },
    },
  });
  await createWebsite(as(), { templateKey: "summit.peak" });
  const png = await sharp({ create: { width: 480, height: 320, channels: 3, background: "#2255aa" } }).png().toBuffer();
  const asset = await createAsset(as(), { kind: "image", bytes: png, filename: "team.png", altText: "Our team at work" });
  const d = (await getDraft(as()))!;
  const c = structuredClone(d.content);
  (c.pages[0].sections[0].data as { image: string | null }).image = asset.id;
  await saveDraft(as(), { content: c, expectedRevision: d.revision });
  const live = async () => (await withSystem((db) => db.query<{ id: string }>("select published_publication_id as id from websites where org_id = $1", [org.id]))).rows[0].id;
  await publishWebsite(as(), { acknowledgeClaims: true }, { probe: async () => ({ status: 200, body: `<i data-site-publication="${await live()}"></i>` }) });
  clearSiteCache();
});
afterAll(() => {
  delete process.env.SITES_PROBE_ORIGIN;
  delete process.env.SITES_BASE_DOMAIN;
  resetEnvCache();
});

const base = (now: number, over: Record<string, string> = {}, req: Partial<Parameters<typeof handleEnquiry>[0]> = {}) => ({
  host: HOST, origin: `https://${HOST}`, secFetchSite: "same-origin", forwardedFor: "198.51.100.7", referer: `https://${HOST}/contact?utm_source=google&utm_medium=cpc&x=1`, now,
  fields: { p: "contact", t: tokenAt(now - 4000), name: "Alex Kim", email: "alex@example.net", phone: "", message: "Can you help?", service: "", consent: "yes", company_website: "", ...over }, ...req,
});
const count = async () => Number((await withSystem((db) => db.query<{ n: string }>("select count(*) as n from website_form_submissions where org_id = $1", [org.id]))).rows[0].n);

describe("the public enquiry endpoint", () => {
  it("accepts a normal enquiry and stores it for the owner, with a keyed hash instead of the visitor's address", async () => {
    const now = Date.now();
    const res = await handleEnquiry(base(now));
    expect(res).toEqual({ kind: "redirect", to: "/thanks" });
    const row = (await withSystem((db) => db.query<{ name: string; email: string; ip_hash: string; utm: Record<string, string>; consent_text: string; status: string }>("select name, email, ip_hash, utm, consent_text, status from website_form_submissions where org_id = $1", [org.id]))).rows[0];
    expect(row).toMatchObject({ name: "Alex Kim", email: "alex@example.net", status: "received", consent_text: "I agree to be contacted about my enquiry." });
    expect(row.ip_hash).toBe(hashClient("198.51.100.7"));
    expect(row.ip_hash).not.toContain("198");
    expect(row.utm).toEqual({ utm_source: "google", utm_medium: "cpc" }); // only utm_ parameters, never other query data
  });

  it("treats a repeat of the same enquiry as the same enquiry", async () => {
    const before = await count();
    const now = Date.now();
    expect(await handleEnquiry(base(now))).toEqual({ kind: "redirect", to: "/thanks" });
    expect(await count()).toBe(before);
  });

  it("only accepts forms sent from the site itself", async () => {
    const now = Date.now();
    const before = await count();
    for (const [origin, fetchSite] of [["https://evil.example", "cross-site"], [null, "cross-site"], [null, null], ["null", "same-site"], ["not a url", "same-origin"]] as const) {
      const res = await handleEnquiry(base(now, { email: `x${before}@example.net`, message: `m${origin}${fetchSite}` }, { origin, secFetchSite: fetchSite }));
      expect(res, `${origin}/${fetchSite}`).toMatchObject({ kind: "error", status: 403 });
    }
    // No Origin header, but the browser says it is same-origin: fine.
    expect((await handleEnquiry(base(now, { email: "no-origin@example.net" }, { origin: null, secFetchSite: "same-origin" }))).kind).toBe("redirect");
    expect(await handleEnquiry({ ...base(now), host: "nobody.example.org" })).toMatchObject({ kind: "error", status: 404 });
  });

  it("quietly drops submissions that fill the hidden trap field", async () => {
    const before = await count();
    const now = Date.now();
    expect(await handleEnquiry(base(now, { company_website: "http://spam.example", email: "bot@example.net" }))).toEqual({ kind: "redirect", to: "/thanks" });
    expect(await count()).toBe(before);
  });

  it("refuses forms that are missing, forged, instant or stale", async () => {
    const now = Date.now();
    const common = { email: "tok@example.net", message: "token test" };
    expect(await handleEnquiry(base(now, { ...common, t: "" }))).toMatchObject({ kind: "error", status: 400 });
    expect(await handleEnquiry(base(now, { ...common, t: `${now - 5000}.forged` }))).toMatchObject({ kind: "error", status: 400 });
    expect(await handleEnquiry(base(now, { ...common, t: tokenAt(now - 500) }))).toMatchObject({ kind: "error", status: 429, message: expect.stringMatching(/wait a couple of seconds/) });
    expect(await handleEnquiry(base(now, { ...common, t: tokenAt(now - 7 * 3600_000) }))).toMatchObject({ kind: "error", status: 400, message: expect.stringMatching(/expired/) });
  });

  it("validates what was entered and says what is wrong in plain words", async () => {
    const now = Date.now();
    let n = 0;
    // Each attempt comes from a different visitor so the per-visitor limit (tested separately) does not interfere.
    const bad = async (over: Record<string, string>) => (await handleEnquiry(base(now, { message: `v${Math.random()}`, ...over }, { forwardedFor: `192.0.2.${(n += 1)}` }))) as { kind: string; status?: number; message?: string };
    expect((await bad({ name: "A" })).message).toMatch(/enter your name/);
    expect((await bad({ email: "nope" })).message).toMatch(/valid email/);
    expect((await bad({ phone: "abc" })).message).toMatch(/phone number doesn't look right/);
    expect((await bad({ consent: "" })).message).toMatch(/tick the box/);
    expect((await bad({ service: "Hacking" })).message).toMatch(/choose one of the options/);
    expect((await bad({ message: "" })).message).toMatch(/how we can help/);
    expect((await bad({ name: "x".repeat(500), email: "long@example.net" })).kind).toBe("redirect"); // over-long text is shortened, not stored whole
    const long = (await withSystem((db) => db.query<{ name: string }>("select name from website_form_submissions where email = 'long@example.net'"))).rows[0];
    expect(long.name.length).toBe(120);
  });

  it("limits how many a single visitor can send", async () => {
    const now = Date.now();
    let blocked = 0;
    for (let i = 0; i < 12; i += 1) {
      const res = await handleEnquiry(base(now, { email: `rl${i}@example.net`, message: `rate ${i}` }, { forwardedFor: "203.0.113.77" }));
      if (res.kind === "error" && res.status === 429) blocked += 1;
    }
    expect(blocked).toBe(4); // 8 allowed per ten minutes
    expect(await handleEnquiry(base(now, { email: "other-visitor@example.net", message: "different visitor" }, { forwardedFor: "203.0.113.78" }))).toMatchObject({ kind: "redirect" });
  });

  it("renders its error page safely", () => {
    const html = errorPage(`<script>alert(1)</script> & "quotes"`);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("published pages and images", () => {
  it("serve the images of the live publication, with the owner's alt text, from addresses that are the images' own hashes", async () => {
    const site = (await resolveSite(HOST))!;
    expect(site).toBeTruthy();
    const assets = await siteAssets(HOST, site.publicationId);
    expect(assets.size).toBe(1);
    const [asset] = [...assets.values()];
    expect(asset).toMatchObject({ mimeType: "image/webp", width: 480, height: 320, alt: "Our team at work" }); // photos are stored as WebP
    const html = renderToStaticMarkup(
      React.createElement(SiteRenderer, {
        content: site.content, templateKey: site.templateKey, pageSlug: "home", resolveAsset: assetResolver(assets), mode: "published", formAction: "/__iaq/form", formToken: "t",
        hrefFor: (s: string) => (s === "home" ? "/" : `/${s}`), publicationId: site.publicationId,
      }),
    );
    expect(html).toContain(`src="/_a/${asset.sha256}"`);
    expect(html).toContain('alt="Our team at work"');
    expect(html).toContain(`data-site-publication="${site.publicationId}"`);
    const bytes = await loadSiteAsset(HOST, asset.sha256);
    expect(bytes?.mimeType).toBe("image/webp");
    expect((await sharp(bytes!.bytes).metadata()).width).toBe(480);
    expect(await loadSiteAsset("other.example.org", asset.sha256)).toBeNull(); // only for the host that publishes it
    expect(await loadSiteAsset(HOST, "f".repeat(64))).toBeNull();
    expect(await loadSiteAsset(HOST, "../etc/passwd")).toBeNull();
  });

  it("counts requests and image bytes in batches without ever failing a request", async () => {
    await recordUsage(HOST, 1200);
    await recordUsage(HOST, 800);
    await recordUsage("nobody.example.org", 5);
    await flushUsage();
    const row = (await withSystem((db) => db.query<{ requests: string; bytes_served: string }>("select requests, bytes_served from website_usage_daily where org_id = $1", [org.id]))).rows[0];
    expect(Number(row.requests)).toBe(2);
    expect(Number(row.bytes_served)).toBe(2000);
  });
});
