import "server-only";
import type { Queryable } from "@/server/db";
import { checkOrgAutomation } from "@/server/automation/gate";

/**
 * Whether a workspace may have social work done for it right now. A public post is outbound communication, so the answer is the platform's own rule for
 * outbound automation (src/server/automation/gate.ts): a suspended or archived workspace, an iAcquire agency pause, and the workspace's outbound pause all stop it.
 * Offboarding shutdown sets those pauses, so a shut-down client's scheduled posts stop with everything else.
 */
export async function socialOrgRunnable(db: Queryable, orgId: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  const decision = await checkOrgAutomation(db, orgId, "outbound");
  return decision.allowed ? { ok: true } : { ok: false, detail: decision.detail };
}

/**
 * The same rule as a SQL predicate, for jobs that scan many workspaces in one query (the publisher's claim, the health sweep, the metrics sweep). Pass the SQL
 * expression of the row's workspace id, for example `q.org_id`; the expression is spliced into the text, so it must be a column reference written in this code,
 * never user input. Mirrors checkOrgAutomation: an active workspace with no active agency pause (on the workspace or on the agency that owns it) and no active
 * outbound pause of its own.
 */
export function socialOrgRunnableSql(orgIdExpr: string): string {
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(orgIdExpr)) throw new Error("socialOrgRunnableSql takes a column reference");
  return `(exists (select 1 from organizations gate_o where gate_o.id = ${orgIdExpr} and gate_o.status not in ('suspended', 'archived'))
    and not exists (select 1 from automation_pauses gate_p join organizations gate_po on gate_po.id = gate_p.org_id
      where gate_p.active and ((gate_p.org_id = ${orgIdExpr} and gate_p.scope in ('agency', 'outbound')) or (gate_po.kind = 'agency' and gate_p.scope = 'agency'))))`;
}
