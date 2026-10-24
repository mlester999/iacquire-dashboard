// @vitest-environment jsdom
// The Super Admin's "publish a usage rate" form, rendered: choosing a model token unit changes what the amount field says it is (per 1,000 tokens), shows how to
// convert a price quoted another way, and warns when the number looks like a price per single token or per million. Rendered in a test DOM, not in a real browser.
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FinanceWorkspace } from "@/components/admin/finance-workspace";

const mocks = vi.hoisted(() => ({ action: vi.fn(async () => ({ ok: true })) }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }) }));
vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>(function Link({ href, ...props }, ref) {
    return <a {...props} href={href} ref={ref} />;
  });
  return { default: Link };
});
vi.mock("@/app/(admin)/admin/finance-actions", () => ({
  addFinanceEntryAction: mocks.action, addProviderFeeAction: mocks.action, adjustCreditsAction: mocks.action, confirmLiveReviewAction: mocks.action, publishUnitRateAction: mocks.action,
  saveFinanceSettingsAction: mocks.action, setExchangeRateAction: mocks.action, voidFinanceEntryAction: mocks.action,
}));

const REPORT = {
  period: { key: "this_month", label: "This month", from: "2026-10-01", to: "2026-11-01" },
  received: { netMicros: 0 }, usage: { grossMarkupContributionMicros: 0 }, prepaid: { heldForClientsMicros: 0 }, distributable: null,
  clients: [], entries: [], tax: { configuredBps: null }, reserve: { perSetupUsd: 200 },
};
const OVERVIEW = {
  paymongo: { configured: false, webhookConfigured: false, livemode: null, problems: [] }, fx: { usdPhpRate: null, source: null, updatedAt: null },
  liveReviewConfirmedAt: null, markupBps: 13000, unmatchedEvents: [], reconciliationErrors: [],
};

function renderRates() {
  return render(<FinanceWorkspace report={REPORT as never} overview={OVERVIEW as never} rates={[]} canManage tab="rates" period="this_month" />);
}
const chooseUnit = (value: string) => fireEvent.change(screen.getByLabelText("Unit"), { target: { value } });

afterEach(cleanup);

describe("the rate form", () => {
  it("asks for a price per unit for an ordinary unit, with no extra hint", () => {
    renderRates();
    expect(screen.getByLabelText("We pay (USD per unit)")).toBeTruthy();
    expect(screen.queryByText(/not one token/)).toBeNull();
  });

  it("asks for a price per 1,000 tokens for both token units, and says how to convert a per-million price", () => {
    renderRates();
    for (const unit of ["ai_tokens_in", "ai_tokens_out"]) {
      chooseUnit(unit);
      const field = screen.getByLabelText("We pay (USD per 1,000 tokens)") as HTMLInputElement;
      expect(field.placeholder).toBe("0.0005");
      expect(screen.getByText(/1,000 tokens, not one token/)).toBeTruthy();
      expect(screen.getByText(/per million tokens: divide it by 1,000/)).toBeTruthy();
    }
    expect(screen.queryByLabelText("We pay (USD per unit)")).toBeNull();
  });

  it("names the token units 'per 1,000' in the unit list too", () => {
    renderRates();
    const names = Array.from((screen.getByLabelText("Unit") as HTMLSelectElement).options).map((o) => o.textContent);
    expect(names).toContain("AI input tokens (per 1,000)");
    expect(names).toContain("AI output tokens (per 1,000)");
    expect(names).toContain("SMS segments");
  });

  it("warns about a number that looks like a price per single token or per million, and says nothing for a sensible one", () => {
    renderRates();
    chooseUnit("ai_tokens_in");
    const field = screen.getByLabelText("We pay (USD per 1,000 tokens)");
    fireEvent.change(field, { target: { value: "0.000003" } });
    expect(screen.getByRole("status").textContent).toMatch(/per single token/);
    fireEvent.change(field, { target: { value: "15" } });
    expect(screen.getByRole("status").textContent).toMatch(/per million tokens/);
    fireEvent.change(field, { target: { value: "0.002" } });
    expect(screen.queryByRole("status")).toBeNull();
    // The warning does not block publishing.
    expect((screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
