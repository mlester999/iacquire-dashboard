import { AGENT_ROLE_KEYS } from "@/lib/agents";
import type { GrowthPartnerScheduleMigrationPreview } from "@/server/admin/growth-partner-migration";
import type { GrowthPartnerMigrationInventory, TenantDetail } from "@/server/admin/queries";

type Inventory = Pick<GrowthPartnerMigrationInventory,
  "legacyProfiles" | "configReviewsWaiting" | "approvedKnowledgeSections" |
  "approvedLegacyProfileKnowledgeNotes" | "knowledgeSectionsWaiting" | "waitingLegacyProfileKnowledgeNotes" |
  "releasedLegacyProfileDocuments" | "heldLegacyProfileDocuments" | "releasedSharedKnowledgeDocuments" |
  "heldSharedKnowledgeDocuments" | "permanentGrowthPartnerConversations" | "schedules" |
  "enabledSchedules" | "openWorkJobs" | "openApprovals">;
type Candidate = Pick<NonNullable<TenantDetail["growthPartner"]>,
  "status" | "runtime_agent_instance_id" | "hermes_profile" | "has_credential" | "current_version" | "latest_version">;
type SchedulePreview = Pick<GrowthPartnerScheduleMigrationPreview, "generatedAt" | "summary" | "schedules" | "migrationChecks">;

interface MigrationBlocker {
  code: "missing_profiles" | "config_reviews" | "candidate_missing" | "runtime_unbound" | "unbound_runtime_conflict" |
    "runtime_profile_unready" | "permanent_conversation" | "brain_review" | "retained_knowledge_reviews" |
    "open_work" | "open_approvals" | "schedule_preview_required" | "inventory_changed" | "manual_schedule_mapping" |
    "partner_schedule_matches" | "legacy_schedule_collisions" | "due_schedules";
  message: string;
  count?: number;
}

function summarizeScheduleMappings(schedules: SchedulePreview["schedules"]) {
  let potentiallySupported = 0;
  let needsManualMapping = 0;
  let matchingPartnerSchedule = 0;
  const supportedMappings = new Map<string, number>();
  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    if (schedule.matchingGrowthPartnerSchedule) matchingPartnerSchedule++;
    if (schedule.potentiallySupportedByGrowthPartner) {
      potentiallySupported++;
      supportedMappings.set(schedule.capability, (supportedMappings.get(schedule.capability) ?? 0) + 1);
    } else {
      needsManualMapping++;
    }
  }
  return {
    potentiallySupported,
    needsManualMapping,
    matchingPartnerSchedule,
    legacyCapabilityCollisions: [...supportedMappings.values()].filter((count) => count > 1).length,
  };
}

export type GrowthPartnerMigrationReadiness =
  | { stage: "not_applicable" }
  | {
      stage: "checks_open" | "owner_approval_required";
      approvalMessage: string;
      blockers: MigrationBlocker[];
      schedulePreviewGeneratedAt: string | null;
      scheduleMappings: ReturnType<typeof summarizeScheduleMappings> | null;
      retainedKnowledge: { recordedSources: number; heldSources: number; pendingSnapshotReviews: number | null };
    };

