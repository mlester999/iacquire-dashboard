import { describe, expect, it } from "vitest";
import { summarizeGrowthPartnerMigration } from "@/lib/growth-partner-migration-readiness";

type Input = Parameters<typeof summarizeGrowthPartnerMigration>[0];
type Preview = NonNullable<Input["schedulePreview"]>;
type Schedule = Preview["schedules"][number];

const workspace = { kind: "client", status: "active", is_demo: false };
const inventory = {
  legacyProfiles: 6, configReviewsWaiting: 0, approvedKnowledgeSections: 2,
  approvedLegacyProfileKnowledgeNotes: 1, knowledgeSectionsWaiting: 1, waitingLegacyProfileKnowledgeNotes: 0,
  releasedLegacyProfileDocuments: 1, heldLegacyProfileDocuments: 2, releasedSharedKnowledgeDocuments: 1,
  heldSharedKnowledgeDocuments: 1, permanentGrowthPartnerConversations: 1, schedules: 0,
  enabledSchedules: 0, openWorkJobs: 0, openApprovals: 0,
} satisfies NonNullable<Input["inventory"]>;
const candidate = {
  status: "configured",
  runtime_agent_instance_id: "hidden-runtime-identifier",
  hermes_profile: "hidden-profile-identifier",
  has_credential: true,
  current_version: 2,
  latest_version: 2,
} satisfies NonNullable<Input["candidate"]>;
const generatedAt = "2026-11-18T01:00:00.000Z";
const schedule = {
  id: "hidden-schedule-identifier", legacyRole: "lead_hunter", capability: "lead_research",
  capabilityLabel: "Hidden private assignment label", cadence: "daily", intervalMinutes: 1440, timezone: "UTC",
  enabled: true, nextRunAt: generatedAt, lastRunAt: null, due: false,
  potentiallySupportedByGrowthPartner: true, matchingGrowthPartnerSchedule: false, openWorkItemsForCapability: 0,
} satisfies Schedule;

function preview(schedules: Schedule[], checks: Preview["migrationChecks"] = { unboundPartnerRuntimes: 0, pendingRetainedKnowledgeReviews: 0 }): Preview {
  return {
    generatedAt,
    migrationChecks: checks,
    schedules,
    summary: {
      total: schedules.length,
      enabled: schedules.filter((item) => item.enabled).length,
      potentiallySupported: schedules.filter((item) => item.potentiallySupportedByGrowthPartner).length,
      openWorkItems: 0,
      partnerScheduleMatches: schedules.filter((item) => item.matchingGrowthPartnerSchedule).length,
      dueSchedules: schedules.filter((item) => item.due).length,
    },
  };
}

const blockerCodes = (result: ReturnType<typeof summarizeGrowthPartnerMigration>) =>
  result.stage === "not_applicable" ? [] : result.blockers.map((blocker) => blocker.code);

