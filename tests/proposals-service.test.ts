// Proposals on embedded Postgres: who may do what, what an approval covers, what a send does to the rest of the CRM, and what another workspace can never see or change.
import { describe, expect, it } from "vitest";
import { agencyActor, agentActor, startSupportSession } from "@/server/crm/actor";
import { createCompany } from "@/server/crm/companies";
import { createContact } from "@/server/crm/contacts";
import { createOpportunity } from "@/server/crm/opportunities";
import { createTag } from "@/server/crm/tags";
import { createCatalogItem, createTaxRate, listCatalogItems, listTaxRates, updateCatalogItem, updateTaxRate } from "@/server/proposals/catalog";
import { clearFeatureCache, featureOn, setOrgFeature } from "@/server/proposals/features";
import {
  createProposal, decideProposal, getProposal, listProposals, recordOfflineDecision, sendProposal, submitForApproval, updateProposal, withdrawProposal,
} from "@/server/proposals/proposals";
import { getProposalSettings, saveProposalSettings } from "@/server/proposals/settings";
import { approveTemplate, archiveTemplate, createTemplate, getTemplate, listTemplates, saveTemplate } from "@/server/proposals/templates";
import { agencyPeople } from "./support/crm";
import { createUser, uid } from "./support/fixtures";
import { approvedProposal, draftBy, lineOf, proposalOrg, rows, setFeature, type ProposalOrg } from "./support/proposals";

const NOW = new Date("2026-10-23T12:00:00Z");
const deps = { now: NOW };

async function contactAndDeal(p: ProposalOrg) {
  const email = `maria-${uid()}@example.test`;
  const contact = await createContact(p.actor("owner"), { firstName: "Maria", lastName: "Santos", email });
  const deal = await createOpportunity(p.actor("owner"), { name: "Clinic website", contactId: contact.id, value: 1500, currency: "USD" });
  return { contactId: contact.id, dealId: deal.id, email };
}

const events = (id: string) => rows<{ kind: string; actor_kind: string; version: number | null }>("select kind, actor_kind, version from proposal_events where proposal_id = $1 order by id", [id]);
const kinds = async (id: string) => (await events(id)).map((e) => e.kind);

describe("switching proposals on", () => {
  it("does nothing for a workspace a Super Admin has not switched on", async () => {
    const p = await proposalOrg({ feature: false });
    expect(await featureOn(p.org.id, "proposals")).toBe(false);
    await expect(createProposal(p.actor("owner"), { title: "x" })).rejects.toMatchObject({ code: "not_enabled" });
    await expect(listProposals(p.actor("owner"))).rejects.toMatchObject({ code: "not_enabled" });
    await expect(createCatalogItem(p.actor("owner"), { name: "x", unitPriceMinor: 1, currency: "USD" })).rejects.toMatchObject({ code: "not_enabled" });
    await expect(getProposalSettings(p.actor("owner"))).rejects.toMatchObject({ code: "not_enabled" });
  });

  it("lets only a Super Admin switch it on or off, audits it, and takes effect at once", async () => {
    const p = await proposalOrg({ feature: false });
    const agency = await agencyPeople();
    await expect(setOrgFeature(agency.staff, { orgId: p.org.id, feature: "proposals", enabled: true })).rejects.toThrow(/Super Admin/);
    await expect(setOrgFeature(agency.superAdmin, { orgId: p.org.id, feature: "Proposals!", enabled: true })).rejects.toThrow(/feature name/);
    await expect(setOrgFeature(agency.superAdmin, { orgId: "00000000-0000-4000-8000-000000000000", feature: "proposals", enabled: true })).rejects.toThrow(/not found/);
    expect(await setOrgFeature(agency.superAdmin, { orgId: p.org.id, feature: "proposals", enabled: true })).toEqual({ changed: true });
    expect(await setOrgFeature(agency.superAdmin, { orgId: p.org.id, feature: "proposals", enabled: true })).toEqual({ changed: false });
    expect(await featureOn(p.org.id, "proposals")).toBe(true);
    await expect(listProposals(p.actor("owner"))).resolves.toEqual([]);
    await setOrgFeature(agency.superAdmin, { orgId: p.org.id, feature: "proposals", enabled: false });
    expect(await featureOn(p.org.id, "proposals")).toBe(false);
    const audit = await rows<{ action: string }>("select action from audit_logs where org_id = $1 and action like 'feature.%' order by created_at", [p.org.id]);
    expect(audit.map((a) => a.action)).toEqual(["feature.enabled", "feature.disabled"]);
  });

  it("switches one workspace without touching another", async () => {
    const a = await proposalOrg();
    const b = await proposalOrg({ feature: false });
    expect(await featureOn(a.org.id, "proposals")).toBe(true);
    expect(await featureOn(b.org.id, "proposals")).toBe(false);
    await setFeature(a.org.id, false);
    clearFeatureCache();
    expect(await featureOn(a.org.id, "proposals")).toBe(false);
    expect(await featureOn(a.org.id, "esign")).toBe(false);
  });
});

