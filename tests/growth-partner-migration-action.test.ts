import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAgencyOrThrow: vi.fn(),
  requireAgencyOrgPermissionOrThrow: vi.fn(),
  prepareGrowthPartnerMigrationCandidate: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/server/tenancy/context", () => ({
  requireAgencyOrThrow: mocks.requireAgencyOrThrow,
  requireAgencyOrgPermissionOrThrow: mocks.requireAgencyOrgPermissionOrThrow,
}));
vi.mock("@/server/admin/growth-partner-migration", () => ({
  prepareGrowthPartnerMigrationCandidate: mocks.prepareGrowthPartnerMigrationCandidate,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import { prepareGrowthPartnerMigrationCandidateAction } from "@/app/(admin)/admin/migration-actions";
import { AppError } from "@/server/errors";

describe("prepare Growth Partner migration candidate server action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAgencyOrThrow.mockResolvedValue({ id: "10000000-0000-4000-8000-000000000001" });
    mocks.requireAgencyOrgPermissionOrThrow.mockResolvedValue({ id: "10000000-0000-4000-8000-000000000001" });
    mocks.prepareGrowthPartnerMigrationCandidate.mockResolvedValue({
      id: "20000000-0000-4000-8000-000000000002",
      created: true,
      status: "migration_required",
      runtimeBound: false,
      businessBrainVersion: null,
      legacyProfilesPreserved: 6,
    });
  });

  it("rejects malformed organization identifiers before touching the workspace", async () => {
    await expect(prepareGrowthPartnerMigrationCandidateAction("not-a-uuid"))
      .resolves.toMatchObject({ ok: false, code: "invalid_input" });
    expect(mocks.requireAgencyOrThrow).not.toHaveBeenCalled();
    expect(mocks.prepareGrowthPartnerMigrationCandidate).not.toHaveBeenCalled();
  });

  it("enforces Super Admin access and client workforce scope even when called directly", async () => {
    const orgId = "30000000-0000-4000-8000-000000000003";
    mocks.requireAgencyOrThrow.mockRejectedValueOnce(new AppError("forbidden", "Agency access is required."));
    await expect(prepareGrowthPartnerMigrationCandidateAction(orgId))
      .resolves.toMatchObject({ ok: false, code: "forbidden" });
    expect(mocks.requireAgencyOrgPermissionOrThrow).not.toHaveBeenCalled();
    expect(mocks.prepareGrowthPartnerMigrationCandidate).not.toHaveBeenCalled();

    mocks.requireAgencyOrThrow.mockResolvedValueOnce({ id: "10000000-0000-4000-8000-000000000001" });
    mocks.requireAgencyOrgPermissionOrThrow.mockRejectedValueOnce(new AppError("forbidden", "Client scope is required."));
    await expect(prepareGrowthPartnerMigrationCandidateAction(orgId))
      .resolves.toMatchObject({ ok: false, code: "forbidden" });
    expect(mocks.requireAgencyOrgPermissionOrThrow).toHaveBeenCalledWith(orgId, "agency.workforce.manage");
    expect(mocks.prepareGrowthPartnerMigrationCandidate).not.toHaveBeenCalled();
  });

  it("calls the candidate service only after both authorization checks pass", async () => {
    const orgId = "30000000-0000-4000-8000-000000000003";
    const actorId = "10000000-0000-4000-8000-000000000001";
    await expect(prepareGrowthPartnerMigrationCandidateAction(orgId)).resolves.toMatchObject({ ok: true, data: { created: true } });
    expect(mocks.requireAgencyOrThrow).toHaveBeenCalledWith("super_admin");
    expect(mocks.requireAgencyOrgPermissionOrThrow).toHaveBeenCalledWith(orgId, "agency.workforce.manage");
    expect(mocks.prepareGrowthPartnerMigrationCandidate).toHaveBeenCalledWith(orgId, actorId);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/admin/clients/${orgId}`);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/admin/employees");
  });
});
