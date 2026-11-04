import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { authorizeEmployeeAction, type PolicyAction } from "@/lib/employee-tool-policy";
import { isWorkforceRoleKey, type WorkforceRoleKey } from "@/lib/agents";

// The server's side of the AI employee tool policy (src/lib/employee-tool-policy.ts). The role is read from the employee's own database row, in the workspace the caller names, and
// the decision is the pure table's: nothing a model said, nothing in a prompt and nothing the caller claims about the role can widen it. A refusal leaves an audit record (who asked,
// which employee, which action, why), because a refused action is the first sign of a prompt trying to reach past its role.

export interface AuthorizedAction {
  role: WorkforceRoleKey;
  action: PolicyAction;
}

interface DenialInput {
  orgId: string;
  agentId: string | null;
  actionId: string;
  actorUserId?: string | null;
  actorKind?: "user" | "system" | "agent";
  role?: string | null;
  /** The work job the refusal stopped, when there is one, so the row can be tied to the request that was blocked. */
  jobId?: string | null;
  reason: string;
}

/** Writes the refusal to the audit log. Never throws: a full audit table must not turn a refusal into an allowance. */
export async function recordActionDenied(input: DenialInput, db?: Queryable): Promise<void> {
  try {
    await recordAudit({
      orgId: input.orgId, actorUserId: input.actorUserId ?? null, actorKind: input.actorKind ?? "system", agentInstanceId: input.agentId ?? undefined,
      action: "agent.action_denied", targetType: "agent_instance", targetId: input.agentId ?? undefined, result: "denied",
      metadata: { actionId: input.actionId, role: input.role ?? null, ...(input.jobId ? { jobId: input.jobId } : {}), reason: input.reason.slice(0, 200) },
    }, db);
  } catch {
    // Deliberately swallowed: see above.
  }
}

export type AgentActionDecision =
  | { allowed: true; role: WorkforceRoleKey; action: PolicyAction }
  | { allowed: false; code: "forbidden" | "not_found"; message: string; role: WorkforceRoleKey | null; reason: string };

/**
 * The decision alone: no write, no throw, so it can run inside a caller's transaction without a refusal rolling back its own record. `agentId` must belong to `orgId` (another tenant's
 * employee is "not found") and the role is read from that row, never taken from the caller.
 */
export async function decideAgentAction(db: Queryable, input: { orgId: string; agentId: string; actionId: string }): Promise<AgentActionDecision> {
  const { rows } = await db.query<{ role_key: string }>("select role_key from agent_instances where id = $1 and org_id = $2", [input.agentId, input.orgId]);
  if (!rows[0]) return { allowed: false, code: "not_found", message: "AI employee not found.", role: null, reason: "The employee does not belong to this workspace." };
  const rawRole = rows[0].role_key;
  if (!isWorkforceRoleKey(rawRole)) return { allowed: false, code: "forbidden", message: "This AI employee role is not supported.", role: null, reason: "The employee has an unsupported role." };
  const role = rawRole;
  const decision = authorizeEmployeeAction(role, input.actionId);
  if (decision.allowed) return { allowed: true, role, action: decision.action };
  return { allowed: false, code: "forbidden", message: decision.reason, role, reason: decision.reason };
}

/**
 * Authorizes one action for one employee of one workspace, or throws AppError("forbidden" | "not_found") with the policy's reason, after writing the refusal to the audit log. The
 * decision is read first and the refusal is recorded on its own, so it survives the failure it reports.
 */
export async function enforceAgentAction(
  input: { orgId: string; agentId: string; actionId: string; actorUserId?: string | null; actorKind?: "user" | "system" | "agent" },
): Promise<AuthorizedAction> {
  const decision = await withSystem((db) => decideAgentAction(db, input));
  if (decision.allowed) return { role: decision.role, action: decision.action };
  await recordActionDenied({ ...input, role: decision.role, reason: decision.reason });
  throw new AppError(decision.code, decision.message);
}
