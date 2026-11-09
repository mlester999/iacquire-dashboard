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
    const clientPartners = html.indexOf("AI Growth Partners");
    const internalProfiles = html.indexOf("iAcquire internal profiles");
    const retainedProfiles = html.indexOf("Retained client profiles");

    expect(clientPartners).toBeGreaterThanOrEqual(0);
    expect(internalProfiles).toBeGreaterThan(clientPartners);
    expect(retainedProfiles).toBeGreaterThan(internalProfiles);
    expect(html).toContain("One tenant-scoped runtime per client");
    expect(html).toContain("Existing role-specific profiles remain available for audit");
  });
});
