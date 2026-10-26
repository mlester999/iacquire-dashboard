// The server actions behind "Send it to the customer" on an invoice and "Make a draft invoice" on an accepted proposal, on embedded Postgres: which role each one needs, what they check
// before the service does, what they refuse to take from a browser, and which screens they refresh. The signed-in person is replaced by a fixture's context; nothing else is mocked
// except the framework's cache.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoiceTokenFor } from "@/server/invoices/links";
import { acceptedProposal, proposalOrg, rows, withInvoicing } from "./support/proposals";
import { addMessaging, consentTo, contactIn, invoiceOrg, issuedInvoice, issuedTestInvoice, type InvoiceOrg, type InvoiceWho } from "./support/invoices";

const mocks = vi.hoisted(() => ({ ctx: null as unknown, revalidate: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/server/tenancy/context", async (original) => ({
  ...(await original<typeof import("@/server/tenancy/context")>()),
  requireOrgContextOrThrow: async () => {
    // An agency person with no client workspace open has no workspace of their own to act in.
    if (!mocks.ctx) throw new (await import("@/server/errors")).AppError("forbidden", "You don't have access to a workspace.");
    return mocks.ctx;
  },
}));

import { createInvoiceFromProposalAction, previewInvoiceDeliveryAction, sendInvoiceDeliveryAction } from "@/app/actions/invoices";

const FORBIDDEN = { ok: false, code: "forbidden" };
const ID = "3f2a9c1e-5b7d-4c80-9a12-0d4e6f8a1b23";
const HASH = "a".repeat(64);
const asInvoices = (io: InvoiceOrg, who: InvoiceWho) => {
  mocks.ctx = io.ctx(who);
};

beforeEach(() => {
  mocks.revalidate.mockReset();
});

describe("sending an invoice's link to the customer", () => {
  async function shop() {
    const io = await invoiceOrg();
    await addMessaging(io, {});
    const contactId = await contactIn(io);
    await consentTo(io, contactId, "email");
    const inv = await issuedInvoice(io, { contactId });
    return { io, id: inv.invoice.id };
  }

  it("is for the owner and a manager, shows the exact message first, and queues what was read", async () => {
    const { io, id } = await shop();
    for (const who of ["sales", "setter", "support", "viewer", "member"] as const) {
      asInvoices(io, who);
      expect(await previewInvoiceDeliveryAction(id, "email"), who).toMatchObject(FORBIDDEN);
      expect(await sendInvoiceDeliveryAction(id, { channel: "email", linkVersion: 1, wordingHash: HASH }), who).toMatchObject(FORBIDDEN);
    }
    expect(await rows("select 1 from customer_invoice_deliveries where invoice_id = $1", [id])).toHaveLength(0);

    asInvoices(io, "manager");
    mocks.revalidate.mockReset();
    const preview = await previewInvoiceDeliveryAction(id, "email");
    expect(preview).toMatchObject({ ok: true, data: { available: true, channel: "email", linkVersion: 1, wordingHash: expect.stringMatching(/^[0-9a-f]{64}$/), verdict: { kind: "ready" } } });
    // Reading the message changes nothing, so no screen is refreshed for it.
    expect(mocks.revalidate).not.toHaveBeenCalled();
    const hash = (preview as { data: { wordingHash: string } }).data.wordingHash;
    asInvoices(io, "owner");
    const queued = await sendInvoiceDeliveryAction(id, { channel: "email", linkVersion: 1, wordingHash: hash });
    expect(queued).toMatchObject({ ok: true, data: { status: "queued", delivery: { channel: "email", state: "queued" } } });
    expect(mocks.revalidate.mock.calls.map((x) => x.join(":"))).toContain("/invoices:layout");
    expect(JSON.stringify([preview, queued])).not.toContain(invoiceTokenFor(id, 1));
    // The same confirmation again sends nothing more.
    expect(await sendInvoiceDeliveryAction(id, { channel: "email", linkVersion: 1, wordingHash: hash })).toMatchObject({ ok: true, data: { status: "already" } });
    expect(await rows("select 1 from customer_invoice_deliveries where invoice_id = $1", [id])).toHaveLength(1);
  });

  it("refuses what is not an id, a channel, a link version or a fingerprint, in words, before the service is asked", async () => {
    const { io } = await shop();
    asInvoices(io, "owner");
    expect(await previewInvoiceDeliveryAction("nope", "email")).toEqual({ ok: false, error: "That item was not found.", code: "invalid_input" });
    expect(await previewInvoiceDeliveryAction(ID, "carrier_pigeon")).toEqual({ ok: false, error: "Choose email, text message or WhatsApp.", code: "invalid_input" });
    expect(await sendInvoiceDeliveryAction("nope", { channel: "email", linkVersion: 1, wordingHash: HASH })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await sendInvoiceDeliveryAction(ID, { channel: "fax", linkVersion: 1, wordingHash: HASH })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await sendInvoiceDeliveryAction(ID, { channel: "email", linkVersion: 0, wordingHash: HASH })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await sendInvoiceDeliveryAction(ID, { channel: "email", linkVersion: 1, wordingHash: "short" })).toEqual({ ok: false, error: "Read the message again before you send it.", code: "invalid_input" });
    expect(await sendInvoiceDeliveryAction(ID, null)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await previewInvoiceDeliveryAction(ID, "email")).toMatchObject({ ok: false, code: "not_found" });
  });

  it("is never done for a test invoice, and says so, and is not reachable by someone with no workspace of their own", async () => {
    const { io } = await shop();
    const contactId = await contactIn(io);
    await consentTo(io, contactId, "email");
    const test = await issuedTestInvoice(io, { contactId });
    asInvoices(io, "owner");
    expect(await previewInvoiceDeliveryAction(test.invoice.id, "email")).toMatchObject({ ok: true, data: { available: false, reason: "test_invoice" } });
    expect(await sendInvoiceDeliveryAction(test.invoice.id, { channel: "email", linkVersion: 1, wordingHash: HASH })).toMatchObject({ ok: true, data: { status: "refused", reason: "test_invoice" } });
    expect(await rows("select 1 from customer_invoice_deliveries where invoice_id = $1", [test.invoice.id])).toHaveLength(0);
    mocks.ctx = null;
    expect(await previewInvoiceDeliveryAction(test.invoice.id, "email")).toMatchObject(FORBIDDEN);
    expect(await sendInvoiceDeliveryAction(test.invoice.id, { channel: "email", linkVersion: 1, wordingHash: HASH })).toMatchObject(FORBIDDEN);
  });

  it("does nothing for another workspace's invoice", async () => {
    const a = await shop();
    const b = await shop();
    asInvoices(b.io, "owner");
    expect(await previewInvoiceDeliveryAction(a.id, "email")).toMatchObject({ ok: false, code: "not_found" });
    expect(await sendInvoiceDeliveryAction(a.id, { channel: "email", linkVersion: 1, wordingHash: HASH })).toMatchObject({ ok: false, code: "not_found" });
    expect(await rows("select 1 from customer_invoice_deliveries where invoice_id = $1", [a.id])).toHaveLength(0);
  });
});

