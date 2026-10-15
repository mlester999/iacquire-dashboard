import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { saveOnboardingStep } from "@/server/onboarding/service";
import { createWebsite, getDraft, saveDraft } from "@/server/websites/service";
import { agencyOrgContext } from "@/server/websites/studio-ctx";
import { getManagedWebsite, listManagedWebsites, reviewQueue, studioOverview } from "@/server/websites/admin";
import { acquireEditLock, addComment, listComments, releaseEditLock, requestChanges, resolveComment, setArchived } from "@/server/websites/review";
import {
  buildFromTemplate, checkTemplate, createTemplate, duplicateTemplate, getTemplateDraft, isOfferable, listLibrary, listPublishedCards, listTemplateVersions, saveTemplateDraft, setTemplateStatus,
  TemplateConflictError, updateTemplateMeta,
} from "@/server/websites/templates";
import { suggestWithAi } from "@/server/websites/assistant";
import { deleteComponent, listComponents, listPatterns, saveComponent, setPatternStatus } from "@/server/websites/components";
import { templateUpdateFor } from "@/server/websites/template-update";
import { applyDesignUpdate, designChanges } from "@/lib/website/editor/template-update";
import { SYSTEM_PROMPT } from "@/lib/website/assistant/brief";
import { makeBrief } from "@/lib/website/assistant/brief";
import { eachElement, isRef, type Section, type SiteContent } from "@/lib/website/doc";
import { setProp } from "@/lib/website/ops";
import type { SessionUser } from "@/server/auth/service";
import { addMember, agencyUser, createOrg, createUser, ctxFor } from "./support/fixtures";

// The model is mocked: no request ever leaves the test process.
const llm = vi.hoisted(() => ({ config: null as null | { baseUrl: string; format: "openai"; model: string; apiKey: string; source: "portal" }, reply: { ok: true as boolean, text: "" }, calls: [] as Array<{ system: string; user: string }> }));
vi.mock("@/server/llm/client", () => ({
  resolveLlmConfig: async () => llm.config,
  llmComplete: async (_c: unknown, input: { system: string; user: string }) => {
    llm.calls.push({ system: input.system, user: input.user });
    return llm.reply.ok ? { ok: true as const, text: llm.reply.text } : { ok: false as const, status: 500 };
  },
}));

let orgA: Awaited<ReturnType<typeof createOrg>>;
let orgB: Awaited<ReturnType<typeof createOrg>>;
let ownerA: { id: string; email: string };
let ownerB: { id: string; email: string };
let staffRow: { id: string; email: string };
let superRow: { id: string; email: string };
let staff: SessionUser;
let superAdmin: SessionUser;
let staffCtxA: ReturnType<typeof agencyOrgContext>;
let superCtxA: ReturnType<typeof agencyOrgContext>;
const asOwner = (o: typeof orgA, u: typeof ownerA) => ctxFor(u, o, "owner");

async function seedFacts(org: typeof orgA, owner: typeof ownerA, name: string) {
  await saveOnboardingStep(asOwner(org, owner), {
    answers: {
      "a.business_name": { value: name }, "a.industry": { value: "home_services" }, "a.business_model": { value: "local" },
      "a.description": { value: `${name} looks after homes across Austin.` }, "a.contact_phone": { value: "+15125550100" }, "a.contact_email": { value: "hello@example.test" },
      "a.territories": { value: "Austin" }, "b.services": { value: "Repairs, Inspections, Maintenance" },
    },
  });
}

