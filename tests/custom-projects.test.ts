import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { updateAgencyUserPermission } from "@/server/admin/team";
import { addMember, agencyUser, createOrg, createUser, ctxFor } from "./support/fixtures";
import { listMarketplaceServices, saveService, saveCategory, setServiceFlags, listCatalogForAdmin, listPriceHistory } from "@/server/catalog/service";
import { createProjectRequest, decideQuote, getProject, listProjects, postClientMessage, respondToMilestone, markQuoteViewed, attachClientFile } from "@/server/projects/client";
import {
  addProgressUpdate, assignProject, getAgencyProject, listAgencyProjects, listProjectClients, postAgencyMessage, recordHandover, saveInternalNotes, saveMilestone, saveQuoteDraft,
  sendQuote, setMilestoneStatus, updateProjectStatus, uploadDeliverable,
} from "@/server/projects/agency";
import { formatDelivery, formatPrice, suggestServices } from "@/lib/projects";
import { quoteContentHash } from "@/server/projects/shared";

let orgA: Awaited<ReturnType<typeof createOrg>>;
let orgB: Awaited<ReturnType<typeof createOrg>>;
let ownerA: { id: string; email: string };
let adminA: { id: string; email: string };
let memberA: { id: string; email: string };
let ownerB: { id: string; email: string };
let staffAssigned: ReturnType<typeof agencyUser>;
let staffOther: ReturnType<typeof agencyUser>;
let superAdmin: ReturnType<typeof agencyUser>;

const ctxOwnerA = () => ctxFor(ownerA, orgA, "owner");
const ctxAdminA = () => ctxFor(adminA, orgA, "admin");
const ctxMemberA = () => ctxFor(memberA, orgA, "member");
const ctxOwnerB = () => ctxFor(ownerB, orgB, "owner");

const request = (title = "AI receptionist for incoming calls") => ({
  title,
  problem: "We miss calls after hours and lose booked appointments.",
  currentProcess: "Calls go to voicemail and someone returns them the next day.",
  desiredOutcome: "An AI answers calls and books appointments on our calendar.",
  tools: ["GoHighLevel", "Google Calendar"],
});

const fullQuote = () => ({
  projectName: "AI voice receptionist",
  scope: "Configure and deploy a voice receptionist that answers inbound calls, checks availability and books appointments.",
  deliverables: ["Voice agent", "Calendar integration", "Documentation"],
  includedIntegrations: ["Google Calendar"],
  exclusions: ["Telephony usage costs"],
  timelineText: "3–4 weeks",
  estimatedWeeksMin: 3,
  estimatedWeeksMax: 4,
  oneTimeCents: 120000,
  ongoingMonthlyCents: null,
  ongoingDescription: null,
  revisionTerms: "Two rounds of revisions are included.",
  paymentTerms: "50% to begin, 50% on delivery.",
  warrantyTerms: "30 days of post-launch fixes.",
  validUntil: null,
  internalNotes: "Margin is fine.",
});

beforeAll(async () => {
  orgA = await createOrg({ name: "Alpha Dental" });
  orgB = await createOrg({ name: "Beta Roofing" });
  ownerA = await createUser();
  adminA = await createUser();
  memberA = await createUser();
  ownerB = await createUser();
  await addMember(orgA.id, ownerA.id, "owner");
  await addMember(orgA.id, adminA.id, "admin");
  await addMember(orgA.id, memberA.id, "member");
  await addMember(orgB.id, ownerB.id, "owner");
  const s1 = await createUser({ platformRole: "agency_staff" });
  const s2 = await createUser({ platformRole: "agency_staff" });
  const sa = await createUser({ platformRole: "agency_super_admin" });
  staffAssigned = agencyUser(s1, "agency_staff");
  staffOther = agencyUser(s2, "agency_staff");
  superAdmin = agencyUser(sa, "agency_super_admin");
  await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [orgA.id, s1.id]));
});

