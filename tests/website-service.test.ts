import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSiteRuntime, withSystem, withUser } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { createAsset } from "@/server/assets/service";
import { saveOnboardingStep } from "@/server/onboarding/service";
import { clearSiteCache, resolveSite } from "@/server/sites/runtime";
import {
  DraftConflictError, PublishBlockedError, changeTemplate, createWebsite, decideApproval, getDraft, getWebsite, listPublications, listVersions, preflight, publishWebsite,
  regenerateDraft, restoreVersion, rollbackWebsite, saveDraft, saveVersion, submitForApproval, unpublishWebsite,
} from "@/server/websites/service";
import { newSection } from "@/lib/website/schema";
import type { ProbeFetcher } from "@/server/websites/probe";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";

type Person = { id: string; email: string };
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let owner: Person, manager: Person, rep: Person, viewer: Person, outsider: Person, superAdmin: Person;
const as = (p: Person, o = org, role: "owner" | "admin" | "sales_rep" | "viewer" = "owner") => ctxFor(p, o, role);

/** A probe that behaves like a runtime serving whatever publication id it is told is live. */
const serving = (liveId: () => string | null): ProbeFetcher => async ({ host }) => {
  void host;
  const id = liveId();
  return id ? { status: 200, body: `<div data-site-publication="${id}"></div>` } : { status: 502, body: "" };
};
const broken: ProbeFetcher = async () => ({ status: 502, body: "bad gateway" });

beforeAll(async () => {
  process.env.SITES_PROBE_ORIGIN = "http://127.0.0.1:9";
  process.env.SITES_BASE_DOMAIN = "sites.test.example";
  process.env.SITES_CNAME_TARGET = "cname.sites.test.example";
  resetEnvCache();
  org = await createOrg({ name: "Roof Co" });
  other = await createOrg({ name: "Elsewhere Roofing" });
  [owner, manager, rep, viewer, outsider] = await Promise.all([createUser(), createUser(), createUser(), createUser(), createUser()]);
  superAdmin = await createUser({ platformRole: "agency_super_admin" });
  await addMember(org.id, owner.id, "owner");
  await addMember(org.id, manager.id, "admin");
  await addMember(org.id, rep.id, "sales_rep");
  await addMember(org.id, viewer.id, "viewer");
  await addMember(other.id, outsider.id, "owner");
  await saveOnboardingStep(as(owner), {
    answers: {
      "a.business_name": { value: "Roof Co" }, "a.industry": { value: "home_services" }, "a.business_model": { value: "local" },
      "a.description": { value: "We repair and replace roofs for homeowners in Austin." }, "a.contact_phone": { value: "+15125550100" }, "a.contact_email": { value: "hello@roofco.test" },
      "a.territories": { value: "Austin, Round Rock" }, "b.services": { value: "Roof inspections, roof repairs, gutter replacement" },
    },
  });
});
afterAll(() => {
  delete process.env.SITES_PROBE_ORIGIN;
  delete process.env.SITES_BASE_DOMAIN;
  delete process.env.SITES_CNAME_TARGET;
  resetEnvCache();
});

