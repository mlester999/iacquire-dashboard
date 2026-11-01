import "server-only";
import crypto from "node:crypto";
import { readSystem, withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { canChat, type AgentRoleKey, type AgentStatus } from "@/lib/agents";
import { capabilityDefinition, type CapabilityKey } from "@/lib/workforce-capabilities";
import type { OrgContext } from "@/server/tenancy/context";
import { assertJobAllowed } from "@/server/automation/job-gate";
import { createWorkJob } from "@/server/workforce/jobs";
import { kickWorkJob } from "@/server/workforce/work-kick";
import { authorizeEmployeeAction } from "@/lib/employee-tool-policy";
import { recordActionDenied } from "@/server/workforce/action-policy";
import { assertAbility, capabilityNeed } from "@/server/workforce/abilities";

/**
 * The one server-side dispatcher for reviewed business capabilities.
 *
 * It resolves the caller's own employee row, checks the role allowlist and the required caller
 * permission, refuses an unavailable employee or one whose ability the owner switched off, creates the durable job and only then wakes the
 * worker. A capability that has no registered handler still creates an honest blocked job rather
 * than pretending to run.
 */
export async function dispatchCapabilityJob(
  ctx: OrgContext,
  input: {
    agentRole: AgentRoleKey;
    capability: CapabilityKey;
    title: string;
    input?: Record<string, unknown>;
    idempotencyKey?: string;
    conversationId?: string | null;
    deferKick?: boolean;
    maxAttempts?: number;
    /** Persist related chat provenance in the same transaction as the durable job. */
    onDispatch?: (db: Queryable, job: { jobId: string; agentId: string }) => Promise<void>;
  },
): Promise<{ jobId: string; agentId: string }> {
  const definition = capabilityDefinition(input.capability);
  if (!definition) throw new AppError("invalid_input", "That capability is not available.");
  // The tool policy table decides (src/lib/employee-tool-policy.ts); a refusal is recorded, because a request for another role's work is what a prompt trying to reach past its role looks like.
  const policy = authorizeEmployeeAction(input.agentRole, `capability:${input.capability}`);
  if (!policy.allowed || !definition.allowedRoles.includes(input.agentRole)) {
    await recordActionDenied({ orgId: ctx.org.orgId, agentId: null, actionId: `capability:${input.capability}`, actorUserId: ctx.user.id, actorKind: "user", role: input.agentRole, reason: policy.allowed ? "This employee's role does not include that capability." : policy.reason });
    throw new AppError("forbidden", "This employee's role does not include that capability.");
  }
  // Only a member of the workspace's AI workforce can dispatch AI work. Capability permissions
  // (contacts.view, sales.view, etc.) are additional, not a replacement for this baseline.
  if (!ctx.can("agents.use")) throw new AppError("forbidden", "Your role can't start AI work.");
  if (![definition.requiredPermission, ...(definition.additionalPermissions ?? [])].every((permission) => ctx.can(permission))) {
    throw new AppError("forbidden", "Your role can't start this work.");
  }

  const agent = await withSystem(async (db) => {
    const { rows } = await db.query<{
      id: string; org_id: string; enabled: boolean; status: string; active_config_version_id: string | null;
    }>(
      `select id, org_id, enabled, status, active_config_version_id
         from agent_instances where org_id = $1 and role_key = $2`,
      [ctx.org.orgId, input.agentRole],
    );
    return rows[0] ?? null;
  });
  if (!agent || agent.org_id !== ctx.org.orgId) throw new AppError("not_found", "AI employee not found.");
  if (!agent.enabled) throw new AppError("agent_unavailable", "This AI employee is paused.");
  if (!canChat(agent.status as AgentStatus)) {
    throw new AppError("agent_unavailable", "This AI employee is not available for authorized work yet.");
  }
  if (!agent.active_config_version_id) throw new AppError("agent_unavailable", "This AI employee has no applied configuration yet.");
  // A paused employee, an agency pause or a suspended workspace: no new work, and the person is told why.
  await withSystem((db) => assertJobAllowed(db, { orgId: ctx.org.orgId, agentId: agent.id }));
  // The owner's "Allowed actions" switches: an ability switched off means the work is refused here and no job exists. (A job queued before the switch was turned off is blocked when it runs.)
  await readSystem((db) => assertAbility(db, { orgId: ctx.org.orgId, agentId: agent.id, roleKey: input.agentRole, actionId: `capability:${input.capability}`, actorUserId: ctx.user.id, need: capabilityNeed(input.capability) }));

  const idempotencyKey = input.idempotencyKey ?? `${input.capability}:${input.agentRole}:${crypto.randomUUID()}`;
  const job = await withSystem(async (db) => {
    await assertJobAllowed(db, { orgId: ctx.org.orgId, agentId: agent.id });
    const created = await createWorkJob(db, {
      orgId: ctx.org.orgId,
      agentId: agent.id,
      requestedBy: ctx.user.id,
      capability: input.capability,
      title: input.title.replace(/\s+/g, " ").slice(0, 200) || definition.label,
      idempotencyKey,
      input: input.input ?? {},
      conversationId: input.conversationId ?? null,
      maxAttempts: input.maxAttempts,
    });
    await recordAudit({
      orgId: ctx.org.orgId,
      actorUserId: ctx.user.id,
      actorKind: "user",
      action: "workforce.capability_dispatched",
      targetType: "ai_work_job",
      targetId: created.id,
      result: "success",
      metadata: { capability: input.capability, agentRole: input.agentRole },
    }, db);
    await input.onDispatch?.(db, { jobId: created.id, agentId: agent.id });
    return created;
  });
  if (!input.deferKick) kickWorkJob(job.id);
  return { jobId: job.id, agentId: agent.id };
}

/**
 * Starts reviewed, read-only work for an employee on iAcquire's own initiative (nobody pressed a button), such as the launch sweep re-running an employee's final check after its
 * configuration changed. Every job still needs an accountable person: the worker refuses work with no recorded requester, and checks that person's permissions again when it runs, so
 * `onBehalfOf` names the workspace owner and a revoked owner blocks the job exactly as it would a request they made themselves. The dispatch itself is audited as the system's, with
 * whom it was for. It refuses anything that is not read-only (a capability that could change a record or needs a human decision can never be started this way), and an idempotency key
 * that already exists returns the job it made (`created: false`) instead of a second one.
 */
export async function dispatchSystemCapabilityJob(input: {
  orgId: string;
  /** The accountable person: an active member of the workspace. */
  onBehalfOf: string;
  agentRole: AgentRoleKey;
  capability: CapabilityKey;
  title: string;
  input?: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<{ jobId: string; agentId: string; created: boolean }> {
  const definition = capabilityDefinition(input.capability);
  if (!definition) throw new AppError("invalid_input", "That capability is not available.");
  if (definition.risk !== "read_only") throw new AppError("forbidden", "Only read-only work can be started without a person.");
  const policy = authorizeEmployeeAction(input.agentRole, `capability:${input.capability}`);
  if (!policy.allowed || !definition.allowedRoles.includes(input.agentRole)) throw new AppError("forbidden", "This employee's role does not include that capability.");

  const agent = await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; enabled: boolean; status: string; active_config_version_id: string | null }>(
      "select id, enabled, status, active_config_version_id from agent_instances where org_id = $1 and role_key = $2",
      [input.orgId, input.agentRole],
    );
    return rows[0] ?? null;
  });
  if (!agent) throw new AppError("not_found", "AI employee not found.");
  if (!agent.enabled) throw new AppError("agent_unavailable", "This AI employee is paused.");
  if (!canChat(agent.status as AgentStatus)) throw new AppError("agent_unavailable", "This AI employee is not available for authorized work yet.");
  if (!agent.active_config_version_id) throw new AppError("agent_unavailable", "This AI employee has no applied configuration yet.");

  const job = await withSystem(async (db) => {
    await assertJobAllowed(db, { orgId: input.orgId, agentId: agent.id });
    const created = await createWorkJob(db, {
      orgId: input.orgId,
      agentId: agent.id,
      requestedBy: input.onBehalfOf,
      capability: input.capability,
      title: input.title.replace(/\s+/g, " ").slice(0, 200) || definition.label,
      idempotencyKey: input.idempotencyKey,
      input: { ...(input.input ?? {}), startedBy: "iacquire_setup" },
    });
    if (created.created) {
      await recordAudit({
        orgId: input.orgId,
        actorUserId: null,
        actorKind: "system",
        action: "workforce.capability_dispatched",
        targetType: "ai_work_job",
        targetId: created.id,
        result: "success",
        metadata: { capability: input.capability, agentRole: input.agentRole, startedBy: "system", onBehalfOf: input.onBehalfOf },
      }, db);
    }
    return created;
  });
  if (job.created) kickWorkJob(job.id);
  return { jobId: job.id, agentId: agent.id, created: job.created };
}
