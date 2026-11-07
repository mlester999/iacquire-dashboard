// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GrowthPartnerGoalsPanel } from "@/components/growth-partner/goals-panel";
import type { GrowthPartnerGoalProgress } from "@/lib/ai-growth-partner-goals";

const { refresh, save, toggle } = vi.hoisted(() => ({ refresh: vi.fn(), save: vi.fn(), toggle: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/actions/ai-growth-partner", () => ({
  saveGrowthPartnerGoalAction: (...args: unknown[]) => save(...args),
  setGrowthPartnerGoalEnabledAction: (...args: unknown[]) => toggle(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const goal: GrowthPartnerGoalProgress = {
  id: "00000000-0000-4000-8000-000000000013",
  metric: "leads_approved",
  metricLabel: "Leads approved",
  cadence: "weekly",
  targetValue: 5,
  enabled: true,
  revision: 2,
  updatedAt: new Date("2026-11-07T00:00:00.000Z"),
  actualValue: 2,
  percentComplete: 40,
  remainingValue: 3,
  periodLabel: "This week",
  canViewProgress: true,
};

describe("Growth Partner goals panel", () => {
  it("shows real progress and clearly labels targets as objectives", () => {
    render(<GrowthPartnerGoalsPanel goals={[goal]} canManage hasPartner />);
    expect(screen.getByRole("heading", { name: "Growth goals" })).toBeTruthy();
    expect(screen.getByText("2 of 5 · this week")).toBeTruthy();
    expect(screen.getByText("3 to go")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Leads approved weekly target progress" }).getAttribute("aria-valuenow")).toBe("2");
    expect(screen.getByText(/Targets, not guarantees/)).toBeTruthy();
  });

  it("saves a selected target with its latest revision and refreshes the persisted view", async () => {
    save.mockResolvedValue({ ok: true, data: { id: goal.id, revision: 3 } });
    render(<GrowthPartnerGoalsPanel goals={[goal]} canManage hasPartner />);
    fireEvent.change(screen.getByLabelText("Target count"), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: "Update target" }));
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith({ metric: "leads_approved", cadence: "weekly", targetValue: 9, baseRevision: 2 }));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("keeps the target read-only for workspace members without configuration access", () => {
    render(<GrowthPartnerGoalsPanel goals={[goal]} canManage={false} hasPartner />);
    expect(screen.queryByRole("button", { name: /pause target/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /save target|update target/i })).toBeNull();
    expect(screen.getByText(/Only workspace owners and admins can set or pause goals/)).toBeTruthy();
  });
});