beforeAll(async () => {
  process.env.SITES_BASE_DOMAIN = "sites.test.example";
  process.env.SITES_CNAME_TARGET = "cname.sites.test.example";
  resetEnvCache();
  [orgA, orgB] = await Promise.all([createOrg({ name: "Admin Test Alpha" }), createOrg({ name: "Admin Test Beta" })]);
  [ownerA, ownerB, staffRow, superRow] = await Promise.all([createUser(), createUser(), createUser({ platformRole: "agency_staff" }), createUser({ platformRole: "agency_super_admin" })]);
  await addMember(orgA.id, ownerA.id, "owner");
  await addMember(orgB.id, ownerB.id, "owner");
  staff = agencyUser(staffRow, "agency_staff");
  superAdmin = agencyUser(superRow, "agency_super_admin");
  // The staff member is assigned to Alpha only.
  await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [orgA.id, staffRow.id]));
  await seedFacts(orgA, ownerA, "Admin Test Alpha");
  await seedFacts(orgB, ownerB, "Admin Test Beta");
  await createWebsite(asOwner(orgA, ownerA), { templateKey: "local.crew" });
  await createWebsite(asOwner(orgB, ownerB), { templateKey: "care.haven" });
  const org = (o: typeof orgA) => ({ orgId: o.id, name: o.name, slug: o.slug, status: "active" as const, timezone: "UTC" });
  staffCtxA = agencyOrgContext(staff, org(orgA));
  superCtxA = agencyOrgContext(superAdmin, org(orgA));
});
afterAll(() => {
  delete process.env.SITES_BASE_DOMAIN;
  delete process.env.SITES_CNAME_TARGET;
  resetEnvCache();
});

