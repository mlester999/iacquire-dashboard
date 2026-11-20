// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { GrowthPartnerControlCenter } from "@/components/growth-partner/control-center";
import type { GrowthPartnerControlState } from "@/server/ai-growth-partner/service";
import type { BusinessBrain } from "@/lib/ai-growth-partner";
import { BUSINESS_BRAIN_SECTIONS } from "@/lib/ai-growth-partner";

const { refresh, saveGoal, toggleGoal, deleteMemory, saveMemory, updateMemory } = vi.hoisted(() => ({
  refresh: vi.fn(),
  saveGoal: vi.fn(),
  toggleGoal: vi.fn(),
  deleteMemory: vi.fn(),
  saveMemory: vi.fn(),
  updateMemory: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/actions/ai-growth-partner", () => ({
  prepareGrowthPartnerFromSubmittedOnboardingAction: vi.fn(),
  saveGrowthPartnerGoalAction: (...args: unknown[]) => saveGoal(...args),
  setGrowthPartnerGoalEnabledAction: (...args: unknown[]) => toggleGoal(...args),
  deleteGrowthPartnerMemoryAction: (...args: unknown[]) => deleteMemory(...args),
  saveGrowthPartnerMemoryAction: (...args: unknown[]) => saveMemory(...args),
  updateGrowthPartnerMemoryAction: (...args: unknown[]) => updateMemory(...args),
}));
vi.mock("@/components/workforce/safety-controls", () => ({ WorkforceSafetyControls: () => null }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const brain = {
  schemaVersion: 1,
  generatedAt: null,
  sections: Object.fromEntries(BUSINESS_BRAIN_SECTIONS.map((section) => [section, {}])),
} as BusinessBrain;

function partnerState(overrides: Partial<GrowthPartnerControlState> = {}): GrowthPartnerControlState {
  return {
    id: "partner-1",
    name: "AI Growth Partner",
    status: "configured",
    runtimeAgentInstanceId: "runtime-1",
    runtimeEnabled: true,
    runtimeStatus: "online",
    runtimeHealthOk: true,
    behaviorProfile: null,
    conversationId: "conversation-1",
    conversationLastMessageAt: null,
    currentVersion: null,
    currentBusinessBrain: null,
    draftVersion: null,
    draftBusinessBrain: null,
    versions: [],
    createdAt: new Date("2026-11-16T00:00:00.000Z"),
    updatedAt: new Date("2026-11-16T00:00:00.000Z"),
    ...overrides,
  };
}

function props(overrides: Partial<React.ComponentProps<typeof GrowthPartnerControlCenter>> = {}): React.ComponentProps<typeof GrowthPartnerControlCenter> {
  return {
    state: partnerState(),
    capabilityAccess: [],
    memories: [],
    goals: [],
    workSummary: { active: 0, waiting: 0, needsAttention: 0, completedToday: 0 },
    canManageMemory: true,
    canManageGoals: true,
    canConfigure: true,
    canConfigureResearch: false,
    researchSourcePolicies: { openstreetmap: null, company_website: null },
    legacyKnowledgeReview: { candidates: [], imports: [] },
    canOpenSetup: false,
    controlPermissions: { "agents.use": true, "agents.configure": true, "knowledge.view": true, "activity.view": true, "approvals.view": true },
    legacyProfilesPresent: false,
    hasSubmittedOnboarding: false,
    submittedAnswerCount: 0,
    timezone: "UTC",
    safetyControls: { messagingPaused: false, outboundPaused: false, agencyPaused: false, canPause: false },
    ...overrides,
  };
}

describe("Growth Partner Control Center states", () => {
  it.each([
    ["unlinked runtime", { runtimeAgentInstanceId: null, runtimeStatus: null, runtimeHealthOk: null }, "Not connected"],
    ["paused runtime", { runtimeEnabled: false, runtimeStatus: "online", runtimeHealthOk: true }, "Paused"],
    ["failed health", { runtimeStatus: "error", runtimeHealthOk: true }, "Needs attention"],
    ["negative health", { runtimeStatus: "online", runtimeHealthOk: false }, "Needs attention"],
    ["in setup", { runtimeStatus: "provisioning", runtimeHealthOk: null }, "Setting up"],
    ["healthy runtime", { runtimeStatus: "online", runtimeHealthOk: true }, "Online"],
    ["healthy runtime without an activated Business Brain", { status: "setup_required", runtimeStatus: "busy", runtimeHealthOk: true }, "Online"],
    ["runtime offline despite a prior health pass", { runtimeStatus: "offline", runtimeHealthOk: true }, "Needs attention"],
    ["migration holds a healthy runtime", { status: "migration_required" }, "Review migration"],
    ["unchecked runtime", { runtimeStatus: "online", runtimeHealthOk: null }, "Connection not checked yet"],
  ] as const)("labels the %s connection state truthfully", (_name, stateOverrides, expected) => {
    render(<GrowthPartnerControlCenter {...props({ state: partnerState(stateOverrides) })} />);
    const connection = screen.getByRole("group", { name: "Partner connection" });
    expect(within(connection).getByText(expected)).toBeTruthy();
  });

  it("uses the canonical Control Center names and the real memory and goals panels", () => {
    render(<GrowthPartnerControlCenter {...props()} />);
    expect(screen.getByRole("heading", { name: "Permanent Conversation" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Memory and Knowledge" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Goals" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Capability Access" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Activity and Approvals" })).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /Open Knowledge Center/ }).some((link) => link.getAttribute("href") === "/knowledge")).toBe(true);
    expect(screen.queryByText(/Hermes/i)).toBeNull();
    expect(screen.getByLabelText("Target count").className).toContain("sm:text-[16px]");
  });

  it("shows active, draft and absent Business Brain states", () => {
    const { rerender } = render(<GrowthPartnerControlCenter {...props({ state: partnerState({
      currentVersion: 1,
      currentBusinessBrain: brain,
      versions: [{ version: 1, source: "onboarding", createdBy: null, createdAt: new Date("2026-11-16T00:00:00.000Z"), active: true }],
    }) })} />);
    expect(screen.getByText(/Active Business Brain/)).toBeTruthy();
    expect(screen.getByText("Business Brain history")).toBeTruthy();

    rerender(<GrowthPartnerControlCenter {...props({ state: partnerState({ draftVersion: 2, draftBusinessBrain: brain }) })} />);
    expect(screen.getByText(/Draft Business Brain/)).toBeTruthy();

    rerender(<GrowthPartnerControlCenter {...props({ state: null })} />);
    expect(screen.getByText("The Business Brain is not prepared yet")).toBeTruthy();
  });

  it("explains paused and retained-profile states and filters shortcuts by permission", () => {
    render(<GrowthPartnerControlCenter {...props({
      state: partnerState({ status: "paused" }),
      legacyProfilesPresent: true,
      controlPermissions: { "agents.use": true, "activity.view": true, "approvals.view": false },
    })} />);
    expect(screen.getByText(/workspace still has enabled profiles from its previous setup/i)).toBeTruthy();
    expect(screen.getByText(/Safety controls above show whether workspace messaging is also paused/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Activity and Approvals" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Activity" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open Approvals" })).toBeNull();
  });

  it("labels migration review and displays a separate fallback for each failed optional read", () => {
    const { rerender } = render(<GrowthPartnerControlCenter {...props({ state: partnerState({ status: "migration_required" }) })} />);
    expect(screen.getByText("Review previous profiles")).toBeTruthy();

    rerender(<GrowthPartnerControlCenter {...props({
      state: partnerState(),
      canConfigureResearch: true,
      unavailable: {
        previousProfiles: true,
        submittedOnboarding: true,
        memories: true,
        capabilityAccess: true,
        goals: true,
        workSummary: true,
        researchSourcePolicies: true,
        legacyKnowledgeReview: true,
        controls: true,
      },
    })} />);
    expect(screen.getAllByText("Couldn't load this section.").length).toBeGreaterThanOrEqual(8);
    fireEvent.click(screen.getAllByRole("button", { name: "Try again" })[0]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