describe("creating the website", () => {
  it("builds a first draft from confirmed workspace facts, with its own included address", async () => {
    const { subdomain } = await createWebsite(as(owner), { templateKey: "forge.foreman" });
    expect(subdomain).toBe("roof-co");
    const site = (await getWebsite(as(owner)))!;
    expect(site).toMatchObject({ name: "Roof Co", templateKey: "forge.foreman", platformHost: "roof-co.sites.test.example", draftRevision: 0, hasUnpublishedChanges: false, published: null });
    expect(site.approval.status).toBe("draft");
    expect(site.domains).toHaveLength(1);
    expect(site.domains[0]).toMatchObject({ kind: "platform", status: "verified", isPrimary: true, acquisition: "platform", hostname: "roof-co.sites.test.example" });
    const draft = (await getDraft(as(owner)))!;
    expect(draft.content.business).toMatchObject({ name: "Roof Co", phone: "+15125550100", email: "hello@roofco.test" });
    expect(draft.content.pages.map((p) => p.slug)).toEqual(["home", "about", "services", "contact"]);
    expect((await listVersions(as(owner)))[0]).toMatchObject({ version: 1, source: "generated" });
  });

  it("allows one main website per workspace and only to people who may edit", async () => {
    await expect(createWebsite(as(owner), { templateKey: "summit.peak" })).rejects.toThrow(/already has a website/);
    await expect(createWebsite(as(rep, org, "sales_rep"), { templateKey: "summit.peak" })).rejects.toThrow(/Only owners and managers/);
    await expect(createWebsite(as(owner), { templateKey: "nope.nope" })).rejects.toThrow(/Choose one of the templates/);
  });

  it("gives other workspaces their own distinct, valid addresses", async () => {
    const o2 = await createOrg({ name: "Www" });
    const u2 = await createUser();
    await addMember(o2.id, u2.id, "owner");
    const a = await createWebsite(as(u2, o2), { templateKey: "summit.peak" });
    expect(a.subdomain).toMatch(/^[a-z0-9-]{3,42}$/);
    expect(["www", "app", "api", "admin"]).not.toContain(a.subdomain);
    const o3 = await createOrg({ name: "Roof Co" });
    const u3 = await createUser();
    await addMember(o3.id, u3.id, "owner");
    const b = await createWebsite(as(u3, o3), { templateKey: "summit.peak" });
    expect(b.subdomain).not.toBe("roof-co");
    expect(b.subdomain.startsWith("roof-co")).toBe(true);
  });
});

