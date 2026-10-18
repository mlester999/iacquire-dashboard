import "server-only";
import type { Queryable } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { sha256 } from "@/server/security/crypto";
import { automationGate, checkOrgAutomation } from "@/server/automation/gate";
import { toolInventoryReady } from "@/server/integrations/hermes/inventory";
import { AGENT_BY_KEY } from "@/lib/agents";
import { isAgentRole } from "@/server/crm/agent-tools/catalog";

/**
 * The workflow "ask an AI employee" step (ai_task). It records the request against the client's own employee for that role and says
 * honestly whether anything will happen:
 *
 *  - blocked: the employee isn't included, is paused, the workspace paused its workflows, iAcquire paused automation, the workspace
 *    isn't active, the employee isn't connected, or live
 *    employee runs are still switched off because the employee's complete tool permissions can't be verified (today: everywhere except
 *    the loopback test environment). Nothing is asked of the employee and nothing changes.
 *  - queued: an agent run (purpose crm_tool) is recorded once per workflow run and step. The employee's CRM changes then go through the
 *    scoped CRM tools, with its mode (approval required or autonomous) and every pause applied to each call.
 *
 * It runs inside the workflow step's transaction and makes no external call.
 */

export interface AgentTaskRequest {
  orgId: string;
  roleKey: string;
  instruction: string;
  contactId?: string | null;
  /** The workflow run asking. With stepKey it makes the request idempotent. */
  runId: string;
  stepKey: string;
}

export interface AgentTaskResult {
  status: "queued" | "blocked";
  detail: string;
  agentRunId?: string;
}

const MAX_INSTRUCTION = 2000;

/**
 * Whether live runs of this employee can go ahead: it is connected to its AI service, its last
 * health check succeeded, and the persisted complete inventory attestation is current. The live
 * adapter re-verifies the gateway inventory immediately before submitting the run, so this is a
 * preflight/UI answer rather than the security boundary.
 */
export function agentLiveRunsVerified(agent: {
  hermes_base_url: string | null;
  hermes_profile: string | null;
  credential_id: string | null;
  last_health_ok?: boolean | null;
  tool_inventory_contract?: string | null;
  tool_inventory_digest?: string | null;
  tool_inventory_verified_at?: Date | string | null;
  tool_inventory_expires_at?: Date | string | null;
  tool_inventory_tool_count?: number | null;
}): boolean {
  if (!agent.hermes_base_url || !agent.credential_id) return false;
  try {
    return toolInventoryReady({
      last_health_ok: agent.last_health_ok,
      tool_inventory_contract: agent.tool_inventory_contract ?? null,
      tool_inventory_digest: agent.tool_inventory_digest ?? null,
      tool_inventory_verified_at: agent.tool_inventory_verified_at ?? null,
      tool_inventory_expires_at: agent.tool_inventory_expires_at ?? null,
      tool_inventory_tool_count: agent.tool_inventory_tool_count ?? null,
    });
  } catch {
    // An unparsable persisted state is simply not verified.
    return false;
  }
}

