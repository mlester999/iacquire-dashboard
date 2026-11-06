// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BusinessBrainDraftReview } from "@/components/growth-partner/brain-draft-review";
import { activateGrowthPartnerBusinessBrainVersionAction } from "@/app/actions/ai-growth-partner";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/actions/ai-growth-partner", () => ({ activateGrowthPartnerBusinessBrainVersionAction: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Business Brain draft review", () => {
  it("requires explicit confirmation and activates with the version that was reviewed", async () => {
    vi.mocked(activateGrowthPartnerBusinessBrainVersionAction).mockResolvedValue({
      ok: true,
      data: { version: 4, activated: true, alreadyActive: false },
    });
    render(<BusinessBrainDraftReview version={4} currentVersion={3} />);

    fireEvent.click(screen.getByRole("button", { name: "Review and apply version 4" }));
    expect(screen.getByRole("dialog").textContent).toContain("changes the confirmed business facts");
    expect(activateGrowthPartnerBusinessBrainVersionAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Apply version 4" }));
    await waitFor(() => expect(activateGrowthPartnerBusinessBrainVersionAction).toHaveBeenCalledWith({
      expectedCurrentVersion: 3,
      version: 4,
    }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps the review open and reports a stale-version response", async () => {
    vi.mocked(activateGrowthPartnerBusinessBrainVersionAction).mockResolvedValue({
      ok: false,
      error: "The active Business Brain changed in another session.",
      code: "conflict",
    });
    render(<BusinessBrainDraftReview version={4} currentVersion={3} />);

    fireEvent.click(screen.getByRole("button", { name: "Review and apply version 4" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply version 4" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("changed in another session");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });
});
