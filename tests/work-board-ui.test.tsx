// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { WorkBoard } from "@/components/work/work-board";
import { setScheduleEnabledAction, setTriggerEnabledAction } from "@/app/actions/work";
import type { WorkBoardJob } from "@/server/workforce/work-board";
import type { ScheduleView } from "@/server/workforce/schedules";
import type { TriggerView } from "@/server/workforce/triggers";
import type { MonitoringStatus, ProactiveReportView } from "@/server/workforce/reports";

const startReview = vi.fn(async () => ({ ok: true as const, data: { jobId: "job-new", agentId: "agent-1" } }));
const acknowledgeReport = vi.fn(async () => ({ ok: true as const, data: { acknowledged: true } }));
vi.mock("@/app/actions/work", () => ({
  startReviewAction: () => startReview(),
  saveScheduleAction: vi.fn(async () => ({ ok: true as const, data: { id: "s1", enabled: false } })),
  setScheduleEnabledAction: vi.fn(async () => ({ ok: true as const })),
  deleteScheduleAction: vi.fn(async () => ({ ok: true as const })),
  saveTriggerAction: vi.fn(async () => ({ ok: true as const, data: { id: "t1", enabled: false } })),
  setTriggerEnabledAction: vi.fn(async () => ({ ok: true as const })),
  deleteTriggerAction: vi.fn(async () => ({ ok: true as const })),
  acknowledgeReportAction: () => acknowledgeReport(),
  createFindingTaskAction: vi.fn(async () => ({ ok: true as const, data: { taskId: "task-1", created: true } })),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn() }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>(function Link({ href, ...props }, ref) {
    return <a {...props} href={href} ref={ref} />;
  });
  return { default: Link, useLinkStatus: () => ({ pending: false }) };
});
vi.mock("@/components/work/job-progress", () => ({
  WorkJobPanel: ({ jobId }: { jobId: string }) => <div data-testid="job-panel">{jobId}</div>,
}));

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function job(overrides: Partial<WorkBoardJob> = {}): WorkBoardJob {
  return {
    id: "job-1",
    capability: "lead_research",
    title: "Find 20 real estate agencies in Miami",
    status: "running",
    statusLabel: "Working",
    stage: "reviewing",
    stageLabel: "Reviewing discovered company websites",
    resultSummary: null,
    resultCount: 0,
    failureMessage: null,
    employeeName: "Lead Hunter",
    employeeRole: "lead_hunter",
    conversationId: null,
    createdAt: "2026-10-21T06:00:00.000Z",
    startedAt: "2026-10-21T06:00:05.000Z",
    finishedAt: null,
    latestEvent: { message: "3 source pages reviewed", kind: "progress", createdAt: "2026-10-21T06:01:00.000Z" },
    ...overrides,
  };
}

const summary = { active: 1, waiting: 0, failed: 1, completedToday: 2 };

const reviewActions = [
  { capability: "proactive_review" as const, label: "On-demand operations review", description: "Read persisted records and recommend next actions.", employeeName: "Operations Manager", available: true, reason: null },
  { capability: "crm_quality_review" as const, label: "CRM quality review", description: "Review CRM data quality.", employeeName: "CRM Manager", available: false, reason: "CRM Manager needs an applied configuration first." },
];

const proactiveReport: ProactiveReportView = {
  id: "r1",
  kind: "alert",
  severity: "critical",
  title: "Operations Manager found 1 urgent signal",
  summary: "1 signal across 1 affected item.",
  sections: [{ key: "what_happened", title: "What happened", body: "A persisted integration is failing." }],
  findings: [{
    key: "integration_attention",
    severity: "critical",
    title: "One integration needs attention",
    detail: "A persisted connection is degraded.",
    count: 1,
    samples: ["ghl · error"],
    evidenceHref: "/settings/integrations",
    recommendedAction: "Inspect the connection before customer work.",
    requiresApproval: false,
  }],
  evidence: [{ label: "One integration needs attention", href: "/settings/integrations" }],
  metrics: [],
  actions: [],
  data: {},
  employeeName: "Operations Manager",
  employeeRole: "operations_manager",
  capability: "proactive_review",
  jobId: "job-1",
  jobStatus: "completed",
  status: "open",
  deliveryStatus: "delivered",
  deliveryReason: null,
  canCreateTask: true,
  createdAt: "2026-10-21T06:00:00.000Z",
  acknowledgedAt: null,
};

