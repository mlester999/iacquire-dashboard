// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TeamGrid } from "@/components/overview/overview-panels";
import { growthPartnerPrimaryAction } from "@/lib/ai-growth-partner-navigation";

afterEach(cleanup);

describe("overview retained-profile links", () => {
  it("routes the primary action to one conversation after it exists and setup to the Control Center before then", () => {
    expect(growthPartnerPrimaryAction({ conversationId: "conversation-1" })).toEqual({
      href: "/growth-partner/conversation",
      label: "Open AI Growth Partner",
    });
    expect(growthPartnerPrimaryAction({ conversationId: null })).toEqual({
      href: "/growth-partner",
      label: "Review Partner setup",
    });
    expect(growthPartnerPrimaryAction(null)).toEqual({
      href: "/growth-partner",
      label: "Set up AI Growth Partner",
    });
  });

  it("routes enabled legacy entries to the permanent conversation and keeps disabled records reviewable", () => {
    render(<TeamGrid agents={[
      { id: "enabled", role_key: "lead_hunter", display_name: "Lead Hunter", enabled: true, status: "online" },
      { id: "disabled", role_key: "crm_manager", display_name: "CRM Manager", enabled: false, status: "disabled" },
    ]} />);

    expect(screen.getByRole("link", { name: /Lead Hunter/ }).getAttribute("href"))
      .toBe("/growth-partner/conversation");
    expect(screen.getByRole("link", { name: /CRM Manager/ }).getAttribute("href"))
      .toBe("/employees/crm-manager");
  });
});
