// The invoices browser-QA world (scripts/invoices-qa-world.ts) proves itself on a synthetic workspace: every story ends in the state it says it does, nothing leaves the machine, and
// the customer addresses it prints open the pages it describes. If this passes, the QA seed's logic works; only its wrapper (the isolated QA database) is not exercised here.
import { describe, expect, it } from "vitest";
import { seedInvoiceDeliveryWorld, seedInvoiceWorld } from "../scripts/invoices-qa-world";
import { attributionReport } from "@/server/attribution/report";
import { previewInvoiceDelivery } from "@/server/invoices/delivery";
import { getInvoiceDetail, receivablesSummary } from "@/server/invoices/invoices";
import { loadPublicInvoice } from "@/server/invoices/public";
import { freshIp, invoiceOrg, rows } from "./support/invoices";

const world = (io: Awaited<ReturnType<typeof invoiceOrg>>, over: Parameters<typeof seedInvoiceWorld>[1] = {}) => seedInvoiceWorld({ owner: io.ctx("owner"), ownerActor: io.c.actor("owner"), sales: io.ctx("sales") }, over);

describe("the invoices QA world", () => {
  it("builds sixteen invoices in the states it describes, two of them test invoices, with customer links that open the right pages, and sends nothing to anyone", async () => {
    const io = await invoiceOrg();
    const outboxBefore = (await rows<{ n: string }>("select count(*)::text as n from email_outbox where status <> 'captured'"))[0].n;
    const out = await world(io);
    expect(out).toHaveLength(16);
    const by = (title: string) => out.find((r) => r.title === title)!;
    const detail = (title: string) => getInvoiceDetail(io.ctx("owner"), by(title).invoiceId);
    const status = async (title: string) => { const d = await detail(title); return `${d.invoice.status}/${d.invoice.paymentStatus}`; };

    // Numbers are given when an invoice is issued: the draft and the one waiting for approval have none.
    expect(by("Bathroom faucet replacement").number).toBeNull();
    expect(by("Leak detection survey").number).toBeNull();
    // Real invoices are numbered INV-0001 on; the two test invoices have a counter of their own, so the real sequence has no gap for them.
    expect(out.filter((r) => r.number && !r.number.startsWith("TEST-")).map((r) => r.number)).toEqual(Array.from({ length: 12 }, (_, i) => `INV-${String(i + 1).padStart(4, "0")}`));
    expect(out.filter((r) => r.number?.startsWith("TEST-")).map((r) => r.number)).toEqual(["TEST-0001", "TEST-0002"]);
    expect(await status("Bathroom faucet replacement")).toBe("draft/unpaid");
    expect(await status("Leak detection survey")).toBe("pending_approval/unpaid");
    expect(await status("Annual boiler service")).toBe("issued/unpaid");
    expect(await status("Water heater inspection")).toBe("issued/unpaid");
    expect((await detail("Water heater inspection")).invoice.overdue).toBe(true);
    expect((await detail("Annual boiler service")).invoice.overdue).toBe(false);
    expect(await status("Kitchen repipe")).toBe("issued/partially_paid");
    expect(await status("Drain clearing")).toBe("issued/paid");
    expect(await status("Sump pump installation")).toBe("issued/paid");
    expect((await detail("Sump pump installation")).payments[0]).toMatchObject({ status: "partially_refunded", livemode: true, provider: "manual" });
    expect(await status("Gas line check")).toBe("void/unpaid");
    expect((await detail("Remote monitoring set-up")).invoice).toMatchObject({ currency: "USD", taxInclusive: true });
    expect((await detail("Seasonal tune-up")).invoice.writtenOffAt).not.toBeNull();
    expect(await status("Pressure valve replacement")).toBe("issued/disputed");
    // The payment the provider reported that did not match is kept for review and counts for nothing.
    expect(await status("Radiator bleed")).toBe("issued/unpaid");
    expect((await detail("Radiator bleed")).payments).toEqual([expect.objectContaining({ status: "needs_review" })]);
    expect(await status("Whole-house water filter")).toBe("issued/paid");
    expect(await status("Sprinkler repair")).toBe("issued/paid");
    // The test invoices: marked, kept out of what is owed, one paid at the testing checkout with a test-mode payment and the other open for a customer to pay there.
    const paidTest = await detail("Testing the payment account: paid");
    const openTest = await detail("Testing the payment account: open");
    expect(paidTest.invoice).toMatchObject({ isTest: true, number: "TEST-0001", status: "issued", paymentStatus: "paid" });
    expect(paidTest.payments).toEqual([expect.objectContaining({ livemode: false, provider: "simulated", status: "succeeded" })]);
    expect(openTest.invoice).toMatchObject({ isTest: true, number: "TEST-0002", status: "issued", paymentStatus: "unpaid" });
    expect((await rows<{ n: string }>("select count(*)::text as n from customer_invoices where org_id = $1 and is_test", [io.orgId]))[0].n).toBe("2");
    // No real invoice holds test money, and no test invoice holds anything else.
    expect(await rows("select 1 from customer_payments p join customer_invoices i on i.id = p.invoice_id where i.org_id = $1 and p.livemode = i.is_test", [io.orgId])).toEqual([]);
    const summary = await receivablesSummary(io.ctx("owner"));
    expect(summary.testInvoices).toBe(2);
    const openPage = await loadPublicInvoice(by("Testing the payment account: open").customerPath!.split("/pay/")[1], { ip: freshIp() });
    expect(openPage.state === "ok" && openPage.invoice).toMatchObject({ isTest: true, canPayOnline: true, banner: { kind: "test" } });
    const realPage = await loadPublicInvoice(by("Annual boiler service").customerPath!.split("/pay/")[1], { ip: freshIp() });
    expect(realPage.state === "ok" && realPage.invoice).toMatchObject({ isTest: false, canPayOnline: false });

    // Each customer link opens its own invoice; a void invoice and the drafts have none.
    for (const r of out) {
      if (!r.customerPath) continue;
      const res = await loadPublicInvoice(r.customerPath.split("/pay/")[1], { ip: freshIp() });
      if (r.title === "Gas line check") continue;
      expect(res.state, r.title).toBe("ok");
      expect(res.state === "ok" && res.invoice.number, r.title).toBe(r.number);
    }
    expect(by("Gas line check").customerPath).toBeNull();
    expect(by("Bathroom faucet replacement").customerPath).toBeNull();

    // Nothing was sent: no message exists, no email left the outbox's capture, and the only payment connections are the simulated one and a paused placeholder with no keys.
    expect((await rows<{ n: string }>("select count(*)::text as n from conversation_messages where org_id = $1", [io.orgId]))[0].n).toBe("0");
    expect((await rows<{ n: string }>("select count(*)::text as n from email_outbox where status <> 'captured'"))[0].n).toBe(outboxBefore);
    const connections = await rows<{ provider: string; mode: string; status: string; credentials: string | null }>("select provider, mode, status, credentials from customer_payment_connections where org_id = $1 order by provider", [io.orgId]);
    expect(connections.map((c) => `${c.provider}/${c.mode}/${c.status}`)).toEqual(["paymongo/live/disabled", "simulated/test/connected"]);
    expect(connections.find((c) => c.provider === "paymongo")!.credentials).toBeNull();

    // The Lead Sources report has something to show, honestly: the fictional live payment is revenue, the hand-recorded one is shown apart, the testing checkout's payments are left out.
    const report = await attributionReport(io.c.actor("owner"), { startsAt: new Date(Date.now() - 86_400_000), endsAt: new Date(Date.now() + 86_400_000) });
    const google = report.rows.find((r) => r.source === "google")!;
    expect(google.verifiedRevenue.map((l) => `${l.currency} ${l.amount}`)).toEqual(["PHP 7000"]);
    // The 4,000.00 deposit on the kitchen repipe and the 1,500.00 sprinkler repair, both recorded by a person.
    expect(google.recordedByHand.map((l) => `${l.currency} ${l.amount}`)).toEqual(["PHP 5500"]);
    expect(google).toMatchObject({ cost: [{ currency: "PHP", amount: 1500 }], returnCurrency: "PHP" });
    expect(google.returnOnSpend).toBeCloseTo((7000 - 1500) / 1500, 4);
    expect(report.rows.find((r) => r.source === "facebook")!.verifiedRevenue).toEqual([]);
    expect(report.revenue).toMatchObject({ state: "shown", manualCounted: false, testPaymentsExcluded: 1, disputedHeldOut: 1 });
  }, 120_000);

  it("leaves the fictional live payment out when asked, so no invoice is paid by money that never moved", async () => {
    const io = await invoiceOrg();
    const out = await world(io, { revenueFiction: false });
    expect(out).toHaveLength(12);
    expect(out.filter((r) => r.number?.startsWith("TEST-"))).toHaveLength(2);
    expect((await rows<{ n: string }>("select count(*)::text as n from customer_payments where org_id = $1 and provider = 'paymongo'", [io.orgId]))[0].n).toBe("0");
    const report = await attributionReport(io.c.actor("owner"), { startsAt: new Date(Date.now() - 86_400_000), endsAt: new Date(Date.now() + 86_400_000) });
    expect(report.rows.every((r) => r.verifiedRevenue.length === 0)).toBe(true);
  }, 120_000);

  it("makes the issued invoices of customers who agreed to email sendable from the page, refuses the one who did not, never offers a test invoice, and still sends nothing", async () => {
    const io = await invoiceOrg();
    const emailsBefore = (await rows<{ n: string }>("select count(*)::text as n from email_outbox where status <> 'captured'"))[0].n;
    const out = await world(io);
    // (The test must not depend on the time of day it runs at: quiet hours would make a preview "waiting" instead of "ready".)
    await rows("update messaging_policy set quiet_hours_start = '00:00', quiet_hours_end = '00:00'");
    const delivery = await seedInvoiceDeliveryWorld({ owner: io.ctx("owner"), ownerActor: io.c.actor("owner") });
    expect(delivery).toEqual({ ready: ["Annual boiler service", "Water heater inspection", "Kitchen repipe"], refused: ["Remote monitoring set-up"] });
    const idOf = (title: string) => out.find((r) => r.title === title)!.invoiceId;
    const preview = (title: string) => previewInvoiceDelivery(io.ctx("owner"), idOf(title), "email");
    for (const title of delivery.ready) expect(await preview(title), title).toMatchObject({ available: true, verdict: { kind: "ready" } });
    expect(await preview("Remote monitoring set-up")).toMatchObject({ available: true, verdict: { kind: "refused", reason: "no_consent" } });
    // What is never offered, and why: a test invoice, a paid one, a written-off one, a void one and a draft.
    expect(await preview("Testing the payment account: open")).toMatchObject({ available: false, reason: "test_invoice" });
    expect(await preview("Drain clearing")).toMatchObject({ available: false, reason: "paid" });
    expect(await preview("Seasonal tune-up")).toMatchObject({ available: false, reason: "written_off" });
    expect(await preview("Gas line check")).toMatchObject({ available: false, reason: "not_issued" });
    expect(await preview("Bathroom faucet replacement")).toMatchObject({ available: false, reason: "not_issued" });
    // Nothing was sent: no message exists and no email left the outbox's capture.
    expect(await rows("select 1 from conversation_messages where org_id = $1", [io.orgId])).toHaveLength(0);
    expect((await rows<{ n: string }>("select count(*)::text as n from email_outbox where status <> 'captured'"))[0].n).toBe(emailsBefore);
    // Run again, it changes nothing that matters.
    await seedInvoiceDeliveryWorld({ owner: io.ctx("owner"), ownerActor: io.c.actor("owner") });
    expect(await rows("select 1 from messaging_channels where org_id = $1 and channel = 'email' and provider = 'resend'", [io.orgId])).toHaveLength(1);
  }, 120_000);
});
