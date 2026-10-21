import "server-only";
import crypto from "node:crypto";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { canChat, type AgentRoleKey, type AgentStatus } from "@/lib/agents";
import { capabilityDefinition, type CapabilityKey } from "@/lib/workforce-capabilities";
import type { OrgContext } from "@/server/tenancy/context";
import { createWorkJob } from "@/server/workforce/jobs";
import { kickWorkJob } from "@/server/workforce/work-runner";

/**
 * The one server-side dispatcher for reviewed business capabilities.
 *
 * It resolves the caller's own employee row, checks the role allowlist and the required caller
 * permission, refuses an unavailable employee, creates the durable job and only then wakes the
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
  },
): Promise<{ jobId: string; agentId: string }> {
  const definition = capabilityDefinition(input.capability);
  if (!definition) throw new AppError("invalid_input", "That capability is not available.");
  if (!definition.allowedRoles.includes(input.agentRole)) {
    throw new AppError("forbidden", "This employee's role does not include that capability.");
  }
  // Only a member of the workspace's AI workforce can dispatch AI work. Capability permissions
  // (contacts.view, sales.view, etc.) are additional, not a replacement for this baseline.
  if (!ctx.can("agents.use")) throw new AppError("forbidden", "Your role can't start AI work.");
  if (!ctx.can(definition.requiredPermission)) {
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

  const idempotencyKey = input.idempotencyKey ?? `${input.capability}:${input.agentRole}:${crypto.randomUUID()}`;
  const job = await withSystem(async (db) => {
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
    return created;
  });
  if (!input.deferKick) kickWorkJob(job.id);
  return { jobId: job.id, agentId: agent.id };
}
