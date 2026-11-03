// @vitest-environment jsdom
// Billing, Payment providers, as a Super Admin sees it: each provider's setup state in the six words the release promised, the exact settings to add in Vercel (named, never valued),
// the webhook address and events, and one action, "Check connection". Above all: there is no field for a key anywhere on the page, nothing a provider needs is ever drawn from
// the browser's own state, and the page never says "ready" for a configuration the server has not verified.
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ check: vi.fn(), refresh: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: mocks.success, error: mocks.error }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }) }));
vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>(function Link({ href, ...props }, ref) {
    return <a {...props} href={href} ref={ref} />;
  });
  return { default: Link };
});
vi.mock("@/app/(admin)/admin/finance-actions", () => ({ checkPaymentProviderAction: mocks.check }));

import { PaymentProvidersPanel } from "@/components/admin/payment-providers-panel";
import { PROVIDER_GUIDE, READINESS_LABEL } from "@/lib/payment-providers/readiness";
import { sampleHealth, sampleProvider, type SampleProviderState } from "./support/payment-samples";

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
});
afterEach(cleanup);

const card = (name: string) => screen.getByRole("region", { name });

describe("every setup state, in its own words", () => {
  const cases: Array<[SampleProviderState, string]> = [
    ["none", READINESS_LABEL.not_connected],
    ["incomplete", READINESS_LABEL.incomplete],
    ["testing", READINESS_LABEL.ready_for_testing],
    ["verified", READINESS_LABEL.test_verified],
    ["live_approval", READINESS_LABEL.live_approval_required],
    ["live_ready", READINESS_LABEL.ready_for_live],
  ];
  it.each(cases)("shows %s as %s, with its mode and the next step", (state, label) => {
    render(<PaymentProvidersPanel health={sampleHealth(state)} canManage />);
    const pm = within(card("PayMongo"));
    expect(pm.getByText(label)).toBeTruthy();
    const mode = state === "none" ? null : state.startsWith("live") ? "Live mode" : "Test mode";
    if (mode) expect(pm.getAllByText(mode).length).toBeGreaterThan(0);
    else expect(pm.queryByText("Test mode")).toBeNull();
    expect(card("PayMongo").textContent).toContain(sampleProvider("paymongo", state).readiness.next);
  });

  it("never calls a configuration ready that was not verified: a stale check says it no longer counts", () => {
    render(<PaymentProvidersPanel health={sampleHealth("stale")} canManage />);
    const pm = within(card("PayMongo"));
    // A check made with an earlier configuration does not count: the state falls back to "Ready for testing", exactly as the server derives it.
    expect(pm.getByText(READINESS_LABEL.ready_for_testing)).toBeTruthy();
    expect(pm.queryByText(READINESS_LABEL.test_verified)).toBeNull();
    expect(pm.getByText(/Checked before the configuration changed/)).toBeTruthy();
    expect(pm.getByText(/no longer counts/)).toBeTruthy();
  });

  it("tells a live configuration apart from a test one, and warns that real money cannot move until the review", () => {
    render(<PaymentProvidersPanel health={sampleHealth("live_approval")} canManage />);
    expect(card("PayMongo").textContent).toMatch(/Live mode: real money\. Nothing can be charged until the payment and tax review is confirmed/);
    cleanup();
    render(<PaymentProvidersPanel health={sampleHealth("verified")} canManage />);
    expect(card("PayMongo").textContent).toMatch(/Test mode: no real money moves/);
  });

  it("says why buyers are not offered a provider that cannot take a payment", () => {
    render(<PaymentProvidersPanel health={sampleHealth("none")} canManage />);
    expect(card("PayMongo").textContent).toMatch(/Buyers are not offered PayMongo\./);
    cleanup();
    render(<PaymentProvidersPanel health={sampleHealth("verified")} canManage />);
    expect(card("PayMongo").textContent).not.toMatch(/Buyers are not offered/);
  });

  it("explains the checkout switch honestly: on is not working", () => {
    render(<PaymentProvidersPanel health={sampleHealth("none", "none", "blocked")} canManage />);
    const summary = card("Online checkout for purchases");
    expect(within(summary).getByText("On, but blocked")).toBeTruthy();
    expect(summary.textContent).toMatch(/Real-money checkout needs three things/);
    expect(summary.textContent).toMatch(/iAcquire does not do this for you, and nothing here switches it on/);
  });
});

