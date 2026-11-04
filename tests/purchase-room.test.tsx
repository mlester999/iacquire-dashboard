// @vitest-environment jsdom
// The buyer's two pages, in their "offer room" look: the purchase page (what the buyer reads and can press at each stage) and the payment page (what the buyer reads after the payment
// provider's page). The look is CSS and is judged in a browser; what is held here is what must stay true under any look: the promises the page makes are still on it, only the right
// buttons exist at each stage, the progress shows the buyer's real place, a failed press is told in words, and the payment page never says "paid" before the stored status does.
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ start: vi.fn(), startCheckout: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }) }));
vi.mock("@/app/actions/purchase-intents", () => ({ startPurchaseAction: mocks.start, startPurchaseCheckoutAction: mocks.startCheckout }));

import { PublicPurchaseBody, PublicPurchaseInvalid, PublicPurchaseTooMany } from "@/components/purchase-intents/public-purchase";
import { PaymentResultView, type ResultStage } from "@/components/purchase-intents/payment-result";
import { companyInitials } from "@/components/purchase-intents/team-orbit";
import { buyerJourney, checkoutReturnStage, checkoutReturnText, type CheckoutStatus, type PurchaseStatus } from "@/lib/purchase-intents/rules";
import { AGENT_ROLES } from "@/lib/agents";
import type { PublicPurchaseView } from "@/server/purchase-intents/service";

beforeAll(() => {
  // The price counts up when it scrolls into view; a browser-like document needs the observer that drives that.
  globalThis.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } } as unknown as typeof IntersectionObserver;
});
beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
});
afterEach(cleanup);

const PROVIDERS = [{ id: "paymongo" as const, label: "PayMongo" }, { id: "paypal" as const, label: "PayPal" }];
const SAMPLE: PublicPurchaseView = {
  reference: "PUR-SAMPLE2345", buyerName: "Bailey Buyer", buyerEmail: "bailey@harborview.example", company: "Harborview Realty Group", industry: "Real estate", setupFeeCents: 149900,
  maintenanceMonthlyCents: 29900, maintenanceSelected: true, currency: "USD", status: "invited", statusText: "Invitation created", expiresAt: "2026-11-16T15:35:00.000Z", timezone: "America/Chicago",
  canConfirm: true, problem: null, checkout: { offered: false, status: null, reference: null, providers: [] },
};
const view = (over: Partial<PublicPurchaseView>): PublicPurchaseView => ({ ...SAMPLE, ...over });
const paying = (over: Partial<PublicPurchaseView["checkout"]> = {}) => view({ status: "started", statusText: "Buyer confirmed", canConfirm: false, checkout: { offered: true, status: null, reference: null, providers: PROVIDERS, ...over } });
const draw = (v: PublicPurchaseView) => render(<PublicPurchaseBody purchase={v} token="sample-token-not-a-real-link" />);
const steps = () => within(screen.getByRole("list", { name: "Progress of this purchase" })).getAllByRole("listitem");
const stateOf = (li: HTMLElement) => li.getAttribute("data-state");

