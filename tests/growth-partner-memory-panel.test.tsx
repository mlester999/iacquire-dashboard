// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GrowthPartnerMemoryPanel } from "@/components/growth-partner/memory-panel";
import type { GrowthPartnerMemory } from "@/lib/ai-growth-partner-memory";
import {
  deleteGrowthPartnerMemoryAction,
  saveGrowthPartnerMemoryAction,
  updateGrowthPartnerMemoryAction,
} from "@/app/actions/ai-growth-partner";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/actions/ai-growth-partner", () => ({
  deleteGrowthPartnerMemoryAction: vi.fn(),
  saveGrowthPartnerMemoryAction: vi.fn(),
  updateGrowthPartnerMemoryAction: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const note: GrowthPartnerMemory = {
  id: "0a31f2cc-9418-4a43-81c3-2854144f1022",
  kind: "preference",
  content: "Keep progress notes concise.",
  revision: 2,
  createdAt: new Date("2026-11-05T00:00:00.000Z"),
  updatedAt: new Date("2026-11-05T00:00:00.000Z"),
};

describe("Growth Partner memory controls", () => {
  it("shows the app-memory distinction and lets workspace admins save a note", async () => {
    vi.mocked(saveGrowthPartnerMemoryAction).mockResolvedValue({
      ok: true,
      data: { id: note.id, revision: 1, duplicate: false },
    });
    render(<GrowthPartnerMemoryPanel memories={[]} canManage hasPartner timezone="UTC" />);

    expect(screen.getByText(/separate from Hermes runtime memory/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Add a note/ }));
    fireEvent.change(screen.getByLabelText("Saved note"), { target: { value: "Keep weekly reports concise." } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() => expect(saveGrowthPartnerMemoryAction).toHaveBeenCalledWith({
      kind: "working_context",
      content: "Keep weekly reports concise.",
    }));
    expect(screen.getByRole("status").textContent).toContain("Workspace memory saved");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("supports revision-aware correction and removal and renders saved notes read-only to members", async () => {
    vi.mocked(updateGrowthPartnerMemoryAction).mockResolvedValue({ ok: true, data: { id: note.id, revision: 3 } });
    vi.mocked(deleteGrowthPartnerMemoryAction).mockResolvedValue({ ok: true, data: { deleted: true } });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { rerender } = render(<GrowthPartnerMemoryPanel memories={[note]} canManage hasPartner timezone="UTC" />);

    fireEvent.click(screen.getByRole("button", { name: /Correct/ }));
    fireEvent.change(screen.getByLabelText("Saved note"), { target: { value: "Keep reports concise and weekly." } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(updateGrowthPartnerMemoryAction).toHaveBeenCalledWith({
      memoryId: note.id,
      baseRevision: note.revision,
      kind: note.kind,
      content: "Keep reports concise and weekly.",
    }));

    fireEvent.click(screen.getByRole("button", { name: /Remove/ }));
    await waitFor(() => expect(deleteGrowthPartnerMemoryAction).toHaveBeenCalledWith({
      memoryId: note.id,
      baseRevision: note.revision,
    }));

    rerender(<GrowthPartnerMemoryPanel memories={[note]} canManage={false} hasPartner timezone="UTC" />);
    expect(screen.getByText(note.content)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Correct/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
  });
});
