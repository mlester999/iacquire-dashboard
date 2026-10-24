// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { WorkBoardKanban } from "@/components/work/work-board-kanban";
import type { AgentRoleKey } from "@/lib/agents";
import type { ScheduleView } from "@/server/workforce/schedules";
import type { WorkBoardJob } from "@/server/workforce/work-board";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>(function Link({ href, ...props }, ref) {
    return <a {...props} href={href} ref={ref} />;
  });
  return { default: Link };
});
vi.mock("@/components/work/job-progress", () => ({
  WorkJobPanel: ({ jobId }: { jobId: string }) => <div data-testid="job-panel">{jobId}</div>,
}));

afterEach(cleanup);

function job(overrides: Partial<WorkBoardJob> = {}): WorkBoardJob {
  return {
    id: "job-1",
    capability: "proactive_review",
    title: "Operations review job",
    status: "running",
    statusLabel: "Working",
    recoveryPending: false,
    stage: "reviewing",
    stageLabel: "Reviewing persisted operations",
    resultSummary: null,
    resultCount: 0,
    failureMessage: null,
    employeeName: "Zeng",
    employeeRole: "operations_manager",
    conversationId: null,
    createdAt: "2026-10-23T08:00:00.000Z",
    startedAt: "2026-10-23T08:00:05.000Z",
    finishedAt: null,
    latestEvent: { message: "One active blocker found", kind: "progress", createdAt: "2026-10-23T08:01:00.000Z" },
    ...overrides,
  };
}

function schedule(): ScheduleView {
  return {
    id: "schedule-1",
    capability: "crm_quality_review",
    capabilityLabel: "CRM quality review",
    employeeRole: "crm_manager" as AgentRoleKey,
    employeeName: "CRM Manager",
    cadence: "daily",
    intervalMinutes: 1440,
    recurrenceRule: { kind: "daily", localTime: "09:00" },
    recurrenceInvalid: false,
    timezone: "UTC",
    businessHours: {},
    payload: {},
    enabled: false,
    nextRunAt: "2026-10-25T09:00:00.000Z",
    updatedAt: "2026-10-24T07:00:00.000Z",
    lastRunAt: null,
    lastJobId: null,
    lastSkippedReason: null,
    lastSkippedAt: null,
    operatorEnabled: false,
  };
}

describe("AI Work Board Kanban", () => {
  it("keeps persisted jobs and future schedule occurrences in separate truthful lanes", () => {
    render(<WorkBoardKanban
      jobs={[
        job(),
        job({ id: "job-2", title: "Sales follow-up review", status: "blocked", statusLabel: "Blocked", employeeName: "Sales Assistant", employeeRole: "sales_assistant" }),
      ]}
      schedules={[schedule()]}
      filter="all"
      scheduleOperatorEnabled={false}
      timeZone="UTC"
      focusJobId={null}
      referenceTime="2026-10-24T08:00:00.000Z"
    />);

    expect(screen.getByRole("heading", { name: "Planned" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Working" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Blocked" })).toBeTruthy();
    expect(screen.getAllByText("CRM quality review").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Scheduled · not a job").length).toBeGreaterThan(0);
    expect(screen.getByText("Operator switch off.")).toBeTruthy();
    expect(screen.getByText("Operations review job")).toBeTruthy();
    expect(screen.getByText("Sales follow-up review")).toBeTruthy();

    const operationsCard = screen.getByText("Operations review job").closest("article");
    expect(operationsCard).not.toBeNull();
    fireEvent.click(within(operationsCard as HTMLElement).getByRole("button", { name: "Activity" }));
    expect(screen.getByTestId("job-panel").textContent).toBe("job-1");
  });

  it("filters jobs and projected occurrences together by employee", () => {
    render(<WorkBoardKanban
      jobs={[job(), job({ id: "job-2", title: "Sales follow-up review", status: "blocked", statusLabel: "Blocked", employeeName: "Sales Assistant", employeeRole: "sales_assistant" })]}
      schedules={[schedule()]}
      filter="all"
      scheduleOperatorEnabled={false}
      timeZone="UTC"
      focusJobId={null}
      referenceTime="2026-10-24T08:00:00.000Z"
    />);

    fireEvent.click(screen.getByRole("button", { name: "CRM Manager" }));
    expect(screen.getAllByText("CRM quality review").length).toBeGreaterThan(0);
    expect(screen.queryByText("Operations review job")).toBeNull();
    expect(screen.queryByText("Sales follow-up review")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "All six" }));
    expect(screen.getByText("Operations review job")).toBeTruthy();
    expect(screen.getByText("Sales follow-up review")).toBeTruthy();
  });
});