describe("the road shown to the buyer", () => {
  it("restates the purchase's own status as four stops, and shows none for a purchase that was closed or ran out", () => {
    const at = (s: PurchaseStatus) => buyerJourney(s)?.map((x) => `${x.label}:${x.state}`).join(" ");
    expect(at("invited")).toBe("Confirm:current Pay:todo Verify:todo Workspace:todo");
    expect(at("started")).toBe("Confirm:done Pay:current Verify:todo Workspace:todo");
    expect(at("payment_verified")).toBe("Confirm:done Pay:done Verify:done Workspace:current");
    expect(at("provisioned")).toBe("Confirm:done Pay:done Verify:done Workspace:done");
    expect(buyerJourney("expired")).toBeNull();
    expect(buyerJourney("cancelled")).toBeNull();
  });

  it("names the stage of the payment page from the same facts as its words, so the picture never contradicts them", () => {
    const statuses: Array<CheckoutStatus | null> = [null, "creating", "pending", "paid", "failed", "cancelled", "expired", "mismatch", "refunded", "disputed"];
    const purchases: Array<PurchaseStatus | null> = [null, "invited", "started", "payment_verified", "provisioned", "cancelled", "expired"];
    const tone: Record<string, string> = { review: "warning", ready: "success", paid: "success", test: "neutral", left: "neutral", waiting: "neutral", failed: "danger" };
    for (const status of statuses) for (const purchase of purchases) for (const left of [false, true]) for (const sandbox of [false, true]) {
      const stage = checkoutReturnStage(status, purchase, left, sandbox);
      const words = checkoutReturnText(status, purchase, left, sandbox);
      expect(words.tone, JSON.stringify({ status, purchase, left, sandbox, stage })).toBe(tone[stage]);
    }
  });

  it("puts two letters of the company in the middle of the orbit, and does not count a leading 'The'", () => {
    expect(companyInitials("Harborview Realty Group")).toBe("HR");
    expect(companyInitials("The Extraordinarily Long Named Harborview")).toBe("EL");
    expect(companyInitials("the")).toBe("T");
    expect(companyInitials("Acme")).toBe("A");
    expect(companyInitials("Smith & Sons")).toBe("SS");
    expect(companyInitials("  ")).toBe("I");
  });
});