describe("making a draft invoice from an accepted proposal", () => {
  async function accepted() {
    const p = await proposalOrg();
    const inv = await withInvoicing(p);
    const a = await acceptedProposal(p, {}, "recorded");
    return { p, inv, id: a.proposal.id };
  }
  const as = (inv: Awaited<ReturnType<typeof withInvoicing>>, who: Parameters<typeof inv.ctx>[0]) => {
    mocks.ctx = inv.ctx(who);
  };

  it("is for people who can write invoices, makes one draft, and refreshes the invoices and the proposals", async () => {
    const { inv, id } = await accepted();
    for (const who of ["setter", "support", "viewer"] as const) {
      as(inv, who);
      expect(await createInvoiceFromProposalAction(id, { version: 1 }), who).toMatchObject(FORBIDDEN);
    }
    expect(await rows("select 1 from customer_invoices where source_id = $1", [id])).toHaveLength(0);
    as(inv, "sales");
    mocks.revalidate.mockReset();
    const made = await createInvoiceFromProposalAction(id, { version: 1 });
    expect(made).toMatchObject({ ok: true, data: { status: "created", lines: 1, recurringLines: 0, invoiceId: expect.any(String) } });
    expect(mocks.revalidate.mock.calls.map((x) => x.join(":"))).toEqual(expect.arrayContaining(["/invoices:layout", "/proposals:layout"]));
    // The same request again finds the draft that exists.
    const again = await createInvoiceFromProposalAction(id, { version: 1 });
    expect(again).toMatchObject({ ok: true, data: { status: "already", count: 1 } });
    expect(await rows("select 1 from customer_invoices where source_id = $1", [id])).toHaveLength(1);
  });

  it("lets only the owner or a manager ask for a further one", async () => {
    const { inv, id } = await accepted();
    as(inv, "sales");
    await createInvoiceFromProposalAction(id, { version: 1 });
    expect(await createInvoiceFromProposalAction(id, { version: 1, another: true })).toMatchObject(FORBIDDEN);
    as(inv, "manager");
    expect(await createInvoiceFromProposalAction(id, { version: 1, another: true })).toMatchObject({ ok: true, data: { status: "created" } });
    expect(await rows("select 1 from customer_invoices where source_id = $1", [id])).toHaveLength(2);
  });

  it("refuses what is not an id or a version, in words, before the service is asked", async () => {
    const { inv } = await accepted();
    as(inv, "owner");
    expect(await createInvoiceFromProposalAction("nope", { version: 1 })).toEqual({ ok: false, error: "That item was not found.", code: "invalid_input" });
    expect(await createInvoiceFromProposalAction(ID, { version: 0 })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await createInvoiceFromProposalAction(ID, { version: "1" })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await createInvoiceFromProposalAction(ID, { version: 1, another: "yes" })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await createInvoiceFromProposalAction(ID, null)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await createInvoiceFromProposalAction(ID, { version: 1 })).toMatchObject({ ok: false, code: "not_found" });
  });

  it("is not reachable by someone with no workspace of their own", async () => {
    const { id } = await accepted();
    mocks.ctx = null;
    expect(await createInvoiceFromProposalAction(id, { version: 1 })).toMatchObject(FORBIDDEN);
    expect(await rows("select 1 from customer_invoices where source_id = $1", [id])).toHaveLength(0);
  });
});
