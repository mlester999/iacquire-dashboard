// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ClientWorkforcesManager } from "@/components/admin/client-workforces-manager";
import { ConnectionChips } from "@/components/admin/client-card";
import { TooltipProvider } from "@/components/ui/overlays";
import type { listClientWorkforceSummaries } from "@/server/workforce/agency-registry";
import type { ClientSetupRow } from "@/server/setup/snapshots";

vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>(function Link({ href, ...props }, ref) {
    return <a {...props} href={href} ref={ref} />;
  });
  return { default: Link };
});

afterEach(cleanup);

type ClientWorkforce = Awaited<ReturnType<typeof listClientWorkforceSummaries>>[number];

describe("Super Admin Growth Partner readiness", () => {
  it("shows one current Partner runtime and keeps role-profile health separate", () => {
    const client: ClientWorkforce = {
      id: "client-1",
      name: "Synthetic Roofing Co",
      industry: "Roofing",
      status: "active",
      growth_partner_identities: 1,
      growth_partner_mapped: 1,
      growth_partner_credentialed: 1,
      growth_partner_verified: 1,
      growth_partner_issues: 0,
      growth_partner_last_success_at: new Date("2026-11-05T12:00:00.000Z"),
      retained_profiles: 6,
      retained_mapped: 2,
      retained_credentialed: 2,
      retained_verified: 1,
      retained_issues: 1,
      provisioning_open: 0,
      provisioning_failed: 0,
      hermes_status: "connected",
      hermes_detail: null,
    };

    render(<ClientWorkforcesManager clients={[client]} timeZone="UTC" />);

    expect(screen.getByRole("heading", { name: "AI Growth Partner readiness" })).toBeTruthy();
    const partner = screen.getByRole("region", { name: "AI Growth Partner runtime" });
    expect(within(partner).getByText("Runtime checks passed")).toBeTruthy();
    expect(within(partner).getByText("Present")).toBeTruthy();
    expect(within(partner).getByText("Mapped")).toBeTruthy();
    expect(within(partner).getByText("Saved")).toBeTruthy();
    expect(within(partner).getByText("Passed")).toBeTruthy();
    expect(screen.getByText("Retained role profiles", { exact: true })).toBeTruthy();
    expect(document.body.textContent).not.toContain("/6");
    expect(screen.getByRole("link", { name: "Open runtime readiness" }).getAttribute("href")).toBe("/admin/clients/client-1?tab=workforce");
  });

  it("labels only the linked Growth Partner runtime and exposes setup state", () => {
    const makeRow = (health: ClientSetupRow["health"]) => ({ health } as ClientSetupRow);
    const linked = makeRow({
      level: "healthy",
      agentsOnline: 1,
      agentsEnabled: 1,
      growthPartnerIdentityExists: true,
      growthPartnerRuntimeLinked: true,
      ghl: null,
      calendar: null,
      n8n: null,
      failedChecks: 0,
      failingAgents: 0,
    });
    const missing = makeRow({
      level: "not_connected",
      agentsOnline: 0,
      agentsEnabled: 0,
      growthPartnerIdentityExists: false,
      growthPartnerRuntimeLinked: false,
      ghl: null,
      calendar: null,
      n8n: null,
      failedChecks: 0,
      failingAgents: 0,
    });

    const { rerender } = render(<TooltipProvider><ConnectionChips r={linked} /></TooltipProvider>);
    expect(screen.getByText("Partner 1/1")).toBeTruthy();
    rerender(<TooltipProvider><ConnectionChips r={missing} /></TooltipProvider>);
    expect(screen.getByText("Partner setup")).toBeTruthy();
  });
});
