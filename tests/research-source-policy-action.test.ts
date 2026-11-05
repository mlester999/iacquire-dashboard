import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const context = { org: { orgId: "tenant-a" }, user: { id: "owner-a" } };
  return {
    context,
    requireOrgContextOrThrow: vi.fn(async (_permission: string) => context),
    saveResearchSourcePolicy: vi.fn(async (..._args: unknown[]) => undefined),
    createResearchRequest: vi.fn(),
    requestCrmImport: vi.fn(),
    retryResearchRequest: vi.fn(),
    reviewLeads: vi.fn(),
    saveTargeting: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/tenancy/context", () => ({ requireOrgContextOrThrow: mocks.requireOrgContextOrThrow }));
vi.mock("@/server/leads/service", () => ({
  createResearchRequest: mocks.createResearchRequest,
  requestCrmImport: mocks.requestCrmImport,
  retryResearchRequest: mocks.retryResearchRequest,
  reviewLeads: mocks.reviewLeads,
  saveTargeting: mocks.saveTargeting,
}));
vi.mock("@/server/leads/research-source-policy", () => ({ saveResearchSourcePolicy: mocks.saveResearchSourcePolicy }));

import { saveResearchSourcePolicyAction } from "@/app/actions/leads";

function field(form: FormData, key: string, value: string) {
  form.set(key, value);
}

function baseForm(source: "openstreetmap" | "company_website") {
  const form = new FormData();
  field(form, "source", source);
  field(form, "perJobRequestCap", "3");
  field(form, "perDayRequestCap", "12");
  field(form, "perJobSpendCapUsd", "0");
  field(form, "perDaySpendCapUsd", "0");
  return form;
}

describe("Growth Partner research-source settings action", () => {
  beforeEach(() => {
    mocks.requireOrgContextOrThrow.mockReset().mockResolvedValue(mocks.context);
    mocks.saveResearchSourcePolicy.mockReset().mockResolvedValue(undefined);
    mocks.revalidatePath.mockReset();
    mocks.createResearchRequest.mockReset();
  });

  it("requires the lead-research permission and saves bounded OpenStreetMap settings without starting research", async () => {
    const form = baseForm("openstreetmap");
    field(form, "providerFeeUsdPerRequest", "0");
    field(form, "endpoint", "https://maps.example/api/interpreter");
    field(form, "approvedEndpointHosts", "maps.example");
    field(form, "userAgent", "Example workspace research/1.0");
    field(form, "boundsSouth", "28.1");
    field(form, "boundsWest", "-81.6");
    field(form, "boundsNorth", "28.8");
    field(form, "boundsEast", "-81.1");
    field(form, "maxResults", "10");
    field(form, "timeoutSeconds", "20");

    const result = await saveResearchSourcePolicyAction({ status: "idle", message: "" }, form);

    expect(result).toEqual({ status: "success", message: "Settings saved. No discovery was started." });
    expect(mocks.requireOrgContextOrThrow).toHaveBeenCalledWith("leads.research");
    expect(mocks.saveResearchSourcePolicy).toHaveBeenCalledWith(mocks.context, "openstreetmap", expect.objectContaining({
      enabled: false,
      providerFeeUsdPerRequest: 0,
      perJobRequestCap: 3,
      perDayRequestCap: 12,
      sourceConfig: expect.objectContaining({
        endpoint: "https://maps.example/api/interpreter",
        approvedEndpointHosts: ["maps.example"],
        userAgent: "Example workspace research/1.0",
        bounds: { south: 28.1, west: -81.6, north: 28.8, east: -81.1 },
        maxResults: 10,
        timeoutSeconds: 20,
      }),
    }));
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/growth-partner");
    expect(mocks.createResearchRequest).not.toHaveBeenCalled();
  });

  it("forces company-website provider fees to zero and splits exact domains", async () => {
    const form = baseForm("company_website");
    field(form, "providerFeeUsdPerRequest", "999");
    field(form, "approvedDomains", "roofing.example\nwinter.example");
    field(form, "maxRequests", "6");

    const result = await saveResearchSourcePolicyAction({ status: "idle", message: "" }, form);

    expect(result.status).toBe("success");
    expect(mocks.saveResearchSourcePolicy).toHaveBeenCalledWith(mocks.context, "company_website", expect.objectContaining({
      providerFeeUsdPerRequest: 0,
      sourceConfig: { approvedDomains: ["roofing.example", "winter.example"], maxRequests: 6 },
    }));
  });

  it("does not save when the owner/admin permission check fails", async () => {
    mocks.requireOrgContextOrThrow.mockRejectedValueOnce(new Error("not authorized"));

    const result = await saveResearchSourcePolicyAction({ status: "idle", message: "" }, baseForm("company_website"));

    expect(result.status).toBe("error");
    expect(mocks.saveResearchSourcePolicy).not.toHaveBeenCalled();
  });
});
