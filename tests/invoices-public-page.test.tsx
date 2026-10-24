// @vitest-environment jsdom
// The customer's two pages in the browser: the invoice with its Pay button, and the page they return to from the provider. The rule under both: the page never says the
// payment was received until the server says the database holds it, and it sends nothing but the link (or the reference) in a header. fetch is replaced by a recorder.
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PayPanel } from "@/components/invoices/public/pay-panel";
import { ReturnStatus } from "@/components/invoices/public/return-status";
import { InvoiceDocument } from "@/components/invoices/public/invoice-document";
import { PublicNotice, PublicShell } from "@/components/invoices/public/shell";
import { BACK_STORAGE_KEY, CAPTURE_ENDPOINT, PAY_ENDPOINT, POLL_DELAYS_MS, REFERENCE_HEADER, STATUS_ENDPOINT, TOKEN_HEADER } from "@/lib/invoices/public-http";
import type { PublicInvoice } from "@/server/invoices/public";

const TOKEN = "A".repeat(43);
const REFERENCE = `CP-${"a".repeat(24)}`;
const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const CONFIRMING = { state: "confirming" as const, headline: "We are confirming your payment", detail: "This can take a minute. Please do not pay again.", polling: true, tone: "wait" as const };
const RECEIVED = { state: "received" as const, headline: "We have received your payment", detail: "Thank you.", polling: false, tone: "ok" as const };

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the Pay button", () => {
  it("asks the server for the provider's page with the link in a header and nothing else, then goes where it is told, remembering the invoice page to come back to", async () => {
    fetchSpy.mockResolvedValue(respond(200, { url: "https://checkout.paymongo.com/cs_1_client_abc" }));
    const navigate = vi.fn();
    window.history.replaceState(null, "", `/pay/${TOKEN}`);
    render(<PayPanel token={TOKEN} canPay balanceMinor={150000} currency="PHP" navigate={navigate} />);
    fireEvent.click(screen.getByRole("button", { name: /Pay ₱1,500\.00 online/ }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://checkout.paymongo.com/cs_1_client_abc"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(PAY_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ [TOKEN_HEADER]: TOKEN });
    // No amount, no invoice, no workspace: only the link, and never in the address.
    expect(init.body).toBeUndefined();
    expect(url).not.toContain(TOKEN);
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(window.sessionStorage.getItem(BACK_STORAGE_KEY)).toBe(`/pay/${TOKEN}`);
  });

  it("says in the server's words why it could not open the page, charges nothing, goes nowhere, and lets the customer try again", async () => {
    fetchSpy.mockResolvedValueOnce(respond(503, { error: "unavailable", message: "Online payment is not available for this invoice right now. Please contact the business to arrange payment." }));
    const navigate = vi.fn();
    render(<PayPanel token={TOKEN} canPay balanceMinor={150000} currency="PHP" navigate={navigate} />);
    fireEvent.click(screen.getByRole("button", { name: /Pay ₱1,500\.00 online/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("Online payment is not available for this invoice right now.");
    expect(navigate).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(BACK_STORAGE_KEY)).toBeNull();
    fetchSpy.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: /Pay ₱1,500\.00 online/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Nothing was charged. Check your connection and try again."));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("offers no Pay button when the invoice cannot be paid online, and always offers to print", () => {
    render(<PayPanel token={TOKEN} canPay={false} balanceMinor={0} currency="PHP" />);
    expect(screen.queryByRole("button", { name: /online/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Print or save as PDF/ })).toBeTruthy();
    expect(screen.queryByText(/Your card details are entered there/)).toBeNull();
    cleanup();
    render(<PayPanel token={TOKEN} canPay balanceMinor={5000} currency="USD" />);
    expect(screen.getByText(/Your card details are entered there, not on this page\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Pay \$50\.00 online/ })).toBeTruthy();
  });
});

describe("coming back from the provider", () => {
  it("says 'we are confirming your payment' at first, however the customer arrived, and asks the server again with only the reference until the database says received", async () => {
    vi.useFakeTimers();
    fetchSpy.mockResolvedValueOnce(respond(200, CONFIRMING)).mockResolvedValueOnce(respond(200, RECEIVED));
    render(<ReturnStatus reference={REFERENCE} initial={CONFIRMING} approvedCheckoutId={null} />);
    expect(screen.getByRole("heading", { name: "We are confirming your payment" })).toBeTruthy();
    expect(screen.queryByText("We have received your payment")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_DELAYS_MS[0] + 5); });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(STATUS_ENDPOINT);
    expect(init.headers).toEqual({ [REFERENCE_HEADER]: REFERENCE });
    expect(screen.queryByText("We have received your payment")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_DELAYS_MS[1] + 5); });
    expect(screen.getByRole("heading", { name: "We have received your payment" })).toBeTruthy();
    // It stops asking once the answer is final.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps saying so when the server cannot be reached or answers badly, and never turns that into 'received'", async () => {
    vi.useFakeTimers();
    fetchSpy.mockRejectedValue(new Error("offline"));
    render(<ReturnStatus reference={REFERENCE} initial={CONFIRMING} approvedCheckoutId={null} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_DELAYS_MS.slice(0, 6).reduce((a, b) => a + b, 0) + 50); });
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(screen.getByRole("heading", { name: "We are confirming your payment" })).toBeTruthy();
    expect(screen.queryByText("We have received your payment")).toBeNull();
  });

  it("gives up asking after a few minutes, says it is still waiting rather than that anything is wrong, and offers to check again", async () => {
    vi.useFakeTimers();
    fetchSpy.mockResolvedValue(respond(200, CONFIRMING));
    render(<ReturnStatus reference={REFERENCE} initial={CONFIRMING} approvedCheckoutId={null} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_DELAYS_MS.reduce((a, b) => a + b, 0) + 500); });
    expect(fetchSpy).toHaveBeenCalledTimes(POLL_DELAYS_MS.length);
    expect(screen.getByText("Still waiting for your payment provider to confirm it.")).toBeTruthy();
    const again = screen.getByRole("button", { name: "Check again" });
    fetchSpy.mockClear();
    fireEvent.click(again);
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_DELAYS_MS[0] + 5); });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("We have received your payment")).toBeNull();
  });

  it("does not ask at all for an answer that is already final", async () => {
    vi.useFakeTimers();
    render(<ReturnStatus reference={REFERENCE} initial={RECEIVED} approvedCheckoutId={null} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("We have received your payment");
  });

  it("takes the payment the customer approved before it asks where things stand (PayPal), naming the reference and the checkout, once", async () => {
    vi.useFakeTimers();
    fetchSpy.mockImplementation(async (url: string) => (url === CAPTURE_ENDPOINT ? respond(200, { ok: true }) : respond(200, RECEIVED)));
    render(<ReturnStatus reference={REFERENCE} initial={CONFIRMING} approvedCheckoutId="5O190127TN364715T" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const [first, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(first).toBe(CAPTURE_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ reference: REFERENCE, checkoutId: "5O190127TN364715T" });
    expect(String(fetchSpy.mock.calls[1][0])).toBe(STATUS_ENDPOINT);
    expect(screen.getByRole("heading", { name: "We have received your payment" })).toBeTruthy();
    expect(fetchSpy.mock.calls.filter((c) => c[0] === CAPTURE_ENDPOINT)).toHaveLength(1);
  });

  it("goes on asking, and claims nothing, when taking the approved payment failed", async () => {
    vi.useFakeTimers();
    fetchSpy.mockImplementation(async (url: string) => {
      if (url === CAPTURE_ENDPOINT) throw new Error("offline");
      return respond(200, CONFIRMING);
    });
    render(<ReturnStatus reference={REFERENCE} initial={CONFIRMING} approvedCheckoutId="5O190127TN364715T" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_DELAYS_MS[0] + POLL_DELAYS_MS[1] + 50); });
    expect(fetchSpy.mock.calls.filter((c) => c[0] === STATUS_ENDPOINT).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("heading", { name: "We are confirming your payment" })).toBeTruthy();
    expect(screen.queryByText("We have received your payment")).toBeNull();
  });

  it("offers a way back to the invoice only when the stored address is exactly an invoice page of this site", () => {
    window.sessionStorage.setItem(BACK_STORAGE_KEY, `/pay/${TOKEN}`);
    render(<ReturnStatus reference={REFERENCE} initial={RECEIVED} approvedCheckoutId={null} />);
    expect(screen.getByRole("link", { name: "Back to your invoice" }).getAttribute("href")).toBe(`/pay/${TOKEN}`);
    cleanup();
    for (const bad of ["https://evil.example/pay/" + TOKEN, "//evil.example", "javascript:alert(1)", `/pay/${TOKEN}?x=1`, "/pay/short"]) {
      window.sessionStorage.setItem(BACK_STORAGE_KEY, bad);
      render(<ReturnStatus reference={REFERENCE} initial={RECEIVED} approvedCheckoutId={null} />);
      expect(screen.queryByRole("link", { name: "Back to your invoice" }), bad).toBeNull();
      cleanup();
    }
  });
});

