import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { RUNTIME_ONLINE_STATUSES } from "@/lib/employee-runtime";

/**
 * What an AI employee is about to do.
 * - reply:    answer a message the customer started
 * - followup: a scheduled message the customer did not just ask for
 * - outbound: prospecting or campaign outreach
 * - job:      new autonomous background work (research, CRM maintenance)
 * Private chat between a client and their own employee is deliberately not a scope: it stays
 * available while an employee is paused.
 */
export type AutomationScope = "reply" | "followup" | "outbound" | "job";
export type AgentMode = "autonomous" | "approval_required" | "paused";

export type BlockReason =
  | "org_inactive"
  | "agency_paused"
  | "messaging_paused"
  | "outbound_paused"
  | "agent_paused"
  | "agent_disabled"
  | "agent_not_ready"
  | "agent_missing";

export type GateDecision =
  | { decision: "allow"; mode: AgentMode }
  | { decision: "needs_approval"; mode: AgentMode; detail: string }
  | { decision: "blocked"; reason: BlockReason; detail: string };

const READY_STATUSES: ReadonlySet<string> = new Set(RUNTIME_ONLINE_STATUSES);
// Which pause scopes stop which kind of action.
const STOPPED_BY: Record<AutomationScope, Array<"messaging" | "outbound" | "agency">> = {
  reply: ["messaging", "agency"],
  followup: ["messaging", "outbound", "agency"],
  outbound: ["messaging", "outbound", "agency"],
  job: ["agency"],
};

interface GateRow {
  org_status: string;
  pauses: string[] | null;
  agent_found: boolean;
  enabled: boolean | null;
  status: string | null;
  mode: AgentMode | null;
}

/**
 * The single decision point for customer-facing and autonomous AI work. It reads current state from
 * the database on every call, so queued work, retries and restarted workers can never act on a stale
 * "allowed" answer. Call it immediately before executing, in the same transaction as the side effect
 * wherever possible.
 *
 * With `approvalId`, an approval that is currently approved, unexpired and for this tenant satisfies
 * an approval-required employee. It never overrides a pause.
 */
export async function automationGate(
  db: Queryable,
  input: { orgId: string; agentId: string | null; scope: AutomationScope; approvalId?: string | null },
): Promise<GateDecision> {
  const { rows } = await db.query<GateRow>(
    `select o.status as org_status,
       (select array_agg(p.scope) from automation_pauses p join organizations po on po.id = p.org_id
         where p.active and (p.org_id = o.id or (po.kind = 'agency' and p.scope = 'agency'))) as pauses,
       a.id is not null as agent_found, a.enabled, a.status, a.mode
     from organizations o left join agent_instances a on a.org_id = o.id and a.id = $2
     where o.id = $1`,
    [input.orgId, input.agentId],
  );
  const row = rows[0];
  if (!row || ["suspended", "archived"].includes(row.org_status)) {
    return { decision: "blocked", reason: "org_inactive", detail: "This workspace is not active." };
  }
  const pauses = new Set(row.pauses ?? []);
  const stopped = STOPPED_BY[input.scope].find((scope) => pauses.has(scope));
  if (stopped === "agency") return { decision: "blocked", reason: "agency_paused", detail: "iAcquire has paused automation for this workspace while it is reviewed." };
  if (stopped === "messaging") return { decision: "blocked", reason: "messaging_paused", detail: "Customer-facing AI messaging is paused for this workspace." };
  if (stopped === "outbound") return { decision: "blocked", reason: "outbound_paused", detail: "Outbound AI actions are paused for this workspace." };

  if (!input.agentId || !row.agent_found) return { decision: "blocked", reason: "agent_missing", detail: "No AI employee is assigned to this action." };
  if (!row.enabled) return { decision: "blocked", reason: "agent_disabled", detail: "This AI employee is not included in the workspace." };
  const mode = row.mode ?? "approval_required";
  if (mode === "paused") return { decision: "blocked", reason: "agent_paused", detail: "This AI employee is paused." };
  if (!READY_STATUSES.has(row.status ?? "")) {
    return { decision: "blocked", reason: "agent_not_ready", detail: "This AI employee has not passed its connection check." };
  }
  if (mode === "autonomous") return { decision: "allow", mode };

  if (input.approvalId && (await approvalCoversAction(db, input.orgId, input.agentId, input.approvalId))) return { decision: "allow", mode };
  return { decision: "needs_approval", mode, detail: "This employee needs a person's approval before it can do this." };
}

async function approvalCoversAction(db: Queryable, orgId: string, agentId: string, approvalId: string): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from approval_requests where id = $1 and org_id = $2 and status = 'approved'
       and (expires_at is null or expires_at > now()) and (agent_instance_id is null or agent_instance_id = $3)`,
    [approvalId, orgId, agentId],
  );
  return rows.length > 0;
}

/**
 * The organization half of the gate, for deterministic automation that has no AI employee behind it (workflow steps). It reads the
 * workspace's status and pauses on every call:
 *  - workflows: stopped by a workspace's "workflows" pause and by the agency pause.
 *  - outbound:  stopped by the "outbound" pause and the agency pause (a workflow step that calls an outside system checks this too).
 *  - messaging: stopped by the "messaging" pause and the agency pause.
 * Customer messages still go through evaluateSend, which applies the AI employee's mode and every messaging rule on top.
 */
export type OrgAutomationScope = "workflows" | "outbound" | "messaging";
export type OrgBlockReason = "org_inactive" | "agency_paused" | "workflows_paused" | "outbound_paused" | "messaging_paused";
export type OrgAutomationDecision = { allowed: true } | { allowed: false; reason: OrgBlockReason; detail: string };

const ORG_STOPPED_BY: Record<OrgAutomationScope, Array<"workflows" | "outbound" | "messaging" | "agency">> = {
  workflows: ["agency", "workflows"],
  outbound: ["agency", "outbound"],
  messaging: ["agency", "messaging"],
};

export async function checkOrgAutomation(db: Queryable, orgId: string, scope: OrgAutomationScope): Promise<OrgAutomationDecision> {
  const { rows } = await db.query<{ org_status: string; pauses: string[] | null }>(
    `select o.status as org_status,
       (select array_agg(p.scope) from automation_pauses p join organizations po on po.id = p.org_id
         where p.active and (p.org_id = o.id or (po.kind = 'agency' and p.scope = 'agency'))) as pauses
     from organizations o where o.id = $1`,
    [orgId],
  );
  const row = rows[0];
  if (!row || ["suspended", "archived"].includes(row.org_status)) return { allowed: false, reason: "org_inactive", detail: "This workspace is not active." };
  const pauses = new Set(row.pauses ?? []);
  const stopped = ORG_STOPPED_BY[scope].find((s) => pauses.has(s));
  if (stopped === "agency") return { allowed: false, reason: "agency_paused", detail: "iAcquire has paused automation for this workspace while it is reviewed." };
  if (stopped === "workflows") return { allowed: false, reason: "workflows_paused", detail: "Workflows are paused for this workspace." };
  if (stopped === "outbound") return { allowed: false, reason: "outbound_paused", detail: "Outbound automation is paused for this workspace." };
  if (stopped === "messaging") return { allowed: false, reason: "messaging_paused", detail: "Customer messaging is paused for this workspace." };
  return { allowed: true };
}

/** For callers that cannot continue unless the action is allowed. */
export async function assertAutomationAllowed(db: Queryable, input: Parameters<typeof automationGate>[1]) {
  const decision = await automationGate(db, input);
  if (decision.decision === "allow") return decision;
  throw new AppError("forbidden", decision.detail);
}
