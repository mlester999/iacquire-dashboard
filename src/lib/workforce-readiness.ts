import { SETUP_REQUIRED_LABEL, type AgentStatus } from "@/lib/agents";
import { toolInventoryReady, toolInventoryRecorded } from "@/lib/hermes-tool-inventory";
import { PAYMENT_REQUIRED_SENTENCE } from "@/lib/billing-clearance";
import { blockingUnmet, type RequirementResult } from "@/lib/employee-requirements";

export type { RequirementResult } from "@/lib/employee-requirements";

/** Consecutive failed health probes after which an employee reads "Unavailable" (and the agency is alerted) instead of "Degraded". */
export const HEALTH_FAILURE_THRESHOLD = 3;

export type ReadinessStage =
  | "disabled"
  | "suspended"
  | "review"
  | "setup"
  | "connection"
  | "inventory"
  | "identity"
  | "attention"
  | "approval"
  | "incomplete"
  | "degraded"
  | "ready"
  | "working";

/**
 * The eight states every screen, the Super Admin, the scheduler and the acceptance tests speak in. `stage` is the finer detail a screen needs (which check is missing); the state is the
 * answer to "what is this employee's situation": nothing here is displayed as `ready` unless the runtime is verified AND the role's blocking prerequisites are in place.
 */
export type ReadinessState = "pending_setup" | "configuration_incomplete" | "connection_required" | "provisioning" | "ready" | "degraded" | "unavailable" | "suspended";

export const READINESS_STATE_LABEL: Record<ReadinessState, string> = {
  pending_setup: "Pending setup",
  configuration_incomplete: "Configuration incomplete",
  connection_required: "Connection required",
  provisioning: "Provisioning",
  ready: "Ready for authorized work",
  degraded: "Degraded",
  unavailable: "Unavailable",
  suspended: "Suspended",
};

export function readinessStateOf(stage: ReadinessStage): ReadinessState {
  switch (stage) {
    case "disabled":
    case "suspended": return "suspended";
    case "review":
    case "setup": return "pending_setup";
    case "connection":
    case "inventory":
    case "identity":
    case "approval": return "connection_required";
    case "attention": return "unavailable";
    case "incomplete": return "configuration_incomplete";
    case "degraded": return "degraded";
    case "ready":
    case "working": return "ready";
  }
}

/** What the scheduled health probe has recorded, as the screens need it. Counts are of CONSECUTIVE failed probes; a passing probe resets them. */
export interface HealthSummary {
  consecutiveFailures: number;
  lastHealthyAt: string | null;
  lastFailureAt: string | null;
  lastProbeAt: string | null;
  lastProbeSource: "scheduled" | "manual" | null;
}

/** Facts a list or detail loader attaches to an employee row so every screen reaches the same answer (src/server/workforce/readiness-facts.ts). */
export interface ReadinessExtras {
  requirements?: RequirementResult[];
  health?: HealthSummary | null;
  /** The workspace is suspended or archived. */
  suspended?: { reason: string } | null;
}

export type ReadinessTone = "neutral" | "warning" | "danger" | "success" | "primary" | "violet";
export type ReadinessCta = "configure" | "history" | "chat" | "connection" | "none";
export type ReadinessStepState = "done" | "current" | "upcoming" | "blocked" | "not_applicable";

export interface ReadinessStep {
  key: "configuration" | "connection" | "inventory" | "identity" | "acknowledgement" | "requirements" | "ready";
  label: string;
  description: string;
  state: ReadinessStepState;
}

export interface EmployeeReadiness {
  stage: ReadinessStage;
  state: ReadinessState;
  tone: ReadinessTone;
  label: string;
  title: string;
  description: string;
  cta: ReadinessCta;
  steps: ReadinessStep[];
  completed: number;
  total: number;
  chatAvailable: boolean;
  /** Ready for authorized WORK, not only to chat: the runtime is verified and no blocking role prerequisite is missing. */
  workReady: boolean;
  /** Every prerequisite of the role and whether it is met (empty when the loader did not supply them). */
  requirements: RequirementResult[];
  /** The unmet prerequisites that stop "ready". */
  blocking: RequirementResult[];
  health: HealthSummary | null;
  /** The persisted short-lived attestation is still within its TTL. */
  inventoryAttestationCurrent: boolean;
  executing: boolean;
}

