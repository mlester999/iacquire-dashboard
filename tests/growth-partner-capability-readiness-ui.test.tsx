// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { GrowthPartnerControlCenter } from "@/components/growth-partner/control-center";
import { deriveGrowthPartnerCapabilityAccess } from "@/lib/ai-growth-partner-capability-access";
import { ROLE_ABILITIES } from "@/lib/employee-tool-policy";
import type { GrowthPartnerControlState } from "@/server/ai-growth-partner/service";

vi.mock("@/app/actions/ai-growth-partner", () => ({ prepareGrowthPartnerFromSubmittedOnboardingAction: vi.fn() }));
vi.mock("@/components/growth-partner/memory-panel", () => ({ GrowthPartnerMemoryPanel: () => null }));
vi.mock("@/components/growth-partner/goals-panel", () => ({ GrowthPartnerGoalsPanel: () => null }));
vi.mock("@/components/growth-partner/legacy-knowledge-review", () => ({ GrowthPartnerLegacyKnowledgeReview: () => null }));
vi.mock("@/components/workforce/safety-controls", () => ({ WorkforceSafetyControls: () => null }));

afterEach(cleanup);

describe("Growth Partner capability readiness UI", () => {
  it("shows each skill's actual access state inside the one six-domain control center", () => {
    const capabilityAccess = deriveGrowthPartnerCapabilityAccess({
      partnerExists: true,
      runtimeAgentId: "growth-partner-runtime",
      runtimeReady: true,
      can: (permission) => permission !== "inbox.reply",
      activeAbilities: new Set(ROLE_ABILITIES.growth_partner),
    });
    const { container } = render(<GrowthPartnerControlCenter
      state={null}
      capabilityAccess={capabilityAccess}
      memories={[]}
      goals={[]}
      workSummary={{ active: 2, waiting: 1, needsAttention: 3, completedToday: 5 }}
      canManageMemory={false}
      canManageGoals={false}
      canConfigure={false}
      canConfigureResearch={false}
      researchSourcePolicies={{ openstreetmap: null, company_website: null }}
      legacyKnowledgeReview={{ candidates: [], imports: [] }}
      canOpenSetup={false}
      controlPermissions={{}}
      legacyProfilesPresent={false}
      hasSubmittedOnboarding={false}
      submittedAnswerCount={0}
      timezone="America/New_York"
      safetyControls={{ messagingPaused: false, outboundPaused: false, agencyPaused: false, canPause: false }}
    />);

    expect(screen.getByRole("heading", { name: "One partner, six capabilities" })).toBeTruthy();
    const salesDomain = container.querySelector('[data-capability-domain="sales"]');
    expect(salesDomain).toBeTruthy();
    expect(within(salesDomain as HTMLElement).getByText("Sales follow-up drafts")).toBeTruthy();
    expect(within(salesDomain as HTMLElement).getByText("Your access needed")).toBeTruthy();
    expect(within(salesDomain as HTMLElement).getByText("Pipeline review")).toBeTruthy();
    expect(screen.getAllByText(/service limits and approval rules are checked again before work starts/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/runtime|migration required|logical identity|Allowed actions/i)).toBeNull();
    expect(screen.getByText("Partner connection")).toBeTruthy();
    const workBoard = screen.getByRole("region", { name: "Work Board status" });
    expect(within(workBoard).getByText("Running now")).toBeTruthy();
    expect(within(workBoard).getByText("Waiting for approval")).toBeTruthy();
    expect(within(workBoard).getByText("Needs attention")).toBeTruthy();
    expect(within(workBoard).getByText("Completed today")).toBeTruthy();
    expect(within(workBoard).getByRole("link", { name: /Open Work Board/ }).getAttribute("href")).toBe("/work");
    expect(screen.getByText("Your AI Growth Partner has not been connected yet.")).toBeTruthy();
  });

  it("shows the single approved conversation profile and accurately labels runtime synchronization", () => {
    const state: GrowthPartnerControlState = {
      id: "partner-1",
      name: "AI Growth Partner",
      status: "configured" as const,
      runtimeAgentInstanceId: "runtime-1",
      runtimeEnabled: true,
      runtimeStatus: "online" as const,
      runtimeHealthOk: true,
      behaviorProfile: {
        configVersion: 4,
        runtimeSyncStatus: "pending" as const,
        tone: "premium" as const,
        replyLength: "concise" as const,
        language: "Spanish" as const,
        personality: "Steady and evidence-led.",
        communicationStyle: "Use plain language.",
        responseBehavior: "Report only verified outcomes.",
        proactiveResponsibilities: "Work toward approved goals.",
        reportingBehavior: "Show status and next steps.",
      },
      conversationId: "conversation-1",
      conversationLastMessageAt: null,
      currentVersion: 1,
      currentBusinessBrain: null,
      draftVersion: null,
      draftBusinessBrain: null,
      versions: [],
      createdAt: new Date("2026-11-01T00:00:00Z"),
      updatedAt: new Date("2026-11-01T00:00:00Z"),
    };
    const props = {
      capabilityAccess: [],
      memories: [],
      goals: [],
      workSummary: { active: 0, waiting: 0, needsAttention: 0, completedToday: 0 },
      canManageMemory: false,
      canManageGoals: false,
      canConfigure: true,
      canConfigureResearch: false,
      researchSourcePolicies: { openstreetmap: null, company_website: null },
      legacyKnowledgeReview: { candidates: [], imports: [] },
      canOpenSetup: false,
      controlPermissions: { "agents.configure": true },
      legacyProfilesPresent: false,
      hasSubmittedOnboarding: false,
      submittedAnswerCount: 0,
      timezone: "America/New_York",
      safetyControls: { messagingPaused: false, outboundPaused: false, agencyPaused: false, canPause: false },
    };
    const view = render(<GrowthPartnerControlCenter {...props} state={state} />);

    const section = screen.getByRole("region", { name: "Partner personality and behavior" });
    expect(within(section).getByText("Saved configuration version 4")).toBeTruthy();
    expect(within(section).getByText("Profile sync pending")).toBeTruthy();
    expect(within(section).getByText("premium", { selector: "dd" })).toBeTruthy();
    expect(within(section).getByText("Steady and evidence-led.")).toBeTruthy();
    expect(within(section).getByRole("link", { name: /Edit AI preferences/ }).getAttribute("href")).toBe("/settings/ai");
    expect(within(section).getByText(/has not finished syncing to its Hermes runtime/i)).toBeTruthy();
    expect(screen.getByText("Sync pending")).toBeTruthy();
    expect(screen.getByText("Online")).toBeTruthy();
    expect(screen.getByText("The active runtime configuration passed its latest health check.")).toBeTruthy();

    view.rerender(<GrowthPartnerControlCenter {...props} state={{
      ...state,
      behaviorProfile: { ...state.behaviorProfile!, runtimeSyncStatus: "not_configured" },
    }} />);
    expect(screen.getByText("Runtime setup needed")).toBeTruthy();
    view.rerender(<GrowthPartnerControlCenter {...props} state={{
      ...state,
      behaviorProfile: { ...state.behaviorProfile!, runtimeSyncStatus: "synced" },
    }} />);
    expect(screen.getByText("Configured")).toBeTruthy();

    view.rerender(<GrowthPartnerControlCenter {...props} state={{ ...state, status: "setup_required" }} />);
    expect(screen.getByText("Health check needed")).toBeTruthy();
    expect(screen.queryByText("Online")).toBeNull();
    expect(screen.getByText("Partner connection").parentElement?.textContent).not.toContain("Connected");

    view.rerender(<GrowthPartnerControlCenter {...props} state={{ ...state, status: "paused" }} />);
    expect(screen.getByText("Partner connection").parentElement?.textContent).toContain("Paused");
    expect(screen.queryByText("Online")).toBeNull();
  });
});