describe("service catalog and pricing rules", () => {
  it("seeds the founder's published catalog with distinct price tiers", async () => {
    const services = await listMarketplaceServices(ownerA.id);
    const by = (slug: string) => services.find((s) => s.slug === slug)!;
    expect(services.length).toBe(15);
    expect(services.some((s) => s.kind === "maintenance_plan")).toBe(false);
    // Ready-to-use automations $499–$999, agents $699–$1,499, web & funnels $899–$1,799.
    expect(formatPrice(by("lead-capture-qualification").price)).toBe("$499–$999");
    expect(formatPrice(by("ai-voice-receptionist").price)).toBe("$699–$1,499");
    expect(formatPrice(by("shopify-starter-system").price)).toBe("$899–$1,799");
    // Custom work is a starting price, never a fixed total.
    expect(formatPrice(by("custom-automation-system").price)).toBe("From $1,500");
    expect(formatPrice(by("custom-ai-agent").price)).toBe("From $2,000");
    expect(formatPrice(by("custom-web-saas-shopify").price)).toBe("From $2,500");
    expect(formatDelivery(by("custom-automation-system").deliveryMinDays, by("custom-automation-system").deliveryMaxDays)).toBe("2–4 weeks");
    expect(formatDelivery(by("custom-ai-agent").deliveryMinDays, by("custom-ai-agent").deliveryMaxDays)).toBe("3–6 weeks");
    expect(formatDelivery(by("custom-web-saas-shopify").deliveryMinDays, by("custom-web-saas-shopify").deliveryMaxDays)).toBe("4–10 weeks");
    expect(by("lead-capture-qualification").requiresQuote).toBe(true);
  });

  it("keeps the maintenance plan at $299/month and separate from the marketplace", async () => {
    const { rows } = await withSystem((db) =>
      db.query<{ min_cents: number; price_type: string }>("select v.min_cents, v.price_type from service_catalog s join service_price_versions v on v.id = s.current_price_version_id where s.kind = 'maintenance_plan'"),
    );
    expect(rows).toEqual([{ min_cents: 29900, price_type: "monthly" }]);
  });

  it("agents carry a note that standard iAcquire employees are not an add-on", async () => {
    const services = await listMarketplaceServices(ownerA.id);
    expect(services.find((s) => s.slug === "ai-voice-receptionist")!.coreOverlapNote).toMatch(/never an add-on/);
  });

  it("only super admins edit the catalog; price changes become immutable versions; hidden services disappear for clients", async () => {
    await expect(saveService(staffAssigned, { categoryId: "00000000-0000-0000-0000-000000000000", slug: "x", kind: "ready_system", name: "Nope" })).rejects.toThrow(/super admins/);
    const catalog = await listCatalogForAdmin(superAdmin);
    const svc = catalog.services.find((s) => s.slug === "reporting-notification-system")!;
    const edit = (over: Record<string, unknown>) => ({
      id: svc.id, categoryId: svc.categoryId, slug: svc.slug, kind: svc.kind, name: svc.name, tagline: svc.tagline, platforms: svc.platforms, tags: ["ai-automation" as const],
      deliveryMinDays: 4, deliveryMaxDays: 8, ...over,
    });
    await saveService(superAdmin, edit({ price: { type: "range", minCents: 59900, maxCents: 109900, note: null } }));
    const history = await listPriceHistory(superAdmin, svc.id);
    expect(history.map((h) => h.version)).toEqual([2, 1]);
    expect(history[0].min_cents).toBe(59900);
    // Saving the identical price again does not create a version.
    await saveService(superAdmin, edit({ price: { type: "range", minCents: 59900, maxCents: 109900, note: null } }));
    expect((await listPriceHistory(superAdmin, svc.id)).length).toBe(2);
    await expect(saveService(superAdmin, edit({ price: { type: "range", minCents: 90000, maxCents: 50000, note: null } }))).rejects.toThrow();

    await setServiceFlags(superAdmin, svc.id, { visible: false });
    expect((await listMarketplaceServices(ownerA.id)).some((s) => s.id === svc.id)).toBe(false);
    expect((await listCatalogForAdmin(superAdmin)).services.some((s) => s.id === svc.id)).toBe(true);
    await setServiceFlags(superAdmin, svc.id, { visible: true });
  });

  it("only super admins manage categories, and hiding a category hides its services from clients", async () => {
    await expect(saveCategory(staffAssigned, { name: "Staff category" })).rejects.toThrow(/super admins/);
    const created = await saveCategory(superAdmin, { name: "Seasonal Offers", tier: "custom", description: "Limited-time work." });
    const catalog = await listCatalogForAdmin(superAdmin);
    expect(catalog.categories.find((c) => c.id === created.id)).toMatchObject({ code: "seasonal_offers", visible: true });
    await expect(saveCategory(superAdmin, { name: "Seasonal Offers" })).rejects.toThrow(/already exists/);
    const reporting = catalog.categories.find((c) => c.code === "ready_automations")!;
    await saveCategory(superAdmin, { id: reporting.id, name: reporting.name, description: reporting.description, tier: "ready_to_use", sortOrder: reporting.sortOrder, visible: false });
    const hidden = await listMarketplaceServices(ownerA.id);
    expect(hidden.some((s) => s.categoryCode === "ready_automations")).toBe(false);
    expect(hidden.length).toBe(10);
    await saveCategory(superAdmin, { id: reporting.id, name: reporting.name, description: reporting.description, tier: "ready_to_use", sortOrder: reporting.sortOrder, visible: true });
    expect((await listMarketplaceServices(ownerA.id)).length).toBe(15);
  });

  it("clients cannot write to the catalog or read hidden price data", async () => {
    await expect(withUser(ownerA.id, (db) => db.query("update service_catalog set featured = true"))).rejects.toThrow();
    await expect(withUser(ownerA.id, (db) => db.query("insert into service_price_versions (service_id, version, price_type, min_cents) select id, 99, 'starting_at', 1 from service_catalog limit 1"))).rejects.toThrow();
  });

  it("suggests the voice receptionist for the phone-call example without promising a price", async () => {
    const services = await listMarketplaceServices(ownerA.id);
    const s = suggestServices("I want an AI that answers incoming customer phone calls and automatically books appointments.", [], services);
    expect(s[0].service.slug).toBe("ai-voice-receptionist");
    expect(suggestServices("hi", [], services)).toEqual([]);
  });
});

