import type { AgentStatus } from "@/lib/agents";
import { toolInventoryReady } from "@/lib/hermes-tool-inventory";

export type ReadinessStage =
  | "disabled"
  | "review"
  | "setup"
  | "connection"
  | "inventory"
  | "identity"
  | "attention"
  | "approval"
  | "ready"
  | "working";

export type ReadinessTone = "neutral" | "warning" | "danger" | "success" | "primary" | "violet";
export type ReadinessCta = "configure" | "history" | "chat" | "connection" | "none";
export type ReadinessStepState = "done" | "current" | "upcoming" | "blocked" | "not_applicable";

export interface ReadinessStep {
  key: "configuration" | "connection" | "inventory" | "identity" | "acknowledgement" | "ready";
  label: string;
  description: string;
  state: ReadinessStepState;
}

export interface EmployeeReadiness {
  stage: ReadinessStage;
  tone: ReadinessTone;
  label: string;
  title: string;
  description: string;
  cta: ReadinessCta;
  steps: ReadinessStep[];
  completed: number;
  total: number;
  chatAvailable: boolean;
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
  /** Fixed per server render to avoid server/client clock drift at the two-minute expiry boundary. */
  evaluatedAt?: string | Date | number;
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
  const checkedAt = validTimestamp(evidence.checkedAt);
  return Boolean(
    internalIdentityIsCurrent(evidence)
    && acknowledgedAt !== null
    && checkedAt !== null
    && acknowledgedAt >= checkedAt
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
  const inventoryRecorded = Boolean(inventoryDigest);
  const evaluatedAt = input.evaluatedAt ? new Date(input.evaluatedAt) : new Date();
  const inventoryCurrent = toolInventoryReady({
    last_health_ok: lastHealthOk,
    tool_inventory_contract: inventoryContract,
    tool_inventory_digest: inventoryDigest,
    tool_inventory_verified_at: inventoryVerifiedAt,
    tool_inventory_expires_at: inventoryExpiresAt,
    tool_inventory_tool_count: inventoryToolCount ?? null,
  }, evaluatedAt);
  const identityApplies = isAgencyEmployee;
  const identityOk = !identityApplies || identityCurrent === true;
  const credentialOk = credentialCurrent !== false;
  const acknowledgementApplies = isAgencyEmployee;
  const acknowledgementOk = !acknowledgementApplies || acknowledgementCurrent === true;
  const online = enabled && (status === "online" || status === "busy");
  const authorized = enabled && configured && healthOk && inventoryCurrent && credentialOk && identityOk && acknowledgementOk && online;
  const executing = taskExecuting === true;

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
    label = "Setup required";
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
  } else if (!healthOk) {
    stage = "attention";
    tone = "danger";
    label = "Connection needs attention";
    title = "The last connection check did not pass";
    description = lastHealthDetail?.trim() || "The latest health check did not verify this employee. Review the connection detail and run the check again.";
    cta = "connection";
  } else if (!credentialOk) {
    stage = "attention";
    tone = "danger";
    label = "Connection needs attention";
    title = "The saved Hermes credential is unavailable";
    description = "The credential used for the last connection check is revoked or missing. Restore the authorized credential and recheck the connection before starting work.";
    cta = "connection";
  } else if (!inventoryCurrent) {
    stage = "inventory";
    tone = "warning";
    label = inventoryRecorded ? "Inventory expired / needs verification" : "Inventory verification required";
    title = inventoryRecorded ? "Refresh the runtime tool inventory" : "Record the approved tool inventory";
    description = inventoryRecorded
      ? "The stored tool inventory attestation has expired or is incomplete. Run the authorized health check to refresh it before new work is queued."
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
  } else {
    stage = "ready";
    tone = "success";
    label = "Ready for authorized work";
    title = "Ready for authorized work";
    description = "The applied configuration, connection, current inventory and applicable identity and acknowledgement checks are satisfied.";
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
    label: "Runtime tool inventory current",
    description: inventoryCurrent
      ? `The approved inventory is recorded${inventoryToolCount ? ` (${inventoryToolCount} tools)` : ""} and current.`
      : inventoryRecorded
        ? "The stored inventory attestation expired or failed validation; refresh it through the health check."
        : "A passing health check records the complete reviewed tool inventory.",
    state: inventoryCurrent ? "done" : inventoryRecorded ? "blocked" : healthOk ? "current" : "upcoming",
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
      state: identityOk && credentialOk ? "done" : inventoryCurrent ? "current" : "upcoming",
    });
  }
  if (acknowledgementApplies) {
    steps.push({
      key: "acknowledgement",
      label: "Super Admin acknowledgement current",
      description: acknowledgementOk
        ? "The acknowledgement matches the current internal profile, configuration and tool inventory digest."
        : "A Super Admin must acknowledge the verified identity and the currently reviewed inventory.",
      state: acknowledgementOk ? "done" : identityOk && inventoryCurrent ? "current" : "upcoming",
    });
  }
  steps.push({
    key: "ready",
    label: "Ready for authorized work",
    description: authorized ? "All recorded requirements are current." : "This becomes available when every requirement above is satisfied.",
    state: authorized ? "done" : "upcoming",
  });

  const completed = steps.filter((step) => step.state === "done").length;
  return { stage, tone, label, title, description, cta, steps, completed, total: steps.length, chatAvailable: authorized, executing };
}

/** Short factual line for cards and compact headers. Never invents a reason. */
export function readinessSummary(input: EmployeeReadinessInput): string {
  return deriveEmployeeReadiness(input).description;
}