export async function requestAgentTask(db: Queryable, req: AgentTaskRequest): Promise<AgentTaskResult> {
  if (!isAgentRole(req.roleKey)) return { status: "blocked", detail: "That AI employee role doesn't exist, so nothing was asked." };
  const role = AGENT_BY_KEY[req.roleKey];
  const instruction = req.instruction.trim();
  if (!instruction || instruction.length > MAX_INSTRUCTION) return { status: "blocked", detail: `The instruction must be between 1 and ${MAX_INSTRUCTION} characters, so nothing was asked.` };
  if (!req.runId || !req.stepKey) return { status: "blocked", detail: "The workflow step couldn't be identified, so nothing was asked." };

  const { rows } = await db.query<{ id: string; display_name: string; enabled: boolean; status: string; last_health_ok: boolean | null; last_health_detail: string | null; hermes_base_url: string | null; hermes_profile: string | null; credential_id: string | null; tool_inventory_contract: string | null; tool_inventory_digest: string | null; tool_inventory_verified_at: Date | null; tool_inventory_expires_at: Date | null; tool_inventory_tool_count: number | null }>(
    `select id, display_name, enabled, status, last_health_ok, last_health_detail, hermes_base_url, hermes_profile, credential_id,
            tool_inventory_contract, tool_inventory_digest, tool_inventory_verified_at, tool_inventory_expires_at, tool_inventory_tool_count
     from agent_instances where org_id = $1 and role_key = $2`,
    [req.orgId, req.roleKey],
  );
  const agent = rows[0];
  const name = agent?.display_name || role.shortName;
  const blocked = async (detail: string): Promise<AgentTaskResult> => {
    await recordAudit({
      orgId: req.orgId, actorKind: "system", agentInstanceId: agent?.id ?? null, action: "crm.agent_task_requested", targetType: "crm_workflow_run", targetId: req.runId.slice(0, 120), result: "denied",
      metadata: { stepKey: req.stepKey.slice(0, 60), role: req.roleKey, outcome: "blocked", detail: detail.slice(0, 200) },
    }, db);
    return { status: "blocked", detail };
  };
  if (!agent || !agent.enabled) return blocked(`The ${role.shortName} isn't included in this workspace, so nothing was asked.`);

  if (req.contactId) {
    // A malformed id would abort the caller's transaction in PostgreSQL, so it is refused before any query.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.contactId)) return blocked("The contact couldn't be identified, so nothing was asked.");
    const c = await db.query("select 1 from contacts where id = $1 and org_id = $2 and deleted_at is null", [req.contactId, req.orgId]);
    if (!c.rows[0]) return blocked("The contact no longer exists, so nothing was asked.");
  }

  // Mode and pauses are read now, at the step's execution time: the workspace's workflows pause (the engine checks it too), then the
  // employee's own gate (workspace status, iAcquire pause, included, mode, connection check).
  const org = await checkOrgAutomation(db, req.orgId, "workflows");
  if (!org.allowed) return blocked(`${org.detail} Nothing was asked of ${name}.`);
  const gate = await automationGate(db, { orgId: req.orgId, agentId: agent.id, scope: "job" });
  if (gate.decision === "blocked") return blocked(`${gate.detail} Nothing was asked of ${name}.`);

  if (!agent.hermes_base_url || !agent.credential_id) return blocked(`${name} isn't connected to its AI service yet, so nothing was asked.`);
  if (!agentLiveRunsVerified(agent)) {
    const reason = agent.last_health_detail?.trim() || "its complete runtime tool inventory hasn't been verified";
    const sentence = /[.!?]$/.test(reason) ? reason : `${reason}.`;
    return blocked(`Not sent to ${name}: ${sentence} live AI employee runs stay switched off until the inventory check passes. Nothing was asked and nothing changed.`);
  }

  const key = `crm-task:${req.runId}:${req.stepKey}`.slice(0, 200);
  const ins = await db.query<{ id: string }>(
    `insert into agent_runs (org_id, agent_instance_id, purpose, idempotency_key, status) values ($1, $2, 'crm_tool', $3, 'queued')
     on conflict (idempotency_key) do nothing returning id`,
    [req.orgId, agent.id, key],
  );
  let agentRunId = ins.rows[0]?.id ?? null;
  const created = Boolean(agentRunId);
  if (!agentRunId) {
    const existing = await db.query<{ id: string }>("select id from agent_runs where idempotency_key = $1 and org_id = $2 and agent_instance_id = $3", [key, req.orgId, agent.id]);
    agentRunId = existing.rows[0]?.id ?? null;
    if (!agentRunId) return blocked("This request couldn't be recorded, so nothing was asked.");
  }
  if (created) {
    await recordAudit({
      orgId: req.orgId, actorKind: "system", agentInstanceId: agent.id, action: "crm.agent_task_requested", targetType: "agent_run", targetId: agentRunId, result: "success",
      metadata: { stepKey: req.stepKey.slice(0, 60), role: req.roleKey, outcome: "queued", workflowRunId: req.runId.slice(0, 120), contactId: req.contactId ?? null, instructionHash: sha256(instruction).slice(0, 16), mode: gate.mode },
    }, db);
  }
  const how = gate.decision === "allow" ? "It can make routine CRM changes itself; high-impact ones still wait for approval." : "Its CRM changes wait for a person's approval.";
  return { status: "queued", agentRunId, detail: `Queued for ${name}. ${how}` };
}
