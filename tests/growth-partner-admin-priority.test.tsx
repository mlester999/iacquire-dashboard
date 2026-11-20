import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAgency: vi.fn(),
  ensureAgencyWorkspace: vi.fn(),
  listAllAgents: vi.fn(),
  listGrowthPartners: vi.fn(),
  listAgencyAgents: vi.fn(),
  listHermesGateways: vi.fn(),
  countInternalHeldConfigReviews: vi.fn(),
  withSystem: vi.fn(),
}));

vi.mock("@/server/tenancy/context", () => ({ requireAgency: mocks.requireAgency }));
vi.mock("@/server/workforce/agency", () => ({ ensureAgencyWorkspace: mocks.ensureAgencyWorkspace }));
vi.mock("@/server/admin/queries", () => ({
  listAllAgents: mocks.listAllAgents,
  listGrowthPartners: mocks.listGrowthPartners,
  listAgencyAgents: mocks.listAgencyAgents,
}));
vi.mock("@/server/integrations/hermes/gateways", () => ({ listHermesGateways: mocks.listHermesGateways }));
vi.mock("@/server/workforce/reviews", () => ({ countInternalHeldConfigReviews: mocks.countInternalHeldConfigReviews }));
vi.mock("@/server/db", () => ({ withSystem: mocks.withSystem }));

import AdminWorkforcePage from "@/app/(admin)/admin/employees/page";

describe("Growth Partner admin priority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAgency.mockResolvedValue({ id: "synthetic-admin", platformRole: "agency_super_admin" });
    mocks.ensureAgencyWorkspace.mockResolvedValue(undefined);
    mocks.listAllAgents.mockResolvedValue([]);
    mocks.listGrowthPartners.mockResolvedValue([]);
    mocks.listAgencyAgents.mockResolvedValue([]);
    mocks.listHermesGateways.mockResolvedValue([]);
    mocks.countInternalHeldConfigReviews.mockResolvedValue(0);
    mocks.withSystem.mockImplementation((callback: (db: { query: () => Promise<{ rows: { timezone: string }[] }> }) => unknown) =>
      callback({ query: async () => ({ rows: [{ timezone: "UTC" }] }) }),
    );
  });

  it("shows client Growth Partners before internal and retained role-profile records", async () => {
    const html = renderToStaticMarkup(await AdminWorkforcePage());
    const clientPartners = html.indexOf("AI Growth Partner Operations");
    const retainedProfiles = html.indexOf("Previous profile activity");
    const internalProfiles = html.indexOf("Internal agency profiles and gateways");

    expect(clientPartners).toBeGreaterThanOrEqual(0);
    expect(retainedProfiles).toBeGreaterThan(clientPartners);
    expect(internalProfiles).toBeGreaterThan(clientPartners);
    expect(html).toContain("Client Partner status");
    expect(html).toMatch(/<details[^>]*><summary[^>]*><span[^>]*>Previous profile activity/);
    expect(html).toMatch(/<details[^>]*><summary[^>]*>Internal agency profiles and gateways/);
    expect(html).toContain("Review previous profiles for audits, support and staged migration.");
  });

  it("shows an error card when the Growth Partner fleet read fails", async () => {
    mocks.listGrowthPartners.mockRejectedValueOnce(new Error("trusted fleet read failed"));

    const html = renderToStaticMarkup(await AdminWorkforcePage());

    expect(html).toContain('aria-label="Growth Partner fleet unavailable"');
    expect(html).toContain("Growth Partner fleet status could not be loaded");
    expect(html).toContain("Retained client profiles");
  });
});