/** Builds an advisory summary from count and status records. The result has no profile IDs, saved assignments, or content. */
export function summarizeGrowthPartnerMigration({ workspace, inventory, candidate, schedulePreview }: {
  workspace: Pick<TenantDetail["org"], "kind" | "status" | "is_demo">;
  inventory: Inventory | null;
  candidate: Candidate | null;
  schedulePreview: SchedulePreview | null;
}): GrowthPartnerMigrationReadiness {
  if (workspace.kind !== "client" || workspace.status !== "active" || workspace.is_demo || !inventory || inventory.legacyProfiles === 0) {
    return { stage: "not_applicable" };
  }

  const blockers: MigrationBlocker[] = [];
  const add = (code: MigrationBlocker["code"], message: string, count?: number) => blockers.push({
    code, message, ...(count === undefined ? {} : { count }),
  });
  if (inventory.legacyProfiles !== AGENT_ROLE_KEYS.length) {
    add("missing_profiles", "Reconcile the retained profile inventory before preparing or approving a candidate.");
  }
  if (inventory.configReviewsWaiting) add("config_reviews", "Resolve the waiting previous profile configuration reviews.", inventory.configReviewsWaiting);
  if (!candidate) add("candidate_missing", "Prepare the tenant’s Growth Partner migration candidate.");
  else if (!candidate.runtime_agent_instance_id) add("runtime_unbound", "Bind the candidate to its own verified tenant runtime.");
  else if (!candidate.hermes_profile || !candidate.has_credential || candidate.status !== "configured") {
    add("runtime_profile_unready", "Verify the bound runtime profile, credential, connection and tool inventory.");
  }
  if (inventory.permanentGrowthPartnerConversations !== 1) add("permanent_conversation", "Verify that the tenant has exactly one permanent Growth Partner conversation.");
  if (!candidate?.current_version) add("brain_review", "Have the workspace review and activate a Business Brain version.");
  else if (candidate.latest_version && candidate.latest_version > candidate.current_version) {
    add("brain_review", "Resolve the Business Brain draft before the workspace approves the migration.");
  }

  const pendingSnapshotReviews = schedulePreview?.migrationChecks?.pendingRetainedKnowledgeReviews ?? null;
  if (pendingSnapshotReviews) add("retained_knowledge_reviews", "Review the queued retained knowledge snapshots with the workspace.", pendingSnapshotReviews);
  const unboundPartnerRuntimes = schedulePreview?.migrationChecks?.unboundPartnerRuntimes ?? null;
  if (unboundPartnerRuntimes) add("unbound_runtime_conflict", "Resolve the Growth Partner runtime recorded outside the tenant’s canonical binding.", unboundPartnerRuntimes);
  const openWork = Math.max(inventory.openWorkJobs, schedulePreview?.summary.openWorkItems ?? 0);
  if (openWork) add("open_work", "Resolve or wait for open work attached to previous profiles.", openWork);
  if (inventory.openApprovals) add("open_approvals", "Review the workspace’s pending approvals and unfinished approval executions.", inventory.openApprovals);

  const scheduleMappings = schedulePreview ? summarizeScheduleMappings(schedulePreview.schedules) : null;
  if (!schedulePreview?.migrationChecks) {
    add("schedule_preview_required", "Run a current schedule and retained knowledge reconciliation preview.");
  }
  if (schedulePreview && scheduleMappings) {
    const { summary } = schedulePreview;
    if (summary.total !== schedulePreview.schedules.length || summary.total !== inventory.schedules
      || summary.enabled !== inventory.enabledSchedules || summary.openWorkItems !== inventory.openWorkJobs) {
      add("inventory_changed", "Refresh the inventory and preview the schedules again because recorded counts differ.");
    }
    if (scheduleMappings.needsManualMapping) add("manual_schedule_mapping", "Review enabled schedules outside the current Partner policy.", scheduleMappings.needsManualMapping);
    if (scheduleMappings.matchingPartnerSchedule) add("partner_schedule_matches", "Reconcile enabled previous schedules with matching Partner schedules.", scheduleMappings.matchingPartnerSchedule);
    if (scheduleMappings.legacyCapabilityCollisions) add("legacy_schedule_collisions", "Resolve capabilities targeted by multiple enabled previous schedules.", scheduleMappings.legacyCapabilityCollisions);
    if (summary.dueSchedules) add("due_schedules", "Resolve previous schedules that are already due.", summary.dueSchedules);
  }

  return {
    stage: blockers.length ? "checks_open" : "owner_approval_required",
    approvalMessage: "Obtain explicit workspace owner approval for the exact tenant, schedule changes, activation window and rollback plan. Any production operation requires its own approval.",
    blockers,
    schedulePreviewGeneratedAt: schedulePreview?.generatedAt ?? null,
    scheduleMappings,
    retainedKnowledge: {
      recordedSources: inventory.approvedKnowledgeSections + inventory.approvedLegacyProfileKnowledgeNotes
        + inventory.releasedLegacyProfileDocuments + inventory.releasedSharedKnowledgeDocuments,
      heldSources: inventory.knowledgeSectionsWaiting + inventory.waitingLegacyProfileKnowledgeNotes
        + inventory.heldLegacyProfileDocuments + inventory.heldSharedKnowledgeDocuments,
      pendingSnapshotReviews,
    },
  };
}