describe("the invoice and its frame", () => {
  const invoice: PublicInvoice = {
    business: { name: "Harbor Home Services", brandColor: "#1d4ed8", addressLines: ["14 Quay Road", "Cebu City"], taxLabel: "VAT", taxId: "QA-111", email: "billing@harbor.example.test", phone: null },
    number: "INV-0007", issueOn: "2026-10-20", dueOn: "2026-11-03", currency: "PHP", taxInclusive: false, billTo: { name: "Mara Villanueva", company: null, addressLines: ["12 Mango Street"] },
    lines: [{ position: 1, description: "Annual boiler service", quantity: "1", unitPriceMinor: 480000, discountMinor: 0, taxRateBps: 1200, amountMinor: 480000 }],
    subtotalMinor: 480000, taxMinor: 57600, totalMinor: 537600, paidMinor: 0, balanceMinor: 537600, paymentStatus: "unpaid", overdue: false, paymentInstructions: "Bank transfer to QA Bank.", notes: null, terms: null, footerNote: "Thank you.",
    hasPendingPayment: false, canPayOnline: true, isTest: false, banner: { kind: "pay_online", tone: "info" },
  };

  it("reads as an invoice: the business, the customer, the lines, tax shown as the owner entered it, the balance and how to pay, with no script needed", () => {
    render(<PublicShell business={invoice.business} wide><InvoiceDocument invoice={invoice} /></PublicShell>);
    expect(screen.getByRole("heading", { name: "Invoice", level: 1 })).toBeTruthy();
    expect(screen.getByText("INV-0007")).toBeTruthy();
    expect(screen.getAllByText("Harbor Home Services").length).toBeGreaterThan(0);
    expect(screen.getByText("Mara Villanueva")).toBeTruthy();
    expect(screen.getByText("VAT: QA-111")).toBeTruthy();
    expect(screen.getByText("Plus 12% VAT")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("You can pay this invoice online, or use the instructions below.");
    expect(screen.getByText("Bank transfer to QA Bank.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Skip to content" })).toBeTruthy();
    expect(screen.getByRole("main").id).toBe("invoice-main");
    // The table is labelled for a screen reader.
    expect(screen.getByRole("region", { name: "Invoice lines" })).toBeTruthy();
  });

  it("says paid only when the invoice is paid, and shows the customer's own words for a partial payment", () => {
    render(<InvoiceDocument invoice={{ ...invoice, paymentStatus: "paid", paidMinor: 537600, balanceMinor: 0, canPayOnline: false, banner: { kind: "paid", tone: "ok" } }} />);
    expect(screen.getByRole("status").textContent).toContain("Paid in full. Thank you.");
    cleanup();
    render(<InvoiceDocument invoice={{ ...invoice, paymentStatus: "partially_paid", paidMinor: 100000, balanceMinor: 437600, banner: { kind: "partly_paid", tone: "info" } }} />);
    expect(screen.getByRole("status").textContent).toContain("Partly paid. ₱4,376.00 is still due.");
    expect(screen.queryByText(/Paid in full/)).toBeNull();
  });

  it("shows an erased customer's copy without their details, and a whole-page notice for a link that opens nothing", () => {
    render(<InvoiceDocument invoice={{ ...invoice, billTo: { name: null, company: null, addressLines: [] } }} />);
    expect(screen.getByText("Customer details are not shown on this copy.")).toBeTruthy();
    cleanup();
    render(<PublicShell business={null}><PublicNotice kind="invalid" title="This link isn't valid"><p>Open the link straight from the message you received.</p></PublicNotice></PublicShell>);
    expect(screen.getByRole("heading", { name: "This link isn't valid" })).toBeTruthy();
    expect(screen.queryByText("Harbor Home Services")).toBeNull();
  });
});