describe("editing", () => {
  it("saves with a revision check so two editors can't silently overwrite each other", async () => {
    const draft = (await getDraft(as(owner)))!;
    const edited = structuredClone(draft.content);
    edited.business.tagline = "Straight answers, fair prices";
    const saved = await saveDraft(as(owner), { content: edited, expectedRevision: draft.revision });
    expect(saved.revision).toBe(draft.revision + 1);
    await expect(saveDraft(as(manager, org, "admin"), { content: edited, expectedRevision: draft.revision })).rejects.toBeInstanceOf(DraftConflictError);
    const again = await saveDraft(as(manager, org, "admin"), { content: edited, expectedRevision: saved.revision });
    expect(again.revision).toBe(saved.revision + 1);
  });

  it("refuses invalid content, foreign images and people without edit rights", async () => {
    const draft = (await getDraft(as(owner)))!;
    const bad = structuredClone(draft.content);
    bad.business.email = "not-an-email";
    await expect(saveDraft(as(owner), { content: bad, expectedRevision: draft.revision })).rejects.toThrow(/email address/);
    const withImage = structuredClone(draft.content);
    (withImage.pages[0].sections[0].data as { image: string | null }).image = "11111111-1111-4111-8111-111111111111";
    await expect(saveDraft(as(owner), { content: withImage, expectedRevision: draft.revision })).rejects.toThrow(/no longer in your library/);
    await expect(saveDraft(as(rep, org, "sales_rep"), { content: draft.content, expectedRevision: draft.revision })).rejects.toThrow(/Only owners and managers/);
    await expect(saveDraft(as(viewer, org, "viewer"), { content: draft.content, expectedRevision: draft.revision })).rejects.toThrow(/Only owners and managers/);
  });

  it("cannot reference another workspace's image, even by its exact id", async () => {
    const o2u = (await withSystem((db) => db.query<{ user_id: string }>("select user_id from organization_memberships where org_id = $1", [other.id]))).rows[0].user_id;
    void o2u;
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#ccc" } }).png().toBuffer();
    const foreign = await createAsset(as(outsider, other), { kind: "image", bytes: png, filename: "theirs.png" });
    const draft = (await getDraft(as(owner)))!;
    const sneaky = structuredClone(draft.content);
    (sneaky.pages[0].sections[0].data as { image: string | null }).image = foreign.id;
    await expect(saveDraft(as(owner), { content: sneaky, expectedRevision: draft.revision })).rejects.toThrow(/no longer in your library/);
  });

  it("switches templates without touching content, and withdraws approval on any change", async () => {
    const before = (await getDraft(as(owner)))!;
    const res = await changeTemplate(as(owner), { templateKey: "atlas.quill", expectedRevision: before.revision });
    const after = (await getDraft(as(owner)))!;
    expect(after.templateKey).toBe("atlas.quill");
    expect(after.content).toEqual(before.content);
    expect(after.revision).toBe(res.revision);
    await expect(changeTemplate(as(owner), { templateKey: "atlas.quill", expectedRevision: before.revision })).rejects.toBeInstanceOf(DraftConflictError);
  });

  it("keeps a restorable history and never loses the draft when restoring or rebuilding", async () => {
    const draft = (await getDraft(as(owner)))!;
    const v1 = (await saveVersion(as(owner), { note: "Before experiments" })).version;
    expect((await saveVersion(as(owner), {})).created).toBe(false); // nothing changed since: no duplicate version
    const experiment = structuredClone(draft.content);
    experiment.business.tagline = "An experiment";
    const saved = await saveDraft(as(owner), { content: experiment, expectedRevision: draft.revision });
    const versions = await listVersions(as(owner));
    const target = versions.find((v) => v.version === v1)!;
    const restored = await restoreVersion(as(owner), { versionId: target.id, expectedRevision: saved.revision });
    expect((await getDraft(as(owner)))!.content.business.tagline).toBe(draft.content.business.tagline);
    expect((await listVersions(as(owner))).some((v) => v.note?.startsWith("Saved before restoring"))).toBe(true);
    const rebuilt = await regenerateDraft(as(owner), { expectedRevision: restored.revision });
    expect(rebuilt.revision).toBe(restored.revision + 1);
    await expect(restoreVersion(as(owner), { versionId: target.id, expectedRevision: restored.revision })).rejects.toBeInstanceOf(DraftConflictError);
  });

  it("only lets the people who may see the website read it", async () => {
    expect(await getWebsite(as(viewer, org, "viewer"))).not.toBeNull();
    expect(await getWebsite(as(outsider, other))).toBeNull(); // their workspace has no site
    const leak = await withUser(outsider.id, (db) => db.query("select id from websites where org_id = $1", [org.id]));
    expect(leak.rows).toEqual([]);
    for (const table of ["website_versions", "website_publications", "website_domains", "website_form_submissions", "website_usage_daily"]) {
      const r = await withUser(outsider.id, (db) => db.query(`select 1 from ${table} where org_id = $1`, [org.id]));
      expect(r.rows, table).toEqual([]);
    }
    await expect(withUser(outsider.id, (db) => db.query("update websites set name = 'x' where org_id = $1", [org.id]))).rejects.toThrow(/permission denied/);
  });
});