describe("existing workspace migration dry-run summary", () => {
  it("does not apply when there is no eligible active client with retained profiles", () => {
    for (const input of [
      { workspace: { ...workspace, kind: "agency" }, inventory },
      { workspace: { ...workspace, status: "suspended" }, inventory },
      { workspace: { ...workspace, is_demo: true }, inventory },
      { workspace, inventory: { ...inventory, legacyProfiles: 0 } },
      { workspace, inventory: null },
    ]) {
      expect(summarizeGrowthPartnerMigration({ ...input, candidate, schedulePreview: null })).toEqual({ stage: "not_applicable" });
    }
  });

  it("requires an actual candidate, active Brain, permanent conversation and current preview", () => {
    const result = summarizeGrowthPartnerMigration({
      workspace, inventory: { ...inventory, legacyProfiles: 5, permanentGrowthPartnerConversations: 0 },
      candidate: null, schedulePreview: null,
    });
    expect(result.stage).toBe("checks_open");
    expect(blockerCodes(result)).toEqual(["missing_profiles", "candidate_missing", "permanent_conversation", "brain_review", "schedule_preview_required"]);
    expect(result).toMatchObject({ approvalMessage: expect.stringContaining("explicit workspace owner approval"), retainedKnowledge: { pendingSnapshotReviews: null } });

    const unbound = summarizeGrowthPartnerMigration({
      workspace, inventory, candidate: { ...candidate, runtime_agent_instance_id: null }, schedulePreview: preview([]),
    });
    expect(blockerCodes(unbound)).toEqual(["runtime_unbound"]);

    const noProfile = summarizeGrowthPartnerMigration({
      workspace, inventory, candidate: { ...candidate, hermes_profile: null }, schedulePreview: preview([]),
    });
    expect(blockerCodes(noProfile)).toEqual(["runtime_profile_unready"]);
  });

  it("reports conflicts, open work and unresolved reviews using counts only", () => {
    const schedules = [
      { ...schedule, due: true, matchingGrowthPartnerSchedule: true },
      { ...schedule, legacyRole: "operations_manager" as const },
      { ...schedule, capability: "custom_admin_action", potentiallySupportedByGrowthPartner: false },
      { ...schedule, enabled: false, matchingGrowthPartnerSchedule: true },
    ];
    const schedulePreview = preview(schedules, { unboundPartnerRuntimes: 1, pendingRetainedKnowledgeReviews: 2 });
    schedulePreview.summary.openWorkItems = 3;
    const result = summarizeGrowthPartnerMigration({
      workspace, inventory: { ...inventory, schedules: 4, enabledSchedules: 3, openWorkJobs: 2, openApprovals: 2, configReviewsWaiting: 1 },
      candidate: { ...candidate, status: "needs_attention", latest_version: 3 }, schedulePreview,
    });
    expect(result).toMatchObject({
      stage: "checks_open",
      schedulePreviewGeneratedAt: generatedAt,
      scheduleMappings: { potentiallySupported: 2, needsManualMapping: 1, matchingPartnerSchedule: 1, legacyCapabilityCollisions: 1 },
      retainedKnowledge: { recordedSources: 5, heldSources: 4, pendingSnapshotReviews: 2 },
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: "config_reviews", count: 1 }),
        expect.objectContaining({ code: "runtime_profile_unready" }),
        expect.objectContaining({ code: "brain_review" }),
        expect.objectContaining({ code: "retained_knowledge_reviews", count: 2 }),
        expect.objectContaining({ code: "unbound_runtime_conflict", count: 1 }),
        expect.objectContaining({ code: "open_work", count: 3 }),
        expect.objectContaining({ code: "open_approvals", count: 2 }),
        expect.objectContaining({ code: "inventory_changed" }),
        expect.objectContaining({ code: "manual_schedule_mapping", count: 1 }),
        expect.objectContaining({ code: "partner_schedule_matches", count: 1 }),
        expect.objectContaining({ code: "legacy_schedule_collisions", count: 1 }),
        expect.objectContaining({ code: "due_schedules", count: 1 }),
      ]),
    });
    expect(JSON.stringify(result)).not.toMatch(/hidden-|private assignment|custom_admin_action/);
  });

  it("keeps owner approval pending with a complete dry run and treats missing preview metadata as unknown", () => {
    const complete = summarizeGrowthPartnerMigration({ workspace, inventory, candidate, schedulePreview: preview([]) });
    expect(complete).toMatchObject({
      stage: "owner_approval_required", blockers: [], approvalMessage: expect.stringMatching(/exact tenant.*rollback plan/),
    });

    const incomplete = summarizeGrowthPartnerMigration({
      workspace, inventory, candidate, schedulePreview: { ...preview([]), migrationChecks: undefined },
    });
    expect(incomplete).toMatchObject({ stage: "checks_open", retainedKnowledge: { pendingSnapshotReviews: null } });
    expect(blockerCodes(incomplete)).toEqual(["schedule_preview_required"]);
  });
});