const activeMonitoring: MonitoringStatus = {
  state: "active",
  schedulesEnabled: 1,
  triggersEnabled: 0,
  schedulesOperatorEnabled: true,
  triggersOperatorEnabled: false,
  briefingsOperatorEnabled: false,
  lastVerifiedReportAt: "2026-10-21T06:00:00.000Z",
  byRole: [{ role: "operations_manager", schedules: 1, triggers: 0, enabled: 1 }],
};

describe("AI Work Board proactive reports", () => {
  it("shows an honest monitoring state and a real acknowledgement action", async () => {
    render(<WorkBoard jobs={[job()]} summary={summary} filter="all" reviewActions={reviewActions} schedules={[]} canManageSchedules={false} scheduleOperatorEnabled={false} triggers={[]} canManageTriggers={false} triggerOperatorEnabled={false} timeZone="UTC" focusJobId={null} reports={[proactiveReport]} monitoring={activeMonitoring} focusReportId="r1" />);
    expect(screen.getByText("Proactive watch")).toBeTruthy();
    expect(screen.getByText("Monitoring active")).toBeTruthy();
    expect(screen.getByText("Operations Manager found 1 urgent signal")).toBeTruthy();
    expect(screen.getAllByText("One integration needs attention").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("link", { name: /Open evidence/ }).getAttribute("href")).toBe("/settings/integrations");
    await userEvent.click(screen.getByRole("button", { name: /Acknowledge/ }));
    await waitFor(() => expect(acknowledgeReport).toHaveBeenCalledTimes(1));
  });

  it("does not imply continuous monitoring when no schedule is configured", () => {
    render(<WorkBoard jobs={[]} summary={summary} filter="all" reviewActions={reviewActions} schedules={[]} canManageSchedules={false} scheduleOperatorEnabled={false} triggers={[]} canManageTriggers={false} triggerOperatorEnabled={false} timeZone="UTC" focusJobId={null} reports={[]} monitoring={{ ...activeMonitoring, state: "not_configured", schedulesEnabled: 0, triggersEnabled: 0, byRole: [] }} />);
    expect(screen.getByText("No monitoring schedule")).toBeTruthy();
    expect(screen.getByText(/employees are not watching continuously/i)).toBeTruthy();
    expect(screen.getByText("No proactive reports yet")).toBeTruthy();
  });
});

