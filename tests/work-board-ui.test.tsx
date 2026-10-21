// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { WorkBoard } from "@/components/work/work-board";
import type { WorkBoardJob } from "@/server/workforce/work-board";

const startReview = vi.fn(async () => ({ ok: true as const, data: { jobId: "job-new", agentId: "agent-1" } }));
vi.mock("@/app/actions/work", () => ({ startProactiveReviewAction: () => startReview() }));
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

describe("AI Work Board", () => {
  it("renders persisted status, stage and metrics without inventing progress", () => {
    render(<WorkBoard jobs={[job()]} summary={summary} filter="all" canStartReview={false} reviewBlockedReason="Operations review requires workspace activity access." operationsManagerName="Operations Manager" timeZone="Asia/Manila" focusJobId={null} />);
    expect(screen.getByText("See the work, not a spinner.")).toBeTruthy();
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.getByText("Reviewing discovered company websites")).toBeTruthy();
    expect(screen.getByText(/3 source pages reviewed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Run operations review/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Operations review requires workspace activity access.")).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it("starts a real on-demand review when access allows it", async () => {
    render(<WorkBoard jobs={[]} summary={summary} filter="all" canStartReview reviewBlockedReason={null} operationsManagerName="Operations Manager" timeZone="Asia/Manila" focusJobId={null} />);
    await userEvent.click(screen.getByRole("button", { name: /Run operations review/ }));
    await waitFor(() => expect(startReview).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalled();
  });

  it("expands the real work panel and links filters correctly", () => {
    render(<WorkBoard jobs={[job()]} summary={summary} filter="all" canStartReview={false} reviewBlockedReason={null} operationsManagerName="Operations Manager" timeZone="Asia/Manila" focusJobId={null} />);
    expect(screen.getByRole("link", { name: "Needs attention" }).getAttribute("href")).toBe("/work?status=attention");
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    expect(screen.getByTestId("job-panel").textContent).toBe("job-1");
    fireEvent.click(screen.getByRole("button", { name: "Hide activity" }));
    expect(screen.queryByTestId("job-panel")).toBeNull();
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
      canStartReview={false}
      reviewBlockedReason={null}
      operationsManagerName="Operations Manager"
      timeZone="UTC"
      focusJobId={null}
    />);
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText(/worker stopped before the review completed/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Needs attention" }).getAttribute("aria-current")).toBe("page");
  });
});
