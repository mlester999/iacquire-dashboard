import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { automationGate, type BlockReason } from "@/server/automation/gate";

/**
 * Background AI work is checked when requested, scheduled, and claimed by a worker. The claim-time
 * check includes readiness so a queued job cannot run after its employee is disabled or loses its
 * connection. Approval-required mode still permits read-only jobs; approval applies to customer-
 * facing actions inside a job, not to the review itself.
 */
export type JobGateDecision = { allowed: true } | { allowed: false; reason: BlockReason; detail: string };

const BLOCKING_REASONS: ReadonlySet<BlockReason> = new Set([
  "org_inactive",
  "agency_paused",
  "agent_paused",
  "agent_disabled",
  "agent_not_ready",
  "agent_missing",
]);

export async function jobGate(db: Queryable, input: { orgId: string; agentId: string }): Promise<JobGateDecision> {
  const decision = await automationGate(db, { orgId: input.orgId, agentId: input.agentId, scope: "job" });
  if (decision.decision === "blocked" && BLOCKING_REASONS.has(decision.reason)) {
    return { allowed: false, reason: decision.reason, detail: decision.detail };
  }
  return { allowed: true };
}

/** Stable failure code for a skipped schedule or a job blocked before execution. */
export const jobBlockCode = (reason: BlockReason): string => `automation_${reason}`;

export async function assertJobAllowed(db: Queryable, input: { orgId: string; agentId: string }): Promise<void> {
  const gate = await jobGate(db, input);
  if (!gate.allowed) throw new AppError("agent_unavailable", gate.detail);
}
