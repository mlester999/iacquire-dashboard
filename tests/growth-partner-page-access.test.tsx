// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  requireOrgContext: vi.fn(),
  redirect: vi.fn(),
  getControlState: vi.fn(),
  listLegacyKnowledge: vi.fn(),
  getCapabilityAccess: vi.fn(),
  getAbilityControls: vi.fn(),
  listMemories: vi.fn(),
  listGoals: vi.fn(),
  getSubmittedBrainSource: vi.fn(),
  listAgents: vi.fn(),
  withUser: vi.fn(),
  getControlStateForDb: vi.fn(),
  getResearchSourcePolicy: vi.fn(),
  workBoardSummary: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/server/tenancy/context", () => ({ requireOrgContext: mocks.requireOrgContext }));
vi.mock("@/server/ai-growth-partner/service", () => ({ getGrowthPartnerControlState: mocks.getControlState }));
vi.mock("@/server/ai-growth-partner/legacy-knowledge", () => ({ listGrowthPartnerLegacyKnowledge: mocks.listLegacyKnowledge }));
vi.mock("@/server/ai-growth-partner/capability-access", () => ({ getGrowthPartnerCapabilityAccess: mocks.getCapabilityAccess }));
vi.mock("@/server/ai-growth-partner/ability-controls", () => ({ getGrowthPartnerAbilityControls: mocks.getAbilityControls }));
vi.mock("@/server/ai-growth-partner/memory", () => ({ listGrowthPartnerMemories: mocks.listMemories }));
vi.mock("@/server/ai-growth-partner/goals", () => ({ listGrowthPartnerGoalProgress: mocks.listGoals }));
vi.mock("@/server/onboarding/submitted-brain-source", () => ({ getSubmittedBrainSource: mocks.getSubmittedBrainSource }));
vi.mock("@/server/workforce/service", () => ({ listAgents: mocks.listAgents }));
vi.mock("@/server/db", () => ({ withUser: mocks.withUser }));
vi.mock("@/server/automation/controls", () => ({ getControlState: mocks.getControlStateForDb }));
vi.mock("@/server/leads/research-source-policy", () => ({ getResearchSourcePolicy: mocks.getResearchSourcePolicy }));
vi.mock("@/server/workforce/work-board", () => ({ workBoardSummary: mocks.workBoardSummary }));
vi.mock("@/server/billing/clearance", () => ({ isSetupPaymentClearedFor: async () => true }));
vi.mock("@/components/growth-partner/control-center", () => ({ GrowthPartnerControlCenter: () => null }));
vi.mock("@/components/workforce/gallery", () => ({ WorkforceGallery: () => null }));
vi.mock("@/components/workforce/safety-controls", () => ({ WorkforceSafetyControls: () => null }));

import GrowthPartnerPage from "@/app/(portal)/growth-partner/page";
import WorkforcePage from "@/app/(portal)/employees/page";
import { resetEnvCache } from "@/server/env";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  resetEnvCache();
});

function context(canUsePartner: boolean, canConfigure = true) {
  return {
    org: { kind: "client", orgId: "org-1", timezone: "UTC" },
    user: { id: "member-1", platformRole: "client_owner" },
    can: (permission: string) => permission === "agents.use" ? canUsePartner : permission === "agents.configure" ? canConfigure : true,
  };
}

