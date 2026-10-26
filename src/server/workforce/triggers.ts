import "server-only";
import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { canChat, type AgentRoleKey, type AgentStatus } from "@/lib/agents";
import { capabilityDefinition, type CapabilityKey } from "@/lib/workforce-capabilities";
import { TRIGGER_EVENT_CAPABILITIES } from "@/lib/workforce-triggers";
import { jobGate } from "@/server/automation/job-gate";
import { appendWorkEvent, createWorkJob } from "@/server/workforce/jobs";
import { kickWorkJob } from "@/server/workforce/work-kick";
import type { OrgContext } from "@/server/tenancy/context";

/**
 * Tenant-scoped AI workforce event triggers.
 *
 * A trigger maps one reviewed CRM event type to one reviewed, read-only capability. It only creates
 * a durable job when the row is enabled AND the operator has set WORKFORCE_TRIGGERS_ENABLED=true.
 * The tick never executes provider work itself.
 */

export function triggersOperatorEnabled(): boolean {
  return process.env.WORKFORCE_TRIGGERS_ENABLED === "true";
}

export interface TriggerView {
  id: string;
  eventType: string;
  capability: string;
  capabilityLabel: string;
  employeeRole: AgentRoleKey;
  employeeName: string;
  enabled: boolean;
  lastEventId: number;
  lastJobId: string | null;
  operatorEnabled: boolean;
}

type AgentRow = { id: string; role_key: AgentRoleKey; display_name: string; enabled: boolean; status: string; active_config_version_id: string | null };

async function resolveAgent(ctx: OrgContext, role: AgentRoleKey, capability: CapabilityKey): Promise<AgentRow> {
  const definition = capabilityDefinition(capability);
  if (!definition || !definition.allowedRoles.includes(role) || definition.risk !== "read_only") {
    throw new AppError("invalid_input", "That capability cannot be used by an event trigger.");
  }
  const agent = await withSystem(async (db) => {
    const { rows } = await db.query<AgentRow>(
      "select id, role_key, display_name, enabled, status, active_config_version_id from agent_instances where org_id = $1 and role_key = $2",
      [ctx.org.orgId, role],
    );
    return rows[0] ?? null;
  });
  if (!agent) throw new AppError("not_found", "AI employee not found.");
  if (!agent.enabled) throw new AppError("agent_unavailable", "This AI employee is paused.");
  if (!agent.active_config_version_id) throw new AppError("agent_unavailable", "This AI employee has no applied configuration yet.");
  if (!canChat(agent.status as AgentStatus)) throw new AppError("agent_unavailable", "This AI employee is not available for triggered work yet.");
  return agent;
}

export async function listTriggers(ctx: OrgContext): Promise<TriggerView[]> {
  if (!ctx.can("agents.configure")) return [];
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{
      id: string; event_type: string; capability: string; enabled: boolean; last_event_id: string;
      last_job_id: string | null; employee_role: AgentRoleKey; employee_name: string;
    }>(
      `select t.id, t.event_type, t.capability, t.enabled, t.last_event_id::text as last_event_id, t.last_job_id,
              a.role_key as employee_role, a.display_name as employee_name
         from ai_work_triggers t
         join agent_instances a on a.id = t.agent_instance_id and a.org_id = t.org_id
        where t.org_id = $1 order by t.created_at asc`,
      [ctx.org.orgId],
    );
    return rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      capability: row.capability,
      capabilityLabel: capabilityDefinition(row.capability)?.label ?? row.capability.replaceAll("_", " "),
      employeeRole: row.employee_role,
      employeeName: row.employee_name,
      enabled: row.enabled,
      lastEventId: Number(row.last_event_id),
      lastJobId: row.last_job_id,
      operatorEnabled: triggersOperatorEnabled(),
    }));
  });
}

