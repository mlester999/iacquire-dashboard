// The server actions behind the proposal screens, on embedded Postgres: which role each one needs, what they check before the service does, what they refuse to take from a
// browser, and how an agency person reaches the price book. The signed-in person is replaced by a fixture's context; nothing else is mocked except the framework's cache.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/server/auth/service";
import { startSupportSession } from "@/server/crm/actor";
import { createContact } from "@/server/crm/contacts";
import { createOpportunity } from "@/server/crm/opportunities";
import { agencyPeople, CRM_ROLES, type CrmWho } from "./support/crm";
import { ctxFor, uid } from "./support/fixtures";
import { draftBy, enableAi, proposalOrg, rows, type ProposalOrg } from "./support/proposals";

const mocks = vi.hoisted(() => ({ ctx: null as unknown, user: null as unknown, revalidate: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/server/auth/session", async (original) => ({ ...(await original<typeof import("@/server/auth/session")>()), requireUserOrThrow: async () => mocks.user }));
vi.mock("@/server/tenancy/context", async (original) => ({
  ...(await original<typeof import("@/server/tenancy/context")>()),
  requireOrgContextOrThrow: async () => {
    // An agency person with no client workspace open has no workspace of their own to act in.
    if (!mocks.ctx) throw new (await import("@/server/errors")).AppError("forbidden", "You don't have access to a workspace.");
    return mocks.ctx;
  },
}));

import {
  createCatalogItemAction, createProposalAction, createTaxRateAction, createTemplateAction, decideProposalAction, draftWithAiAction, duplicateProposalAction, getShareUrlAction,
  recordOfflineDecisionAction, renewShareLinkAction, reviseProposalAction, saveProposalSettingsAction, searchDealsAction, sendProposalAction, submitForApprovalAction,
  updateProposalAction, updateTaxRateAction, withdrawProposalAction, approveTemplateAction, archiveTemplateAction, saveTemplateAction, updateCatalogItemAction,
} from "@/app/actions/proposals";

const who = (p: ProposalOrg, w: CrmWho) => {
  const ctx = ctxFor(p.people[w], p.org, CRM_ROLES[w]);
  mocks.ctx = ctx;
  mocks.user = ctx.user;
};
const FORBIDDEN = { ok: false, code: "forbidden" };
const ID = "3f2a9c1e-5b7d-4c80-9a12-0d4e6f8a1b23";

beforeEach(() => {
  mocks.revalidate.mockReset();
});

describe("which role each action needs", () => {
  it("lets only people who write proposals start one, and a viewer look and nothing else", async () => {
    const p = await proposalOrg();
    who(p, "viewer");
    expect(await createProposalAction({ title: "x" })).toMatchObject(FORBIDDEN);
    expect(await duplicateProposalAction(ID)).toMatchObject(FORBIDDEN);
    expect(await draftWithAiAction({})).toMatchObject(FORBIDDEN);
    expect(await submitForApprovalAction(ID)).toMatchObject(FORBIDDEN);
    expect(await reviseProposalAction(ID)).toMatchObject(FORBIDDEN);
    who(p, "sales");
    const made = await createProposalAction({ title: "Website proposal", clientName: "Maria Santos" });
    expect(made).toMatchObject({ ok: true, data: { id: expect.any(String) } });
    expect(await rows("select 1 from proposals where org_id = $1", [p.org.id])).toHaveLength(1);
  });

  it("keeps approving, sending, recording an answer and the settings with the people the server says", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "sales");
    who(p, "sales");
    const sub = await submitForApprovalAction(draft.id);
    expect(sub).toMatchObject({ ok: true, data: { status: "pending_approval" } });
    const version = (sub as { data: { version: number } }).data.version;
    // The sales rep can write and send, but approving is for the owner and manager.
    expect(await decideProposalAction(draft.id, { decision: "approve", version })).toMatchObject(FORBIDDEN);
    who(p, "setter");
    expect(await sendProposalAction(draft.id, version)).toMatchObject(FORBIDDEN);
    who(p, "manager");
    expect(await decideProposalAction(draft.id, { decision: "approve", version })).toMatchObject({ ok: true, data: { status: "approved" } });
    expect(await saveProposalSettingsAction({ twoPerson: true }, 0)).toMatchObject(FORBIDDEN);
    who(p, "sales");
    expect(await sendProposalAction(draft.id, version)).toMatchObject({ ok: true, data: { status: "sent" } });
    // The answer a customer gives by phone is recorded by the owner or a manager, never by the person who wrote the proposal.
    expect(await recordOfflineDecisionAction(draft.id, { decision: "accepted" })).toMatchObject(FORBIDDEN);
    who(p, "manager");
    expect(await recordOfflineDecisionAction(draft.id, { decision: "accepted", note: "Said yes on the phone." })).toMatchObject({ ok: true, data: { status: "accepted" } });
    who(p, "owner");
    expect(await saveProposalSettingsAction({ twoPerson: true }, 0)).toMatchObject({ ok: true, data: { twoPerson: true, version: 1 } });
  });

  it("lets the customer's link be shown and renewed only by someone who can send", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "sales");
    who(p, "sales");
    const sent = await sendProposalAction(draft.id, draft.version);
    expect(sent.ok).toBe(true);
    who(p, "viewer");
    expect(await getShareUrlAction(draft.id)).toMatchObject(FORBIDDEN);
    expect(await renewShareLinkAction(draft.id)).toMatchObject(FORBIDDEN);
    who(p, "sales");
    const shown = await getShareUrlAction(draft.id);
    expect(shown).toMatchObject({ ok: true, data: { url: expect.stringMatching(/\/proposal\/[A-Za-z0-9_-]{43}$/), expiresAt: expect.any(String) } });
    const token = (shown as { data: { url: string } }).data.url.split("/proposal/")[1];
    const renewed = await renewShareLinkAction(draft.id);
    expect(renewed.ok).toBe(true);
    expect((renewed as { data: { url: string } }).data.url).not.toContain(token);
    // The address is for the person who asked: it is not kept in the history, the audit log or a notice.
    const stored = JSON.stringify([
      await rows("select detail from proposal_events where proposal_id = $1", [draft.id]),
      await rows("select metadata from audit_logs where org_id = $1", [p.org.id]),
      await rows("select title, body, link from notifications where org_id = $1", [p.org.id]),
    ]);
    expect(stored).not.toContain(token);
    expect(stored).not.toContain((renewed as { data: { url: string } }).data.url.split("/proposal/")[1]);
  });

  it("lets the price book and tax rates be changed by the owner and manager, templates approved by the owner alone", async () => {
    const p = await proposalOrg();
    who(p, "sales");
    expect(await createTaxRateAction(null, { name: "VAT", rateBps: 2000 })).toMatchObject(FORBIDDEN);
    expect(await createCatalogItemAction(null, { name: "Logo", unitPriceMinor: 10_000, currency: "USD" })).toMatchObject(FORBIDDEN);
    expect(await createTemplateAction(null, { name: "Standard" })).toMatchObject(FORBIDDEN);
    who(p, "manager");
    const tax = await createTaxRateAction(null, { name: "VAT", rateBps: 2000 });
    expect(tax).toMatchObject({ ok: true, data: { name: "VAT", rateBps: 2000 } });
    expect(await updateTaxRateAction(null, (tax as { data: { id: string } }).data.id, { rateBps: 2100 })).toMatchObject({ ok: true, data: { rateBps: 2100 } });
    const item = await createCatalogItemAction(null, { name: "Logo", unitPriceMinor: 10_000, currency: "USD", billing: "one_time", taxRateId: null });
    expect(item).toMatchObject({ ok: true, data: { unitPriceMinor: 10_000 } });
    const id = (item as { data: { id: string; version: number } }).data.id;
    expect(await updateCatalogItemAction(null, id, { unitPriceMinor: 12_000 }, 1)).toMatchObject({ ok: true, data: { unitPriceMinor: 12_000, version: 2 } });
    expect(await updateCatalogItemAction(null, id, { unitPriceMinor: 13_000 }, 1)).toMatchObject({ ok: false, code: "conflict" });
    const tpl = await createTemplateAction(null, { name: "Standard", doc: { lines: [{ catalogItemId: id, quantityMilli: 1000 }] } });
    const tplId = (tpl as { data: { id: string } }).data.id;
    expect(await saveTemplateAction(null, tplId, { doc: { terms: "Pay in 14 days." } }, 1)).toMatchObject({ ok: true, data: { currentVersion: 2 } });
    expect(await approveTemplateAction(tplId, 2)).toMatchObject(FORBIDDEN);
    who(p, "owner");
    expect(await approveTemplateAction(tplId, 2)).toMatchObject({ ok: true, data: { status: "approved", approvedVersion: 2 } });
    who(p, "manager");
    expect(await archiveTemplateAction(null, tplId)).toMatchObject({ ok: true, data: true });
  });
});

