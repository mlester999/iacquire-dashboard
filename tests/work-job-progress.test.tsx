// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkJobPanel, type WorkJob } from "@/components/work/job-progress";
import { createFindingTaskAction } from "@/app/actions/work";

vi.mock("@/app/actions/work", () => ({
  createFindingTaskAction: vi.fn(async () => ({ ok: true as const, data: { taskId: "task-1", created: true } })),
}));

vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>(function Link({ href, ...props }, ref) {
    return <a {...props} href={href} ref={ref} />;
  });
  return { default: Link, useLinkStatus: () => ({ pending: false }) };
});

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function job(overrides: Partial<WorkJob> = {}): WorkJob {
  return {
    id: "job-1",
    capability: "lead_research",
    title: "Find 20 real estate agencies in Miami",
    status: "running",
    statusLabel: "Working",
    recoveryPending: false,
    stage: "reviewing",
    stageLabel: "Reviewing discovered company websites",
    progress: { searches: 3, pagesReviewed: 7, candidates: 4 },
    result: {},
    resultSummary: null,
    resultCount: 0,
    failureCode: null,
    failureMessage: null,
    attempts: 1,
    cancelRequested: false,
    canCancel: true,
    canRetry: false,
    canCreateTask: false,
    conversationId: null,
    createdAt: "2026-10-20T10:00:00.000Z",
    startedAt: "2026-10-20T10:00:05.000Z",
    finishedAt: null,
    elapsedMs: 42_000,
    events: [
      { id: "1", kind: "stage", stage: "searching", stageLabel: "Searching approved public sources", message: "Searching approved business sources…", createdAt: "2026-10-20T10:00:10.000Z" },
      { id: "2", kind: "progress", stage: null, stageLabel: null, message: "3 search queries completed · 7 source pages reviewed", createdAt: "2026-10-20T10:00:40.000Z" },
      { id: "3", kind: "stage", stage: "reviewing", stageLabel: "Reviewing discovered company websites", message: "Reviewing discovered company websites…", createdAt: "2026-10-20T10:00:45.000Z" },
    ],
    ...overrides,
  };
}

function stubJob(value: WorkJob) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ job: value }), { status: 200, headers: { "content-type": "application/json" } })));
}