describe("a setting nobody set that has a built-in default", () => {
  it("says Default, not Set, so the team is not told it set something it did not", () => {
    // The 2026-11-03 walkthrough of the live page: PAYMONGO_PAYMENT_METHODS and PAYPAL_ENVIRONMENT showed a green "Set" while neither exists in Vercel.
    const health = sampleHealth("none");
    const withDefaults = {
      ...health,
      providers: health.providers.map((p) => ({
        ...p,
        envVars: p.envVars.map((v) => (v.name === "PAYMONGO_PAYMENT_METHODS" ? { ...v, set: true, usingDefault: true, shown: "card" } : v.name === "PAYPAL_ENVIRONMENT" ? { ...v, set: true, usingDefault: true, shown: "sandbox" } : v)),
      })),
    };
    render(<PaymentProvidersPanel health={withDefaults} canManage />);
    const rowOf = (provider: string, name: string) => within(card(provider)).getByText(name).closest("li") as HTMLElement;
    for (const [provider, name, value] of [["PayMongo", "PAYMONGO_PAYMENT_METHODS", "card"], ["PayPal", "PAYPAL_ENVIRONMENT", "sandbox"]] as const) {
      const row = rowOf(provider, name);
      expect(within(row).getByText("Default")).toBeTruthy();
      expect(within(row).queryByText("Set")).toBeNull();
      expect(within(row).getByText(`now: ${value}`)).toBeTruthy();
    }
    // A required setting that is missing still says Missing, and one that is really set still says Set.
    expect(within(rowOf("PayMongo", "PAYMONGO_SECRET_KEY")).getByText("Missing")).toBeTruthy();
    cleanup();
    render(<PaymentProvidersPanel health={sampleHealth("testing")} canManage />);
    expect(within(rowOf("PayMongo", "PAYMONGO_SECRET_KEY")).getByText("Set")).toBeTruthy();
    expect(within(rowOf("PayMongo", "PAYMONGO_PAYMENT_METHODS")).getByText("Set")).toBeTruthy();
  });
});

describe("the webhook events listed for PayPal", () => {
  it("shows the payment confirmation as required and the monthly plan's events as such", () => {
    render(<PaymentProvidersPanel health={sampleHealth("none")} canManage />);
    const rowOf = (name: string) => within(card("PayPal")).getByText(name).closest("li") as HTMLElement;
    expect(within(rowOf("PAYMENT.CAPTURE.COMPLETED")).getByText("required")).toBeTruthy();
    expect(within(rowOf("PAYMENT.CAPTURE.REFUNDED")).getByText("recommended")).toBeTruthy();
    for (const name of ["BILLING.SUBSCRIPTION.ACTIVATED", "BILLING.SUBSCRIPTION.PAYMENT.FAILED", "PAYMENT.SALE.COMPLETED"]) {
      expect(within(rowOf(name)).getByText("monthly plan"), name).toBeTruthy();
    }
  });
});

describe("a setting that was given but cannot be used", () => {
  it("says Not usable with the reason, in place of Set or Missing", () => {
    const health = sampleHealth("none");
    const message = "PAYPAL_CLIENT_ID is set but cannot be used (it is too short or too long), so it is treated as not set.";
    const withProblem = { ...health, providers: health.providers.map((p) => ({ ...p, envVars: p.envVars.map((v) => (v.name === "PAYPAL_CLIENT_ID" ? { ...v, set: false, problem: message } : v)) })) };
    render(<PaymentProvidersPanel health={withProblem} canManage />);
    const row = within(card("PayPal")).getByText("PAYPAL_CLIENT_ID").closest("li") as HTMLElement;
    expect(within(row).getByText("Not usable")).toBeTruthy();
    expect(within(row).getByText(message)).toBeTruthy();
    expect(within(row).queryByText("Missing")).toBeNull();
    expect(within(row).queryByText("Set")).toBeNull();
    // The other settings are unaffected.
    const secret = within(card("PayPal")).getByText("PAYPAL_CLIENT_SECRET").closest("li") as HTMLElement;
    expect(within(secret).queryByText("Not usable")).toBeNull();
  });
});