export interface EmployeeReadinessInput {
  displayName?: string;
  enabled: boolean;
  status: AgentStatus;
  configVersion: number | null;
  /** For list views that only know whether an active configuration exists, without its version. */
  configured?: boolean;
  hasPendingReview?: boolean;
  lastHealthCheckAt: string | null;
  lastHealthOk: boolean | null;
  lastHealthDetail?: string | null;
  inventoryContract?: string | null;
  inventoryDigest: string | null;
  inventoryVerifiedAt?: string | null;
  inventoryExpiresAt?: string | null;
  inventoryToolCount?: number | null;
  /** Current saved Hermes credential state when available from a trusted server-side lookup. */
  credentialCurrent?: boolean;
  /** `null`/`undefined` for client employees, where this agency-only control does not apply. */
  identityCurrent?: boolean | null;
  acknowledgementCurrent?: boolean | null;
  /** Only true for an internal agency employee viewed by an agency Super Admin. */
  isAgencyEmployee?: boolean;
  /** True only when a persisted `agent_runs` row is actually in `running` state. */
  taskExecuting?: boolean;
  /**
   * Whether the workspace's setup payment is confirmed (paid or waived). Only a client workspace passes it; `undefined` means "not asked" and changes nothing. `false`
   * keeps an employee that is not yet working at "Setup required" with the reason. It never touches an employee that is already authorized: a refund stops new
   * provisioning, it does not pause a running AI team.
   */
  paymentCleared?: boolean;
  /** Fixed per server render to avoid server/client clock drift at the two-minute expiry boundary. */
  evaluatedAt?: string | Date | number;
  /** Role prerequisites, the scheduled probe's record and workspace suspension, attached by the loader. Omitted: the runtime checks alone decide, as before. */
  extras?: ReadinessExtras | null;
}

export interface InternalIdentityEvidence {
  expectedProfile: string | null;
  savedProfile: string | null;
  savedGatewayId: string | null;
  checkedProfile: string | null;
  checkedGatewayId: string | null;
  checkStatus: string | null;
  identityVerified: boolean | null;
  apiContractVerified: boolean | null;
  toolPermissionsStatus: string | null;
  checkedAt: string | Date | null;
  configAppliedAt: string | Date | null;
}

export interface InternalAcknowledgementEvidence extends InternalIdentityEvidence {
  acknowledgedAt: string | Date | null;
  acknowledgedProfile: string | null;
  acknowledgedPolicyId: string | null;
  expectedPolicyId: string | null;
  activeConfigVersionId: string | null;
  acknowledgedConfigVersionId: string | null;
  inventoryDigest: string | null;
  acknowledgedInventoryDigest: string | null;
  credentialReady: boolean;
  hasAgentPolicyOverride: boolean;
}

/** Server render clock for readiness expiry checks. */
export function readinessClockNow(): number {
  return Date.now();
}