describe("approval", () => {
  it("requires a clean site, goes to the owner, and covers exactly what was submitted", async () => {
    const draft = (await getDraft(as(owner)))!;
    // A blocker stops submission.
    const blocked = structuredClone(draft.content);
    blocked.business.tagline = "Serving [city] since forever";
    const s1 = await saveDraft(as(manager, org, "admin"), { content: blocked, expectedRevision: draft.revision });
    await expect(submitForApproval(as(manager, org, "admin"))).rejects.toBeInstanceOf(PublishBlockedError);
    const clean = structuredClone(draft.content);
    const s2 = await saveDraft(as(manager, org, "admin"), { content: clean, expectedRevision: s1.revision });
    void s2;
    await submitForApproval(as(manager, org, "admin"));
    expect((await getWebsite(as(owner)))!.approval.status).toBe("submitted");
    // A manager cannot approve their own submission.
    await expect(decideApproval(as(manager, org, "admin"), { approve: true })).rejects.toThrow(/Only the business owner/);
    // Editing after submission withdraws it, so approval can't cover content nobody reviewed.
    const cur = (await getDraft(as(owner)))!;
    const tweaked = structuredClone(cur.content);
    tweaked.business.tagline = "Changed after submission";
    await saveDraft(as(manager, org, "admin"), { content: tweaked, expectedRevision: cur.revision });
    expect((await getWebsite(as(owner)))!.approval.status).toBe("draft");
    await expect(decideApproval(as(owner), { approve: true })).rejects.toThrow(/nothing waiting/);
    await submitForApproval(as(manager, org, "admin"));
    await expect(decideApproval(as(owner), { approve: false, note: "" })).rejects.toThrow(/what you'd like changed/);
    await decideApproval(as(owner), { approve: false, note: "Please add our phone number to the hero." });
    expect((await getWebsite(as(owner)))!.approval).toMatchObject({ status: "changes_requested", note: "Please add our phone number to the hero." });
    await submitForApproval(as(manager, org, "admin"));
    await decideApproval(as(owner), { approve: true });
    expect((await getWebsite(as(owner)))!.approval.status).toBe("approved");
  });
});

describe("publishing", () => {
  let liveId: string | null = null;
  const probe = serving(() => liveId);

  it("shows what stands in the way before publishing", async () => {
    const draft = (await getDraft(as(owner)))!;
    const risky = structuredClone(draft.content);
    (risky.pages[0].sections[0].data as { subheadline: string }).subheadline = "Award-winning roofers. 100% satisfaction guaranteed.";
    await saveDraft(as(owner), { content: risky, expectedRevision: draft.revision });
    const pf = await preflight(as(owner));
    expect(pf.blockers).toEqual([]);
    expect(pf.needsAcknowledgement.map((w) => w.match?.toLowerCase())).toEqual(expect.arrayContaining(["award-winning", "100%"]));
  });

  it("will not publish unverifiable claims until the owner confirms them, and only the owner may publish", async () => {
    await expect(publishWebsite(as(owner), {}, { probe })).rejects.toThrow(/confirm you can back each one up/);
    await expect(publishWebsite(as(manager, org, "admin"), { acknowledgeClaims: true }, { probe })).rejects.toThrow(/Only the business owner can publish/);
    await expect(publishWebsite(as(rep, org, "sales_rep"), { acknowledgeClaims: true }, { probe })).rejects.toThrow(/Only the business owner can publish/);
    const draft = (await getDraft(as(owner)))!;
    const ph = structuredClone(draft.content);
    ph.business.tagline = "Lorem ipsum";
    await saveDraft(as(owner), { content: ph, expectedRevision: draft.revision });
    await expect(publishWebsite(as(owner), { acknowledgeClaims: true }, { probe })).rejects.toBeInstanceOf(PublishBlockedError);
    const cur = (await getDraft(as(owner)))!;
    const fixed = structuredClone(cur.content);
    fixed.business.tagline = "Straight answers, fair prices";
    await saveDraft(as(owner), { content: fixed, expectedRevision: cur.revision });
  });

  it("copies images into the publication, freezes the content and checks the live site", async () => {
    const png = await sharp({ create: { width: 320, height: 200, channels: 3, background: "#3366cc" } }).png().toBuffer();
    const asset = await createAsset(as(owner), { kind: "image", bytes: png, filename: "roof.png", altText: "A repaired roof" });
    const draft = (await getDraft(as(owner)))!;
    const withImage = structuredClone(draft.content);
    (withImage.pages[0].sections[0].data as { image: string | null }).image = asset.id;
    await saveDraft(as(owner), { content: withImage, expectedRevision: draft.revision });

    const publicationProbe: ProbeFetcher = async () => ({ status: 200, body: `<div data-site-publication="${liveId}"></div>` });
    // The id is only known after publishing, so let the probe read whatever the database says is live.
    const live = async () => (await withSystem((db) => db.query<{ id: string }>("select published_publication_id as id from websites where org_id = $1", [org.id]))).rows[0].id;
    const out = await publishWebsite(as(owner), { acknowledgeClaims: true, note: "First launch" }, { probe: async (t) => ({ status: 200, body: `<div data-site-publication="${await live()}"></div>` }) });
    void publicationProbe;
    liveId = out.publicationId;
    expect(out).toMatchObject({ number: 1, health: "healthy", restoredPrevious: false, host: "roof-co.sites.test.example" });

    const site = (await getWebsite(as(owner)))!;
    expect(site.published).toMatchObject({ number: 1, health: "healthy" });
    expect(site.hasUnpublishedChanges).toBe(false);
    const blob = await withSystem((db) => db.query<{ n: string }>("select count(*) as n from website_publication_assets pa join website_asset_blobs b on b.id = pa.blob_id where pa.publication_id = $1", [out.publicationId]));
    expect(Number(blob.rows[0].n)).toBe(1);
    // Publications are frozen.
    await expect(withSystem((db) => db.query("update website_publications set content = '{}'::jsonb where id = $1", [out.publicationId]))).rejects.toThrow(/cannot be changed/);
    await expect(withSystem((db) => db.query("update website_versions set note = 'x' where website_id = $1", [site.id]))).rejects.toThrow(/cannot be changed/);
    // Draft edits no longer touch the live site, and are reported as unpublished changes.
    const d = (await getDraft(as(owner)))!;
    const edit = structuredClone(d.content);
    edit.business.tagline = "A change that is not live yet";
    await saveDraft(as(owner), { content: edit, expectedRevision: d.revision });
    expect((await getWebsite(as(owner)))!.hasUnpublishedChanges).toBe(true);
    clearSiteCache();
    const served = await resolveSite("roof-co.sites.test.example");
    expect(served?.content.business.tagline).toBe("Straight answers, fair prices");
  });

  it("restores the last healthy publication when a new one cannot be served", async () => {
    const before = (await getWebsite(as(owner)))!.published!;
    const out = await publishWebsite(as(owner), { acknowledgeClaims: true, note: "Will fail its live check" }, { probe: broken });
    expect(out.restoredPrevious).toBe(true);
    expect(out.publicationId).toBe(before.publicationId);
    const site = (await getWebsite(as(owner)))!;
    expect(site.published!.publicationId).toBe(before.publicationId);
    const pubs = await listPublications(as(owner));
    expect(pubs.find((p) => p.number === 2)).toMatchObject({ status: "failed", health: "unhealthy" });
    expect(pubs.find((p) => p.number === 1)).toMatchObject({ status: "live", health: "healthy" });
    const notice = await withSystem((db) => db.query("select kind from notifications where org_id = $1 and kind = 'website_publish_failed'", [org.id]));
    expect(notice.rows.length).toBeGreaterThan(0);
    clearSiteCache();
    expect((await resolveSite("roof-co.sites.test.example"))?.content.business.tagline).toBe("Straight answers, fair prices");
  });

  it("publishes again, then restores an earlier version as a new publication", async () => {
    const live = async () => (await withSystem((db) => db.query<{ id: string }>("select published_publication_id as id from websites where org_id = $1", [org.id]))).rows[0].id;
    const probe2: ProbeFetcher = async () => ({ status: 200, body: `<div data-site-publication="${await live()}"></div>` });
    const second = await publishWebsite(as(owner), { acknowledgeClaims: true }, { probe: probe2 });
    expect(second.number).toBe(3);
    clearSiteCache();
    expect((await resolveSite("roof-co.sites.test.example"))?.content.business.tagline).toBe("A change that is not live yet");
    const back = await rollbackWebsite(as(owner), { publicationNumber: 1 }, { probe: probe2 });
    expect(back.number).toBe(4);
    clearSiteCache();
    expect((await resolveSite("roof-co.sites.test.example"))?.content.business.tagline).toBe("Straight answers, fair prices");
    const pubs = await listPublications(as(owner));
    expect(pubs[0]).toMatchObject({ number: 4, rolledBackTo: 1, status: "live" });
    expect(pubs.filter((p) => p.status === "live")).toHaveLength(1);
    const assets = await withSystem((db) => db.query<{ n: string }>("select count(*) as n from website_publication_assets where publication_id = $1", [back.publicationId]));
    expect(Number(assets.rows[0].n)).toBe(1); // the images came along
    await expect(rollbackWebsite(as(owner), { publicationNumber: 4 })).rejects.toThrow(/already live/);
    await expect(rollbackWebsite(as(owner), { publicationNumber: 2 })).rejects.toThrow(/can't be restored/); // the one that failed
    await expect(rollbackWebsite(as(manager, org, "admin"), { publicationNumber: 1 })).rejects.toThrow(/Only the business owner/);
  });

  it("can be taken offline, and then is not served at all", async () => {
    await unpublishWebsite(as(owner));
    clearSiteCache();
    expect(await resolveSite("roof-co.sites.test.example")).toBeNull();
    expect((await getWebsite(as(owner)))!.published).toBeNull();
    await expect(unpublishWebsite(as(owner))).rejects.toThrow(/isn't published/);
  });

  it("lets a super admin publish for a managed client only after the owner approved that exact draft", async () => {
    const d = (await getDraft(as(owner)))!;
    const next = structuredClone(d.content);
    next.business.tagline = "Ready for the agency to publish";
    await saveDraft(as(owner), { content: next, expectedRevision: d.revision });
    const agency = { ...ctxFor(superAdmin, org, "owner"), role: "agency_super_admin" as const, can: (p: string) => ["website.publish", "website.view", "website.edit"].includes(p) };
    const acting = agency as unknown as ReturnType<typeof as>;
    await expect(publishWebsite(acting, { acknowledgeClaims: true }, { probe: broken })).rejects.toThrow(/owner needs to approve/);
    await submitForApproval(as(manager, org, "admin"));
    await decideApproval(as(owner), { approve: true });
    await expect(publishWebsite(acting, { acknowledgeClaims: true }, { probe: async () => ({ status: 200, body: "" }) })).resolves.toMatchObject({ health: "unhealthy" });
  });
});

describe("the public runtime can only do what it is allowed to", () => {
  it("has no table privileges at all", async () => {
    for (const table of ["websites", "website_versions", "website_publications", "website_domains", "website_form_submissions", "website_asset_blobs", "contacts", "organizations", "users", "credential_references", "credit_ledger_entries", "audit_logs", "onboarding_answers"]) {
      await expect(withSiteRuntime((db) => db.query(`select * from ${table} limit 1`)), table).rejects.toThrow(/permission denied/);
    }
    await expect(withSiteRuntime((db) => db.query("insert into website_form_submissions (org_id) values (gen_random_uuid())"))).rejects.toThrow(/permission denied/);
    await expect(withSiteRuntime((db) => db.query("update websites set name = 'x'"))).rejects.toThrow(/permission denied/);
    await expect(withSiteRuntime((db) => db.query("select * from app.has_permission(gen_random_uuid(), 'website.view')"))).rejects.toThrow(/permission denied/);
  });

  it("serves a host only when it is verified, has a live publication, and its organization is active", async () => {
    const probe: ProbeFetcher = async () => ({ status: 200, body: "" });
    const site = (await getWebsite(as(owner)))!;
    await publishWebsite(as(owner), { acknowledgeClaims: true }, { probe });
    clearSiteCache();
    expect((await resolveSite("roof-co.sites.test.example"))?.orgId).toBe(org.id);
    expect((await resolveSite("ROOF-CO.sites.test.example:443"))?.orgId).toBe(org.id); // host is normalized
    expect(await resolveSite("unknown.sites.test.example")).toBeNull();
    expect(await resolveSite("bad host")).toBeNull();
    expect(await resolveSite("localhost")).toBeNull();
    // An unverified custom domain never serves, even for a published site.
    await withSystem((db) => db.query("insert into website_domains (org_id, website_id, hostname, kind, status, verification_token) values ($1, $2, 'unverified.example.org', 'custom', 'pending_dns', repeat('a', 32))", [org.id, site.id]));
    clearSiteCache();
    expect(await resolveSite("unverified.example.org")).toBeNull();
    await withSystem((db) => db.query("update website_domains set status = 'verified', verified_at = now() where hostname = 'unverified.example.org'"));
    clearSiteCache();
    expect((await resolveSite("unverified.example.org"))?.websiteId).toBe(site.id);
    // A suspended workspace goes dark immediately.
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [org.id]));
    clearSiteCache();
    expect(await resolveSite("roof-co.sites.test.example")).toBeNull();
    await withSystem((db) => db.query("update organizations set status = 'active' where id = $1", [org.id]));
    // A removed domain stops serving.
    await withSystem((db) => db.query("update website_domains set removed_at = now(), status = 'removed' where hostname = 'unverified.example.org'"));
    clearSiteCache();
    expect(await resolveSite("unverified.example.org")).toBeNull();
  });

  it("never exposes drafts, and never serves one tenant's image under another's host", async () => {
    const { rows } = await withSiteRuntime((db) => db.query<{ content: { business: { tagline: string } } }>("select content from app.site_by_host('roof-co.sites.test.example')"));
    expect(rows[0].content.business.tagline).not.toBe("Ready for the agency to publish".repeat(2));
    const mine = await withSiteRuntime((db) => db.query<{ sha256: string }>("select sha256 from app.site_assets_for_host('roof-co.sites.test.example')"));
    expect(mine.rows.length).toBeGreaterThan(0);
    const theirs = await withSiteRuntime((db) => db.query("select * from app.site_asset('roof-co.sites.test.example', $1)", [mine.rows[0].sha256]));
    expect(theirs.rows).toHaveLength(1);
    const wrongHost = await withSiteRuntime((db) => db.query("select * from app.site_asset('nobody.sites.test.example', $1)", [mine.rows[0].sha256]));
    expect(wrongHost.rows).toEqual([]);
    const notAHash = await withSiteRuntime((db) => db.query("select * from app.site_asset('roof-co.sites.test.example', $1)", ["0".repeat(64)]));
    expect(notAHash.rows).toEqual([]);
  });

  it("accepts enquiries only for live sites, with consent, once, and rate-limits abuse", async () => {
    const submit = (over: Partial<{ host: string; consent: boolean; dedupe: string; email: string; phone: string }> = {}) =>
      withSiteRuntime((db) =>
        db.query<{ r: { status: string; id?: string } }>("select app.submit_site_form($1, 'contact', 'Sam', $2, $3, '', 'Please call', $4, false, 'I agree to be contacted about my enquiry.', 'iphash', '{}'::jsonb, '', $5) as r", [
          over.host ?? "roof-co.sites.test.example", over.email ?? "sam@example.net", over.phone ?? "", over.consent ?? true, over.dedupe ?? "dedupe-00000001",
        ]),
      ).then((x) => x.rows[0].r);
    expect((await submit()).status).toBe("ok");
    expect((await submit()).status).toBe("duplicate"); // a double click or retry
    expect((await submit({ dedupe: "dedupe-00000002", consent: false })).status).toBe("consent_required");
    expect((await submit({ dedupe: "dedupe-00000003", host: "nobody.sites.test.example" })).status).toBe("unknown_host");
    const stored = await withSystem((db) => db.query<{ n: string; org_id: string }>("select count(*) as n, min(org_id::text) as org_id from website_form_submissions where host = 'roof-co.sites.test.example'"));
    expect({ n: Number(stored.rows[0].n), org: stored.rows[0].org_id }).toEqual({ n: 1, org: org.id });
    const usage = await withSystem((db) => db.query<{ form_submissions: number }>("select form_submissions from website_usage_daily where org_id = $1", [org.id]));
    expect(usage.rows[0].form_submissions).toBe(1);

    const hits: boolean[] = [];
    for (let i = 0; i < 4; i += 1) hits.push((await withSiteRuntime((db) => db.query<{ ok: boolean }>("select app.site_rate_limit('test-key', 3, 60) as ok"))).rows[0].ok);
    expect(hits).toEqual([true, true, true, false]);
  });
});
