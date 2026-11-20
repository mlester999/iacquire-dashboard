// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PartnerOverviewCard } from "@/components/overview/partner-overview-card";
import { getOverviewGrowthPartnerState } from "@/server/queries/dashboard";
import type { OrgContext } from "@/server/tenancy/context";

const service = vi.hoisted(() => ({ getGrowthPartnerControlState: vi.fn() }));

vi.mock("@/server/ai-growth-partner/service", () => ({ getGrowthPartnerControlState: service.getGrowthPartnerControlState }));
vi.mock("@/server/tenancy/context", () => ({ requireOrgContext: vi.fn() }));
vi.mock("@/server/ops/incidents", () => ({ listIncidentsForClient: vi.fn() }));
vi.mock("@/server/offboarding/service", () => ({ getOffboardingForOwner: vi.fn() }));
vi.mock("@/server/workforce/service", () => ({ listAgents: vi.fn() }));
vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>(function Link({ href, ...props }, ref) {
      return <a {...props} href={href} ref={ref} />;
    }),
  };
});

beforeEach(() => service.getGrowthPartnerControlState.mockReset());
afterEach(cleanup);

describe("Overview Growth Partner card", () => {
  it("keeps the AQi anchor and shows the partner actions without listing disabled legacy profiles", () => {
    const { container } = render(<PartnerOverviewCard state={{ status: "configured", currentVersion: 3 }} hasEnabledLegacyProfile={false} canConfigure />);

    expect(container.querySelector('[data-aqi-target="overview.ai-team"]')).not.toBeNull();
    expect(screen.getByText("Business Brain ready")).toBeTruthy();
    expect(screen.getByText("Active Business Brain v3")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open AI Growth Partner" }).getAttribute("href")).toBe("/growth-partner");
    expect(screen.getByRole("link", { name: "Permanent Conversation" }).getAttribute("href")).toBe("/growth-partner/conversation");
    expect(screen.queryByRole("link", { name: /Previous role profiles/ })).toBeNull();
    expect(container.textContent).not.toMatch(/Lead Hunter|Appointment Setter|Sales Assistant|CRM Manager|Operations Manager|Performance Analyst/);
  });

  it("shows one plain Previous role profiles row only for a configurable viewer with an enabled profile", () => {
    const { container } = render(<PartnerOverviewCard state={null} hasEnabledLegacyProfile canConfigure />);
    const links = screen.getAllByRole("link", { name: /Previous role profiles/ });
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("/employees");
    expect(container.querySelectorAll("img")).toHaveLength(0);

    cleanup();
    render(<PartnerOverviewCard state={null} hasEnabledLegacyProfile canConfigure={false} />);
    expect(screen.queryByRole("link", { name: /Previous role profiles/ })).toBeNull();
  });

  it("does not ask for Growth Partner state when the viewer lacks agents.use", async () => {
    const can = vi.fn(() => false);
    const ctx = { can } as unknown as OrgContext;

    await expect(getOverviewGrowthPartnerState(ctx)).resolves.toBeNull();
    expect(can).toHaveBeenCalledWith("agents.use");
    expect(service.getGrowthPartnerControlState).not.toHaveBeenCalled();
  });
});