describe("project requests: submission and tenant isolation", () => {
  let id: string;
  it("members cannot request; owners and admins can; nothing is charged", async () => {
    await expect(createProjectRequest(ctxMemberA(), request())).rejects.toThrow(/can't request/);
    const created = await createProjectRequest(ctxOwnerA(), { ...request(), serviceSlug: "ai-voice-receptionist" });
    id = created.id;
    expect(created.ref).toMatch(/^PRJ-\d+$/);
    const row = (await withSystem((db) => db.query<{ status: string; org_id: string; suggested_service_ids: string[] }>("select status, org_id, suggested_service_ids from client_project_requests where id = $1", [id]))).rows[0];
    expect(row.status).toBe("submitted");
    expect(row.org_id).toBe(orgA.id);
    expect(row.suggested_service_ids.length).toBeGreaterThan(0);
    const tasks = await withSystem((db) => db.query("select kind from project_review_tasks where request_id = $1 and status = 'open'", [id]));
    expect(tasks.rows).toEqual([{ kind: "initial_review" }]);
    const reqs = await withSystem((db) => db.query("select key from project_requirements where request_id = $1 order by sort_order", [id]));
    expect(reqs.rows.map((r) => (r as { key: string }).key)).toEqual(["build", "problem", "current_process", "desired_outcome", "tools", "deadline", "budget"]);
    // The request is a record only: no quote, no project price, no billing change.
    expect((await withSystem((db) => db.query("select 1 from client_projects where request_id = $1", [id]))).rows).toHaveLength(0);
    const notified = await withSystem((db) => db.query("select 1 from notifications where kind = 'project_submitted' and user_id = $1", [superAdmin.id]));
    expect(notified.rows.length).toBeGreaterThan(0);
  });

  it("budget and deadline are optional, a past deadline is rejected, an unavailable service is refused", async () => {
    await expect(createProjectRequest(ctxAdminA(), { ...request("Another idea for workflows"), preferredDeadline: "2001-01-01" })).rejects.toThrow(/deadline/);
    await expect(createProjectRequest(ctxAdminA(), { ...request("Pick a missing service"), serviceSlug: "does-not-exist" })).rejects.toThrow(/isn't available/);
    await withSystem((db) => db.query("update service_catalog set availability = 'coming_soon' where slug = 'crm-pipeline-automation'"));
    await expect(createProjectRequest(ctxAdminA(), { ...request("CRM sync job"), serviceSlug: "crm-pipeline-automation" })).rejects.toThrow(/isn't open/);
    await withSystem((db) => db.query("update service_catalog set availability = 'available' where slug = 'crm-pipeline-automation'"));
  });

  it("another company can neither list nor read the request, and RLS blocks direct queries", async () => {
    expect((await listProjects(ctxOwnerB())).length).toBe(0);
    expect(await getProject(ctxOwnerB(), id)).toBeNull();
    const direct = await withUser(ownerB.id, (db) => db.query("select id from client_project_requests"));
    expect(direct.rows).toHaveLength(0);
    // Even claiming the right id under B's context, the org scope hides it.
    expect(await getProject({ ...ctxOwnerB(), org: { ...ctxOwnerB().org, orgId: orgA.id } }, id)).toBeNull();
    const mine = await listProjects(ctxMemberA());
    expect(mine.map((p) => p.id)).toContain(id);
  });

  it("clients can never read or change agency-only columns", async () => {
    await expect(withUser(ownerA.id, (db) => db.query("select internal_notes from client_project_requests"))).rejects.toThrow(/permission denied/);
    await expect(withUser(ownerA.id, (db) => db.query("update client_project_requests set status = 'completed'"))).rejects.toThrow(/permission denied/);
    await expect(withUser(ownerA.id, (db) => db.query("update project_quotes set one_time_cents = 1"))).rejects.toThrow(/permission denied/);
    await expect(withUser(ownerA.id, (db) => db.query("select * from project_review_tasks"))).rejects.toThrow(/permission denied/);
  });

  it("the agency queue's client filter only lists clients the viewer works with", async () => {
    expect((await listProjectClients(staffAssigned)).map((c) => c.id)).toEqual([orgA.id]);
    expect(await listProjectClients(staffOther)).toEqual([]);
    expect((await listProjectClients(superAdmin)).map((c) => c.id)).toContain(orgA.id);
  });

  it("agency access is limited to assigned clients; unassigned staff get 'not found'", async () => {
    expect(await getAgencyProject(staffOther, id)).toBeNull();
    expect((await listAgencyProjects(staffOther)).some((p) => p.id === id)).toBe(false);
    await expect(updateProjectStatus(staffOther, id, { status: "under_review" })).rejects.toThrow(/not found/i);
    await expect(saveInternalNotes(staffOther, id, "peek")).rejects.toThrow(/not found/i);
    expect(await getAgencyProject(staffAssigned, id)).not.toBeNull();
    expect((await listAgencyProjects(staffAssigned)).some((p) => p.id === id)).toBe(true);
    expect((await listAgencyProjects(superAdmin)).some((p) => p.id === id)).toBe(true);
    const manager = agencyUser(await createUser({ platformRole: "agency_manager" }), "agency_manager");
    expect(await getAgencyProject(manager, id)).not.toBeNull();
    expect((await listAgencyProjects(manager)).some((p) => p.id === id)).toBe(true);
    await assignProject(manager, id, manager.id);
    expect((await getAgencyProject(manager, id))!.assignedTo?.id).toBe(manager.id);

    await updateAgencyUserPermission(superAdmin, { userId: staffAssigned.id, permission: "projects.view", effect: "deny" });
    await expect(listAgencyProjects(staffAssigned)).rejects.toMatchObject({ code: "forbidden" });
    await expect(updateProjectStatus(staffAssigned, id, { status: "under_review" })).rejects.toMatchObject({ code: "forbidden" });
    await updateAgencyUserPermission(superAdmin, { userId: staffAssigned.id, permission: "projects.view", effect: null });
  });
});

describe("project workflow, messages and files", () => {
  let id: string;
  beforeAll(async () => {
    id = (await createProjectRequest(ctxOwnerA(), request("Workflow test project"))).id;
  });

  it("enforces status transitions and records every change in the audit trail", async () => {
    await expect(updateProjectStatus(staffAssigned, id, { status: "testing" })).rejects.toThrow(/can't move/);
    await expect(updateProjectStatus(staffAssigned, id, { status: "completed" })).rejects.toThrow();
    await expect(updateProjectStatus(staffAssigned, id, { status: "cancelled" })).rejects.toThrow(/reason/);
    await updateProjectStatus(staffAssigned, id, { status: "under_review" });
    const audit = await withSystem((db) => db.query("select metadata from audit_logs where target_id = $1 and action = 'project.status_changed'", [id]));
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows[0])).toContain("under_review");
    // Opening review closes the initial-review task.
    expect((await withSystem((db) => db.query("select 1 from project_review_tasks where request_id = $1 and status = 'open' and kind = 'initial_review'", [id]))).rows).toHaveLength(0);
  });

  it("asks for information, moves to Discovery Needed, and returns to review when the client answers", async () => {
    await postAgencyMessage(staffAssigned, id, "Which calendar do you use?", { infoRequest: true });
    expect((await getProject(ctxOwnerA(), id))!.request.status).toBe("discovery_needed");
    await postClientMessage(ctxAdminA(), id, "We use Google Calendar.");
    const p = (await getProject(ctxOwnerA(), id))!;
    expect(p.request.status).toBe("under_review");
    expect(p.messages.map((m) => m.kind)).toContain("info_response");
    await expect(postClientMessage(ctxMemberA(), id, "hi")).rejects.toThrow(/can't message/);
  });

  it("hides internal notes, internal messages and internal updates from clients", async () => {
    await saveInternalNotes(staffAssigned, id, "Client is price sensitive");
    await postAgencyMessage(staffAssigned, id, "Internal: quote high end", { internal: true });
    await addProgressUpdate(staffAssigned, id, "Internal: waiting on vendor", "internal");
    await addProgressUpdate(staffAssigned, id, "Kick-off call scheduled.", "client");
    const client = (await getProject(ctxOwnerA(), id))!;
    expect(JSON.stringify(client)).not.toContain("price sensitive");
    expect(client.messages.some((m) => m.internal)).toBe(false);
    expect(client.updates.some((u) => u.visibility === "internal")).toBe(false);
    expect(client.updates.some((u) => u.body.includes("Kick-off"))).toBe(true);
    const agency = (await getAgencyProject(staffAssigned, id))!;
    expect(agency.internalNotes).toBe("Client is price sensitive");
    expect(agency.messages.some((m) => m.internal)).toBe(true);
    // Raw SQL as the client confirms row-level security, not just the service layer.
    const direct = await withUser(ownerA.id, (db) => db.query("select internal from project_messages where internal"));
    expect(direct.rows).toHaveLength(0);
  });

  it("assigns only people who work on this client", async () => {
    await assignProject(staffAssigned, id, staffAssigned.id);
    await expect(assignProject(staffAssigned, id, staffOther.id)).rejects.toThrow(/works on this client/);
    expect((await getAgencyProject(superAdmin, id))!.assignedTo?.id).toBe(staffAssigned.id);
  });

  it("stores client and agency files privately and only the right people can download them", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082", "hex");
    const f = await attachClientFile(ctxOwnerA(), id, { name: "example.png", bytes: png }, "A screenshot of the current form");
    expect(f.filename).toBe("example.png");
    await expect(attachClientFile(ctxMemberA(), id, { name: "example.png", bytes: png })).rejects.toThrow(/can't add/);
    await expect(attachClientFile(ctxOwnerA(), id, { name: "bad.exe", bytes: Buffer.from("MZ") })).rejects.toThrow(/Choose a/);
    await uploadDeliverable(staffAssigned, id, { name: "internal-notes.txt", bytes: Buffer.from("internal only") }, { visibility: "internal", kind: "reference" });
    await uploadDeliverable(staffAssigned, id, { name: "handover.txt", bytes: Buffer.from("deliverable doc") }, { visibility: "client", kind: "deliverable" });
    const client = (await getProject(ctxOwnerA(), id))!;
    expect(client.files.map((x) => x.filename).sort()).toEqual(["example.png", "handover.txt"]);
    const agency = (await getAgencyProject(superAdmin, id))!;
    expect(agency.files.map((x) => x.filename)).toContain("internal-notes.txt");
    // Other tenants see no files at all.
    expect((await withUser(ownerB.id, (db) => db.query("select id from project_files"))).rows).toHaveLength(0);
    expect((await withUser(ownerB.id, (db) => db.query("select id from private_files where bucket = 'project-uploads'"))).rows).toHaveLength(0);
  });
});

describe("quotes, approval and delivery", () => {
  let id: string;
  let quoteId: string;
  beforeAll(async () => {
    id = (await createProjectRequest(ctxOwnerA(), request("Quote lifecycle project"))).id;
    await updateProjectStatus(staffAssigned, id, { status: "under_review" });
  });

  it("drafts are invisible to clients and cannot be sent while incomplete", async () => {
    quoteId = (await saveQuoteDraft(staffAssigned, id, { projectName: "AI voice receptionist" })).id;
    expect((await getProject(ctxOwnerA(), id))!.quotes).toHaveLength(0);
    expect((await withUser(ownerA.id, (db) => db.query("select id from project_quotes"))).rows).toHaveLength(0);
    await expect(sendQuote(staffAssigned, id, quoteId)).rejects.toThrow(/Complete the quote before sending/);
    await saveQuoteDraft(staffAssigned, id, { id: quoteId, ...fullQuote() });
    expect((await getProject(ctxOwnerA(), id))!.request.status).toBe("quote_preparing");
    await expect(saveQuoteDraft(staffAssigned, id, fullQuote())).rejects.toThrow(/already a draft/);
  });

  it("sending reveals the quote and its price, never the internal notes, and clients cannot decide before it is sent", async () => {
    await expect(decideQuote(ctxOwnerA(), quoteId, "accepted")).rejects.toThrow(/no longer open/);
    await sendQuote(staffAssigned, id, quoteId);
    const p = (await getProject(ctxOwnerA(), id))!;
    expect(p.request.status).toBe("quote_sent");
    expect(p.quotes[0].oneTimeCents).toBe(120000);
    expect(JSON.stringify(p)).not.toContain("Margin is fine");
    await expect(withUser(ownerA.id, (db) => db.query("select internal_notes from project_quotes"))).rejects.toThrow(/permission denied/);
    await markQuoteViewed(ctxOwnerA(), quoteId);
    expect((await getProject(ctxOwnerA(), id))!.request.status).toBe("awaiting_approval");
    // Sent quotes are immutable: edit by drafting a new version.
    await expect(saveQuoteDraft(staffAssigned, id, { id: quoteId, ...fullQuote(), oneTimeCents: 1 })).rejects.toThrow(/Only drafts/);
  });

  it("only an owner can accept; a tampered quote is refused; acceptance records the account, time and exact terms", async () => {
    await expect(decideQuote(ctxAdminA(), quoteId, "accepted")).rejects.toThrow(/owner/);
    await expect(decideQuote(ctxMemberA(), quoteId, "changes_requested", "lower please")).rejects.toThrow(/can't respond/);
    await expect(decideQuote(ctxOwnerB(), quoteId, "accepted")).rejects.toThrow(/not found/i);
    // Simulate the stored terms changing after sending (database tampering): the decision must be refused.
    await withSystem((db) => db.query("update project_quotes set one_time_cents = 100 where id = $1", [quoteId]));
    await expect(decideQuote(ctxOwnerA(), quoteId, "accepted")).rejects.toThrow(/changed after it was sent/);
    await withSystem((db) => db.query("update project_quotes set one_time_cents = 120000 where id = $1", [quoteId]));
    const result = await decideQuote(ctxOwnerA(), quoteId, "accepted", undefined, "iphash");
    expect(result.decision).toBe("accepted");
    const p = (await getProject(ctxOwnerA(), id))!;
    expect(p.request.status).toBe("approved");
    expect(p.delivery!.agreedPriceCents).toBe(120000);
    const approval = (await withSystem((db) => db.query<{ decided_by: string; acknowledgement: string; content_hash: string }>("select decided_by, acknowledgement, content_hash from quote_approvals where quote_id = $1", [quoteId]))).rows[0];
    expect(approval.decided_by).toBe(ownerA.id);
    expect(approval.acknowledgement).toMatch(/not an electronic signature/);
    expect(approval.content_hash).toHaveLength(64);
    // A second decision is refused, and approvals are append-only.
    await expect(decideQuote(ctxOwnerA(), quoteId, "declined")).rejects.toThrow(/no longer open/);
    await expect(withSystem((db) => db.query("update quote_approvals set decision = 'declined'"))).rejects.toThrow(/append-only/);
    // No payment was triggered: acceptance only creates records.
    expect(p.delivery!.completedAt).toBeNull();
  });

  it("walks the delivery milestones, with client approval controlled by the client", async () => {
    await updateProjectStatus(staffAssigned, id, { status: "in_development" });
    await saveMilestone(staffAssigned, id, { title: "Discovery", requiresClientApproval: false });
    await saveMilestone(staffAssigned, id, { title: "Voice agent build", requiresClientApproval: true });
    const ms = (await getAgencyProject(staffAssigned, id))!.milestones;
    const build = ms.find((m) => m.title === "Voice agent build")!;
    await expect(setMilestoneStatus(staffAssigned, id, build.id, "completed")).rejects.toThrow(/client has to approve/);
    await expect(setMilestoneStatus(staffAssigned, id, ms[0].id, "awaiting_approval")).rejects.toThrow(/doesn't need/);
    await setMilestoneStatus(staffAssigned, id, ms[0].id, "completed");
    await setMilestoneStatus(staffAssigned, id, build.id, "awaiting_approval");
    await expect(respondToMilestone(ctxMemberA(), build.id, "approve")).rejects.toThrow(/can't approve/);
    await expect(respondToMilestone(ctxOwnerB(), build.id, "approve")).rejects.toThrow(/not found/i);
    await respondToMilestone(ctxAdminA(), build.id, "request_changes", "Please change the greeting.");
    expect((await getProject(ctxOwnerA(), id))!.milestones.find((m) => m.id === build.id)!.status).toBe("in_progress");
    await setMilestoneStatus(staffAssigned, id, build.id, "awaiting_approval");
    await respondToMilestone(ctxOwnerA(), build.id, "approve");
    const done = (await getProject(ctxOwnerA(), id))!.milestones.find((m) => m.id === build.id)!;
    expect(done.status).toBe("completed");
    expect(done.clientApprovedAt).not.toBeNull();
  });

  it("records completion and handover only from Ready for Review", async () => {
    await expect(recordHandover(staffAssigned, id, "All delivered and documented for the client.")).rejects.toThrow(/Ready for Review/);
    await updateProjectStatus(staffAssigned, id, { status: "testing" });
    await updateProjectStatus(staffAssigned, id, { status: "ready_for_review" });
    await expect(recordHandover(staffAssigned, id, "short")).rejects.toThrow(/10/);
    await recordHandover(staffAssigned, id, "Voice receptionist delivered with documentation and a walkthrough recording.");
    const p = (await getProject(ctxOwnerA(), id))!;
    expect(p.request.status).toBe("completed");
    expect(p.delivery!.handoverNotes).toMatch(/walkthrough/);
    await expect(postClientMessage(ctxOwnerA(), id, "thanks")).rejects.toThrow(/closed/);
  });

  it("declining a quote cancels the request with a reason, and requesting changes sends it back to quote preparation", async () => {
    const a = (await createProjectRequest(ctxOwnerA(), request("Decline path project"))).id;
    await updateProjectStatus(staffAssigned, a, { status: "under_review" });
    const q1 = (await saveQuoteDraft(staffAssigned, a, fullQuote())).id;
    await sendQuote(staffAssigned, a, q1);
    await decideQuote(ctxAdminA(), q1, "changes_requested", "Can we drop the calendar integration?");
    let p = (await getProject(ctxOwnerA(), a))!;
    expect(p.request.status).toBe("quote_preparing");
    expect(p.quotes[0].status).toBe("changes_requested");
    const q2 = (await saveQuoteDraft(staffAssigned, a, { ...fullQuote(), oneTimeCents: 90000 })).id;
    await sendQuote(staffAssigned, a, q2);
    await decideQuote(ctxOwnerA(), q2, "declined", "Too expensive right now.");
    p = (await getProject(ctxOwnerA(), a))!;
    expect(p.request.status).toBe("cancelled");
    expect(p.request.cancelReason).toBe("Too expensive right now.");
    expect(p.quotes.map((q) => q.version)).toEqual([2, 1]);
  });

  it("an expired quote cannot be accepted", async () => {
    const b = (await createProjectRequest(ctxOwnerA(), request("Expiry path project"))).id;
    await updateProjectStatus(staffAssigned, b, { status: "under_review" });
    const q = (await saveQuoteDraft(staffAssigned, b, { ...fullQuote(), validUntil: "2099-01-01" })).id;
    await sendQuote(staffAssigned, b, q);
    // Move validity into the past and keep the integrity hash consistent, so only the expiry is under test.
    const sent = (await getAgencyProject(staffAssigned, b))!.quotes.find((x) => x.id === q)!;
    await withSystem((db) => db.query("update project_quotes set valid_until = '2001-01-01', content_hash = $2 where id = $1", [q, quoteContentHash({ ...sent, validUntil: "2001-01-01" })]));
    await expect(decideQuote(ctxOwnerA(), q, "accepted")).rejects.toThrow(/expired/);
    // Declining or asking for changes is still possible.
    await decideQuote(ctxOwnerA(), q, "declined", "No longer needed.");
  });

  it("is not decided while staff have held or cancelled the project, so a closed project is never brought back to Approved", async () => {
    // A fresh owner: project requests are limited per person per hour and the earlier tests in this file spend the first owner's allowance.
    const owner = await createUser();
    await addMember(orgA.id, owner.id, "owner");
    const ctx = ctxFor(owner, orgA, "owner");
    const rows = async (table: string, id: string) => Number((await withSystem((db) => db.query<{ n: string }>(`select count(*)::text as n from ${table} where request_id = $1`, [id]))).rows[0].n);
    const statusOf = async (id: string) => (await withSystem((db) => db.query<{ status: string }>("select status from client_project_requests where id = $1", [id]))).rows[0].status;
    const id = (await createProjectRequest(ctx, request("Held then accepted project"))).id;
    await updateProjectStatus(staffAssigned, id, { status: "under_review" });
    const q = (await saveQuoteDraft(staffAssigned, id, fullQuote())).id;
    await sendQuote(staffAssigned, id, q);

    await updateProjectStatus(staffAssigned, id, { status: "on_hold", reason: "Waiting for the client's budget." });
    for (const decision of ["accepted", "declined", "changes_requested"] as const) await expect(decideQuote(ctx, q, decision, "please")).rejects.toThrow(/on hold/);
    expect(await statusOf(id)).toBe("on_hold");
    expect(await rows("client_projects", id)).toBe(0);
    expect(await rows("quote_approvals", id)).toBe(0);

    // Resume it, then cancel it from there to prove the second closed state too.
    await updateProjectStatus(staffAssigned, id, { resume: true });
    expect(await statusOf(id)).toBe("quote_sent");
    await updateProjectStatus(staffAssigned, id, { status: "cancelled", reason: "The client changed plans." });
    // Cancelling withdraws the quote that was still waiting, so the client is told it is no longer open (the status guard behind it is the backstop).
    await expect(decideQuote(ctx, q, "accepted")).rejects.toThrow(/no longer open/);
    expect(await statusOf(id)).toBe("cancelled");
    expect(await rows("client_projects", id)).toBe(0);
    expect(await rows("quote_approvals", id)).toBe(0);

    // A project that was only held can be decided again once it resumes.
    const id2 = (await createProjectRequest(ctx, request("Held then resumed project"))).id;
    await updateProjectStatus(staffAssigned, id2, { status: "under_review" });
    const q2 = (await saveQuoteDraft(staffAssigned, id2, fullQuote())).id;
    await sendQuote(staffAssigned, id2, q2);
    await updateProjectStatus(staffAssigned, id2, { status: "on_hold" });
    await expect(decideQuote(ctx, q2, "accepted")).rejects.toThrow(/on hold/);
    await updateProjectStatus(staffAssigned, id2, { resume: true });
    expect((await decideQuote(ctx, q2, "accepted")).decision).toBe("accepted");
    expect(await statusOf(id2)).toBe("approved");
  });
});