describe("AI Work Board", () => {
  it("renders persisted status, stage and metrics without inventing progress", () => {
    render(<WorkBoard jobs={[job()]} summary={summary} filter="all" reviewActions={reviewActions} schedules={[]} canManageSchedules={false} scheduleOperatorEnabled={false} triggers={[]} canManageTriggers={false} triggerOperatorEnabled={false} timeZone="Asia/Manila" focusJobId={null} />);
    expect(screen.getByText("See the work, not a spinner.")).toBeTruthy();
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.getByText("Reviewing discovered company websites")).toBeTruthy();
    expect(screen.getByText(/3 source pages reviewed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Start review/ }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("combobox", { name: "Review to run" })).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it("starts a real on-demand review when access allows it", async () => {
    render(<WorkBoard jobs={[]} summary={summary} filter="all" reviewActions={reviewActions} schedules={[]} canManageSchedules={false} scheduleOperatorEnabled={false} triggers={[]} canManageTriggers={false} triggerOperatorEnabled={false} timeZone="Asia/Manila" focusJobId={null} />);
    await userEvent.click(screen.getByRole("button", { name: /Start review/ }));
    await waitFor(() => expect(startReview).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalled();
  });

  it("expands the real work panel and links filters correctly", () => {
    render(<WorkBoard jobs={[job()]} summary={summary} filter="all" reviewActions={reviewActions} schedules={[]} canManageSchedules={false} scheduleOperatorEnabled={false} triggers={[]} canManageTriggers={false} triggerOperatorEnabled={false} timeZone="Asia/Manila" focusJobId={null} />);
    expect(screen.getByRole("link", { name: "Needs attention" }).getAttribute("href")).toBe("/work?status=attention");
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    expect(screen.getByTestId("job-panel").textContent).toBe("job-1");
    fireEvent.click(screen.getByRole("button", { name: "Hide activity" }));
    expect(screen.queryByTestId("job-panel")).toBeNull();
  });

  it("disables a review whose employee is not available and explains why", () => {
    render(<WorkBoard jobs={[]} summary={summary} filter="all" reviewActions={[reviewActions[1]]} schedules={[]} canManageSchedules={false} scheduleOperatorEnabled={false} triggers={[]} canManageTriggers={false} triggerOperatorEnabled={false} timeZone="UTC" focusJobId={null} />);
    expect(screen.getByRole("button", { name: /Start review/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/CRM Manager needs an applied configuration first/)).toBeTruthy();
  });

  it("shows schedules with their real enabled state and pauses one through the audited action", async () => {
    const schedules: ScheduleView[] = [{
      id: "s1",
      capability: "proactive_review",
      capabilityLabel: "On-demand operations review",
      employeeRole: "operations_manager",
      employeeName: "Operations Manager",
      cadence: "daily",
      intervalMinutes: 1440,
      timezone: "UTC",
      businessHours: {},
      enabled: true,
      nextRunAt: "2026-10-22T07:00:00.000Z",
      lastRunAt: null,
      lastJobId: null,
      lastSkippedReason: null,
      lastSkippedAt: null,
      operatorEnabled: false,
    }];
    render(<WorkBoard jobs={[]} summary={summary} filter="all" reviewActions={reviewActions} schedules={schedules} canManageSchedules scheduleOperatorEnabled={false} triggers={[]} canManageTriggers={false} triggerOperatorEnabled={false} timeZone="UTC" focusJobId={null} />);
    expect(screen.getByText("Scheduled reviews")).toBeTruthy();
    expect(screen.getByText("Operator switch off")).toBeTruthy();
    expect(screen.getByText(/no schedule creates work even when its row is enabled/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("switch", { name: /Pause On-demand operations review schedule/ }));
    await waitFor(() => expect(setScheduleEnabledAction).toHaveBeenCalledWith("s1", false));
  });

  it("shows event triggers with their operator gate and pauses one through the audited action", async () => {
    const triggers: TriggerView[] = [{
      id: "tr1",
      eventType: "appointment.cancelled",
      capability: "appointment_review",
      capabilityLabel: "Appointment review",
      employeeRole: "appointment_setter",
      employeeName: "Appointment Setter",
      enabled: true,
      lastEventId: 42,
      lastJobId: null,
      operatorEnabled: false,
    }];
    render(<WorkBoard jobs={[]} summary={summary} filter="all" reviewActions={reviewActions} schedules={[]} canManageSchedules={false} scheduleOperatorEnabled={false} triggers={triggers} canManageTriggers triggerOperatorEnabled={false} timeZone="UTC" focusJobId={null} />);
    expect(screen.getByText("Event triggers")).toBeTruthy();
    expect(screen.getByText(/no event creates work even when its trigger is enabled/i)).toBeTruthy();
    expect(screen.getByText(/last event #42/)).toBeTruthy();
    await userEvent.click(screen.getByRole("switch", { name: /Pause Appointment cancelled trigger/ }));
    await waitFor(() => expect(setTriggerEnabledAction).toHaveBeenCalledWith("tr1", false));
  });

  it("shows a failed proactive review as failed and keeps its evidence reachable", () => {
    render(<WorkBoard
      jobs={[job({
        id: "job-2",
        capability: "proactive_review",
        title: "Weekly operations review",
        status: "failed",
        statusLabel: "Failed",
        stage: "failed",
        stageLabel: "Failed",
        employeeName: "Operations Manager",
        employeeRole: "operations_manager",
        failureMessage: "The worker stopped before the review completed.",
        latestEvent: null,
      })]}
      summary={summary}
      filter="attention"
      reviewActions={reviewActions}
      schedules={[]}
      canManageSchedules={false}
      scheduleOperatorEnabled={false}
      triggers={[]}
      canManageTriggers={false}
      triggerOperatorEnabled={false}
      timeZone="UTC"
      focusJobId={null}
    />);
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText(/worker stopped before the review completed/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Needs attention" }).getAttribute("aria-current")).toBe("page");
  });
});