describe("what each agency role can see across clients", () => {
  it("shows a super admin every client website and an assigned staff member only theirs", async () => {
    const all = (await listManagedWebsites(superAdmin)).map((s) => s.orgId);
    expect(all).toEqual(expect.arrayContaining([orgA.id, orgB.id]));
    const mine = (await listManagedWebsites(staff)).map((s) => s.orgId);
    expect(mine).toContain(orgA.id);
    expect(mine).not.toContain(orgB.id);
  });

  it("won't hand a staff member a client they aren't assigned to, even by id", async () => {
    expect(await getManagedWebsite(staff, orgB.id)).toBeNull();
    expect(await getManagedWebsite(staff, orgA.id)).toMatchObject({ orgId: orgA.id, templateKey: "local.crew", lifecycle: "draft" });
  });

  it("refuses the lists to anyone who isn't agency", async () => {
    const plain: SessionUser = { ...staff, platformRole: "none" };
    await expect(listManagedWebsites(plain)).rejects.toMatchObject({ code: "forbidden" });
    await expect(studioOverview(plain)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("counts real records and scopes the overview and queues the same way", async () => {
    const mine = await studioOverview(staff);
    const everything = await studioOverview(superAdmin);
    expect(everything.total).toBeGreaterThanOrEqual(2);
    expect(mine.total).toBeLessThan(everything.total);
    expect(mine.published).toBe(0);
    const q = await reviewQueue(staff);
    expect([...q.waiting, ...q.approved, ...q.changes, ...q.failed, ...q.comments].every((s) => s.orgId !== orgB.id)).toBe(true);
  });
});

describe("agency permissions inside a client's website", () => {
  it("lets staff edit but not publish or archive, and super admins do both", async () => {
    expect(staffCtxA.can("website.edit")).toBe(true);
    expect(staffCtxA.can("website.review")).toBe(true);
    expect(staffCtxA.can("website.publish")).toBe(false);
    expect(superCtxA.can("website.publish")).toBe(true);
    await expect(setArchived(staffCtxA, true)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("saves an agency edit through the same revision check as the client's own", async () => {
    const draft = (await getDraft(staffCtxA))!;
    const edited = structuredClone(draft.content);
    edited.business.tagline = "Edited by the agency";
    const saved = await saveDraft(staffCtxA, { content: edited, expectedRevision: draft.revision });
    expect(saved.revision).toBe(draft.revision + 1);
    await expect(saveDraft(staffCtxA, { content: edited, expectedRevision: draft.revision })).rejects.toMatchObject({ code: "conflict" });
    expect((await getDraft(asOwner(orgA, ownerA)))!.content.business.tagline).toBe("Edited by the agency");
  });

  it("keeps a client's draft private from another client", async () => {
    // Beta's owner has no way into Alpha's website, whatever the request says.
    const asBeta = ctxFor(ownerB, orgB, "owner");
    expect((await getDraft(asBeta))!.content.business.name).toBe("Admin Test Beta");
    expect((await getDraft(asBeta))!.content.business.name).not.toBe("Admin Test Alpha");
  });
});

describe("comments, change requests and the edit lock", () => {
  it("lets the agency and the client talk on the website, and keeps each client's notes to itself", async () => {
    const note = await addComment(staffCtxA, { body: "Please confirm the opening hours.", pageSlug: "home" });
    await addComment(asOwner(orgA, ownerA), { body: "Hours confirmed." });
    const list = await listComments(asOwner(orgA, ownerA));
    expect(list.map((c) => c.authorKind).sort()).toEqual(["agency", "client"]);
    expect(await listComments(ctxFor(ownerB, orgB, "owner"))).toEqual([]);
    await resolveComment(asOwner(orgA, ownerA), note.id, true);
    expect((await listComments(asOwner(orgA, ownerA))).find((c) => c.id === note.id)!.resolvedAt).not.toBeNull();
    // A comment can't be resolved from another tenant.
    await expect(resolveComment(ctxFor(ownerB, orgB, "owner"), note.id, false)).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects empty or oversized comments and comments from people without a right to make them", async () => {
    await expect(addComment(staffCtxA, { body: "  " })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(addComment(staffCtxA, { body: "x".repeat(2001) })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(addComment(ctxFor(ownerA, orgA, "viewer"), { body: "Looks good" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("sends changes back to the owner with the reviewer's note", async () => {
    await requestChanges(staffCtxA, "Swap the hero picture for one of your vans.");
    const m = (await getManagedWebsite(superAdmin, orgA.id))!;
    expect(m.lifecycle).toBe("changes_requested");
    expect(m.approvalNote).toMatch(/vans/);
    await expect(requestChanges(staffCtxA, "no")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(requestChanges(asOwner(orgA, ownerA), "Please change this")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("tells a second editor who is already in, and lets them take over on purpose", async () => {
    const first = await acquireEditLock(asOwner(orgA, ownerA));
    expect(first.held).toBe(true);
    const second = await acquireEditLock(staffCtxA);
    expect(second.held).toBe(false);
    expect(second.by).toBeTruthy();
    expect((await getManagedWebsite(superAdmin, orgA.id))!.lockedBy).toBeTruthy();
    expect((await acquireEditLock(staffCtxA, { takeOver: true })).held).toBe(true);
    // An agency person starting work in a client's editor is audited once per visit, not on every keep-alive.
    const audited = async () => Number((await withSystem((db) => db.query<{ n: string }>("select count(*) as n from audit_logs where org_id = $1 and action = 'website.agency_edit' and actor_user_id = $2", [orgA.id, staffRow.id]))).rows[0].n);
    const visits = await audited();
    expect(visits).toBeGreaterThanOrEqual(1);
    expect((await acquireEditLock(staffCtxA)).held).toBe(true);
    expect(await audited()).toBe(visits);
    await releaseEditLock(staffCtxA);
    expect((await acquireEditLock(asOwner(orgA, ownerA))).held).toBe(true);
    await releaseEditLock(asOwner(orgA, ownerA));
  });

  it("archives and restores without losing anything, for people allowed to", async () => {
    await setArchived(superCtxA, true);
    expect((await getManagedWebsite(superAdmin, orgA.id))?.lifecycle ?? "archived").toBe("archived");
    await setArchived(superCtxA, false);
    expect((await getManagedWebsite(superAdmin, orgA.id))!.lifecycle).not.toBe("archived");
    expect((await getDraft(superCtxA))!.content.business.name).toBe("Admin Test Alpha");
  });
});

describe("the template library", () => {
  let templateId = "";
  let templateKey = "";

  it("is only for agency designers, and publishing is for super admins", async () => {
    const plain: SessionUser = { ...staff, platformRole: "none" };
    await expect(listLibrary(plain)).rejects.toMatchObject({ code: "forbidden" });
    await expect(createTemplate(plain, { name: "Nope", from: { kind: "blank" } })).rejects.toMatchObject({ code: "forbidden" });
    const created = await createTemplate(staff, { name: "Harbor Lights", from: { kind: "builtin", key: "host.terrace" }, description: "Coastal hospitality", industries: ["hospitality"], tags: ["Coastal"] });
    templateId = created.id;
    templateKey = created.key;
    expect(templateKey).toMatch(/^custom\./);
    await expect(setTemplateStatus(staff, templateKey, "published")).rejects.toMatchObject({ code: "forbidden" });
    await expect(updateTemplateMeta(staff, templateKey, { featured: true })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("starts as a private working copy that clients can't choose", async () => {
    expect(await isOfferable(templateKey)).toBe(false);
    expect((await listPublishedCards()).some((c) => c.key === templateKey)).toBe(false);
    const draft = await getTemplateDraft(staff, templateId);
    expect(draft.status).toBe("draft");
    expect(draft.content.isSample).toBe(true);
    await expect(buildFromTemplate(templateKey, { businessName: "X Co", industry: "other", tagline: "", description: "d", services: [], pages: ["home"], primaryAction: "enquire" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("checks revisions on save, and never lets a template point at one client's uploaded image", async () => {
    const draft = await getTemplateDraft(staff, templateId);
    const saved = await saveTemplateDraft(staff, templateId, { content: draft.content, expectedRevision: draft.revision });
    expect(saved.revision).toBe(draft.revision + 1);
    await expect(saveTemplateDraft(staff, templateId, { content: draft.content, expectedRevision: draft.revision })).rejects.toBeInstanceOf(TemplateConflictError);
    const withUpload: SiteContent = structuredClone(draft.content);
    let done = false;
    eachElement(withUpload, (e) => {
      if (!done && e.type === "image") { e.props.src = { kind: "asset", id: "11111111-1111-4111-8111-111111111111" }; done = true; }
    });
    if (done) await expect(saveTemplateDraft(staff, templateId, { content: withUpload, expectedRevision: saved.revision })).rejects.toMatchObject({ code: "invalid_input" });
    expect(checkTemplate(withUpload).blockers.map((b) => b.code)).toContain(done ? "uploaded_image" : "never");
  });

  it("blocks publishing a template that uses a placeholder it can't fill in", async () => {
    const draft = await getTemplateDraft(staff, templateId);
    let heading = "";
    eachElement(draft.content, (e) => { if (!heading && e.type === "heading") heading = e.id; });
    const bad = setProp(draft.content, heading, "text", "Welcome to {{business.nickname}}");
    const saved = await saveTemplateDraft(staff, templateId, { content: bad, expectedRevision: draft.revision });
    await expect(setTemplateStatus(superAdmin, templateKey, "published")).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("business.nickname") });
    const fixed = setProp(bad, heading, "text", "Welcome to {{business.name}}");
    await saveTemplateDraft(staff, templateId, { content: fixed, expectedRevision: saved.revision });
  });

  it("publishes as a version, offers it to clients, and fills it in from the client's own facts", async () => {
    const { version } = await setTemplateStatus(superAdmin, templateKey, "published", "First release");
    expect(version).toBe(1);
    expect(await isOfferable(templateKey)).toBe(true);
    const card = (await listPublishedCards()).find((c) => c.key === templateKey)!;
    expect(card).toMatchObject({ source: "custom", name: "Harbor Lights" });
    expect((await listTemplateVersions(staff, templateId))[0]).toMatchObject({ version: 1, note: "First release" });
    const built = await buildFromTemplate(templateKey, { businessName: "Quay Cafe", industry: "other", tagline: "By the water", description: "A cafe", services: [], pages: ["home"], primaryAction: "enquire" });
    expect(built.templateKey).toBe(templateKey);
    expect(built.content.isSample).toBe(false);
    expect(built.content.business.name).toBe("Quay Cafe");
    expect(JSON.stringify(built.content)).not.toContain("{{");
    expect(built.content.origin).toMatchObject({ key: templateKey, version: 1 });
  });

  it("is a starting point: editing the template afterwards never changes a website made from it", async () => {
    const orgC = await createOrg({ name: "Quay Cafe" });
    const ownerC = await createUser();
    await addMember(orgC.id, ownerC.id, "owner");
    await seedFacts(orgC, ownerC, "Quay Cafe");
    const ctxC = ctxFor(ownerC, orgC, "owner");
    await createWebsite(ctxC, { templateKey });
    const before = JSON.stringify((await getDraft(ctxC))!.content);
    // The agency changes the template and publishes version 2.
    const draft = await getTemplateDraft(staff, templateId);
    const next = structuredClone(draft.content);
    next.design.colors.primary = "#aa0000";
    const saved = await saveTemplateDraft(staff, templateId, { content: next, expectedRevision: draft.revision });
    expect(saved.revision).toBeGreaterThan(draft.revision);
    expect((await setTemplateStatus(superAdmin, templateKey, "published", "Red")).version).toBe(2);
    expect(JSON.stringify((await getDraft(ctxC))!.content)).toBe(before);

    // The owner is offered the newer look, and only the look: nothing of the template's content is sent.
    const offer = (await templateUpdateFor(ctxC))!;
    expect(offer).toMatchObject({ templateName: "Harbor Lights", fromVersion: 1, toVersion: 2 });
    expect(Object.keys(offer).sort()).toEqual(["design", "fromVersion", "templateName", "toVersion"]);
    expect(offer.design.colors.primary).toBe("#aa0000");
    const current = (await getDraft(ctxC))!.content;
    expect(designChanges(current.design, offer.design).map((c) => c.label)).toContain("Main colour");
    const updated = applyDesignUpdate(current, offer.design, offer.toVersion);
    expect(updated.design.colors.primary).toBe("#aa0000");
    expect(updated.origin.version).toBe(2);
    expect(updated.pages).toEqual(current.pages);
    expect(updated.business).toEqual(current.business);
    // A template the agency has since hidden is no longer offered, and another client is never told about it.
    expect(await templateUpdateFor(ctxFor(ownerB, orgB, "owner"))).toBeNull();
    await setTemplateStatus(superAdmin, templateKey, "hidden");
    expect(await templateUpdateFor(ctxC)).toBeNull();
    await setTemplateStatus(superAdmin, templateKey, "published");
  });

  it("can be hidden from clients without deleting it, and a hidden built-in design disappears from the gallery", async () => {
    await setTemplateStatus(superAdmin, templateKey, "hidden");
    expect(await isOfferable(templateKey)).toBe(false);
    await setTemplateStatus(superAdmin, "bold.riot", "hidden");
    expect((await listPublishedCards()).some((c) => c.key === "bold.riot")).toBe(false);
    expect(await isOfferable("bold.riot")).toBe(false);
    // A client with no website yet can't start one from a design the agency has hidden.
    const orgD = await createOrg({ name: "Hidden Design Co" });
    const ownerD = await createUser();
    await addMember(orgD.id, ownerD.id, "owner");
    await seedFacts(orgD, ownerD, "Hidden Design Co");
    await expect(createWebsite(ctxFor(ownerD, orgD, "owner"), { templateKey: "bold.riot" })).rejects.toMatchObject({ code: "invalid_input", message: "Choose one of the templates." });
    await setTemplateStatus(superAdmin, "bold.riot", "published");
    expect(await isOfferable("bold.riot")).toBe(true);
  });

  it("duplicates a design into a new private draft", async () => {
    const copy = await duplicateTemplate(staff, "luxe.noir");
    expect(copy.key).toMatch(/^custom\./);
    expect((await getTemplateDraft(staff, copy.id)).status).toBe("draft");
    expect((await listLibrary(staff)).find((t) => t.key === copy.key)).toMatchObject({ kind: "custom", basedOn: "luxe.noir" });
  });
});

describe("the AI assistant's server boundary", () => {
  const doc = () => structuredClone(buildFromTemplateSample());
  function buildFromTemplateSample(): SiteContent {
    // Any valid site will do for an outline.
    return structuredClone(JSON.parse(JSON.stringify(sampleForBrief)));
  }
  let sampleForBrief: SiteContent;
  beforeAll(async () => {
    sampleForBrief = (await getDraft(superCtxA))!.content;
  });
  const brief = () => makeBrief(doc(), doc().pages[0].id, null);

  it("answers nothing, and sends nothing, when no AI provider is connected", async () => {
    llm.config = null;
    llm.calls.length = 0;
    expect(await suggestWithAi(staffCtxA, { request: "Make it feel more luxurious", brief: brief() })).toBeNull();
    expect(llm.calls).toHaveLength(0);
  });

  it("refuses people without edit rights, empty or oversized requests, and malformed outlines", async () => {
    llm.config = { baseUrl: "https://llm.test", format: "openai", model: "m", apiKey: "k", source: "portal" };
    await expect(suggestWithAi(ctxFor(ownerA, orgA, "viewer"), { request: "Make it blue", brief: brief() })).rejects.toMatchObject({ code: "forbidden" });
    await expect(suggestWithAi(staffCtxA, { request: " ", brief: brief() })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(suggestWithAi(staffCtxA, { request: "x".repeat(501), brief: brief() })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(suggestWithAi(staffCtxA, { request: "Make it blue", brief: { ...brief(), extra: "the whole site" } })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(suggestWithAi(staffCtxA, { request: "Make it blue", brief: "not an outline" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("tells the model the rules and shows it only an outline: no phone, email or address", async () => {
    llm.config = { baseUrl: "https://llm.test", format: "openai", model: "m", apiKey: "k", source: "portal" };
    llm.reply = { ok: true, text: JSON.stringify({ summary: "Rounder corners.", ops: [{ op: "design", set: { radius: "round" } }] }) };
    llm.calls.length = 0;
    const plan = await suggestWithAi(staffCtxA, { request: "Make the corners rounder", brief: brief() });
    expect(plan).toMatchObject({ source: "ai", ops: [{ op: "design", set: { radius: "round" } }] });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].system).toBe(SYSTEM_PROMPT);
    expect(llm.calls[0].system).toMatch(/Never invent testimonials/);
    expect(llm.calls[0].user).not.toContain("+15125550100");
    expect(llm.calls[0].user).not.toContain("hello@example.test");
  });

  it("returns nothing usable when the model fails or rambles, so the built-in assistant answers instead", async () => {
    llm.config = { baseUrl: "https://llm.test", format: "openai", model: "m", apiKey: "k", source: "portal" };
    llm.reply = { ok: false, text: "" };
    expect(await suggestWithAi(staffCtxA, { request: "Make it blue", brief: brief() })).toBeNull();
    llm.reply = { ok: true, text: "Sure! I'd make it blue and add some sparkle." };
    expect(await suggestWithAi(staffCtxA, { request: "Make it blue", brief: brief() })).toBeNull();
  });

  it("drops unsafe suggestions the model makes, rather than passing them on", async () => {
    llm.config = { baseUrl: "https://llm.test", format: "openai", model: "m", apiKey: "k", source: "portal" };
    llm.reply = { ok: true, text: JSON.stringify({ summary: "x", ops: [{ op: "design", set: { primary: "url(javascript:alert(1))" } }, { op: "eval", code: "alert(1)" }, { op: "design", set: { mode: "dark" } }] }) };
    const plan = (await suggestWithAi(staffCtxA, { request: "Go dark", brief: brief() }))!;
    expect(plan.ops).toEqual([{ op: "design", set: { mode: "dark" } }]);
    expect(plan.notes.join(" ")).toMatch(/2 suggested changes weren't/);
  });
});

describe("saved sections", () => {
  const firstSection = async (): Promise<Section> => {
    const draft = (await getDraft(superCtxA))!;
    return structuredClone(draft.content.pages[0].items.find((i): i is Section => !isRef(i))!);
  };

  it("are kept per website and never shown to another client", async () => {
    const saved = await saveComponent(asOwner(orgA, ownerA), { name: "Our hero", section: await firstSection(), scope: "site" });
    expect(saved).toMatchObject({ name: "Our hero", scope: "site" });
    expect((await listComponents(asOwner(orgA, ownerA))).map((c) => c.id)).toContain(saved.id);
    expect((await listComponents(ctxFor(ownerB, orgB, "owner"))).map((c) => c.id)).not.toContain(saved.id);
    // Another client can't remove it either.
    await expect(deleteComponent(ctxFor(ownerB, orgB, "owner"), saved.id)).rejects.toMatchObject({ code: "not_found" });
    await deleteComponent(asOwner(orgA, ownerA), saved.id);
    expect((await listComponents(asOwner(orgA, ownerA))).map((c) => c.id)).not.toContain(saved.id);
  });

  it("only accept a section that is valid, named and a sensible size, from someone allowed to save", async () => {
    const section = await firstSection();
    await expect(saveComponent(asOwner(orgA, ownerA), { name: " ", section, scope: "site" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(saveComponent(asOwner(orgA, ownerA), { name: "Broken", section: { id: "x", type: "section", columns: "nope" }, scope: "site" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(saveComponent(ctxFor(ownerA, orgA, "viewer"), { name: "Viewer save", section, scope: "site" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("can be shared with every client by the agency only, as built-in artwork, and staff drafts wait for a super admin", async () => {
    const section = await firstSection();
    await expect(saveComponent(asOwner(orgA, ownerA), { name: "Client share", section, scope: "agency" })).rejects.toMatchObject({ code: "forbidden" });
    const withUpload = structuredClone(section);
    let done = false;
    eachElement({ ...sampleOf(withUpload) }, (e) => { if (!done && e.type === "image") { e.props.src = { kind: "asset", id: "22222222-2222-4222-8222-222222222222" }; done = true; } });
    if (!done) withUpload.bg = { kind: "image", src: { kind: "asset", id: "22222222-2222-4222-8222-222222222222" }, overlay: { color: "dark", opacity: 40, dir: "flat" }, pos: { x: 50, y: 50 }, parallax: false };
    await expect(saveComponent(staffCtxA, { name: "Has upload", section: withUpload, scope: "agency" })).rejects.toMatchObject({ code: "invalid_input" });
    const draftPattern = await saveComponent(staffCtxA, { name: "Staff pattern", section, scope: "agency" });
    // A client doesn't see the staff member's draft; agency staff do.
    expect((await listComponents(asOwner(orgA, ownerA))).map((c) => c.id)).not.toContain(draftPattern.id);
    expect((await listComponents(staffCtxA)).map((c) => c.id)).toContain(draftPattern.id);
    const published = await saveComponent(superCtxA, { name: "Studio hero", section, scope: "agency" });
    const asClient = await listComponents(ctxFor(ownerB, orgB, "owner"));
    expect(asClient.find((c) => c.id === published.id)).toMatchObject({ scope: "agency", name: "Studio hero" });
    // Clients can't remove an agency pattern; the agency can.
    await expect(deleteComponent(ctxFor(ownerB, orgB, "owner"), published.id)).rejects.toMatchObject({ code: "not_found" });
    await deleteComponent(superCtxA, published.id);
    expect((await listComponents(ctxFor(ownerB, orgB, "owner"))).map((c) => c.id)).not.toContain(published.id);
  });
});

describe("managing shared sections", () => {
  it("lists them for the agency team only, and lets only a super admin offer or withdraw them", async () => {
    const draft = (await getDraft(superCtxA))!.content.pages[0].items.find((i): i is Section => !isRef(i))!;
    const saved = await saveComponent(staffCtxA, { name: "Staff idea", section: structuredClone(draft), scope: "agency" });
    const plain: SessionUser = { ...staff, platformRole: "none" };
    await expect(listPatterns(plain)).rejects.toMatchObject({ code: "forbidden" });
    expect((await listPatterns(staff)).find((p) => p.id === saved.id)).toMatchObject({ name: "Staff idea", status: "draft" });
    // Staff can see it, but offering it to every client is a super admin's decision.
    await expect(setPatternStatus(staff, saved.id, "published")).rejects.toMatchObject({ code: "forbidden" });
    expect((await listComponents(ctxFor(ownerB, orgB, "owner"))).map((c) => c.id)).not.toContain(saved.id);
    await setPatternStatus(superAdmin, saved.id, "published");
    expect((await listComponents(ctxFor(ownerB, orgB, "owner"))).map((c) => c.id)).toContain(saved.id);
    await setPatternStatus(superAdmin, saved.id, "draft");
    expect((await listComponents(ctxFor(ownerB, orgB, "owner"))).map((c) => c.id)).not.toContain(saved.id);
    await setPatternStatus(superAdmin, saved.id, "archived");
    expect((await listPatterns(superAdmin)).find((p) => p.id === saved.id)?.status).toBe("archived");
    await expect(setPatternStatus(superAdmin, "00000000-0000-4000-8000-00000000dead", "published")).rejects.toMatchObject({ code: "not_found" });
    await expect(setPatternStatus(superAdmin, saved.id, "weird" as never)).rejects.toMatchObject({ code: "invalid_input" });
  });
});

function sampleOf(section: Section): SiteContent {
  return { pages: [{ items: [section] }], globals: {}, header: null, footer: null } as unknown as SiteContent;
}