export async function saveTrigger(ctx: OrgContext, input: { eventType: string; enabled: boolean }): Promise<{ id: string; enabled: boolean }> {
  if (!ctx.can("agents.configure")) throw new AppError("forbidden", "Only owners and admins can manage AI triggers.");
  if (!ctx.can("agents.use")) throw new AppError("forbidden", "Your role can't start AI work.");
  const capability = TRIGGER_EVENT_CAPABILITIES[input.eventType];
  if (!capability) throw new AppError("invalid_input", "That event type is not reviewed for an AI trigger.");
  const definition = capabilityDefinition(capability);
  const role = definition?.allowedRoles[0];
  if (!definition || !role) throw new AppError("invalid_input", "That capability has no eligible employee role.");
  if (!ctx.can(definition.requiredPermission)) throw new AppError("forbidden", "Your role can't run this review.");
  const agent = await resolveAgent(ctx, role, capability);
  const saved = await withSystem(async (db) => {
    const current = await db.query<{ id: string }>("select coalesce(max(id),0)::bigint as id from crm_events where org_id = $1", [ctx.org.orgId]);
    const latestEventId = Number(current.rows[0]?.id ?? 0);
    const { rows } = await db.query<{ id: string; enabled: boolean }>(
      `insert into ai_work_triggers (org_id, agent_instance_id, created_by, capability, event_type, enabled, last_event_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (agent_instance_id, capability, event_type) do update set
         enabled = excluded.enabled,
         last_event_id = case when excluded.enabled then excluded.last_event_id else ai_work_triggers.last_event_id end,
         updated_at = now()
       returning id, enabled`,
      [ctx.org.orgId, agent.id, ctx.user.id, capability, input.eventType, Boolean(input.enabled), latestEventId],
    );
    await recordAudit({
      orgId: ctx.org.orgId,
      actorUserId: ctx.user.id,
      actorKind: "user",
      action: "workforce.trigger_saved",
      targetType: "ai_work_trigger",
      targetId: rows[0].id,
      result: "success",
      metadata: { eventType: input.eventType, capability, enabled: Boolean(input.enabled), operatorEnabled: triggersOperatorEnabled() },
    }, db);
    return rows[0];
  });
  return { id: saved.id, enabled: saved.enabled };
}

export async function setTriggerEnabled(ctx: OrgContext, triggerId: string, enabled: boolean): Promise<void> {
  if (!ctx.can("agents.configure")) throw new AppError("forbidden", "Only owners and admins can manage AI triggers.");
  await withSystem(async (db) => {
    const latest = await db.query<{ id: string }>("select coalesce(max(id),0)::bigint as id from crm_events where org_id = $1", [ctx.org.orgId]);
    const { rowCount } = await db.query(
      `update ai_work_triggers
          set enabled = $3,
              last_event_id = case when $3 then $4::bigint else last_event_id end
        where id = $1 and org_id = $2`,
      [triggerId, ctx.org.orgId, enabled, Number(latest.rows[0]?.id ?? 0)],
    );
    if (!rowCount) throw new AppError("not_found", "Trigger not found.");
    await recordAudit({
      orgId: ctx.org.orgId,
      actorUserId: ctx.user.id,
      actorKind: "user",
      action: enabled ? "workforce.trigger_enabled" : "workforce.trigger_disabled",
      targetType: "ai_work_trigger",
      targetId: triggerId,
      result: "success",
      metadata: { operatorEnabled: triggersOperatorEnabled() },
    }, db);
  });
}

export async function deleteTrigger(ctx: OrgContext, triggerId: string): Promise<void> {
  if (!ctx.can("agents.configure")) throw new AppError("forbidden", "Only owners and admins can manage AI triggers.");
  await withSystem(async (db) => {
    const { rowCount } = await db.query("delete from ai_work_triggers where id = $1 and org_id = $2", [triggerId, ctx.org.orgId]);
    if (!rowCount) throw new AppError("not_found", "Trigger not found.");
    await recordAudit({
      orgId: ctx.org.orgId,
      actorUserId: ctx.user.id,
      actorKind: "user",
      action: "workforce.trigger_deleted",
      targetType: "ai_work_trigger",
      targetId: triggerId,
      result: "success",
    }, db);
  });
}