function validTimestamp(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

/** One shared definition of current internal profile identity evidence. */
export function internalIdentityIsCurrent(evidence: InternalIdentityEvidence): boolean {
  const checkedAt = validTimestamp(evidence.checkedAt);
  const configAppliedAt = validTimestamp(evidence.configAppliedAt);
  return Boolean(
    evidence.expectedProfile
    && evidence.savedProfile === evidence.expectedProfile
    && evidence.checkedProfile === evidence.expectedProfile
    && evidence.savedGatewayId
    && evidence.checkedGatewayId === evidence.savedGatewayId
    && evidence.checkStatus === "verified"
    && evidence.identityVerified === true
    && evidence.apiContractVerified === true
    && evidence.toolPermissionsStatus === "verified"
    && checkedAt !== null
    && configAppliedAt !== null
    && checkedAt >= configAppliedAt,
  );
}

/**
 * An acknowledgement is bound to the applied config and the exact reviewed inventory digest.
 * Inventory expiry is a short diagnostic window; a later live check with the same digest does not
 * invalidate the acknowledgement. A changed digest, config, identity check, policy or override does.
 */
export function internalAcknowledgementIsCurrent(evidence: InternalAcknowledgementEvidence): boolean {
  const acknowledgedAt = validTimestamp(evidence.acknowledgedAt);
  return Boolean(
    internalIdentityIsCurrent(evidence)
    && acknowledgedAt !== null
    && evidence.acknowledgedProfile === evidence.expectedProfile
    && evidence.expectedPolicyId
    && evidence.acknowledgedPolicyId === evidence.expectedPolicyId
    && evidence.activeConfigVersionId
    && evidence.acknowledgedConfigVersionId === evidence.activeConfigVersionId
    && evidence.inventoryDigest
    && evidence.acknowledgedInventoryDigest === evidence.inventoryDigest
    && evidence.credentialReady
    && !evidence.hasAgentPolicyOverride,
  );
}

export function deriveEmployeeReadiness(input: EmployeeReadinessInput): EmployeeReadiness {
  const {
    enabled,
    status,
    configVersion,
    configured: configuredOverride,
    hasPendingReview = false,
    lastHealthCheckAt,
    lastHealthOk,
    lastHealthDetail,
    inventoryContract = null,
    inventoryDigest,
    inventoryVerifiedAt = null,
    inventoryExpiresAt = null,
    inventoryToolCount = null,
    credentialCurrent,
    identityCurrent,
    acknowledgementCurrent,
    isAgencyEmployee = false,
    taskExecuting = false,
  } = input;

  const configured = configVersion !== null || configuredOverride === true;
  const checked = Boolean(lastHealthCheckAt);
  const healthOk = lastHealthOk === true;
  const evaluatedAt = input.evaluatedAt ? new Date(input.evaluatedAt) : new Date();
  const inventoryEvidence = {
    last_health_ok: lastHealthOk,
    tool_inventory_contract: inventoryContract,
    tool_inventory_digest: inventoryDigest,
    tool_inventory_verified_at: inventoryVerifiedAt,
    tool_inventory_expires_at: inventoryExpiresAt,
    tool_inventory_tool_count: inventoryToolCount ?? null,
  };
  const inventoryRecorded = toolInventoryRecorded(inventoryEvidence);
  const inventoryCurrent = toolInventoryReady(inventoryEvidence, evaluatedAt);
  const identityApplies = isAgencyEmployee;
  const identityOk = !identityApplies || identityCurrent === true;
  const credentialOk = credentialCurrent !== false;
  const acknowledgementApplies = isAgencyEmployee;
  const acknowledgementOk = !acknowledgementApplies || acknowledgementCurrent === true;
  const online = enabled && (status === "online" || status === "busy");
  // Readiness means a user may enter the authorized chat flow. Chat refreshes an expired
  // attestation before persistence, and Hermes verifies the live inventory again before submit.
  const authorized = enabled && configured && healthOk && inventoryRecorded && credentialOk && identityOk && acknowledgementOk && online;
  const executing = taskExecuting === true;
  const extras = input.extras ?? null;
  const requirements = extras?.requirements ?? [];
  const blocking = blockingUnmet(requirements);
  const health = extras?.health ?? null;
  // A run of fewer than HEALTH_FAILURE_THRESHOLD failed probes after the employee was last seen healthy is "degraded" (the probe is still retrying); the threshold turns it into "unavailable".
  const degradedByProbe = Boolean(health && health.consecutiveFailures > 0 && health.consecutiveFailures < HEALTH_FAILURE_THRESHOLD && health.lastHealthyAt);

  let stage: ReadinessStage;
  let tone: ReadinessTone;
  let label: string;
  let title: string;
  let description: string;
  let cta: ReadinessCta;

  if (!enabled) {
    stage = "disabled";
    tone = "neutral";
    label = "Paused";
    title = "This employee is paused";
    description = "Its configuration, knowledge and history are preserved. Re-enable it before starting new conversations.";
    cta = "none";
  } else if (extras?.suspended) {
    stage = "suspended";
    tone = "neutral";
    label = "Suspended";
    title = "This workspace is suspended";
    description = extras.suspended.reason;
    cta = "none";
  } else if (input.paymentCleared === false && !authorized) {
    stage = "setup";
    tone = "warning";
    label = SETUP_REQUIRED_LABEL;
    title = "Waiting for your setup payment";
    description = `${PAYMENT_REQUIRED_SENTENCE}.`;
    cta = "none";
  } else if (hasPendingReview && !configured) {
    stage = "review";
    tone = "violet";
    label = "Awaiting review";
    title = "A configuration change is under review";
    description = "The requested version is held for review and is not active.";
    cta = "history";
  } else if (!configured) {
    stage = "setup";
    tone = "warning";
    label = SETUP_REQUIRED_LABEL;
    title = `Finish setting up ${input.displayName ?? "this employee"}`;
    description = "Apply an initial configuration, then verify the Hermes connection. Conversations stay unavailable until the required checks pass.";
    cta = "configure";
  } else if (!checked || lastHealthOk === null) {
    stage = "connection";
    tone = "warning";
    label = "Connection check required";
    title = "Verify the Hermes connection";
    description = "The configuration is applied. Run the authorized connection check to verify the profile and record its runtime tool inventory.";
    cta = "connection";
  } else if (!healthOk && degradedByProbe) {
    stage = "degraded";
    tone = "warning";
    label = "Degraded";
    title = "The last connection check failed; re-checking";
    description = `${health!.consecutiveFailures} of ${HEALTH_FAILURE_THRESHOLD} automatic re-checks have failed since this employee was last healthy. It reads Unavailable if the next ones fail too. ${lastHealthDetail?.trim() ?? ""}`.trim();
    cta = "connection";
  } else if (!healthOk) {
    stage = "attention";
    tone = "danger";
    label = health && health.consecutiveFailures >= HEALTH_FAILURE_THRESHOLD ? "Unavailable" : "Connection needs attention";
    title = health && health.consecutiveFailures >= HEALTH_FAILURE_THRESHOLD ? `Unavailable after ${health.consecutiveFailures} failed checks` : "The last connection check did not pass";
    description = lastHealthDetail?.trim() || "The latest health check did not verify this employee. Review the connection detail and run the check again.";
    cta = "connection";
  } else if (!credentialOk) {
    stage = "attention";
    tone = "danger";
    label = "Connection needs attention";
    title = "The saved Hermes credential is unavailable";
    description = "The credential used for the last connection check is revoked or missing. Restore the authorized credential and recheck the connection before starting work.";
    cta = "connection";
  } else if (!inventoryRecorded) {
    stage = "inventory";
    tone = "warning";
    label = "Inventory verification required";
    title = inventoryDigest ? "Verify the runtime tool inventory" : "Record the approved tool inventory";
    description = inventoryDigest
      ? "The saved inventory evidence is incomplete or failed validation. Run the authorized health check before starting new work."
      : "A successful health check must record the complete, reviewed runtime inventory before new work can be queued.";
    cta = "connection";
  } else if (identityApplies && !identityOk) {
    stage = "identity";
    tone = "warning";
    label = "Identity check required";
    title = "Verify the saved Hermes profile identity";
    description = "The profile check does not match the current applied configuration, gateway or approved tool permissions. Refresh identity verification before acknowledgement.";
    cta = "connection";
  } else if (acknowledgementApplies && !acknowledgementOk) {
    stage = "approval";
    tone = "warning";
    label = "Awaiting Super Admin acknowledgement";
    title = "Record the current administrative acknowledgement";
    description = "A Super Admin acknowledgement is required for this verified internal profile, applied configuration and reviewed tool inventory.";
    cta = "connection";
  } else if (!online) {
    stage = "attention";
    tone = "danger";
    label = "Unavailable";
    title = "This employee is not online";
    description = lastHealthDetail?.trim() || "The recorded state is not available for chat. Review the connection detail and run the check again.";
    cta = "connection";
  } else if (executing) {
    stage = "working";
    tone = "primary";
    label = "Working / executing";
    title = "This employee has a running task";
    description = "A current run is recorded as executing. New work remains subject to the same readiness and approval checks.";
    cta = "chat";
  } else if (blocking.length) {
    stage = "incomplete";
    tone = "warning";
    label = "Configuration incomplete";
    title = blocking.length === 1 ? blocking[0].label + " is missing" : `${blocking.length} things this role needs are missing`;
    description = `The connection is verified, so this employee can chat, but it is not ready for authorized work yet. ${blocking.map((b) => b.detail).join(" ")}`;
    cta = "chat";
  } else {
    stage = "ready";
    tone = "success";
    label = "Ready for authorized work";
    title = "Ready for authorized work";
    description = inventoryCurrent
      ? "The applied configuration, connection, current inventory and applicable identity and acknowledgement checks are satisfied."
      : "The saved inventory baseline and applicable identity and acknowledgement checks are in place. The server refreshes the short-lived attestation before saving a new chat message; any material change blocks work for review.";
    cta = "chat";
  }

  const pendingReviewStep = hasPendingReview && !configured;
  const configuration: ReadinessStep = {
    key: "configuration",
    label: pendingReviewStep ? "Configuration awaiting review" : "Configuration applied",
    description: pendingReviewStep
      ? "A requested version is held for review. It is not active."
      : configured
        ? configVersion !== null ? `Version ${configVersion} is the applied configuration.` : "An applied configuration is recorded."
        : "No configuration has been applied yet.",
    state: configured ? "done" : pendingReviewStep ? "blocked" : "current",
  };
  const connection: ReadinessStep = {
    key: "connection",
    label: "Connection verified",
    description: !checked
      ? "Run a connection check after the configuration is applied."
      : healthOk
        ? "The latest authenticated health check passed."
        : lastHealthDetail?.trim() || "The latest connection check did not pass.",
      state: healthOk && credentialOk ? "done" : checked ? "blocked" : configured ? "current" : "upcoming",
  };
  const inventory: ReadinessStep = {
    key: "inventory",
    label: "Verified runtime tool inventory",
    description: inventoryCurrent
      ? `The verified inventory is recorded${inventoryToolCount ? ` (${inventoryToolCount} tools)` : ""} with a current short-lived attestation.`
      : inventoryRecorded
        ? `The verified inventory remains recorded${inventoryToolCount ? ` (${inventoryToolCount} tools)` : ""}. Its short-lived attestation is refreshed server-side before a new chat is saved; a changed inventory blocks work for review.`
        : "A passing health check records the complete reviewed tool inventory.",
    state: inventoryRecorded ? "done" : healthOk ? "current" : "upcoming",
  };

  const steps: ReadinessStep[] = [configuration, connection, inventory];
  if (identityApplies) {
    steps.push({
      key: "identity",
      label: "Hermes identity verified for this configuration",
      description: !credentialOk
        ? "The saved Hermes credential is missing or revoked. Restore the authorized credential before identity verification."
        : identityOk
        ? "The saved profile, gateway, API contract and reviewed permissions match the applied configuration."
        : "Verify the expected saved profile and API contract after applying the current configuration.",
      state: identityOk && credentialOk ? "done" : inventoryRecorded ? "current" : "upcoming",
    });
  }
  if (acknowledgementApplies) {
    steps.push({
      key: "acknowledgement",
      label: "Super Admin acknowledgement current",
      description: acknowledgementOk
        ? "The acknowledgement matches the current internal profile, configuration and tool inventory digest."
        : "A Super Admin must acknowledge the verified identity and the currently reviewed inventory.",
      state: acknowledgementOk ? "done" : identityOk && inventoryRecorded ? "current" : "upcoming",
    });
  }
  if (requirements.length) {
    steps.push({
      key: "requirements",
      label: "Role prerequisites in place",
      description: blocking.length
        ? blocking.map((b) => b.detail).join(" ")
        : requirements.some((r) => !r.met)
          ? `Everything this role needs is in place. Still helpful: ${requirements.filter((r) => !r.met).map((r) => r.label.toLowerCase()).join(", ")}.`
          : "Everything this role needs to do its job is in place.",
      state: blocking.length ? (authorized ? "current" : "upcoming") : "done",
    });
  }
  const workReady = authorized && blocking.length === 0 && stage !== "degraded" && stage !== "suspended";
  steps.push({
    key: "ready",
    label: "Ready for authorized work",
    description: !authorized
      ? "This becomes available when every requirement above is satisfied."
      : blocking.length
        ? "The connection is verified. The role prerequisites above must be in place before this employee reads as ready."
        : inventoryCurrent
          ? "All recorded requirements are current."
          : "A fresh inventory check runs before a new chat is saved. Changes to tools or approval evidence block work.",
    state: workReady ? "done" : "upcoming",
  });

  const completed = steps.filter((step) => step.state === "done").length;
  return {
    stage, state: status === "provisioning" && (stage === "connection" || stage === "inventory") ? "provisioning" : readinessStateOf(stage), tone, label, title, description, cta, steps, completed, total: steps.length,
    chatAvailable: authorized, workReady, requirements, blocking, health, inventoryAttestationCurrent: inventoryCurrent, executing,
  };
}

/** Short factual line for cards and compact headers. Never invents a reason. */
export function readinessSummary(input: EmployeeReadinessInput): string {
  return deriveEmployeeReadiness(input).description;
}
