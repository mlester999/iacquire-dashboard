// The Lead Sources report as a person reads it: the revenue columns, the as-of note, the line for money that belongs to no customer any more, and what a person who may not see
// invoices or a workspace without invoicing is shown instead. Rendered to static markup; the figures come from the report's own types.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/crm/reports/sources" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions/attribution", () => ({ addCostAction: vi.fn(), removeCostAction: vi.fn() }));

import { SourcesReport, asOfText } from "@/components/crm/attribution/sources-report";
import type { AttributionReport, SourceRow } from "@/server/attribution/report";
import type { CrmScope } from "@/server/crm/page";

const scope: CrmScope = { base: "/crm", orgId: null, agency: false, readOnly: false, userId: "u1", timezone: "UTC", currency: "PHP", can: {} };
const php = (amount: number) => ({ currency: "PHP", amount, minor: String(Math.round(amount * 100)) });
const usd = (amount: number) => ({ currency: "USD", amount, minor: String(Math.round(amount * 100)) });

const row = (over: Partial<SourceRow> = {}): SourceRow => ({
  source: "google", label: "Google", leads: 4, qualified: 2, appointments: 1, opportunities: 2, openValue: [], wonCount: 1, wonValue: [php(8000)], known: 4, inferred: 0, unknown: 0,
  cost: [php(1000)], costPerLead: { currency: "PHP", amount: 250 }, verifiedRevenue: [php(3000)], refunded: [php(100)], recordedByHand: [], returnOnSpend: 2, returnCurrency: "PHP", missing: null, ...over,
});

const report = (over: Partial<AttributionReport> = {}, revenue: Partial<AttributionReport["revenue"]> = {}): AttributionReport => ({
  model: "first", startsAt: "2026-09-24T00:00:00.000Z", endsAt: "2026-10-24T09:16:00.000Z", rows: [row()],
  totals: { leads: 4, qualified: 2, appointments: 1, opportunities: 2, wonCount: 1 },
  revenue: { state: "shown", asOf: "2026-10-24T09:15:42.000Z", manualCounted: false, workspaceHasPayments: true, testPaymentsExcluded: 0, disputedHeldOut: 0, total: [php(3000)], unattributed: { verifiedRevenue: [], refunded: [], recordedByHand: [] }, ...revenue },
  excludedCosts: 0, notes: ["A note the report made."], ...over,
});

const render = (r: AttributionReport) => renderToStaticMarkup(<SourcesReport scope={scope} days={30} model="first" report={r} costs={[]} sources={[]} canEnterCosts />);
const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");

describe("the revenue columns", () => {
  it("shows verified revenue net of refunds and without tax, the refund beside it, hand-recorded money apart, and a return in the currency it was worked out in", () => {
    const html = render(report({ rows: [row({ recordedByHand: [php(700)] })] }));
    const text = plain(html);
    expect(text).toContain("Verified revenue (net of refunds, excl. tax)");
    expect(text).toContain("Recorded by hand");
    expect(text).toContain("PHP 3,000");
    expect(text).toContain("after PHP 100 refunded");
    expect(text).toContain("PHP 700");
    expect(text).toContain("not counted above");
    expect(text).toMatch(/200%\s+in PHP/);
    // Deal value is never called revenue.
    expect(text).toContain("Won deal value");
    expect(text).not.toMatch(/Won revenue|Deal revenue/i);
  });

  it("says hand-recorded money is counted when the owner chose that, and what was left out of a return that is shown", () => {
    const text = plain(render(report({ rows: [row({ recordedByHand: [php(700)], missing: "Revenue in USD is not included: it is not converted." })] }, { manualCounted: true })));
    expect(text).toContain("counted above");
    expect(text).not.toContain("not counted above");
    expect(text).toContain("Revenue in USD is not included: it is not converted.");
  });

  it("shows the plain reason for a return that is not shown, and 'None yet' for a source with no verified revenue", () => {
    const text = plain(render(report({ rows: [row({ verifiedRevenue: [], refunded: [], returnOnSpend: null, returnCurrency: null, missing: "No verified payments from these leads yet." })] })));
    expect(text).toContain("None yet");
    expect(text).toContain("No verified payments from these leads yet.");
    expect(text).not.toMatch(/-?100%/);
  });
});

describe("the summary under the table", () => {
  it("says what the total is, which leads and which payments it counts, and when, in the same words on the server and in the browser", () => {
    const text = plain(render(report({}, { total: [php(3000), usd(200)] })));
    expect(text).toContain("Verified revenue in total: PHP 3,000 · USD 200.");
    expect(text).toContain("Counted for leads created in this period, from payments received up to 2026-10-24 09:15 UTC.");
    expect(asOfText("2026-10-24T09:15:42.000Z")).toBe("2026-10-24 09:15 UTC");
  });

  it("keeps money that belongs to no customer any more apart, and says it is in no source and no total", () => {
    const text = plain(render(report({}, { unattributed: { verifiedRevenue: [php(300)], refunded: [], recordedByHand: [php(50)] } })));
    expect(text).toContain("Not tied to a customer: PHP 300, recorded by hand PHP 50 (not counted).");
    expect(text).toContain("not credited to any source or counted in the total above");
    const counted = plain(render(report({}, { manualCounted: true, unattributed: { verifiedRevenue: [php(300)], refunded: [], recordedByHand: [php(50)] } })));
    expect(counted).toContain("recorded by hand PHP 50 (counted)");
    expect(plain(render(report()))).not.toContain("Not tied to a customer");
  });
});

describe("a person who may not see it, and a workspace that does not have it", () => {
  const withoutFigures = { verifiedRevenue: [], refunded: [], recordedByHand: [] };

  it("is told revenue is not shown to their role, instead of a figure or a zero", () => {
    const text = plain(render(report({ rows: [row({ ...withoutFigures, returnOnSpend: null, returnCurrency: null, missing: "Verified revenue is shown to people who can see invoices." })] }, { state: "hidden", total: [], workspaceHasPayments: false })));
    expect(text).toContain("Not shown to your role");
    expect(text).toContain("Verified revenue is shown to people who can see invoices.");
    expect(text).not.toContain("Verified revenue in total");
    expect(text).not.toContain("None yet");
    expect(text).toContain("Leads");
  });

  it("is told revenue is not switched on, with the reason beside the return", () => {
    const text = plain(render(report({ rows: [row({ ...withoutFigures, returnOnSpend: null, returnCurrency: null, missing: "Needs verified payments." })] }, { state: "off", total: [], workspaceHasPayments: false })));
    expect(text).toContain("Not switched on");
    expect(text).toContain("Needs verified payments.");
    expect(text).not.toContain("Verified revenue in total");
  });
});