describe("what to set, and where", () => {
  it("names every setting by its exact variable name with Set or Missing, never its value, and the optional ones as optional", () => {
    render(<PaymentProvidersPanel health={sampleHealth("incomplete", "verified")} canManage />);
    const pm = within(card("PayMongo"));
    for (const v of PROVIDER_GUIDE.paymongo.envVars) expect(pm.getByText(v.name)).toBeTruthy();
    const row = (name: string) => pm.getByText(name).closest("li") as HTMLElement;
    expect(within(row("PAYMONGO_SECRET_KEY")).getByText("Set")).toBeTruthy();
    expect(within(row("PAYMONGO_WEBHOOK_SECRET")).getByText("Missing")).toBeTruthy();
    expect(within(row("PAYMONGO_PAYMENT_METHODS")).getByText("optional")).toBeTruthy();
    expect(pm.getByText("USD to PHP exchange rate")).toBeTruthy();
    expect(pm.getByText(/No rate is set, so the price cannot be converted for PayMongo/)).toBeTruthy();
    expect(pm.getByRole("link", { name: /Set it in Rates & payments/ }).getAttribute("href")).toBe("/admin/billing?tab=rates");
    expect(pm.getByText("How to add them in Vercel")).toBeTruthy();
    expect(document.body.textContent).toMatch(/Never paste a key into this page/);
    const pp = within(card("PayPal"));
    for (const v of PROVIDER_GUIDE.paypal.envVars) expect(pp.getByText(v.name)).toBeTruthy();
    // PayPal has no exchange rate: it charges US dollars as they are.
    expect(pp.queryByText("USD to PHP exchange rate")).toBeNull();
  });

  it("has no field to type a key, a secret or a token into, anywhere on the page", () => {
    const { container } = render(<PaymentProvidersPanel health={sampleHealth("none", "none")} canManage />);
    expect(container.querySelectorAll("input, textarea, select, [contenteditable]").length).toBe(0);
    expect(container.querySelectorAll("form").length).toBe(0);
  });

  it("gives the webhook address to copy, the events to subscribe and which of them confirms a payment, and how to test it", () => {
    render(<PaymentProvidersPanel health={sampleHealth("verified")} canManage />);
    const pm = within(card("PayMongo"));
    expect(pm.getByText("https://www.iacquire.online/api/webhooks/paymongo")).toBeTruthy();
    expect(pm.getByRole("button", { name: "Copy" })).toBeTruthy();
    const event = (name: string) => pm.getByText(name, { selector: "code" }).closest("li") as HTMLElement;
    expect(event("checkout_session.payment.paid").textContent).toContain("required");
    expect(event("payment.failed").textContent).toContain("recommended");
    expect(pm.getByText(/Send a test event/)).toBeTruthy();
    expect(pm.getByText(/Last notice received from PayMongo/)).toBeTruthy();
    expect(pm.getByText("checkout_session.payment.paid", { selector: "strong" })).toBeTruthy();
  });

  it("warns when the site's address is not one a provider can call", () => {
    const health = sampleHealth("verified");
    health.providers[0] = sampleProvider("paymongo", "verified", { webhook: { ...health.providers[0].webhook, reachableByProvider: false, url: "http://localhost:3000/api/webhooks/paymongo" } });
    render(<PaymentProvidersPanel health={health} canManage />);
    expect(within(card("PayMongo")).getByRole("alert").textContent).toMatch(/not a public https address, so PayMongo cannot call it/);
  });

  it("reports notices that were refused, so a wrong signing secret is not a silent failure", () => {
    render(<PaymentProvidersPanel health={sampleHealth("failed")} canManage />);
    expect(card("PayMongo").textContent).toMatch(/2 notices were refused in the last 7 days: check the webhook secret/);
  });
});

describe("Check connection", () => {
  it("runs the check for that provider, announces what the server found, and refreshes the page", async () => {
    mocks.check.mockResolvedValue({ ok: true, data: { outcome: "verified", text: "The provider accepted the credentials.", health: sampleProvider("paymongo", "verified") } });
    render(<PaymentProvidersPanel health={sampleHealth("testing")} canManage />);
    fireEvent.click(within(card("PayMongo")).getByRole("button", { name: /Check connection/ }));
    await waitFor(() => expect(mocks.check).toHaveBeenCalledWith("paymongo"));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(mocks.success).toHaveBeenCalledWith("Connection verified.");
    expect(card("PayMongo").querySelector(".sr-only")!.textContent).toMatch(/provider accepted the credentials/);
  });

  it("reports a failed check as a failure, in the server's words, and never as a success", async () => {
    mocks.check.mockResolvedValue({ ok: true, data: { outcome: "credentials_rejected", text: "The provider did not accept these credentials. Check that they are the right key for the right mode, and still active.", health: sampleProvider("paypal", "failed") } });
    render(<PaymentProvidersPanel health={sampleHealth("none", "testing")} canManage />);
    fireEvent.click(within(card("PayPal")).getByRole("button", { name: /Check connection/ }));
    await waitFor(() => expect(mocks.check).toHaveBeenCalledWith("paypal"));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(expect.stringMatching(/did not accept these credentials/)));
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("shows a refusal (not a Super Admin, too many checks) as an error", async () => {
    mocks.check.mockResolvedValue({ ok: false, error: "The connection was checked several times already. Try again in 40 minutes.", code: "rate_limited" });
    render(<PaymentProvidersPanel health={sampleHealth("testing")} canManage />);
    fireEvent.click(within(card("PayMongo")).getByRole("button", { name: /Check connection/ }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(expect.stringMatching(/checked several times/)));
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("is not offered to someone who may not run it, and the page still reads the same", () => {
    render(<PaymentProvidersPanel health={sampleHealth("verified")} canManage={false} />);
    expect(screen.queryByRole("button", { name: /Check connection/ })).toBeNull();
    expect(within(card("PayMongo")).getByText(READINESS_LABEL.test_verified)).toBeTruthy();
  });
});
