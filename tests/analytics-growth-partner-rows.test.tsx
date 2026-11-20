// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { AnalyticsView } from "@/components/analytics/analytics-view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", async () => {
  const React = await import("react");
  return { default: ({ href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => <a {...props} href={href} /> };
});
vi.mock("@/components/charts", async (original) => ({
  HBarList: (await original<typeof import("@/components/charts")>()).HBarList,
  AreaChart: () => null,
  Columns: () => null,
  StatusSplit: () => null,
}));
vi.mock("@/components/ui/overlays", () => ({
  Segmented: () => null,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

afterEach(cleanup);

type Data = React.ComponentProps<typeof AnalyticsView>["data"];
type Source = Data["leads"]["bySource"][number];

function data(byAgent: Data["workforce"]["byAgent"], bySource: Source[]): Data {
  return {
    sources: { crm: false, calendar: false, native: { opportunities: false, appointments: false } },
    leads: { totals: { total: bySource.reduce((total, source) => total + source.total, 0), approved: 0, rejected: 0, reviewed: 0, avg_score: null, with_sources: 0 }, bySource },
    appointments: null,
    sales: null,
    workforce: { byAgent, toolSteps: 0, cancelled: 0 },
    execution: { succeeded: 0, blocked: 0, failed: 0, rejected: 0, expired: 0 },
    usage: { messages: 0, tokens: 0, research: 0, help: 0 },
    retention: { total: 0, active: 0, at_risk: 0, churned: 0 },
  };
}

function renderAnalytics(byAgent: Data["workforce"]["byAgent"], bySource: Source[] = []) {
  return render(<AnalyticsView
    data={data(byAgent, bySource)}
    leadsByDay={[]}
    messagesByDay={[]}
    range={{ key: "30d", from: "2026-10-01T00:00:00.000Z", to: "2026-10-31T23:59:59.000Z", days: 30 }}
    timeZone="UTC"
    canExport={false}
    canChat={false}
  />);
}

function workActivity() {
  return within(screen.getByRole("region", { name: "AI work activity" }));
}

describe("Performance Reporting Growth Partner rows", () => {
  it("shows Growth Partner runs and groups legacy runs without role names or vendor wording", () => {
    const { container } = renderAnalytics([
      { role_key: "growth_partner", total: 5, completed: 4, failed: 1, tokens: 900 },
      { role_key: "lead_hunter", total: 2, completed: 2, failed: 0, tokens: 300 },
      { role_key: "operations_manager", total: 3, completed: 2, failed: 1, tokens: 400 },
    ]);

    const rows = workActivity().getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("AI Growth Partner")).toBeTruthy();
    expect(within(rows[0]).getByText("5")).toBeTruthy();
    expect(within(rows[1]).getByText("Previous role profiles")).toBeTruthy();
    expect(within(rows[1]).getByText("5")).toBeTruthy();
    expect(container.textContent).not.toMatch(/Lead Hunter|Operations Manager|Sales Assistant|CRM Manager|Appointment Setter|Performance Analyst|Hermes/);
    expect(screen.getByText("Performance Reporting")).toBeTruthy();
  });

  it("omits the previous profiles row when retained roles have no runs", () => {
    renderAnalytics([
      { role_key: "growth_partner", total: 2, completed: 2, failed: 0, tokens: 200 },
      { role_key: "lead_hunter", total: 0, completed: 0, failed: 0, tokens: 0 },
      { role_key: "operations_manager", total: 0, completed: 0, failed: 0, tokens: 0 },
    ]);
    const row = within(workActivity().getByRole("listitem"));
    expect(row.getByText("AI Growth Partner")).toBeTruthy();
    expect(row.getByText("2")).toBeTruthy();
    expect(workActivity().queryByText("Previous role profiles")).toBeNull();
  });

  it("shows the empty state when neither the Partner nor retained profiles have recorded runs", () => {
    renderAnalytics([
      { role_key: "growth_partner", total: 0, completed: 0, failed: 0, tokens: 0 },
      { role_key: "lead_hunter", total: 0, completed: 0, failed: 0, tokens: 0 },
    ]);
    expect(workActivity().getByText("No AI runs in this period.")).toBeTruthy();
    expect(workActivity().queryByRole("listitem")).toBeNull();
  });

  it("keeps lead upload, fixture and approved-source discovery labels distinct", () => {
    renderAnalytics([], ["tenant_upload", "synthetic_fixture", "approved_source"].map((source) => ({
      source, total: 1, approved: 0, avg_score: null,
    })));
    const table = within(screen.getByRole("table", { name: "Lead source performance" }));
    expect(table.getByText("Workspace CSV")).toBeTruthy();
    expect(table.getByText("Synthetic discovery fixture")).toBeTruthy();
    expect(table.getByText("Approved-source discovery")).toBeTruthy();
  });
});
