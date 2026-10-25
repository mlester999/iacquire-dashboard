import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { automationGate, type BlockReason } from "@/server/automation/gate";

/**
 * The pause gate for AI work jobs: reviews, research, scheduled and event-triggered work.
 *
 * The gate in `automation/gate.ts` already defined a "job" scope (stopped by the agency pause), but until now no job path called it, so a paused workspace, a paused employee or a
 * suspended workspace could still start and run background work. This is the one place those paths ask, and they ask at three points: when the work is requested (so the person is
 * told why), when a schedule or trigger would create it (so it is skipped with a reason), and when a worker claims it (so work that was queued before a pause does not run after it).
 *
 * Approval mode does not block a job here. "Needs approval" governs what an employee may DO to a customer (send, book, change a record); every job this gate covers is either
 * requested by a person or is a read-only review, and none of them reaches a customer. Staff chat with an employee is deliberately outside this gate (see automation/gate.ts):
 * it stays available while an employee is paused.
 */

export type JobGateDecision = { allowed: true } | { allowed: false; reason: BlockReason; detail: string };

/**
 * Only a PAUSE blocks here: the agency's pause, the employee's own "paused" mode and a workspace that is not active. Whether an employee is enabled, connected and configured is
 * each path's own check, with its own, more specific message (the dispatcher, the schedule and trigger runners, the lead research flow and each handler's role check), and this gate
 * must not pre-empt them: a job for a role that may not do the work still says so, not "not ready".
 */
const PAUSES: ReadonlySet<BlockReason> = new Set<BlockReason>(["org_inactive", "agency_paused", "agent_paused"]);

export async function jobGate(db: Queryable, input: { orgId: string; agentId: string }): Promise<JobGateDecision> {
  const decision = await automationGate(db, { orgId: input.orgId, agentId: input.agentId, scope: "job" });
  if (decision.decision === "blocked" && PAUSES.has(decision.reason)) return { allowed: false, reason: decision.reason, detail: decision.detail };
  return { allowed: true };
}

/** The failure code a blocked job or a skipped schedule carries, so a screen and a test can tell a pause from a failure. */
export const jobBlockCode = (reason: BlockReason): string => `automation_${reason}`;

/** For callers that must not go on: the person who asked is told why, in the gate's own words. */
export async function assertJobAllowed(db: Queryable, input: { orgId: string; agentId: string }): Promise<void> {
  const gate = await jobGate(db, input);
  if (!gate.allowed) throw new AppError("agent_unavailable", gate.detail);
}
