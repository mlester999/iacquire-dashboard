import "server-only";
import type { Queryable } from "@/server/db";
import { AGENT_BY_KEY, type AgentRoleKey } from "@/lib/agents";
import { HEALTH_FAILURE_THRESHOLD } from "@/lib/workforce-readiness";
import { notifyAgency, notifyOrgRoles } from "@/server/notifications";
import { recordAudit } from "@/server/audit";

// What an AI employee's health checks add up to: a count of failures IN A ROW, when it was last healthy, and one alert per outage. Every observation (the scheduled probe, an
// administrator's "check connection", the probe's own timeout) goes through recordHealthObservation, so the numbers a screen shows are the same whoever looked. Migration 0109 adds the
// columns; until it is applied everything here quietly does nothing, so a deployment that runs ahead of the migration keeps its health checks working.

export interface HealthObservation {
  /** Failed checks in a row after this observation (0 when it passed). */
  consecutiveFailures: number;
  previousFailures: number;
  /** It passed after at least one failure. */
  recovered: boolean;
  /** The agency was already told about the outage this observation ended or continues. */
  wasAlerted: boolean;
  /** This failure is the one that reaches the threshold. */
  crossedThreshold: boolean;
}

let columnsPresent = false;

/** Whether migration 0109's columns exist. A positive answer is remembered; a negative one is asked again, so applying the migration takes effect without a restart. */
export async function healthProbeSchemaReady(db: Queryable): Promise<boolean> {
  if (columnsPresent) return true;
  const { rows } = await db.query<{ n: number }>(
    "select count(*)::int as n from information_schema.columns where table_schema = 'public' and table_name = 'agent_instances' and column_name in ('health_consecutive_failures', 'last_healthy_at', 'health_alerted_at')",
  );
  columnsPresent = (rows[0]?.n ?? 0) === 3;
  return columnsPresent;
}

/** Test seam: forget the remembered answer. */
export function resetHealthProbeSchemaMemo() {
  columnsPresent = false;
}

/** Records one check's outcome on the employee, in the caller's transaction. Returns null when migration 0109 is not applied. */
export async function recordHealthObservation(db: Queryable, input: { agentId: string; ok: boolean; source: "scheduled" | "manual"; now?: Date }): Promise<HealthObservation | null> {
  if (!(await healthProbeSchemaReady(db))) return null;
  const { rows: before } = await db.query<{ failures: number; alerted: Date | null }>(
    "select health_consecutive_failures as failures, health_alerted_at as alerted from agent_instances where id = $1 for update",
    [input.agentId],
  );
  if (!before[0]) return null;
  const previousFailures = before[0].failures;
  const consecutiveFailures = input.ok ? 0 : previousFailures + 1;
  const at = (input.now ?? new Date()).toISOString();
  await db.query(
    `update agent_instances set
       health_consecutive_failures = $2,
       last_healthy_at = case when $3 then $5::timestamptz else last_healthy_at end,
       last_health_failure_at = case when $3 then last_health_failure_at else $5::timestamptz end,
       last_probe_at = $5::timestamptz, last_probe_source = $4
     where id = $1`,
    [input.agentId, consecutiveFailures, input.ok, input.source, at],
  );
  return {
    consecutiveFailures,
    previousFailures,
    recovered: input.ok && previousFailures > 0,
    wasAlerted: before[0].alerted !== null,
    crossedThreshold: !input.ok && consecutiveFailures >= HEALTH_FAILURE_THRESHOLD,
  };
}

/**
 * Tells people about an outage once and about its end once. Below the threshold nothing is sent (a screen shows "Degraded"); at the threshold the workspace's owners and admins and
 * the agency staff who look after it get one notice, and `health_alerted_at` keeps the next failed probe from sending another. A recovery is announced only if the outage was.
 * Notices go to people who already work with the workspace and say only what is recorded; nothing is sent to a customer.
 */
export async function announceHealthObservation(
  db: Queryable,
  input: { orgId: string; agentId: string; role: AgentRoleKey; observation: HealthObservation; detail: string },
): Promise<{ alerted: boolean; recovered: boolean }> {
  const { observation } = input;
  const meta = AGENT_BY_KEY[input.role];
  if (!meta) return { alerted: false, recovered: false };
  const link = `/employees/${meta.slug}`;
  let alerted = false;
  let recovered = false;

  if (observation.crossedThreshold && !observation.wasAlerted) {
    // Conditional update: two probes finishing together cannot both raise the alert.
    const claimed = await db.query("update agent_instances set health_alerted_at = now() where id = $1 and health_alerted_at is null returning id", [input.agentId]);
    if (claimed.rows.length) {
      alerted = true;
      const body = `${meta.shortName} failed ${observation.consecutiveFailures} automatic connection checks in a row. ${input.detail}`.slice(0, 900);
      await notifyOrgRoles(db, input.orgId, ["owner", "admin"], { kind: "integration_disconnected", severity: "critical", title: `${meta.shortName} is unavailable`, body, link });
      await notifyAgency(db, input.orgId, { kind: "integration_disconnected", severity: "critical", title: `${meta.shortName} is unavailable`, body, link: `/admin/employees` });
      await recordAudit({
        orgId: input.orgId, actorUserId: null, actorKind: "system", agentInstanceId: input.agentId, action: "agent.health_alert", targetType: "agent_instance", targetId: input.agentId, result: "failure",
        metadata: { consecutiveFailures: observation.consecutiveFailures, threshold: HEALTH_FAILURE_THRESHOLD },
      }, db);
    }
  }

  if (observation.recovered && observation.wasAlerted) {
    const cleared = await db.query("update agent_instances set health_alerted_at = null where id = $1 and health_alerted_at is not null returning id", [input.agentId]);
    if (cleared.rows.length) {
      recovered = true;
      const body = `${meta.shortName} passed its connection check again after ${observation.previousFailures} failed ${observation.previousFailures === 1 ? "check" : "checks"}.`;
      await notifyOrgRoles(db, input.orgId, ["owner", "admin"], { kind: "agent_status", severity: "success", title: `${meta.shortName} is back online`, body, link });
      await notifyAgency(db, input.orgId, { kind: "agent_status", severity: "success", title: `${meta.shortName} is back online`, body, link: `/admin/employees` });
      await recordAudit({
        orgId: input.orgId, actorUserId: null, actorKind: "system", agentInstanceId: input.agentId, action: "agent.health_recovered", targetType: "agent_instance", targetId: input.agentId, result: "success",
        metadata: { previousFailures: observation.previousFailures },
      }, db);
    }
  } else if (observation.recovered) {
    // A recovery from a short, unannounced blip: the failure count is already back to zero; there is nothing to announce.
  }
  return { alerted, recovered };
}
