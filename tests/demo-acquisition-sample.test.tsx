
// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcquisitionSample } from "@/components/demo/showroom/views/acquisition-sample";
import { scenarioFor } from "@/lib/demo/showroom/industry";

const scenario = scenarioFor("ecommerce");

afterEach(cleanup);
afterEach(vi.unstubAllGlobals);

describe("sample acquisition journey", () => {
  it("qualifies a fixture, waits for approval, then updates the simulated CRM, Work Board, and summary", async () => {
    const user = userEvent.setup();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<AcquisitionSample scenario={scenario} />);

    expect(screen.getByText("Simulation")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Sample CRM" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Discover a sample prospect" }));
    expect(screen.getByRole("status").textContent).toContain("Review the evidence");
    expect(screen.getByText(scenario.lead)).toBeTruthy();
    expect(screen.getByText(/Appointment preference is unknown/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Sample CRM" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Approve and add to sample CRM" }));
    expect(screen.getByRole("status").textContent).toContain("A follow-up task is planned.");
    expect(within(screen.getByRole("region", { name: "Sample CRM" })).getByText(scenario.lead + " · Qualified")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Prepare sample follow-up" }));
    const board = within(screen.getByRole("region", { name: "Sample AI Work Board" }));
    expect(board.getByText("Follow-up · Awaiting approval")).toBeTruthy();
    expect(board.getByText(/Thanks for your interest/)).toBeTruthy();
    expect(screen.getByText(/1 approved lead · 1 follow-up draft · 0 messages sent/)).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps rejected prospects out of CRM and resets the simulation for another run", async () => {
    const user = userEvent.setup();
    render(<AcquisitionSample scenario={scenario} />);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Discover a sample prospect" }));
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("status"));
    await user.click(screen.getByRole("button", { name: "Reject sample prospect" }));
    expect(screen.getByRole("status").textContent).toContain("No contact or follow-up task was created.");
    expect(screen.queryByRole("button", { name: "Approve and add to sample CRM" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Sample CRM" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Sample AI Work Board" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Restart simulation" }));
    expect(screen.getByRole("button", { name: "Discover a sample prospect" })).toBeTruthy();
    expect(screen.queryByText("Simulation summary")).toBeNull();
  });
});