describe("what they check before the service does", () => {
  it("refuses an address that only looks like an id, in words", async () => {
    const p = await proposalOrg();
    who(p, "owner");
    for (const bad of ["not-an-id", "", "1", "3f2a9c1e-5b7d-4c80-9a12-0d4e6f8a1b2"]) {
      expect(await submitForApprovalAction(bad), bad).toEqual({ ok: false, error: "That item was not found.", code: "invalid_input" });
      expect(await getShareUrlAction(bad), bad).toMatchObject({ ok: false, code: "invalid_input" });
    }
    expect(await createProposalAction({ contactId: "nope" })).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("takes only the fields it knows from a browser, so status, approval and ownership can't be set by hand", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "owner");
    who(p, "owner");
    const out = await updateProposalAction(draft.id, {
      title: "Renamed", status: "accepted", approved_version: 1, approvedVersion: 1, approvedBy: p.people.owner.id, origin: "ai", createdBy: p.people.viewer.id, sent_at: "2026-01-01", version: 99,
    }, draft.version);
    expect(out).toMatchObject({ ok: true, data: { title: "Renamed", status: "draft", origin: "human", approvedVersion: null, version: 2 } });
    const [row] = await rows<{ status: string; origin: string; approved_by: string | null; created_by: string; sent_at: string | null }>("select status, origin, approved_by, created_by, sent_at from proposals where id = $1", [draft.id]);
    expect(row).toMatchObject({ status: "draft", origin: "human", approved_by: null, created_by: p.people.owner.id, sent_at: null });
    const made = await createProposalAction({ title: "New", status: "sent", origin: "ai", approvedVersion: 1 });
    const id = (made as { data: { id: string } }).data.id;
    expect((await rows<{ status: string; origin: string }>("select status, origin from proposals where id = $1", [id]))[0]).toEqual({ status: "draft", origin: "human" });
  });

  it("says what is wrong with a number instead of 'something went wrong'", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "owner");
    who(p, "owner");
    const bad = (lines: unknown[]) => updateProposalAction(draft.id, { doc: { lines } }, draft.version);
    const line = { catalogItemId: null, name: "Logo", description: "", unitLabel: "each", quantityMilli: 1000, unitPriceMinor: 100, billing: "one_time", taxRateId: null, discount: null, note: "" };
    expect(await bad([{ ...line, quantityMilli: 0 }])).toMatchObject({ ok: false, error: expect.stringMatching(/^The quantity must be more than zero\./) });
    expect(await bad([{ ...line, unitPriceMinor: -5 }])).toMatchObject({ ok: false, error: expect.stringMatching(/can't be negative/) });
    expect(await bad([{ ...line, unitPriceMinor: 12.5 }])).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await bad([{ ...line, billing: "weekly" }])).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await bad([{ ...line, discount: { kind: "fixed", minor: 1_000_000 } }])).toMatchObject({ ok: false, error: expect.stringMatching(/Giving a discount|more than the line/) });
    expect(await bad(Array.from({ length: 201 }, () => line))).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await saveProposalSettingsAction({ defaultValidityDays: 400 }, 0)).toMatchObject({ ok: false, error: "A proposal can stay valid for 1 to 365 days." });
    expect(await saveProposalSettingsAction({ approvalMode: "nobody" }, 0)).toMatchObject({ ok: false, code: "invalid_input" });
    // Nothing was written by any of them.
    expect((await rows<{ doc: { lines: unknown[] } }>("select doc from proposals where id = $1", [draft.id]))[0].doc.lines).toHaveLength(1);
  });

  it("asks the AI only when it is switched on, and says so when no model is connected", async () => {
    const p = await proposalOrg();
    who(p, "sales");
    expect(await draftWithAiAction({})).toMatchObject({ ok: false, code: "not_enabled", error: expect.stringMatching(/switched off/) });
    await enableAi(p);
    // No language model is configured in the test environment: the answer is honest, nothing is invented, and nothing is saved.
    const out = await draftWithAiAction({ brief: "A starter website." });
    expect(out).toMatchObject({ ok: false });
    expect((out as { code: string }).code).toMatch(/unavailable|upstream_error/);
    expect(await rows("select 1 from proposals where org_id = $1", [p.org.id])).toHaveLength(0);
  });
});