describe("WorkJobPanel", () => {
  it("renders only recorded stages, counts and elapsed time", async () => {
    stubJob(job());
    render(<WorkJobPanel jobId="job-1" />);
    expect(await screen.findByText("Find 20 real estate agencies in Miami")).toBeTruthy();
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.getByText("Reviewing discovered company websites")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByText(/42s elapsed/)).toBeTruthy();
    expect(screen.getByText(/completion time is uncertain/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Stop/ })).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.getByText(/Read-only research/i)).toBeTruthy();
  });

  it("shows a completed job with its real evidence and review link", async () => {
    stubJob(job({
      status: "completed",
      statusLabel: "Completed",
      stage: "completed",
      stageLabel: "Completed",
      resultCount: 12,
      resultSummary: "Research completed. 12 leads prepared for review.",
      canCancel: false,
      finishedAt: "2026-10-20T10:03:00.000Z",
      elapsedMs: 175_000,
      events: [
        { id: "4", kind: "progress", stage: null, stageLabel: null, message: "12 candidates extracted: 9 evidence-backed, 2 need more evidence, 1 duplicate flagged.", createdAt: "2026-10-20T10:02:50.000Z" },
      ],
    }));
    render(<WorkJobPanel jobId="job-1" />);
    expect(await screen.findByText("Research completed. 12 leads prepared for review.")).toBeTruthy();
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(screen.getByText(/2m 55s/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Review 12 leads/ }).getAttribute("href")).toBe("/leads?tab=review");
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
  });

  it("shows a failed job as failed without claiming success", async () => {
    stubJob(job({
      status: "failed",
      statusLabel: "Failed",
      stage: "failed",
      stageLabel: "Failed",
      failureMessage: "The Lead Hunter's Hermes connection is unavailable, so no research was started.",
      canCancel: false,
      canRetry: true,
    }));
    render(<WorkJobPanel jobId="job-1" />);
    expect(await screen.findByText(/connection is unavailable/i)).toBeTruthy();
    expect(screen.getByText(/Nothing was reported as successful/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeTruthy();
    expect(screen.queryByText(/Saved with execution evidence/i)).toBeNull();
  });

  it("shows real bookable availability returned by the job", async () => {
    stubJob(job({
      capability: "appointment_availability",
      status: "completed",
      statusLabel: "Completed",
      stage: "completed",
      stageLabel: "Completed",
      resultCount: 2,
      resultSummary: "Calendar availability checked: 2 bookable slots in the next 7 days (UTC).",
      canCancel: false,
      result: {
        availability: {
          slots: [
            { start: "2026-10-22T14:00:00.000Z", end: "2026-10-22T14:30:00.000Z" },
            { start: "2026-10-22T15:00:00.000Z", end: "2026-10-22T15:30:00.000Z" },
          ],
          timeZone: "UTC",
        },
        metrics: [{ key: "available_slots", label: "Bookable slots (7 days)", value: 2, period: "Next 7 days", definition: "Distinct start times", source: "crm_calendars" }],
        findings: [],
      },
      events: [],
    }));
    render(<WorkJobPanel jobId="job-1" />);
    expect(await screen.findByText("Real bookable availability")).toBeTruthy();
    expect(screen.getAllByText(/2:00 PM|3:00 PM/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Nothing has been held or booked/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open appointments/i }).getAttribute("href")).toBe("/appointments");
  });

  it("shows a measured comparison period without treating every increase as good", async () => {
    stubJob(job({
      status: "completed",
      statusLabel: "Completed",
      stage: "completed",
      stageLabel: "Completed",
      resultSummary: "Performance review completed.",
      canCancel: false,
      result: {
        metrics: [
          { key: "leads_created", label: "Leads created", value: 3, previous: 2, change: 1, changePct: 50, trend: "up", comparisonPeriod: "Previous 30 days", higherIsBetter: true, period: "Last 30 days", definition: "Lead rows", source: "leads" },
          { key: "ai_runs_failed", label: "AI runs failed", value: 3, previous: 2, change: 1, changePct: 50, trend: "up", comparisonPeriod: "Previous 30 days", higherIsBetter: false, period: "Last 30 days", definition: "Failed runs", source: "agent_runs" },
        ],
        findings: [],
      },
      events: [],
    }));
    render(<WorkJobPanel jobId="job-1" />);
    expect(await screen.findByText(/Leads created/)).toBeTruthy();
    const trends = screen.getAllByText(/↑ 50% vs previous 30 days/);
    expect(trends).toHaveLength(2);
    expect(trends.some((element) => element.className.includes("text-success-ink"))).toBe(true);
    expect(trends.some((element) => element.className.includes("text-warning-ink"))).toBe(true);
  });

  it("turns a completed finding into an assigned follow-up task through the real action", async () => {
    stubJob(job({
      status: "completed",
      statusLabel: "Completed",
      stage: "completed",
      stageLabel: "Completed",
      canCancel: false,
      canCreateTask: true,
      resultSummary: "CRM quality review found one signal.",
      result: {
        findings: [{
          key: "companies_missing_web",
          severity: "warning",
          title: "2 companies have no domain or website",
          detail: "Without a domain, duplicate detection is weaker.",
          count: 2,
          samples: ["No Web Co"],
          evidenceHref: "/crm/companies",
          recommendedAction: "Add the verified official domain or website.",
        }],
      },
      events: [],
    }));
    render(<WorkJobPanel jobId="job-1" />);
    await userEvent.click(await screen.findByRole("button", { name: /Create follow-up task/ }));
    await waitFor(() => expect(createFindingTaskAction).toHaveBeenCalledWith("job-1", "companies_missing_web"));
    expect(await screen.findByText("Task created")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Task created/ }).getAttribute("href")).toBe("/crm/tasks?task=task-1");
  });

  it("does not invent progress when only a queued state is persisted", async () => {
    stubJob(job({
      status: "queued",
      statusLabel: "Queued",
      stage: null,
      stageLabel: null,
      progress: {},
      events: [],
      elapsedMs: 0,
      canCancel: true,
    }));
    render(<WorkJobPanel jobId="job-1" />);
    expect(await screen.findByText(/Queued. The worker has not started this work yet./i)).toBeTruthy();
    expect(screen.queryByText(/search queries/i)).toBeNull();
    expect(screen.queryByText(/source pages reviewed/i)).toBeNull();
  });

  it("shows a lost lease as awaiting recovery without a running indicator or elapsed claim", async () => {
    stubJob(job({
      recoveryPending: true,
      statusLabel: "Recovery pending",
      elapsedMs: 42 * 60 * 1000,
    }));
    render(<WorkJobPanel jobId="job-1" />);
    expect(await screen.findByText("Recovery pending")).toBeTruthy();
    expect(screen.getByText(/waiting for recovery; no completion has been recorded/i)).toBeTruthy();
    expect(screen.queryByText(/completion time is uncertain/i)).toBeNull();
    expect(screen.queryByText(/42m elapsed/)).toBeNull();
    expect(screen.queryByText("Working")).toBeNull();
  });
});