describe("who may do what", () => {
  it("lets a viewer look and nothing else, and keeps proposals from people who do not work with customers", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "sales");
    expect(await listProposals(p.actor("viewer"))).toHaveLength(1);
    await expect(getProposal(p.actor("viewer"), draft.id)).resolves.toMatchObject({ id: draft.id });
    await expect(createProposal(p.actor("viewer"), { title: "x" })).rejects.toThrow(/can't write proposals/);
    await expect(updateProposal(p.actor("viewer"), draft.id, { title: "y" }, draft.version)).rejects.toThrow(/can't write proposals/);
    await expect(sendProposal(p.actor("viewer"), draft.id)).rejects.toThrow(/can't send/);
    await expect(withdrawProposal(p.actor("viewer"), draft.id)).rejects.toThrow(/Only the person who wrote/);
    for (const who of ["setter", "support"] as const) await expect(listProposals(p.actor(who))).rejects.toThrow(/can't see proposals/);
  });

  it("lets a sales rep write, submit and send their own work, but not approve, record a decision, discount, change the price book or the settings", async () => {
    const p = await proposalOrg();
    const sales = p.actor("sales");
    const draft = await draftBy(p, "sales");
    await expect(decideProposal(sales, draft.id, { decision: "approve", version: draft.version })).rejects.toThrow(/owner or a manager/);
    await expect(recordOfflineDecision(sales, draft.id, { decision: "accepted" })).rejects.toThrow(/owner or a manager/);
    await expect(createCatalogItem(sales, { name: "x", unitPriceMinor: 1, currency: "USD" })).rejects.toThrow(/owner or a manager/);
    await expect(createTaxRate(sales, { name: "VAT", rateBps: 500 })).rejects.toThrow(/owner or a manager/);
    await expect(createTemplate(sales, { name: "x" })).rejects.toThrow(/owner or a manager/);
    await expect(saveProposalSettings(sales, { twoPerson: true }, 0)).rejects.toThrow(/only the business owner/i);
    await expect(updateProposal(sales, draft.id, { doc: { lines: [lineOf(p.item, 1000, { discount: { kind: "percent", bps: 1000 } })] } }, draft.version)).rejects.toThrow(/discount permission/);
    expect((await sendProposal(sales, draft.id, {}, deps)).status).toBe("sent");
  });

  it("lets a team member write and submit but not send; what they write needs someone who can send to approve it", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "member");
    await expect(sendProposal(p.member, draft.id)).rejects.toThrow(/can't send/);
    const pending = await submitForApproval(p.member, draft.id, deps);
    expect(pending.status).toBe("pending_approval");
    expect(pending.approval.reasons).toContain("cannot_send");
  });

  it("lets a manager do everything but change the settings or approve a template, and the owner all of it", async () => {
    const p = await proposalOrg();
    const manager = p.actor("manager");
    const owner = p.actor("owner");
    await expect(saveProposalSettings(manager, { twoPerson: true }, 0)).rejects.toThrow(/only the business owner/i);
    const t = await createTemplate(manager, { name: "Website package", doc: { lines: [{ catalogItemId: p.item.id, quantityMilli: 1000 }] } });
    await expect(approveTemplate(manager, t.id, 1)).rejects.toThrow(/only the business owner/i);
    expect((await approveTemplate(owner, t.id, 1)).status).toBe("approved");
    expect(await saveProposalSettings(owner, { twoPerson: true }, 0)).toMatchObject({ twoPerson: true, version: 1 });
  });

  it("refuses an agent, the system and the API, and sends the agency to a support session", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "sales");
    await expect(sendProposal(p.system, draft.id)).rejects.toThrow(/signed-in member/);
    await expect(createProposal(p.system, { title: "x" })).rejects.toThrow(/signed-in member/);
    await expect(decideProposal(p.system, draft.id, { decision: "approve", version: 1 })).rejects.toThrow(/signed-in member/);
    // An AI employee with every proposal permission is still not a signed-in member: it can neither write, approve, send nor record an answer.
    const allowed = ["proposals.view", "proposals.create", "proposals.discount", "proposals.approve", "proposals.send", "proposals.record_decision", "proposals.catalog", "proposals.settings"] as const;
    const agent = agentActor({ id: p.org.id, name: "Org", timezone: "UTC" }, { id: "00000000-0000-4000-8000-000000000001", displayName: "Sales Assistant" }, allowed);
    await expect(createProposal(agent, { title: "x" })).rejects.toThrow(/signed-in member/);
    await expect(sendProposal(agent, draft.id)).rejects.toThrow(/signed-in member/);
    await expect(decideProposal(agent, draft.id, { decision: "approve", version: 1 })).rejects.toThrow(/signed-in member/);
    await expect(recordOfflineDecision(agent, draft.id, { decision: "accepted" })).rejects.toThrow(/signed-in member/);
    await expect(withdrawProposal(agent, draft.id)).rejects.toThrow(/signed-in member/);
    expect((await getProposal(p.actor("owner"), draft.id)).status).toBe("draft");
    const agency = await agencyPeople();
    await expect(agencyActor(agency.superAdmin, p.org.id)).rejects.toThrow(/support session/);
  });

  it("lets the agency read inside a read-only session and set up the price book inside a write session, but never write or send a proposal", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "sales");
    const agency = await agencyPeople();
    await startSupportSession(agency.superAdmin, p.org.id, { mode: "read", reason: "Checking the proposal setup" });
    const reader = await agencyActor(agency.superAdmin, p.org.id);
    expect(await listProposals(reader)).toHaveLength(1);
    await expect(getProposal(reader, draft.id)).resolves.toMatchObject({ id: draft.id });
    await expect(createCatalogItem(reader, { name: "Setup", unitPriceMinor: 100, currency: "USD" })).rejects.toThrow(/read-only/);
    await startSupportSession(agency.superAdmin, p.org.id, { mode: "write", reason: "Building the price book for the client" });
    const writer = await agencyActor(agency.superAdmin, p.org.id);
    const item = await createCatalogItem(writer, { name: "Setup service", unitPriceMinor: 5_000, currency: "USD" });
    expect(item.name).toBe("Setup service");
    await expect(createProposal(writer, { title: "x" })).rejects.toThrow();
    await expect(sendProposal(writer, draft.id)).rejects.toThrow();
    await expect(decideProposal(writer, draft.id, { decision: "approve", version: 1 })).rejects.toThrow();
    await expect(saveProposalSettings(writer, { twoPerson: true }, 0)).rejects.toThrow();
    const audit = await rows<{ actor_kind: string }>("select actor_kind from audit_logs where org_id = $1 and action = 'proposals.catalog_item_created'", [p.org.id]);
    expect(audit.map((a) => a.actor_kind)).toContain("agency");
  });
});

