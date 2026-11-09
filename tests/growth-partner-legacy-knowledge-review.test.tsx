// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GrowthPartnerLegacyKnowledgeReview } from "@/components/growth-partner/legacy-knowledge-review";
import {
  importGrowthPartnerLegacyKnowledgeAction,
  previewGrowthPartnerLegacyKnowledgeAction,
  reviewGrowthPartnerLegacyKnowledgeAction,
} from "@/app/actions/ai-growth-partner";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/actions/ai-growth-partner", () => ({
  importGrowthPartnerLegacyKnowledgeAction: vi.fn(),
  previewGrowthPartnerLegacyKnowledgeAction: vi.fn(),
  reviewGrowthPartnerLegacyKnowledgeAction: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Growth Partner retained knowledge review panel", () => {
  it("previews a source before creating a review-only snapshot", async () => {
    vi.mocked(previewGrowthPartnerLegacyKnowledgeAction).mockResolvedValue({
      ok: true,
      data: { title: "Lead Discovery & Qualification · Storm response", content: "Route active leaks to the service manager.", status: "available" },
    });
    vi.mocked(importGrowthPartnerLegacyKnowledgeAction).mockResolvedValue({
      ok: true,
      data: { imported: 1, alreadyPresent: 0 },
    });
    const candidate = {
      sourceType: "employee_note" as const,
      sourceId: "6d99405e-13f4-4f0b-b036-fc1eaa92a146",
      sourceVersion: "3",
      title: "Storm response",
      roleLabel: "Lead Discovery & Qualification",
      updatedAt: "2026-11-07T00:00:00.000Z",
      preview: "Route active leaks...",
    };
    render(<GrowthPartnerLegacyKnowledgeReview data={{ candidates: [candidate], imports: [] }} />);
    expect(screen.getByText(/Previous profile records are grouped by the capability/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /preview/i }));
    await screen.findByText("Route active leaks to the service manager.");
    fireEvent.click(screen.getByRole("button", { name: /add to review queue/i }));

    await waitFor(() => expect(importGrowthPartnerLegacyKnowledgeAction).toHaveBeenCalledWith({
      sources: [{ sourceType: "employee_note", sourceId: candidate.sourceId, sourceVersion: "3" }],
    }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.getByRole("status").textContent).toContain("original profile record is unchanged");
  });

  it("requires an explicit decision before an imported snapshot enters Partner context", async () => {
    vi.mocked(previewGrowthPartnerLegacyKnowledgeAction).mockResolvedValue({
      ok: true,
      data: { title: "Service guide.txt", content: "Use the inspection checklist.", status: "pending_review" },
    });
    vi.mocked(reviewGrowthPartnerLegacyKnowledgeAction).mockResolvedValue({
      ok: true,
      data: { status: "approved", changed: true },
    });
    const item = {
      id: "94d70c9b-a1f0-4725-9f84-a7f2306e5036",
      sourceType: "reference_document" as const,
      sourceId: "6d99405e-13f4-4f0b-b036-fc1eaa92a146",
      sourceVersion: "2026-11-07T00:00:00.000Z",
      roleLabel: "Operations Manager",
      title: "Service guide.txt",
      status: "pending_review" as const,
      createdAt: "2026-11-07T00:00:00.000Z",
      reviewedAt: null,
    };
    render(<GrowthPartnerLegacyKnowledgeReview data={{ candidates: [], imports: [item] }} />);

    fireEvent.click(screen.getByRole("button", { name: /review/i }));
    await screen.findByText("Use the inspection checklist.");
    expect(screen.getByText("Review each snapshot before approval.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /approve for partner/i }));

    await waitFor(() => expect(reviewGrowthPartnerLegacyKnowledgeAction).toHaveBeenCalledWith({ importId: item.id, status: "approved" }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.getByRole("status").textContent).toContain("available to the Growth Partner");
  });
});
