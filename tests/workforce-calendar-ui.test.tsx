// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkforceCalendar } from "@/components/work/workforce-calendar";
import { getWorkforceCalendarRange } from "@/lib/workforce-calendar-view";
import type { AgentRoleKey } from "@/lib/agents";
import type { WorkforceCalendarData } from "@/server/workforce/calendar";

vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>(function Link({ href, ...props }, ref) {
    return <a {...props} href={href} ref={ref} />;
  });
  return { default: Link };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const initialDateKey = "2027-03-14";
const range = getWorkforceCalendarRange(initialDateKey, "month");

function data(): WorkforceCalendarData {
  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    timezone: "America/New_York",
    operatorEnabled: false,
    jobs: [{
      id: "job-calendar-1",
      kind: "job",
      capability: "performance_snapshot",
      title: "Monthly performance review",
      status: "completed",
      statusLabel: "Completed",
      stage: "completed",
      stageLabel: "Report stored",
      resultSummary: "Seven verified measures were compared.",
      resultCount: 7,
      failureMessage: null,
      employeeName: "Performance Analyst",
      employeeRole: "performance_analyst" as AgentRoleKey,
      startsAt: "2027-03-14T14:30:00.000Z",
      createdAt: "2027-03-14T14:30:00.000Z",
      startedAt: "2027-03-14T14:30:02.000Z",
      finishedAt: "2027-03-14T14:31:00.000Z",
      source: "schedule",
      scheduleId: "schedule-calendar-1",
    }],
    jobsTruncated: false,
    schedules: [{
      id: "schedule-calendar-1",
      kind: "schedule",
      capability: "crm_quality_review",
      capabilityLabel: "CRM quality review",
      employeeName: "CRM Manager",
      employeeRole: "crm_manager" as AgentRoleKey,
      cadence: "daily",
      intervalMinutes: 1440,
      recurrenceRule: { kind: "daily", localTime: "09:00" },
      recurrenceInvalid: false,
      timezone: "America/New_York",
      timezoneValid: true,
      businessHours: {},
      enabled: false,
      nextRunAt: "2027-03-14T13:00:00.000Z",
      lastRunAt: "2027-03-13T13:00:00.000Z",
      lastJobId: "job-calendar-1",
      lastSkippedReason: null,
      lastSkippedAt: null,
      operatorEnabled: false,
    }],
  };
}

describe("workforce calendar UI", () => {
  it("renders scheduled occurrences separately from recorded jobs with workspace-local times", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<WorkforceCalendar initialData={data()} initialDateKey={initialDateKey} referenceTime="2027-03-15T14:00:00.000Z" canManageSchedules />);

    const occurrence = screen.getAllByRole("button", { name: /CRM quality review, CRM Manager, scheduled occurrence, not a job/ })[0];
    expect(occurrence).toBeTruthy();
    expect(occurrence.textContent).toContain("9:00 AM");
    expect(screen.getByText("Future occurrence · not a job")).toBeTruthy();
    expect(screen.getByText(/No job will be created from this occurrence/)).toBeTruthy();
    expect(screen.getByText("Schedule time zone")).toBeTruthy();
    expect(screen.getByText("Last actual run")).toBeTruthy();
    expect(screen.getByText("Next recurrence")).toBeTruthy();
    expect(screen.getByText("Mar 16, 2027, 9:00 AM")).toBeTruthy();
    expect(screen.getByText("Daily at 09:00 · America/New_York")).toBeTruthy();
    expect(screen.getByText("Business-hour window")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Edit schedule/ }).getAttribute("href")).toBe("/work?schedule=schedule-calendar-1#scheduled-work");
    expect(screen.getByRole("switch", { name: "Enable CRM quality review schedule" })).toBeTruthy();

    const jobEvent = screen.getAllByRole("button", { name: /Monthly performance review, Performance Analyst, Completed/ })[0];
    fireEvent.click(jobEvent);
    expect(screen.getByText("Recorded job")).toBeTruthy();
    expect(screen.getByText("Seven verified measures were compared.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open work details/ }).getAttribute("href")).toBe("/work?job=job-calendar-1");
  });

  it("filters schedule projections and persisted jobs by employee", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<WorkforceCalendar initialData={data()} initialDateKey={initialDateKey} referenceTime="2027-03-15T14:00:00.000Z" canManageSchedules={false} />);

    fireEvent.click(screen.getByRole("button", { name: "CRM Manager" }));
    expect(screen.getAllByText("CRM quality review").length).toBeGreaterThan(0);
    expect(screen.queryByText("Monthly performance review")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Performance Analyst" }));
    expect(screen.queryByText("CRM quality review")).toBeNull();
    expect(screen.getAllByText("Monthly performance review").length).toBeGreaterThan(0);
  });
});
