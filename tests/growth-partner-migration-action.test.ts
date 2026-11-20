import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAgencyOrThrow: vi.fn(),
  requireAgencyOrgPermissionOrThrow: vi.fn(),
  prepareGrowthPartnerMigrationCandidate: vi.fn(),
  prepareApprovedMigrationPlan: vi.fn(),
  previewGrowthPartnerScheduleMigration: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/server/tenancy/context", () => ({
  requireAgencyOrThrow: mocks.requireAgencyOrThrow,
  requireAgencyOrgPermissionOrThrow: mocks.requireAgencyOrgPermissionOrThrow,
}));
vi.mock("@/server/admin/growth-partner-migration", () => ({
  prepareGrowthPartnerMigrationCandidate: mocks.prepareGrowthPartnerMigrationCandidate,
  previewGrowthPartnerScheduleMigration: mocks.previewGrowthPartnerScheduleMigration,
}));
vi.mock("@/server/admin/growth-partner-migration-plan", () => ({
  prepareApprovedMigrationPlan: mocks.prepareApprovedMigrationPlan,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import { applyApprovedGrowthPartnerMigrationPlanAction, prepareGrowthPartnerMigrationCandidateAction, previewGrowthPartnerScheduleMigrationAction } from "@/app/(admin)/admin/migration-actions";
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

describe("Growth Partner schedule migration preview server action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAgencyOrThrow.mockResolvedValue({ id: "10000000-0000-4000-8000-000000000001" });
    mocks.requireAgencyOrgPermissionOrThrow.mockResolvedValue({ id: "10000000-0000-4000-8000-000000000001" });
    mocks.previewGrowthPartnerScheduleMigration.mockResolvedValue({ schedules: [], summary: { total: 0 } });
  });

  it("rejects malformed organization identifiers before workspace access", async () => {
    await expect(previewGrowthPartnerScheduleMigrationAction("not-a-uuid"))
      .resolves.toMatchObject({ ok: false, code: "invalid_input" });
    expect(mocks.requireAgencyOrThrow).not.toHaveBeenCalled();
    expect(mocks.previewGrowthPartnerScheduleMigration).not.toHaveBeenCalled();
  });

  it("requires Super Admin and client workforce management on direct action calls", async () => {
    const orgId = "30000000-0000-4000-8000-000000000003";
    mocks.requireAgencyOrThrow.mockRejectedValueOnce(new AppError("forbidden", "Super Admin access is required."));
    await expect(previewGrowthPartnerScheduleMigrationAction(orgId)).resolves.toMatchObject({ ok: false, code: "forbidden" });
    expect(mocks.requireAgencyOrgPermissionOrThrow).not.toHaveBeenCalled();

    mocks.requireAgencyOrgPermissionOrThrow.mockRejectedValueOnce(new AppError("forbidden", "Client workforce access is required."));
    await expect(previewGrowthPartnerScheduleMigrationAction(orgId)).resolves.toMatchObject({ ok: false, code: "forbidden" });
    expect(mocks.requireAgencyOrgPermissionOrThrow).toHaveBeenCalledWith(orgId, "agency.workforce.manage");
    expect(mocks.previewGrowthPartnerScheduleMigration).not.toHaveBeenCalled();
  });

  it("returns only the authorized tenant's read-only preview", async () => {
    const orgId = "30000000-0000-4000-8000-000000000003";
    const preview = { schedules: [{ id: "schedule-1" }], summary: { total: 1 } };
    mocks.previewGrowthPartnerScheduleMigration.mockResolvedValueOnce(preview);
    await expect(previewGrowthPartnerScheduleMigrationAction(orgId)).resolves.toEqual({ ok: true, data: preview });
    expect(mocks.requireAgencyOrThrow).toHaveBeenCalledWith("super_admin");
    expect(mocks.requireAgencyOrgPermissionOrThrow).toHaveBeenCalledWith(orgId, "agency.workforce.manage");
    expect(mocks.previewGrowthPartnerScheduleMigration).toHaveBeenCalledWith(orgId);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});


describe("apply an approved Growth Partner preparation", () => {
  const orgId = "30000000-0000-4000-8000-000000000003";
  const planId = "20000000-0000-4000-8000-000000000002";
  const actorId = "10000000-0000-4000-8000-000000000001";
  const digest = "d".repeat(64);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAgencyOrThrow.mockResolvedValue({ id: actorId });
    mocks.requireAgencyOrgPermissionOrThrow.mockResolvedValue({ id: actorId });
  });

  it("validates the digest and requires both authorization checks on direct calls", async () => {
    await expect(applyApprovedGrowthPartnerMigrationPlanAction(orgId, planId, "wrong")).resolves.toMatchObject({ code: "invalid_input" });
    expect(mocks.requireAgencyOrThrow).not.toHaveBeenCalled();
    mocks.requireAgencyOrThrow.mockRejectedValueOnce(new AppError("forbidden", "Super Admin access is required."));
    await expect(applyApprovedGrowthPartnerMigrationPlanAction(orgId, planId, digest)).resolves.toMatchObject({ code: "forbidden" });
    expect(mocks.requireAgencyOrgPermissionOrThrow).not.toHaveBeenCalled();
    mocks.requireAgencyOrgPermissionOrThrow.mockRejectedValueOnce(new AppError("forbidden", "Workspace access is required."));
    await expect(applyApprovedGrowthPartnerMigrationPlanAction(orgId, planId, digest)).resolves.toMatchObject({ code: "forbidden" });
    expect(mocks.requireAgencyOrgPermissionOrThrow).toHaveBeenCalledWith(orgId, "agency.workforce.manage");
    expect(mocks.prepareApprovedMigrationPlan).not.toHaveBeenCalled();
  });

  it("forwards exactly the approved plan and refreshes both review screens after success", async () => {
    const receipt = { brainVersion: 2, replacementScheduleCount: 0 };
    mocks.prepareApprovedMigrationPlan.mockResolvedValueOnce(receipt);
    await expect(applyApprovedGrowthPartnerMigrationPlanAction(orgId, planId, digest)).resolves.toEqual({ ok: true, data: receipt });
    expect(mocks.requireAgencyOrThrow).toHaveBeenCalledWith("super_admin");
    expect(mocks.requireAgencyOrgPermissionOrThrow).toHaveBeenCalledWith(orgId, "agency.workforce.manage");
    expect(mocks.prepareApprovedMigrationPlan).toHaveBeenCalledWith(orgId, actorId, { planId, digest });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/admin/clients/${orgId}`);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/growth-partner");
  });
});