describe("the purchase page", () => {
  it("keeps every promise it always made, in its new look", () => {
    draw(SAMPLE);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Welcome, Bailey");
    const page = document.body.textContent ?? "";
    expect(page).toContain("This is the iAcquireOS launch offer prepared for Harborview Realty Group. Confirm the details below; your card is never entered on this page.");
    expect(page).toContain("The price and product version are frozen when the invitation is created.");
    expect(page).toContain("Only a hash of this link is stored. It stops working on");
    expect(page).toContain("A workspace is created only after the payment is verified: by the payment provider's confirmation, or by iAcquire.");
    expect(page).toContain("No card is charged on this page.");
    expect(page).toContain("A dedicated iAcquireOS client workspace and onboarding.");
    expect(page).toContain("CRM setup, integrations and AI employee provisioning follow verification and onboarding.");
    // The frozen price is on the page as text (it counts up when seen, but is the price without scripts), with the optional plan and whether it was chosen.
    expect(page).toContain("$1,499");
    expect(page).toContain("$299/month");
    expect(page).toContain("Selected");
  });

  it("says when the maintenance plan was not chosen, and tells a long name as it is", () => {
    draw(view({ maintenanceSelected: false, company: "The Extraordinarily Long Named Harborview Realty and Property Management Group of the Greater Pacific Northwest Region LLC", buyerName: "Bartholomew-Alexander Montgomery-Featherstonehaugh" }));
    const page = document.body.textContent ?? "";
    expect(page).toContain("Not selected");
    expect(page).toContain("The maintenance plan is optional and was not selected.");
    expect(page).toContain("Bartholomew-Alexander");
    expect(page).toContain("The Extraordinarily Long Named Harborview Realty and Property Management Group of the Greater Pacific Northwest Region LLC");
  });

  it("offers one button before the buyer confirms: no payment button exists yet", () => {
    draw(SAMPLE);
    expect(screen.getByRole("button", { name: /Confirm and continue/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Pay / })).toBeNull();
    expect(steps().map(stateOf)).toEqual(["current", "todo", "todo", "todo"]);
    expect(steps()[0].getAttribute("aria-current")).toBe("step");
  });

  it("offers a button for each ready provider after the buyer confirmed, with the price in its words, and never says the buyer paid", () => {
    draw(paying());
    expect(screen.getByRole("button", { name: /Pay \$1,499 by card or e-wallet/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Pay \$1,499 with PayPal/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Confirm and continue/ })).toBeNull();
    expect(document.body.textContent).toContain("Your purchase is confirmed.");
    expect(document.body.textContent).toContain("The next step is the payment.");
    expect(steps().map(stateOf)).toEqual(["done", "current", "todo", "todo"]);
    expect(document.body.textContent).not.toMatch(/Payment confirmed|payment was received|you have paid/i);
  });

  it("offers only the provider that is ready, and says nothing about the one that is not", () => {
    draw(paying({ providers: [{ id: "paypal", label: "PayPal" }] }));
    expect(screen.getByRole("button", { name: /Pay \$1,499 with PayPal/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /e-wallet/ })).toBeNull();
    expect(document.body.textContent).toContain("PayPal payments are made in US dollars on PayPal's own page");
    expect(document.body.textContent).not.toContain("PayMongo");
  });

  it("tells a payment attempt that did not go through, and that nothing was charged", () => {
    draw(paying({ status: "failed", reference: "IAQ-SAMPLE0001" }));
    expect(document.body.textContent).toContain("The last payment attempt did not go through. Nothing was charged. You can try again.");
  });

  it("shows the server's reason in words when a press is refused, and starts no checkout twice while one is opening", async () => {
    mocks.startCheckout.mockResolvedValue({ ok: false, error: "The payment provider could not be reached. Nothing was charged. Please try again." });
    draw(paying());
    fireEvent.click(screen.getByRole("button", { name: /Pay \$1,499 with PayPal/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Nothing was charged"));
    expect(mocks.startCheckout).toHaveBeenCalledTimes(1);
    expect(mocks.startCheckout).toHaveBeenCalledWith("sample-token-not-a-real-link", "paypal");
    // The buttons are usable again after a refusal.
    expect((screen.getByRole("button", { name: /Pay \$1,499 with PayPal/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("confirms the offer on one press, refreshes the page's data, and asks nothing else of the buyer", async () => {
    mocks.start.mockResolvedValue({ ok: true });
    draw(view({ checkout: { offered: false, status: null, reference: null, providers: [] } }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm and continue/ }));
    await waitFor(() => expect(document.body.textContent).toContain("iAcquire will verify the payment and send your workspace invitation. You can close this page."));
    expect(mocks.start).toHaveBeenCalledWith("sample-token-not-a-real-link");
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("shows a refused confirmation as an alert in words", async () => {
    mocks.start.mockResolvedValue({ ok: false, error: "This purchase link has expired. Ask iAcquire for a new one." });
    draw(SAMPLE);
    fireEvent.click(screen.getByRole("button", { name: /Confirm and continue/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("has expired"));
    expect(screen.getByRole("button", { name: /Confirm and continue/ })).toBeTruthy();
  });

  it("shows the verified and finished stages with their place on the road and no buttons", () => {
    const { unmount } = draw(view({ status: "payment_verified", statusText: "Payment verified", canConfirm: false, problem: "Your payment is confirmed. iAcquire is creating your workspace and will email your invitation." }));
    expect(steps().map(stateOf)).toEqual(["done", "done", "done", "current"]);
    expect(screen.queryByRole("button")).toBeNull();
    unmount();
    draw(view({ status: "provisioned", statusText: "Workspace created", canConfirm: false, problem: "Your workspace is ready. Check the email address on this purchase for your invitation." }));
    expect(steps().map(stateOf)).toEqual(["done", "done", "done", "done"]);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows a link that ran out or was closed with its reason and no road and no buttons", () => {
    const { unmount } = draw(view({ status: "expired", statusText: "Link expired", canConfirm: false, problem: "This purchase link has expired. Ask iAcquire for a new one." }));
    expect(screen.queryByRole("list", { name: "Progress of this purchase" })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.body.textContent).toContain("This purchase link has expired. Ask iAcquire for a new one.");
    unmount();
    draw(view({ status: "cancelled", statusText: "Cancelled", canConfirm: false, problem: "This purchase was cancelled." }));
    expect(screen.queryByRole("list", { name: "Progress of this purchase" })).toBeNull();
    expect(document.body.textContent).toContain("This purchase was cancelled.");
  });

  it("lists the six AI employees as text, and hides the picture of them from assistive technology", () => {
    const { container } = draw(SAMPLE);
    for (const role of AGENT_ROLES) expect(document.body.textContent).toContain(role.shortName);
    expect(AGENT_ROLES).toHaveLength(6);
    const orbit = container.querySelector(".room-orbit");
    expect(orbit?.getAttribute("aria-hidden")).toBe("true");
    expect(orbit?.querySelectorAll("img[alt='']")).toHaveLength(6);
    // The picture claims nothing about the employees working: the sentence under it says when they are set up.
    expect(document.body.textContent).toContain("Six AI employees, set up for you once your payment is verified.");
  });

  it("answers a link that is not valid, and too many attempts, in words and with no offer", () => {
    const { unmount } = render(<PublicPurchaseInvalid />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("This link is not valid");
    expect(document.body.textContent).toContain("No details were looked up.");
    unmount();
    render(<PublicPurchaseTooMany />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Too many attempts");
    expect(document.body.textContent).toContain("Wait a moment and open the link again.");
  });
});

describe("the payment page", () => {
  const show = (stage: ResultStage, status: CheckoutStatus | null, purchase: PurchaseStatus | null, over: { left?: boolean; sandbox?: boolean; live?: boolean; reference?: string | null } = {}) => {
    const words = checkoutReturnText(status, purchase, over.left === true, over.sandbox === true);
    return render(<PaymentResultView stage={stage} title={words.title} body={words.body} reference={over.reference === undefined ? "IAQ-SAMPLE0123456" : over.reference} live={over.live === true} />);
  };

  it("does not say the buyer paid while the payment provider has not confirmed it, and says it will keep checking", () => {
    show("waiting", "pending", "started", { live: true });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Waiting for the payment provider");
    expect(screen.getByRole("status").textContent).toContain("only the payment provider's confirmation does");
    expect(document.body.textContent).toContain("Checking again every few seconds");
    expect(document.body.textContent).not.toMatch(/Payment confirmed|Your workspace is ready/);
    const next = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(next.map(stateOf)).toEqual(["done", "current", "todo", "todo"]);
  });

  it("shows the reference of the payment, and no 'checking' line when nothing is being waited for", () => {
    show("failed", "failed", "started");
    expect(document.body.textContent).toContain("Payment reference");
    expect(document.body.textContent).toContain("IAQ-SAMPLE0123456");
    expect(document.body.textContent).not.toContain("Checking again");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("The payment did not go through");
    expect(document.body.textContent).toContain("Nothing was charged");
  });

  it("promises a workspace only when the payment was confirmed, and never for a refund, a failure or a test payment", () => {
    const promises = (t: string) => /creating your workspace|Your workspace was created|Open the invitation/.test(t);
    const cases: Array<[ResultStage, CheckoutStatus | null, PurchaseStatus | null, { sandbox?: boolean; left?: boolean }, boolean]> = [
      ["paid", "paid", "payment_verified", {}, true],
      ["ready", "paid", "provisioned", {}, true],
      ["review", "refunded", "payment_verified", {}, false],
      ["failed", "failed", "started", {}, false],
      ["test", "paid", "payment_verified", { sandbox: true }, false],
      ["left", "pending", "started", { left: true }, false],
      ["waiting", "pending", "started", {}, true],
    ];
    for (const [stage, status, purchase, extra, expected] of cases) {
      const { unmount } = show(stage, status, purchase, extra);
      const list = within(screen.getByRole("list")).getAllByRole("listitem").map((li) => li.textContent ?? "").join(" | ");
      // A waiting buyer is told what comes after the confirmation ("iAcquire creates your workspace"), which is a plan; the others are told what is true of their stage.
      if (stage !== "waiting") expect(promises(list), `${stage}: ${list}`).toBe(expected);
      expect(checkoutReturnStage(status, purchase, extra.left === true, extra.sandbox === true)).toBe(stage);
      unmount();
    }
  });

  it("tells a test payment as a test and a payment that needs a person as one that needs a person", () => {
    const { unmount } = show("test", "paid", "payment_verified", { sandbox: true });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Test payment recorded");
    expect(document.body.textContent).toContain("No real money moved");
    unmount();
    show("review", "refunded", "payment_verified");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Your payment needs a person to look at it");
    expect(document.body.textContent).toContain("iAcquire will contact you at the email address on your purchase");
  });

  it("answers too many attempts without a reference", () => {
    render(<PaymentResultView stage="limited" title="Too many attempts" body="Wait a moment and refresh this page." reference={null} live={false} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Too many attempts");
    expect(document.body.textContent).not.toContain("Payment reference");
  });
});