describe("another workspace", () => {
  it("can't reach this workspace's proposals, templates or items by id", async () => {
    const a = await proposalOrg();
    const b = await proposalOrg();
    const draft = await draftBy(a, "owner");
    who(b, "owner");
    expect(await updateProposalAction(draft.id, { title: "Hijack" }, draft.version)).toMatchObject({ ok: false, code: "not_found" });
    expect(await submitForApprovalAction(draft.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await withdrawProposalAction(draft.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await duplicateProposalAction(draft.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await updateCatalogItemAction(null, a.item.id, { unitPriceMinor: 1 }, 1)).toMatchObject({ ok: false, code: "not_found" });
    const theirContact = await createContact(a.actor("owner"), { firstName: "Maria", lastName: "Santos", email: `maria-${uid()}@example.test` });
    expect(await createProposalAction({ title: "x", contactId: theirContact.id })).toMatchObject({ ok: false, code: "not_found" });
    expect((await rows<{ title: string }>("select title from proposals where id = $1", [draft.id]))[0].title).toBe("Website proposal");
    expect(await rows("select 1 from proposals where org_id = $1", [b.org.id])).toHaveLength(0);
  });

  it("finds a workspace's own open deals only", async () => {
    const a = await proposalOrg();
    const b = await proposalOrg();
    const contact = await createContact(a.actor("owner"), { firstName: "Maria", lastName: "Santos", email: `maria-${uid()}@example.test` });
    await createOpportunity(a.actor("owner"), { name: "Clinic website", contactId: contact.id, value: 1500, currency: "USD" });
    const other = await createContact(b.actor("owner"), { firstName: "Zed", lastName: "Other", email: `zed-${uid()}@example.test` });
    await createOpportunity(b.actor("owner"), { name: "Clinic website for someone else", contactId: other.id, value: 10, currency: "USD" });
    who(a, "sales");
    const found = await searchDealsAction("clinic");
    expect(found).toMatchObject({ ok: true });
    expect((found as { data: Array<{ name: string; contactName: string; contactId: string }> }).data).toEqual([expect.objectContaining({ name: "Clinic website", contactName: "Maria Santos", contactId: contact.id })]);
    expect((await searchDealsAction("%"))).toMatchObject({ ok: true, data: [] });
    who(a, "viewer");
    expect(await searchDealsAction("")).toMatchObject(FORBIDDEN);
  });
});

describe("an agency person in a support session", () => {
  it("can build the price book for the client, and nothing else", async () => {
    const p = await proposalOrg();
    const agency = await agencyPeople();
    mocks.user = agency.superAdmin as SessionUser;
    mocks.ctx = null;
    // No session yet.
    expect(await createCatalogItemAction(p.org.id, { name: "Setup", unitPriceMinor: 100, currency: "USD" })).toMatchObject({ ok: false, code: "forbidden", error: expect.stringMatching(/support session/) });
    await startSupportSession(agency.superAdmin, p.org.id, { mode: "read", reason: "Looking at the setup" });
    expect(await createCatalogItemAction(p.org.id, { name: "Setup", unitPriceMinor: 100, currency: "USD" })).toMatchObject({ ok: false, code: "forbidden", error: expect.stringMatching(/read-only/) });
    await startSupportSession(agency.superAdmin, p.org.id, { mode: "write", reason: "Building the price book" });
    const made = await createCatalogItemAction(p.org.id, { name: "Setup service", unitPriceMinor: 5000, currency: "USD" });
    expect(made).toMatchObject({ ok: true, data: { name: "Setup service" } });
    expect(await createTemplateAction(p.org.id, { name: "Built by the agency" })).toMatchObject({ ok: true });
    // Writing, approving and sending stay with the client, and a client id the person is not working on is not theirs to name.
    const draft = await draftBy(p, "sales");
    expect(await sendProposalAction(draft.id, draft.version)).toMatchObject(FORBIDDEN);
    expect(await decideProposalAction(draft.id, { decision: "approve", version: 1 })).toMatchObject(FORBIDDEN);
    const other = await proposalOrg();
    expect(await createCatalogItemAction(other.org.id, { name: "Sneaky", unitPriceMinor: 1, currency: "USD" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await rows("select 1 from proposal_catalog_items where org_id = $1 and name = 'Sneaky'", [other.org.id])).toHaveLength(0);
  });
});

describe("refreshing the screens", () => {
  it("refreshes the proposals area and the contact and deal pages that list proposals, after a change but not after a read", async () => {
    const p = await proposalOrg();
    who(p, "sales");
    await createProposalAction({ title: "x" });
    const paths = mocks.revalidate.mock.calls.map((c) => c.join(":"));
    expect(paths).toContain("/proposals:layout");
    expect(paths).toContain("/crm:layout");
    mocks.revalidate.mockReset();
    await searchDealsAction("x");
    await getShareUrlAction(ID);
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});
