import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import type { CapabilityActivity } from "@/lib/employee-capability-status";

/**
 * The recorded evidence behind "what can this employee actually do": the latest time its role data was read for a chat, how many chats it completed, and what is scheduled.
 * Read-only. Nothing here is inferred; an employee with no record has no activity.
 */
export async function loadCapabilityActivity(orgId: string, agentIds: readonly string[], db?: Queryable): Promise<Map<string, CapabilityActivity>> {
  const out = new Map<string, CapabilityActivity>();
  if (!agentIds.length) return out;
  const run = async (q: Queryable) => {
    const empty = (): CapabilityActivity => ({ lastEvidenceRead: null, completedChatRuns: 0, lastCompletedChatAt: null, scheduledJobsOn: 0 });
    for (const id of agentIds) out.set(id, empty());

    type ReadRow = { agent_instance_id: string; created_at: Date; result: string; metadata: { role?: string; sections?: Record<string, string> } | null };
    const note = (rows: readonly ReadRow[]) => {
      for (const row of rows) {
        const entry = out.get(row.agent_instance_id);
        if (!entry || entry.lastEvidenceRead) continue;
        const sections = Object.entries(row.metadata?.sections ?? {});
        // A read where every area was refused for the person asking proves nothing about the data path, so it is skipped rather than counted either way.
        if (!sections.some(([, state]) => state === "ready" || state === "empty" || state === "not_configured" || state === "unavailable")) continue;
        const unavailable = sections.filter(([, state]) => state === "unavailable").map(([id]) => id.replaceAll("_", " "));
        entry.lastEvidenceRead = { at: new Date(row.created_at).toISOString(), ok: row.result === "success" && unavailable.length === 0, unavailableAreas: unavailable, role: row.metadata?.role ?? "" };
      }
    };
    // A read that was handed to a run which then finished is the strongest proof the data path works: the audit row ties it to that run. Those come first.
    const attached = await q.query<ReadRow>(
      `select a.agent_instance_id, a.created_at, a.result, a.metadata from audit_logs a
         join agent_runs r on r.id = case when a.target_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then a.target_id::uuid end and r.org_id = a.org_id
        where a.org_id = $1 and a.action = 'workforce.employee_evidence_attached' and a.target_type = 'agent_run'
          and a.agent_instance_id = any($2::uuid[]) and r.status = 'completed'
        order by a.created_at desc limit 400`,
      [orgId, [...agentIds]],
    );
    note(attached.rows);
    // An employee with no such row (an older chat, or one whose run never finished) falls back to the plain read record.
    const reads = await q.query<ReadRow>(
      `select agent_instance_id, created_at, result, metadata from audit_logs
        where org_id = $1 and action = 'workforce.employee_evidence_read' and agent_instance_id = any($2::uuid[])
        order by created_at desc limit 400`,
      [orgId, [...agentIds]],
    );
    note(reads.rows);

    const chats = await q.query<{ agent_instance_id: string; n: number; last_at: Date | null }>(
      `select agent_instance_id, count(*)::int as n, max(coalesce(finished_at, started_at)) as last_at from agent_runs
        where org_id = $1 and agent_instance_id = any($2::uuid[]) and purpose = 'chat' and status = 'completed' and conversation_id is not null
        group by agent_instance_id`,
      [orgId, [...agentIds]],
    );
    for (const row of chats.rows) {
      const entry = out.get(row.agent_instance_id);
      if (entry) {
        entry.completedChatRuns = row.n;
        entry.lastCompletedChatAt = row.last_at ? new Date(row.last_at).toISOString() : null;
      }
    }

    // The scheduled-work table arrives with a later migration; without it nothing is scheduled.
    try {
      await q.query("savepoint capability_schedules");
      const schedules = await q.query<{ agent_instance_id: string; n: number }>(
        "select agent_instance_id, count(*)::int as n from ai_work_schedules where org_id = $1 and enabled and agent_instance_id = any($2::uuid[]) group by agent_instance_id",
        [orgId, [...agentIds]],
      );
      await q.query("release savepoint capability_schedules");
      for (const row of schedules.rows) {
        const entry = out.get(row.agent_instance_id);
        if (entry) entry.scheduledJobsOn = row.n;
      }
    } catch {
      try {
        await q.query("rollback to savepoint capability_schedules");
      } catch {
        /* the caller's transaction decides what happens next */
      }
    }
    return out;
  };
  return db ? run(db) : withSystem(run);
}
