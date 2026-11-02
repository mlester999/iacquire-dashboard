import type { AgentRoleKey } from "@/lib/agents";
import type { CapabilityKey } from "@/lib/workforce-capabilities";

// The final functional check of a client's AI team. Each employee is asked to do one reviewed, read-only piece of its own work on the client's real records, through the same
// path as any authorized job (dispatcher, durable job, worker, result). Nothing is written to a business record, nothing is sent and nobody is booked. A passed check is a
// finished job for the employee's current configuration and for what the check reads; a new configuration version, or a change to what it reads, makes it stale
// (src/lib/launch-readiness.ts).

/** The one read-only capability each role is checked with. */
export const LAUNCH_VERIFICATION_CAPABILITY: Record<AgentRoleKey, CapabilityKey> = {
  operations_manager: "proactive_review",
  lead_hunter: "lead_generation_review",
  appointment_setter: "appointment_availability",
  sales_assistant: "pipeline_review",
  crm_manager: "crm_quality_review",
  performance_analyst: "performance_snapshot",
};

/** A piece of the client's own setup that a role's check reads. When it changes, a check that ran before it proves nothing about the new setup. */
export type VerificationInput = "calendar_types" | "host_rules" | "targeting_criteria" | "pipeline_stages";

const VERIFICATION_INPUTS: Record<AgentRoleKey, readonly VerificationInput[]> = {
  operations_manager: [],
  lead_hunter: ["targeting_criteria"],
  appointment_setter: ["calendar_types", "host_rules"],
  sales_assistant: ["pipeline_stages"],
  crm_manager: ["pipeline_stages"],
  performance_analyst: [],
};

/**
 * What each role's check depends on, besides the employee's own configuration. Knowledge is deliberately not an input: no check reads it, so saving a knowledge section must
 * start nothing. An empty list means the check depends on the configuration alone.
 */
export function verificationInputs(role: AgentRoleKey): readonly VerificationInput[] {
  return VERIFICATION_INPUTS[role];
}

export const VERIFICATION_INPUT_LABEL: Record<VerificationInput, string> = {
  calendar_types: "appointment types",
  host_rules: "host hours",
  targeting_criteria: "lead targeting",
  pipeline_stages: "pipeline stages",
};

/**
 * What marks a job as a launch check, which configuration it was run against and, for a role whose check reads the client's setup, a digest of that setup at the time. Read
 * back by the launch-readiness facts. A role with nothing to read carries no digest, and neither does a check recorded before digests existed.
 */
export function launchVerificationInput(configVersion: number | null, inputsDigest: string | null = null): { launchVerification: true; configVersion: number | null; inputsDigest?: string } {
  return { launchVerification: true, configVersion, ...(inputsDigest ? { inputsDigest } : {}) };
}

/**
 * Whether a check covers the setup as it is now. A check with no digest (an old job, or a role with nothing to read) covers whatever the digest is: it stays valid for its
 * configuration version, exactly as before digests existed. Otherwise the two digests must be the same.
 */
export function checkCoversInputs(checkDigest: string | null | undefined, currentDigest: string | null | undefined): boolean {
  return !checkDigest || !currentDigest || checkDigest === currentDigest;
}

/**
 * One job per employee, workspace, configuration version and (where the check reads the client's setup) setup digest, however many times the button is pressed while it runs.
 * `round` counts the checks that already finished for this version and setup, so a check that failed can be run again (a new job) while a double click on a running one reuses
 * the same job. Without a digest the key is the one it always was.
 */
export function launchVerificationKey(o: { orgId: string; role: AgentRoleKey; configVersion: number | null; round: number; inputsDigest?: string | null }): string {
  const digest = o.inputsDigest ? `:d${o.inputsDigest.slice(0, 12)}` : "";
  return `launch-check:${o.orgId}:${o.role}:v${o.configVersion ?? 0}${digest}:r${o.round}`;
}
