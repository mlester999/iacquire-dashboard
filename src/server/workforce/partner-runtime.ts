import "server-only";
import type { Queryable } from "@/server/db";
import { AI_GROWTH_PARTNER_ROLE_KEY, isWorkforceRoleKey, type WorkforceRoleKey } from "@/lib/agents";

/**
 * The ONE derivation of "which agent acts for this workspace".
 *
 * A workspace with a bound AI Growth Partner (ai_growth_partners.runtime_agent_instance_id) acts through that one runtime row.
 * A legacy workspace that was never bound keeps acting through its legacy role row (for example the Sales Assistant).
 * While a Partner runtime is bound the legacy row is NEVER used, even when the Partner is paused or not ready yet: whether the
 * Partner may act right now is decided by the automation gate and the runtime status the caller checks on the returned row, not by
 * quietly handing the work back to a legacy employee (the same rule as the conversation assignment in src/server/messaging/ingest.ts).
 */
export interface ResolvedActorAgent {
  agentId: string;
  roleKey: WorkforceRoleKey;
  /** True when the row is the workspace's bound Growth Partner runtime, false when it is a legacy role row. */
  viaPartner: boolean;
  enabled: boolean;
  status: string;
  activeConfigVersionId: string | null;
}

interface AgentRow {
  id: string;
  role_key: string;
  enabled: boolean;
  status: string;
  active_config_version_id: string | null;
}

function toResolved(row: AgentRow, viaPartner: boolean): ResolvedActorAgent {
  return {
    agentId: row.id,
    roleKey: row.role_key as WorkforceRoleKey,
    viaPartner,
    enabled: row.enabled,
    status: row.status,
    activeConfigVersionId: row.active_config_version_id,
  };
}

/** The workspace's bound Growth Partner runtime row, or null when no Partner runtime is bound. Never reads another workspace's rows. */
export async function boundPartnerRuntime(db: Queryable, orgId: string): Promise<ResolvedActorAgent | null> {
  const { rows } = await db.query<AgentRow>(
    `select a.id, a.role_key, a.enabled, a.status, a.active_config_version_id
       from ai_growth_partners p
       join agent_instances a on a.id = p.runtime_agent_instance_id and a.org_id = p.org_id
      where p.org_id = $1 and a.role_key = $2`,
    [orgId, AI_GROWTH_PARTNER_ROLE_KEY],
  );
  return rows[0] ? toResolved(rows[0], true) : null;
}

/**
 * The agent that acts for the workspace: its bound Growth Partner runtime first; only when no Partner runtime is bound, the
 * workspace's own row for `legacyRole`; otherwise null. A bound but paused or not-ready Partner is returned as it is (enabled/status
 * tell the caller), never replaced by a legacy row.
 */
export async function resolveActorAgent(db: Queryable, orgId: string, legacyRole: WorkforceRoleKey): Promise<ResolvedActorAgent | null> {
  const partner = await boundPartnerRuntime(db, orgId);
  if (partner) return partner;
  const { rows } = await db.query<AgentRow>(
    `select id, role_key, enabled, status, active_config_version_id
       from agent_instances where org_id = $1 and role_key = $2`,
    [orgId, legacyRole],
  );
  return rows[0] ? toResolved(rows[0], false) : null;
}

// Placeholders ($1, $2::uuid) and plain or table-qualified column names. Anything else is refused: this is for code-side constants only.
const ORG_ID_EXPRESSION = /^(?:\$\d{1,3}(?:::uuid)?|[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)$/i;

/**
 * A correlated scalar subselect, for set-based UPDATE ... RETURNING statements (reminders, retention), that yields the workspace's
 * bound Growth Partner runtime id and, only when none is bound, the id of its `legacyRole` row. Same rule as resolveActorAgent.
 *
 * `orgIdExpr` is an SQL expression for the workspace id (a column such as "r.org_id" or a placeholder such as "$1") and must be a
 * code-side constant: it is validated against a strict pattern and never built from user input. `legacyRole` must be a workforce role key.
 */
export function partnerFirstAgentSql(orgIdExpr: string, legacyRole: string): string {
  if (!ORG_ID_EXPRESSION.test(orgIdExpr)) throw new Error("partnerFirstAgentSql needs a plain column or placeholder for the workspace id.");
  if (!isWorkforceRoleKey(legacyRole)) throw new Error("partnerFirstAgentSql needs a workforce role key.");
  return `coalesce(
    (select gp_a.id from ai_growth_partners gp_p
       join agent_instances gp_a on gp_a.id = gp_p.runtime_agent_instance_id and gp_a.org_id = gp_p.org_id and gp_a.role_key = '${AI_GROWTH_PARTNER_ROLE_KEY}'
      where gp_p.org_id = ${orgIdExpr}),
    (select gp_l.id from agent_instances gp_l where gp_l.org_id = ${orgIdExpr} and gp_l.role_key = '${legacyRole}')
  )`;
}
