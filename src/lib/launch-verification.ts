import type { AgentRoleKey } from "@/lib/agents";
import type { CapabilityKey } from "@/lib/workforce-capabilities";

// The final functional check of a client's AI team. Each employee is asked to do one reviewed, read-only piece of its own work on the client's real records, through the same
// path as any authorized job (dispatcher, durable job, worker, result). Nothing is written to a business record, nothing is sent and nobody is booked. A passed check is a
// finished job for the employee's current configuration; a new configuration version makes it stale (src/lib/launch-readiness.ts).

/** The one read-only capability each role is checked with. */
export const LAUNCH_VERIFICATION_CAPABILITY: Record<AgentRoleKey, CapabilityKey> = {
  operations_manager: "proactive_review",
  lead_hunter: "lead_generation_review",
  appointment_setter: "appointment_availability",
  sales_assistant: "pipeline_review",
  crm_manager: "crm_quality_review",
  performance_analyst: "performance_snapshot",
};

/** What marks a job as a launch check, and which configuration it was run against. Read back by the launch-readiness facts. */
export function launchVerificationInput(configVersion: number | null): { launchVerification: true; configVersion: number | null } {
  return { launchVerification: true, configVersion };
}

/**
 * One job per employee, workspace and configuration version, however many times the button is pressed while it runs. `round` counts the checks that already finished for this
 * version, so a check that failed can be run again (a new job) while a double click on a running one reuses the same job.
 */
export function launchVerificationKey(o: { orgId: string; role: AgentRoleKey; configVersion: number | null; round: number }): string {
  return `launch-check:${o.orgId}:${o.role}:v${o.configVersion ?? 0}:r${o.round}`;
}