describe("the workspace settings", () => {
  it("starts with everything off and nothing invented", async () => {
    const p = await proposalOrg();
    expect(await getProposalSettings(p.actor("viewer"))).toEqual({
      aiDraftsEnabled: false, approvalMode: "ai_and_discounts", approvalOverMinor: null, discountNeedsApproval: true, twoPerson: false, defaultValidityDays: null,
      tagOnSendId: null, stageOnSendId: null, dealOnAccept: "none", version: 0,
    });
  });

  it("saves under the version the owner was looking at and refuses a stale save", async () => {
    const p = await proposalOrg();
    const owner = p.actor("owner");
    const first = await saveProposalSettings(owner, { approvalMode: "all", approvalOverMinor: 500_000, defaultValidityDays: 30 }, 0);
    expect(first).toMatchObject({ approvalMode: "all", approvalOverMinor: 500_000, defaultValidityDays: 30, version: 1 });
    await expect(saveProposalSettings(owner, { twoPerson: true }, 0)).rejects.toThrow(/Someone else changed/);
    const second = await saveProposalSettings(owner, { twoPerson: true }, 1);
    expect(second).toMatchObject({ twoPerson: true, approvalMode: "all", version: 2 });
    await expect(saveProposalSettings(owner, { approvalOverMinor: null }, 1)).rejects.toThrow(/Someone else changed/);
    expect((await saveProposalSettings(owner, { approvalOverMinor: null }, 2)).approvalOverMinor).toBeNull();
    expect((await rows("select 1 from audit_logs where org_id = $1 and action = 'proposals.settings_saved'", [p.org.id])).length).toBe(3);
  });

  it("holds the limits and checks a tag and a stage belong to this workspace and fit", async () => {
    const p = await proposalOrg();
    const other = await proposalOrg();
    const owner = p.actor("owner");
    await expect(saveProposalSettings(owner, { defaultValidityDays: 0 }, 0)).rejects.toThrow(/1 to 365/);
    await expect(saveProposalSettings(owner, { defaultValidityDays: 366 }, 0)).rejects.toThrow(/1 to 365/);
    await expect(saveProposalSettings(owner, { approvalOverMinor: 0 }, 0)).rejects.toThrow(/positive/);
    await expect(saveProposalSettings(owner, { approvalOverMinor: 1.5 }, 0)).rejects.toThrow(/positive/);
    await expect(saveProposalSettings(owner, { approvalMode: "sometimes" as never }, 0)).rejects.toThrow(/Choose which/);
    const theirTag = await createTag(other.actor("owner"), { name: "Their tag" });
    await expect(saveProposalSettings(owner, { tagOnSendId: theirTag.id }, 0)).rejects.toThrow(/your tags/);
    const mine = await createTag(owner, { name: "Proposal sent" });
    expect((await saveProposalSettings(owner, { tagOnSendId: mine.id }, 0)).tagOnSendId).toBe(mine.id);
    await createContact(owner, { firstName: "A", lastName: "B", email: `${uid()}@example.test` });
    await createOpportunity(owner, { name: "Seed deal" });
    const stages = await rows<{ id: string; kind: string; org_id: string }>("select id, kind, org_id from crm_pipeline_stages where org_id = $1 order by position", [p.org.id]);
    const won = stages.find((s) => s.kind === "won");
    const open = stages.find((s) => s.kind === "open");
    expect(won && open).toBeTruthy();
    await expect(saveProposalSettings(owner, { stageOnSendId: (won as { id: string }).id }, 1)).rejects.toThrow(/open stage/);
    await createOpportunity(other.actor("owner"), { name: "Their deal" });
    const theirStages = await rows<{ id: string }>("select id from crm_pipeline_stages where org_id = $1 limit 1", [other.org.id]);
    expect(theirStages).toHaveLength(1);
    await expect(saveProposalSettings(owner, { stageOnSendId: theirStages[0].id }, 1)).rejects.toThrow(/your pipeline stages/);
    expect((await saveProposalSettings(owner, { stageOnSendId: (open as { id: string }).id }, 1)).stageOnSendId).toBe((open as { id: string }).id);
  });
});