/** Creates jobs for new matching events. The operator switch is checked before any query. */
export async function runDueTriggers(options: { limit?: number } = {}): Promise<{ operatorEnabled: boolean; created: number; skipped: number; jobIds: string[] }> {
  if (!triggersOperatorEnabled()) return { operatorEnabled: false, created: 0, skipped: 0, jobIds: [] };
  const limit = Math.min(10, Math.max(1, options.limit ?? 3));
  const result = await withSystem(async (db) => {
    const { rows: due } = await db.query<{
      id: string; org_id: string; agent_instance_id: string; created_by: string | null; capability: string; event_type: string;
      event_id: string; entity_type: string; entity_id: string | null; contact_id: string | null;
    }>(
      `select t.id, t.org_id, t.agent_instance_id, t.created_by, t.capability, t.event_type,
              e.id::text as event_id, e.entity_type, e.entity_id, e.contact_id
         from ai_work_triggers t
         join lateral (
           select e.id, e.entity_type, e.entity_id, e.contact_id
             from crm_events e
            where e.org_id = t.org_id and e.type = t.event_type and e.id > t.last_event_id
            order by e.id asc limit 1
         ) e on true
        where t.enabled
        order by e.id asc
        for update of t skip locked
        limit $1`,
      [limit],
    );
    const jobIds: string[] = [];
    let skipped = 0;
    for (const trigger of due) {
      const definition = capabilityDefinition(trigger.capability);
      const agent = await db.query<{ role_key: AgentRoleKey; enabled: boolean; status: string; active_config_version_id: string | null }>(
        "select role_key, enabled, status, active_config_version_id from agent_instances where id = $1 and org_id = $2",
        [trigger.agent_instance_id, trigger.org_id],
      );
      const row = agent.rows[0];
      const runnable = Boolean(
        definition
        && definition.risk === "read_only"
        && row?.role_key
        && definition.allowedRoles.includes(row.role_key)
        && row.enabled
        && row.active_config_version_id
        && row.status
        && canChat(row.status as AgentStatus),
      );
      // A pause (the employee's, the agency's) or a suspended workspace skips this event, like an employee that is not ready: the trigger moves on, and no job is created.
      const gate = runnable ? await jobGate(db, { orgId: trigger.org_id, agentId: trigger.agent_instance_id }) : null;
      if (!runnable || (gate && !gate.allowed)) {
        await db.query("update ai_work_triggers set last_event_id = $2 where id = $1", [trigger.id, trigger.event_id]);
        skipped += 1;
        continue;
      }
      const job = await createWorkJob(db, {
        orgId: trigger.org_id,
        agentId: trigger.agent_instance_id,
        requestedBy: trigger.created_by,
        capability: trigger.capability,
        title: `${definition!.label} — triggered by ${trigger.event_type}`,
        idempotencyKey: `trigger:${trigger.id}:${trigger.event_id}`,
        input: {
          triggerId: trigger.id,
          eventId: trigger.event_id,
          eventType: trigger.event_type,
          entityType: trigger.entity_type,
          entityId: trigger.entity_id,
          contactId: trigger.contact_id,
        },
      });
      await db.query("update ai_work_triggers set last_event_id = $2, last_job_id = $3 where id = $1", [trigger.id, trigger.event_id, job.id]);
      await appendWorkEvent(db, {
        jobId: job.id,
        orgId: trigger.org_id,
        kind: "notice",
        message: `Created by an enabled event trigger (${trigger.event_type}).`,
        data: { triggerId: trigger.id, eventId: trigger.event_id },
      });
      jobIds.push(job.id);
    }
    return { created: jobIds.length, skipped, jobIds };
  });
  for (const jobId of result.jobIds) kickWorkJob(jobId);
  return { operatorEnabled: true, ...result };
}
