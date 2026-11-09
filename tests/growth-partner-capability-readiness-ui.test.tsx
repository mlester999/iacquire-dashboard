// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { GrowthPartnerControlCenter } from "@/components/growth-partner/control-center";
import { deriveGrowthPartnerCapabilityAccess } from "@/lib/ai-growth-partner-capability-access";
import { ROLE_ABILITIES } from "@/lib/employee-tool-policy";

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
    expect(screen.getByText("Your AI Growth Partner needs a connection before it can work.")).toBeTruthy();
  });
});