describe("the price book and tax rates", () => {
  it("keeps each workspace's own, shows archived ones only on request, and never seeds a price", async () => {
    const fresh = await proposalOrg();
    const other = await proposalOrg();
    expect((await listCatalogItems(fresh.actor("viewer"))).map((i) => i.name)).toEqual(["Website build"]);
    expect((await listCatalogItems(other.actor("viewer"))).map((i) => i.id)).not.toContain(fresh.item.id);
    const extra = await createCatalogItem(fresh.actor("manager"), { name: "Hosting", unitPriceMinor: 2_500, currency: "USD", billing: "monthly" });
    expect(extra).toMatchObject({ unitPriceMinor: 2_500, billing: "monthly", unitLabel: "each", version: 1, archived: false });
    const archived = await updateCatalogItem(fresh.actor("manager"), extra.id, { archived: true }, 1);
    expect(archived).toMatchObject({ archived: true, version: 2 });
    expect((await listCatalogItems(fresh.actor("owner"))).map((i) => i.name)).toEqual(["Website build"]);
    expect((await listCatalogItems(fresh.actor("owner"), { includeArchived: true })).map((i) => i.name).sort()).toEqual(["Hosting", "Website build"]);
    await expect(updateCatalogItem(other.actor("owner"), fresh.item.id, { name: "Stolen" }, 1)).rejects.toThrow(/not found/);
  });

  it("refuses a stale save and bad figures, and checks the tax rate is the workspace's own", async () => {
    const p = await proposalOrg();
    const other = await proposalOrg();
    const owner = p.actor("owner");
    await expect(updateCatalogItem(owner, p.item.id, { name: "Renamed" }, 7)).rejects.toThrow(/Someone else changed/);
    const renamed = await updateCatalogItem(owner, p.item.id, { name: "Website build (5 pages)", unitPriceMinor: 160_000 }, 1);
    expect(renamed).toMatchObject({ name: "Website build (5 pages)", unitPriceMinor: 160_000, version: 2 });
    await expect(createCatalogItem(owner, { name: "", unitPriceMinor: 1, currency: "USD" })).rejects.toThrow(/name/);
    await expect(createCatalogItem(owner, { name: "x", unitPriceMinor: -1, currency: "USD" })).rejects.toThrow(/whole number/);
    await expect(createCatalogItem(owner, { name: "x", unitPriceMinor: 10.5, currency: "USD" })).rejects.toThrow(/whole number/);
    await expect(createCatalogItem(owner, { name: "x", unitPriceMinor: 1, currency: "ZZZ" })).rejects.toThrow(/currency/);
    await expect(createCatalogItem(owner, { name: "x", unitPriceMinor: 1, currency: "USD", billing: "weekly" as never })).rejects.toThrow(/once, monthly or yearly/);
    const theirs = await createTaxRate(other.actor("owner"), { name: "Their VAT", rateBps: 700 });
    await expect(createCatalogItem(owner, { name: "x", unitPriceMinor: 1, currency: "USD", taxRateId: theirs.id })).rejects.toThrow(/your tax rates/);
  });

  it("works with a currency that has no minor unit", async () => {
    const p = await proposalOrg();
    const yen = await createCatalogItem(p.actor("owner"), { name: "Consulting day", unitPriceMinor: 50_000, currency: "JPY" });
    const draft = await createProposal(p.actor("owner"), { title: "Yen proposal", currency: "JPY", clientName: "Sato", doc: { lines: [lineOf(yen, 2000)] } });
    expect(draft.liveTotals.one_time.total).toBe(100_000);
    await expect(createProposal(p.actor("owner"), { title: "Mixed", currency: "USD", clientName: "Sato", doc: { lines: [lineOf(yen)] } })).rejects.toThrow(/priced in JPY/);
  });

  it("totals only currencies it knows how to total, and writes the code in capitals", async () => {
    const p = await proposalOrg();
    expect((await createProposal(p.actor("owner"), { title: "Lower case", currency: "usd", clientName: "Maria" })).currency).toBe("USD");
    for (const code of ["PHP", "EUR", "GBP", "AUD", "CAD", "SGD", "JPY"]) expect((await createProposal(p.actor("owner"), { title: code, currency: code, clientName: "Maria" })).currency).toBe(code);
    for (const bad of ["XXX", "BTC", "US", "", "DOLLARS"]) await expect(createProposal(p.actor("owner"), { title: "Bad", currency: bad, clientName: "Maria" }), bad).rejects.toThrow(/isn't one iAcquire can total/);
  });

  it("changes a tax rate for new lines only, and refuses duplicate names", async () => {
    const p = await proposalOrg();
    const owner = p.actor("owner");
    const draft = await draftBy(p, "owner");
    expect(draft.doc.lines[0]).toMatchObject({ taxName: "Sales tax", taxBps: 1200 });
    await updateTaxRate(owner, p.tax.id, { rateBps: 2000 });
    const again = await getProposal(owner, draft.id, deps);
    expect(again.doc.lines[0].taxBps).toBe(1200);
    expect(again.liveTotals.one_time.total).toBe(168_000);
    const fresh = await draftBy(p, "owner");
    expect(fresh.doc.lines[0].taxBps).toBe(2000);
    await expect(createTaxRate(owner, { name: "sales TAX", rateBps: 100 })).rejects.toThrow(/already have a tax rate/);
    await expect(createTaxRate(owner, { name: "Bad", rateBps: 10_001 })).rejects.toThrow(/between 0% and 100%/);
    await updateTaxRate(owner, p.tax.id, { archived: true });
    expect((await listTaxRates(owner)).map((t) => t.name)).toEqual([]);
    expect((await listTaxRates(owner, { includeArchived: true })).map((t) => t.archived)).toEqual([true]);
  });
});

describe("templates", () => {
  it("makes frozen versions, keeps people on the approved one, and needs the owner's approval before anyone sends from it", async () => {
    const p = await proposalOrg();
    const owner = p.actor("owner");
    const manager = p.actor("manager");
    const t = await createTemplate(manager, { name: "Website package", doc: { sections: [{ heading: "Scope", body: "Hello {{client.first_name}}." }], lines: [{ catalogItemId: p.item.id, quantityMilli: 1000 }], terms: "Net 14." } });
    expect(t).toMatchObject({ key: "website-package", status: "draft", currentVersion: 1, approvedVersion: null });
    await expect(createProposal(p.actor("sales"), { templateId: t.id, clientName: "Maria" })).rejects.toThrow(/approved template/);
    expect((await approveTemplate(owner, t.id, 1)).status).toBe("approved");
    const fromV1 = await createProposal(p.actor("sales"), { templateId: t.id, clientName: "Maria Santos" });
    expect(fromV1).toMatchObject({ templateId: t.id, templateVersion: 1 });
    expect(fromV1.doc.lines).toHaveLength(1);
    expect(fromV1.doc.sections[0].body).toBe("Hello {{client.first_name}}.");
    // A newer version waits for approval; people keep using the approved one.
    const saved = await saveTemplate(manager, t.id, { doc: { sections: [{ heading: "Scope", body: "Changed." }], lines: [{ catalogItemId: p.item.id, quantityMilli: 2000 }], terms: "Net 30." } }, 1);
    expect(saved).toMatchObject({ currentVersion: 2, approvedVersion: 1, status: "approved" });
    const stillV1 = await createProposal(p.actor("sales"), { templateId: t.id, clientName: "Maria Santos" });
    expect(stillV1.templateVersion).toBe(1);
    expect(stillV1.doc.lines[0].quantityMilli).toBe(1000);
    await approveTemplate(owner, t.id, 2);
    const v2 = await createProposal(p.actor("sales"), { templateId: t.id, clientName: "Maria Santos" });
    expect(v2).toMatchObject({ templateVersion: 2 });
    expect(v2.doc.lines[0].quantityMilli).toBe(2000);
    expect((await getTemplate(owner, t.id)).versions.map((v) => [v.version, v.approved])).toEqual([[2, true], [1, false]]);
  });

  it("does not make a new version for an unchanged save, and refuses a stale one", async () => {
    const p = await proposalOrg();
    const doc = { lines: [{ id: "tl-line-001", catalogItemId: p.item.id, quantityMilli: 1000 }], terms: "Same." };
    const t = await createTemplate(p.actor("owner"), { name: "Same", doc });
    const same = await saveTemplate(p.actor("owner"), t.id, { name: "Same again", doc }, 1);
    expect(same).toMatchObject({ currentVersion: 1, name: "Same again" });
    await expect(saveTemplate(p.actor("owner"), t.id, { name: "x" }, 5)).rejects.toThrow(/Someone else changed/);
    expect((await rows("select 1 from proposal_template_versions where template_id = $1", [t.id])).length).toBe(1);
  });

  it("refuses a placeholder iAcquire does not know, an unfinished one, and a price book item of another workspace or one that is archived", async () => {
    const p = await proposalOrg();
    const other = await proposalOrg();
    const owner = p.actor("owner");
    await expect(createTemplate(owner, { name: "Bad", doc: { terms: "Dear {{client.nmae}}" } })).rejects.toThrow(/isn't a placeholder/);
    await expect(createTemplate(owner, { name: "Bad", doc: { terms: "Dear {{client.name" } })).rejects.toThrow(/unfinished placeholder/);
    await expect(createTemplate(owner, { name: "Bad", doc: { lines: [{ catalogItemId: other.item.id, quantityMilli: 1000 }] } })).rejects.toThrow(/not found/);
    const extra = await createCatalogItem(owner, { name: "Old service", unitPriceMinor: 100, currency: "USD" });
    const t = await createTemplate(owner, { name: "Uses old", doc: { lines: [{ catalogItemId: extra.id, quantityMilli: 1000 }] } });
    await approveTemplate(owner, t.id, 1);
    await updateCatalogItem(owner, extra.id, { archived: true }, 1);
    await expect(createProposal(owner, { templateId: t.id, clientName: "Maria" })).rejects.toThrow(/no longer available/);
    await expect(approveTemplate(owner, t.id, 1)).rejects.toThrow(/not found, or is archived/);
  });

  it("keeps each workspace's templates to itself and lets an archived one go", async () => {
    const p = await proposalOrg();
    const other = await proposalOrg();
    const t = await createTemplate(p.actor("owner"), { name: "Mine" });
    await expect(getTemplate(other.actor("owner"), t.id)).rejects.toThrow(/not found/);
    await expect(approveTemplate(other.actor("owner"), t.id, 1)).rejects.toThrow(/not found/);
    await expect(archiveTemplate(other.actor("owner"), t.id)).rejects.toThrow(/not found/);
    expect(await listTemplates(other.actor("owner"))).toEqual([]);
    await archiveTemplate(p.actor("owner"), t.id);
    expect(await listTemplates(p.actor("owner"))).toEqual([]);
    expect((await listTemplates(p.actor("owner"), { includeArchived: true }))[0].status).toBe("archived");
    await expect(saveTemplate(p.actor("owner"), t.id, { name: "x" }, 1)).rejects.toThrow(/archived/);
    // The name can be used again.
    expect((await createTemplate(p.actor("owner"), { name: "Mine" })).key).toBe("mine");
  });

  it("lets the agency build one as a setup service while the approval stays with the owner", async () => {
    const p = await proposalOrg();
    const agency = await agencyPeople();
    await startSupportSession(agency.superAdmin, p.org.id, { mode: "write", reason: "Building the client's templates" });
    const writer = await agencyActor(agency.superAdmin, p.org.id);
    const t = await createTemplate(writer, { name: "Built by the agency", doc: { lines: [{ catalogItemId: p.item.id, quantityMilli: 1000 }] } });
    await expect(approveTemplate(writer, t.id, 1)).rejects.toThrow();
    expect((await approveTemplate(p.actor("owner"), t.id, 1)).status).toBe("approved");
  });
});

describe("making a proposal", () => {
  it("numbers them P-0001, P-0002 and gives each workspace its own sequence", async () => {
    const a = await proposalOrg();
    const b = await proposalOrg();
    expect((await draftBy(a, "sales")).number).toBe("P-0001");
    expect((await draftBy(a, "sales")).number).toBe("P-0002");
    expect((await draftBy(b, "sales")).number).toBe("P-0001");
    const both = await Promise.all([draftBy(a, "owner"), draftBy(a, "manager"), draftBy(a, "sales")]);
    expect(new Set(both.map((d) => d.number)).size).toBe(3);
  });

  it("starts from a deal: the customer, company, currency and a title come from it, and nothing is approved", async () => {
    const p = await proposalOrg();
    const { contactId, dealId, email } = await contactAndDeal(p);
    const company = await createCompany(p.actor("owner"), { name: "Santos Dental" });
    const draft = await createProposal(p.actor("sales"), { opportunityId: dealId, companyId: company.id });
    expect(draft).toMatchObject({ title: "Proposal for Clinic website", clientName: "Maria Santos", clientCompany: "Santos Dental", contactId, companyId: company.id, opportunityId: dealId, currency: "USD", status: "draft", origin: "human", version: 1 });
    expect(draft.clientEmail).toBe(email.toLowerCase());
    expect(draft).toMatchObject({ approvedVersion: null, validUntil: null });
    expect(draft.doc.lines).toEqual([]);
    expect(await kinds(draft.id)).toEqual(["created"]);
  });

  it("starts from a contact, with no deal", async () => {
    const p = await proposalOrg();
    const { contactId } = await contactAndDeal(p);
    const draft = await createProposal(p.actor("sales"), { contactId });
    expect(draft).toMatchObject({ title: "Proposal for Maria Santos", opportunityId: null, contactId });
  });

  it("gives a valid-until date only when the workspace set a validity period, counted in the workspace's calendar", async () => {
    const p = await proposalOrg({ timezone: "Asia/Manila" });
    expect((await draftBy(p, "owner")).validUntil).toBeNull();
    await saveProposalSettings(p.actor("owner"), { defaultValidityDays: 30 }, 0);
    // 20:00 UTC on the 23rd is already the 24th in Manila.
    const draft = await createProposal(p.actor("owner"), { title: "Dated", clientName: "Maria" }, { now: new Date("2026-10-23T20:00:00Z") });
    expect(draft.validUntil).toBe("2026-11-23");
    expect((await createProposal(p.actor("owner"), { title: "Chosen", clientName: "Maria", validUntil: "2026-12-31" }, deps)).validUntil).toBe("2026-12-31");
    expect((await createProposal(p.actor("owner"), { title: "None", clientName: "Maria", validUntil: null }, deps)).validUntil).toBeNull();
    await expect(createProposal(p.actor("owner"), { title: "Bad", clientName: "Maria", validUntil: "2026-02-30" })).rejects.toThrow(/real date/);
  });

  it("refuses a contact, company, deal, template or price book item of another workspace exactly as if it did not exist", async () => {
    const p = await proposalOrg();
    const other = await proposalOrg();
    const theirs = await contactAndDeal(other);
    const theirCompany = await createCompany(other.actor("owner"), { name: "Their Co" });
    await expect(createProposal(p.actor("owner"), { contactId: theirs.contactId })).rejects.toThrow(/Contact not found/);
    await expect(createProposal(p.actor("owner"), { opportunityId: theirs.dealId })).rejects.toThrow(/Deal not found/);
    await expect(createProposal(p.actor("owner"), { companyId: theirCompany.id })).rejects.toThrow(/Company not found/);
    await expect(createProposal(p.actor("owner"), { templateId: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow(/template was not found/);
    await expect(createProposal(p.actor("owner"), { clientName: "x", doc: { lines: [lineOf(other.item)] } })).rejects.toThrow(/price book item you chose was not found/);
    const mine = await contactAndDeal(p);
    await expect(createProposal(p.actor("owner"), { contactId: theirs.contactId, opportunityId: mine.dealId })).rejects.toThrow(/Contact not found|different contact/);
    await expect(createProposal(p.actor("owner"), { contactId: (await contactAndDeal(p)).contactId, opportunityId: mine.dealId })).rejects.toThrow(/different contact/);
    expect((await rows("select 1 from proposals where org_id = $1", [p.org.id])).length).toBe(0);
  });

  it("builds lines from the price book on the server, ignoring what a browser claims about the price book price or the tax", async () => {
    const p = await proposalOrg();
    const forged = { ...lineOf(p.item, 1000), catalogPriceMinor: 1, taxBps: 0, taxName: "None" } as ReturnType<typeof lineOf>;
    const draft = await createProposal(p.actor("owner"), { title: "Forged", clientName: "Maria", doc: { lines: [forged] } });
    expect(draft.doc.lines[0]).toMatchObject({ unitPriceMinor: 150_000, catalogPriceMinor: 150_000, taxBps: 1200, taxName: "Sales tax", catalogItemId: p.item.id });
    // A price typed over the price book's on a new proposal is an override: the discount permission decides.
    await expect(createProposal(p.actor("sales"), { title: "Cheaper", clientName: "Maria", doc: { lines: [lineOf(p.item, 1000, { unitPriceMinor: 100 })] } })).rejects.toThrow(/discount permission/);
    const cheaper = await createProposal(p.actor("manager"), { title: "Cheaper", clientName: "Maria", doc: { lines: [lineOf(p.item, 1000, { unitPriceMinor: 100 })] } });
    expect(cheaper.doc.lines[0]).toMatchObject({ unitPriceMinor: 100, catalogPriceMinor: 150_000 });
    expect(cheaper.problems.map((x) => x.code)).toContain("price_override");
  });

  it("lets a line be typed by hand, with a warning, and refuses an archived item", async () => {
    const p = await proposalOrg();
    const hand = await createProposal(p.actor("sales"), { title: "Hand", clientName: "Maria", doc: { lines: [{ name: "Site visit", quantityMilli: 1000, unitPriceMinor: 7_500 }] } });
    expect(hand.doc.lines[0]).toMatchObject({ catalogItemId: null, catalogPriceMinor: null, unitPriceMinor: 7_500, unitLabel: "each", billing: "one_time" });
    expect(hand.problems.map((x) => x.code)).toContain("custom_line");
    await expect(createProposal(p.actor("sales"), { title: "Hand", clientName: "Maria", doc: { lines: [{ name: "No price", quantityMilli: 1000 }] } })).rejects.toThrow(/price/);
    await updateCatalogItem(p.actor("owner"), p.item.id, { archived: true }, 1);
    await expect(createProposal(p.actor("sales"), { title: "Old", clientName: "Maria", doc: { lines: [lineOf(p.item)] } })).rejects.toThrow(/archived/);
  });
});

describe("editing", () => {
  it("makes a new version when the wording or the figures change, and none when nothing did", async () => {
    const p = await proposalOrg();
    const sales = p.actor("sales");
    const draft = await draftBy(p, "sales");
    const same = await updateProposal(sales, draft.id, { title: draft.title, clientName: draft.clientName }, draft.version);
    expect(same.version).toBe(1);
    const edited = await updateProposal(sales, draft.id, { title: "Website proposal (revised)" }, 1);
    expect(edited).toMatchObject({ version: 2, title: "Website proposal (revised)", status: "draft" });
    const lines = await updateProposal(sales, draft.id, { doc: { lines: [lineOf(p.item, 2000)] } }, 2);
    expect(lines).toMatchObject({ version: 3 });
    expect(lines.totals.one_time).toBe(336_000);
    expect((await rows<{ one_time_total_minor: string }>("select one_time_total_minor::text from proposals where id = $1", [draft.id]))[0].one_time_total_minor).toBe("336000");
  });

  it("does not move the version for notes only the team sees, a new owner or new links", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "sales");
    const noted = await updateProposal(p.actor("sales"), draft.id, { internalNotes: "Call on Friday." }, 1);
    expect(noted).toMatchObject({ version: 1, internalNotes: "Call on Friday." });
    const { contactId, dealId } = await contactAndDeal(p);
    const linked = await updateProposal(p.actor("sales"), draft.id, { contactId, opportunityId: dealId }, 1);
    expect(linked).toMatchObject({ version: 1, contactId, opportunityId: dealId });
    expect(await kinds(draft.id)).toEqual(["created", "edited", "edited"]);
  });

  it("voids an approval and sends the proposal back to a draft, marking the old version superseded", async () => {
    const p = await proposalOrg();
    const approved = await approvedProposal(p);
    expect(approved).toMatchObject({ status: "approved", approvedVersion: 1 });
    const edited = await updateProposal(p.actor("manager"), approved.id, { doc: { terms: "Net 30." } }, approved.version);
    expect(edited).toMatchObject({ status: "draft", version: 2, approvedVersion: null, approvedByName: null });
    const versions = await rows<{ version: number; superseded_at: Date | null }>("select version, superseded_at from proposal_versions where proposal_id = $1 order by version", [approved.id]);
    expect(versions).toHaveLength(1);
    expect(versions[0].superseded_at).not.toBeNull();
    await expect(sendProposal(p.actor("manager"), approved.id, {}, deps)).rejects.toBeDefined();
    expect(await kinds(approved.id)).toContain("edited");
  });

  it("keeps a request for changes in place when the author edits, and takes the resubmission", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "member");
    const pending = await submitForApproval(p.member, draft.id, deps);
    const back = await decideProposal(p.actor("manager"), pending.id, { decision: "request_changes", version: pending.version, note: "Add the hosting line." });
    expect(back).toMatchObject({ status: "changes_requested", decisionNote: "Add the hosting line." });
    const edited = await updateProposal(p.member, back.id, { doc: { terms: "Hosting is extra." } }, back.version);
    expect(edited.status).toBe("changes_requested");
    expect(edited.version).toBe(2);
    expect((await submitForApproval(p.member, edited.id, deps)).status).toBe("pending_approval");
  });

  it("refuses a stale edit, an edit by someone who is neither the author nor a manager, and an edit once it has gone out", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "owner");
    await expect(updateProposal(p.actor("owner"), draft.id, { title: "x" }, 9)).rejects.toThrow(/Someone changed this proposal/);
    await expect(updateProposal(p.actor("sales"), draft.id, { title: "Mine now" }, 1)).rejects.toThrow(/person who wrote/);
    expect((await updateProposal(p.actor("manager"), draft.id, { title: "Manager's edit" }, 1)).title).toBe("Manager's edit");
    const sent = await sendProposal(p.actor("owner"), draft.id, {}, deps);
    await expect(updateProposal(p.actor("owner"), sent.id, { title: "x" }, sent.version)).rejects.toThrow(/Revise it to change it/);
  });

  it("holds the limits in words: bad dates, emails, currency changes with lines, notes", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "owner");
    const o = p.actor("owner");
    await expect(updateProposal(o, draft.id, { title: "   " }, 1)).rejects.toThrow(/title/);
    await expect(updateProposal(o, draft.id, { clientEmail: "not an email" }, 1)).rejects.toThrow(/email/);
    await expect(updateProposal(o, draft.id, { validUntil: "next week" }, 1)).rejects.toThrow(/real date/);
    await expect(updateProposal(o, draft.id, { currency: "EUR" }, 1)).rejects.toThrow(/Remove the lines/);
    await expect(updateProposal(o, draft.id, { internalNotes: "n".repeat(4001) }, 1)).rejects.toThrow(/4,000/);
    await expect(updateProposal(o, draft.id, { doc: { lines: [lineOf(p.item, 0)] } }, 1)).rejects.toThrow(/more than zero/);
    await expect(updateProposal(o, draft.id, { doc: { terms: "<b>bold</b>" } }, 1)).rejects.toThrow(/HTML|links/);
    await expect(updateProposal(o, draft.id, { doc: { lines: [lineOf(p.item, 1000, { discount: { kind: "fixed", minor: 999_999 } })] } }, 1)).rejects.toThrow(/discount/);
    expect((await getProposal(o, draft.id)).version).toBe(1);
  });

  it("lets only a manager hand a proposal to someone else, and only to a teammate", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "sales");
    const sales = p.actor("sales");
    await expect(updateProposal(sales, draft.id, { ownerId: p.people.owner.id }, 1)).rejects.toThrow(/Only the business owner or a manager/);
    const handed = await updateProposal(p.actor("manager"), draft.id, { ownerId: p.people.owner.id }, 1);
    expect(handed).toMatchObject({ ownerId: p.people.owner.id, version: 1 });
    const outsider = await createUser();
    await expect(updateProposal(p.actor("manager"), draft.id, { ownerId: outsider.id }, 1)).rejects.toThrow(/Choose a teammate/);
  });
});

