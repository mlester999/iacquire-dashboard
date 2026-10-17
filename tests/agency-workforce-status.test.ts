import { describe, expect, it } from "vitest";
import { deriveAgencyWorkforceStatus, type AgencyWorkforceStatusInput } from "@/lib/agency-workforce-status";

const verifiedRestricted: AgencyWorkforceStatusInput = {
  mappedCorrectly: true,
  profileId: "iacquire-operations-manager",
  gatewayId: "gateway-1",
  hasCredential: true,
  profileCheckStatus: "verified",
  profileCheckProfileId: "iacquire-operations-manager",
  profileCheckGatewayId: "gateway-1",
  profileIdentityVerified: true,
  gatewayStatus: "connected",
  toolPermissionsStatus: "restricted",
};

describe("agency workforce connection and tool readiness", () => {
  it("keeps a verified profile connection separate from tools that still need review", () => {
    expect(deriveAgencyWorkforceStatus(verifiedRestricted)).toEqual({
      connection: "verified",
      tools: "review_needed",
      checkIsCurrent: true,
    });
  });

  it("shows a failed current profile check without calling the gateway connection verified", () => {
    expect(deriveAgencyWorkforceStatus({ ...verifiedRestricted, profileCheckStatus: "cloudflare_auth_failed" })).toEqual({
      connection: "failed",
      tools: "not_checked",
      checkIsCurrent: true,
    });
  });

  it("does not reuse a successful check from an older profile or gateway mapping", () => {
    expect(deriveAgencyWorkforceStatus({ ...verifiedRestricted, profileCheckProfileId: "old-profile" })).toMatchObject({
      connection: "not_tested",
      tools: "not_checked",
      checkIsCurrent: false,
    });
    expect(deriveAgencyWorkforceStatus({ ...verifiedRestricted, profileCheckGatewayId: "old-gateway" })).toMatchObject({
      connection: "not_tested",
      tools: "not_checked",
      checkIsCurrent: false,
    });
  });

  it("requires a mapped identity, approved gateway and active credential before connection checks", () => {
    expect(deriveAgencyWorkforceStatus({ ...verifiedRestricted, hasCredential: false })).toMatchObject({ connection: "setup_required", tools: "not_checked" });
    expect(deriveAgencyWorkforceStatus({ ...verifiedRestricted, gatewayId: null })).toMatchObject({ connection: "setup_required", tools: "not_checked" });
    expect(deriveAgencyWorkforceStatus({ ...verifiedRestricted, mappedCorrectly: false })).toMatchObject({ connection: "setup_required", tools: "not_checked" });
  });
});
