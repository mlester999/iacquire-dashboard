import type { AgentStatus } from "@/lib/agents";

/**
 * UI-only derivation of what a person is looking at. It never changes backend state or grants
 * access: every value comes from the recorded employee fields already returned by the server page.
 */
export type ReadinessStage =
  | "disabled"
  | "review"
  | "setup"
  | "connection"
  | "attention"
  | "approval"
  | "ready"
  | "working";

export type ReadinessTone = "neutral" | "warning" | "danger" | "success" | "primary" | "violet";

export type ReadinessCta = "configure" | "history" | "chat" | "connection" | "none";

export type ReadinessStepState = "done" | "current" | "upcoming" | "blocked" | "not_applicable";

export interface ReadinessStep {
  key: "configuration" | "connection" | "inventory" | "acknowledgement" | "ready";
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
  inventoryDigest: string | null;
  /** `null`/`undefined` for client employees, where this agency-only control does not apply. */
  acknowledgementCurrent?: boolean | null;
  /** Only true for an internal agency employee viewed by an agency Super Admin. */
  isAgencyEmployee?: boolean;
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
    inventoryDigest,
    acknowledgementCurrent,
    isAgencyEmployee = false,
  } = input;

  const configured = configVersion !== null || configuredOverride === true;
  const checked = Boolean(lastHealthCheckAt);
  const healthOk = lastHealthOk === true;
  const inventoryRecorded = Boolean(inventoryDigest);
  const ackApplies = isAgencyEmployee && acknowledgementCurrent !== null && acknowledgementCurrent !== undefined;
  const ackOk = !ackApplies || acknowledgementCurrent === true;
  const online = enabled && (status === "online" || status === "busy");
  const ready = enabled && configured && healthOk && inventoryRecorded && ackOk && online;

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
    description = "Part of the requested instructions could affect safety rules. Nothing is applied until iAcquire approves the version.";
    cta = "history";
  } else if (!configured) {
    stage = "setup";
    tone = "warning";
    label = "Setup required";
    title = `Finish setting up ${input.displayName ?? "this employee"}`;
    description = "Apply an initial configuration, then verify the Hermes connection. Conversations stay unavailable until both succeed.";
    cta = "configure";
  } else if (!checked || lastHealthOk === null) {
    stage = "connection";
    tone = "warning";
    label = "Connection check required";
    title = "Verify the Hermes connection";
    description = "The configuration is applied. Run a connection check to verify the profile identity and record the approved runtime tool inventory.";
    cta = "connection";
  } else if (!healthOk) {
    stage = "attention";
    tone = "danger";
    label = "Connection needs attention";
    title = "The last connection check did not pass";
    description = lastHealthDetail?.trim() || "The latest health check did not verify this employee. Review the connection detail and run the check again.";
    cta = "connection";
  } else if (!inventoryRecorded) {
    stage = "connection";
    tone = "warning";
    label = "Inventory not recorded";
    title = "Record the approved tool inventory";
    description = "A successful connection check must persist the verified tool inventory before this employee can run.";
    cta = "connection";
  } else if (ackApplies && !ackOk) {
    stage = "approval";
    tone = "warning";
    label = "Approval required";
    title = "Refresh the administrative approval";
    description = "The Super Admin acknowledgement is older than the latest identity check. Refresh the profile check, then acknowledge again.";
    cta = "connection";
  } else if (!online) {
    stage = "attention";
    tone = "danger";
    label = "Unavailable";
    title = "This employee is not online";
    description = lastHealthDetail?.trim() || "The recorded state is not available for chat. Review the connection detail and run the check again.";
    cta = "connection";
  } else {
    stage = status === "busy" ? "working" : "ready";
    tone = status === "busy" ? "primary" : "success";
    label = status === "busy" ? "Working now" : "Online and ready";
    title = status === "busy" ? "This employee is working on something" : "Ready for authorized work";
    description =
      status === "busy"
        ? "A current task is in progress. New messages can wait until the current response finishes."
        : "The configuration, authenticated connection and approved runtime inventory are current. Chat is available to people with access.";
    cta = "chat";
  }

  const pendingReviewStep = hasPendingReview && !configured;
  const configuration: ReadinessStep = {
    key: "configuration",
    label: pendingReviewStep ? "Configuration awaiting review" : "Configuration applied",
    description: pendingReviewStep
      ? "A requested version is held for iAcquire review. It is not active."
      : configured
        ? configVersion !== null ? `Version ${configVersion} is the applied configuration.` : "An applied configuration is recorded."
        : "No configuration has been applied yet.",
    state: configured ? "done" : pendingReviewStep ? "blocked" : "current",
  };

  const connection: ReadinessStep = {
    key: "connection",
    label: "Hermes connection verified",
    description: !checked
      ? "Run a connection check after the configuration is applied."
      : healthOk
        ? "The latest authenticated health check passed."
        : lastHealthDetail?.trim() || "The latest connection check did not pass.",
    state: healthOk ? "done" : checked ? "blocked" : configured ? "current" : "upcoming",
  };

  const inventory: ReadinessStep = {
    key: "inventory",
    label: "Approved tool inventory stored",
    description: inventoryRecorded
      ? "The reviewed runtime tools and digest are recorded."
      : "A passing health check records the complete, reviewed tool inventory.",
    state: inventoryRecorded ? "done" : healthOk ? "current" : "upcoming",
  };

  const steps: ReadinessStep[] = [configuration, connection, inventory];

  if (ackApplies) {
    steps.push({
      key: "acknowledgement",
      label: "Identity and administrative approval current",
      description: acknowledgementCurrent
        ? "The current identity check and Super Admin acknowledgement match this profile."
        : "The saved acknowledgement is not current. Refresh the profile check and acknowledge it again.",
      state: acknowledgementCurrent ? "done" : healthOk ? "current" : "upcoming",
    });
  }

  steps.push({
    key: "ready",
    label: "Ready for authorized work",
    description: ready ? "All recorded requirements are current." : "This becomes available when every requirement above is satisfied.",
    state: ready ? "done" : "upcoming",
  });

  const completed = steps.filter((step) => step.state === "done").length;

  return { stage, tone, label, title, description, cta, steps, completed, total: steps.length };
}

/** Short factual line for cards and compact headers. Never invents a reason. */
export function readinessSummary(input: EmployeeReadinessInput): string {
  const readiness = deriveEmployeeReadiness(input);
  return readiness.description;
}