describe("finding proposals, and what the customer is shown", () => {
  it("filters by status, customer, deal and owner, searches number, title and name, and keeps the order newest first", async () => {
    const p = await proposalOrg();
    const { contactId, dealId } = await contactAndDeal(p);
    const a = await draftBy(p, "sales", { title: "Kitchen remodel", clientName: "Ana Reyes" });
    const b = await draftBy(p, "owner", { title: "Bathroom update", clientName: "Ben Cruz", opportunityId: dealId });
    const c = await draftBy(p, "sales", { title: "Garden path", clientName: "Cara Lim" });
    await sendProposal(p.actor("sales"), c.id, {}, deps);
    const owner = p.actor("owner");
    expect((await listProposals(owner)).map((x) => x.number)).toEqual(["P-0003", "P-0002", "P-0001"]);
    expect((await listProposals(owner, { statuses: ["sent"] })).map((x) => x.id)).toEqual([c.id]);
    expect((await listProposals(owner, { statuses: ["draft", "sent"], ownerId: p.people.sales.id })).map((x) => x.id).sort()).toEqual([a.id, c.id].sort());
    expect((await listProposals(owner, { opportunityId: dealId })).map((x) => x.id)).toEqual([b.id]);
    expect((await listProposals(owner, { contactId })).map((x) => x.id)).toEqual([b.id]);
    expect((await listProposals(owner, { search: "bathroom" })).map((x) => x.id)).toEqual([b.id]);
    expect((await listProposals(owner, { search: "cara" })).map((x) => x.id)).toEqual([c.id]);
    expect((await listProposals(owner, { search: "P-0001" })).map((x) => x.id)).toEqual([a.id]);
    expect(await listProposals(owner, { search: "100%_" })).toEqual([]);
    expect(await listProposals(owner, { limit: 1 })).toHaveLength(1);
    expect(await listProposals(owner, { statuses: ["accepted"] })).toEqual([]);
    const row = (await listProposals(owner, { statuses: ["sent"] }))[0];
    expect(row).toMatchObject({ number: "P-0003", clientName: "Cara Lim", currency: "USD", totals: { one_time: 168_000, monthly: 0, yearly: 0 }, ownerName: "Sales Person", origin: "human", version: 1 });
  });

  it("never puts a note for the team into the frozen copy", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "sales", {});
    await updateProposal(p.actor("sales"), draft.id, { internalNotes: "SECRET-NOTE-9931: they will pay more" }, 1);
    const sent = await sendProposal(p.actor("sales"), draft.id, {}, deps);
    expect(sent.internalNotes).toContain("SECRET-NOTE-9931");
    const stored = await rows<{ snapshot: unknown }>("select snapshot from proposal_versions where proposal_id = $1", [draft.id]);
    expect(JSON.stringify(stored[0].snapshot)).not.toContain("SECRET-NOTE-9931");
    expect(JSON.stringify(stored[0].snapshot)).not.toContain("catalog");
  });

  it("shows what can still be fixed on a proposal that has not gone out, and nothing on one that has", async () => {
    const p = await proposalOrg();
    const draft = await createProposal(p.actor("sales"), { title: "Stale", clientName: "Maria", validUntil: "2026-10-01", doc: { lines: [lineOf(p.item)] } });
    expect((await getProposal(p.actor("sales"), draft.id, deps)).problems.map((x) => x.code)).toContain("valid_until_past");
    const sent = await sendProposal(p.actor("sales"), (await draftBy(p, "sales")).id, {}, deps);
    expect(sent.problems).toEqual([]);
  });
});