describe("Growth Partner page access and optional reads", () => {
  beforeEach(() => {
    mocks.requireOrgContext.mockResolvedValue(context(true));
    mocks.getControlState.mockResolvedValue(null);
    mocks.listLegacyKnowledge.mockResolvedValue({ candidates: [], imports: [] });
    mocks.getCapabilityAccess.mockResolvedValue([]);
    mocks.getAbilityControls.mockResolvedValue({ state: "setup_required" });
    mocks.listMemories.mockResolvedValue([]);
    mocks.listGoals.mockResolvedValue([]);
    mocks.getSubmittedBrainSource.mockResolvedValue(null);
    mocks.listAgents.mockResolvedValue([]);
    mocks.withUser.mockImplementation(async (_userId: string, operation: (db: unknown) => unknown) => operation({ query: vi.fn() }));
    mocks.getControlStateForDb.mockResolvedValue({ pauses: { messaging: { active: false }, outbound: { active: false }, agency: { active: false } } });
    mocks.getResearchSourcePolicy.mockResolvedValue(null);
    mocks.workBoardSummary.mockResolvedValue({ active: 0, waiting: 0, needsAttention: 0, completedToday: 0 });
  });

  it.each([false, true])("forwards the outbound master switch to both safety views (%s)", async (enabled) => {
    vi.stubEnv("OUTBOUND_MESSAGING_ENABLED", String(enabled));
    resetEnvCache();
    mocks.withUser.mockImplementation(async (_userId: string, operation: (db: unknown) => unknown) => operation({ query: async () => ({ rows: [] }) }));
    mocks.listAgents.mockResolvedValue([{ enabled: true }]);

    const overview = await GrowthPartnerPage() as React.ReactElement<{ safetyControls: { outboundMessagingEnabled: boolean } }>;
    const legacy = await WorkforcePage() as React.ReactElement<{ children: React.ReactElement<{ outboundMessagingEnabled: boolean }>[] }>;

    expect(overview.props.safetyControls.outboundMessagingEnabled).toBe(enabled);
    expect(legacy.props.children[0].props.outboundMessagingEnabled).toBe(enabled);
  });

  it("renders a no-access card before calling partner services", async () => {
    mocks.requireOrgContext.mockResolvedValue(context(false));

    const page = await GrowthPartnerPage();
    render(page as React.ReactElement);

    expect(screen.getByRole("heading", { name: "AI Growth Partner access needed" })).toBeTruthy();
    expect(mocks.getControlState).not.toHaveBeenCalled();
    expect(mocks.getAbilityControls).not.toHaveBeenCalled();
    expect(mocks.listAgents).not.toHaveBeenCalled();
    expect(mocks.listMemories).not.toHaveBeenCalled();
    expect(mocks.workBoardSummary).not.toHaveBeenCalled();
  });

  it("reads editor data only for members with configuration permission", async () => {
    mocks.requireOrgContext.mockResolvedValue(context(true, false));
    const page = await GrowthPartnerPage() as React.ReactElement<{ abilityControls: unknown }>;
    expect(mocks.getCapabilityAccess).toHaveBeenCalled();
    expect(mocks.getAbilityControls).not.toHaveBeenCalled();
    expect(page.props.abilityControls).toBeNull();
  });

  it("keeps the page available and marks each failed optional read for its section", async () => {
    mocks.getControlState.mockResolvedValue({
      id: "partner-1",
      status: "setup_required",
      runtimeAgentInstanceId: null,
      runtimeEnabled: null,
    });
    mocks.listAgents.mockRejectedValue(new Error("agent read failed"));
    mocks.listMemories.mockRejectedValue(new Error("memory read failed"));
    mocks.getCapabilityAccess.mockRejectedValue(new Error("capability read failed"));
    mocks.getAbilityControls.mockRejectedValue(new Error("ability read failed"));
    mocks.listGoals.mockRejectedValue(new Error("goal read failed"));
    mocks.getSubmittedBrainSource.mockRejectedValue(new Error("setup answer read failed"));
    mocks.getControlStateForDb.mockRejectedValue(new Error("controls read failed"));
    mocks.getResearchSourcePolicy.mockRejectedValue(new Error("research policy read failed"));
    mocks.listLegacyKnowledge.mockRejectedValue(new Error("legacy knowledge read failed"));
    mocks.workBoardSummary.mockRejectedValue(new Error("work summary read failed"));

    const page = await GrowthPartnerPage() as React.ReactElement<{ unavailable: Record<string, boolean> }>;

    expect(page.props.unavailable).toEqual({
      previousProfiles: true,
      submittedOnboarding: true,
      memories: true,
      capabilityAccess: true,
      abilityControls: true,
      goals: true,
      workSummary: true,
      researchSourcePolicies: true,
      legacyKnowledgeReview: true,
      controls: true,
    });
  });
});
