import "server-only";
import { withSystem } from "@/server/db";
import { assertCan, type CrmActor } from "@/server/crm/actor";
import { agentLiveRunsVerified } from "@/server/crm/agent-tools/tasks";
import type { AgentMode } from "@/server/automation/gate";
import { AGENT_TOOL_NAMES, AGENT_TOOLS, ROLE_SCOPES, SCOPE_INFO, isAgentRole, type AgentToolKind, type AgentToolName } from "@/server/crm/agent-tools/catalog";
import { liveTokenCounts } from "@/server/crm/agent-tools/tokens";

/** What a tool does for one employee right now, given its role and mode. */
export type ToolBehaviour = "runs" | "asks_first" | "always_asks" | "proposes" | "stopped" | "not_for_role";

export interface EmployeeToolAccess {
  id: string;
  roleKey: string;
  name: string;
  mode: AgentMode;
  enabled: boolean;
  status: string;
  connected: boolean;
  liveTokens: number;
  scopes: Array<{ scope: string; label: string }>;
  tools: Array<{ name: AgentToolName; label: string; kind: AgentToolKind; behaviour: ToolBehaviour; note: string | null }>;
}

export interface ToolCallEntry {
  id: string;
  at: string;
  employee: string | null;
  tool: string;
  toolLabel: string;
  outcome: "done" | "draft" | "pending_approval" | "unavailable" | "refused" | "failed" | "queued" | "blocked";
  detail: string | null;
  approvalId: string | null;
  approved: boolean;
}

export interface AgentToolsOverview {
  employees: EmployeeToolAccess[];
  calls: ToolCallEntry[];
  counts: { calls7d: number; done7d: number; refused7d: number; pendingApprovals: number };
  pauses: { agency: boolean; messaging: boolean; outbound: boolean };
  liveRunsVerified: boolean;
  canStop: boolean;
}

function behaviourFor(tool: AgentToolName, allowed: boolean, mode: AgentMode, enabled: boolean): { behaviour: ToolBehaviour; note: string | null } {
  const def = AGENT_TOOLS[tool];
  if (!allowed) return { behaviour: "not_for_role", note: null };
  if (!enabled || mode === "paused") return { behaviour: "stopped", note: null };
  if (def.kind === "read") return { behaviour: "runs", note: null };
  if (def.kind === "proposal") return { behaviour: def.alwaysApproval ? "always_asks" : "proposes", note: null };
  if (mode === "autonomous") return { behaviour: "runs", note: def.highImpactWhen ? `Asks first when ${def.highImpactWhen}.` : null };
  return { behaviour: "asks_first", note: null };
}

const OUTCOMES = new Set(["done", "draft", "pending_approval", "unavailable", "refused", "failed", "queued", "blocked"]);

/** The client's view of their AI employees' CRM tool access: who may use what, and every recent call with its outcome. */
export async function getAgentToolsOverview(actor: CrmActor): Promise<AgentToolsOverview> {
  assertCan(actor, "activity.view");
  // Trusted read after the check above: audit entries are not readable through row-level security.
  return withSystem(async (db) => {
    const orgId = actor.orgId;
    const { rows: agents } = await db.query<{ id: string; role_key: string; display_name: string; mode: AgentMode; enabled: boolean; status: string; last_health_ok: boolean | null; hermes_base_url: string | null; hermes_profile: string | null; credential_id: string | null; tool_inventory_contract: string | null; tool_inventory_digest: string | null; tool_inventory_verified_at: Date | null; tool_inventory_expires_at: Date | null; tool_inventory_tool_count: number | null }>(
      `select a.id, a.role_key, a.display_name, a.mode, a.enabled, a.status, a.last_health_ok, a.hermes_base_url, a.hermes_profile, a.credential_id,
              a.tool_inventory_contract, a.tool_inventory_digest, a.tool_inventory_verified_at, a.tool_inventory_expires_at, a.tool_inventory_tool_count
       from agent_instances a join agent_roles r on r.key = a.role_key where a.org_id = $1 order by r.sort_order`,
      [orgId],
    );
    const tokens = await liveTokenCounts(db, orgId);
    let liveRunsVerified = false;
    const employees: EmployeeToolAccess[] = agents.map((a) => {
      const connected = Boolean(a.hermes_base_url && a.credential_id);
      if (connected) liveRunsVerified ||= agentLiveRunsVerified(a);
      const scopes = isAgentRole(a.role_key) ? ROLE_SCOPES[a.role_key] : [];
      return {
        id: a.id, roleKey: a.role_key, name: a.display_name, mode: a.mode, enabled: a.enabled, status: a.status, connected, liveTokens: tokens.get(a.id) ?? 0,
        scopes: scopes.map((s) => ({ scope: s, label: SCOPE_INFO[s].label })),
        tools: AGENT_TOOL_NAMES.map((n) => ({ name: n, label: AGENT_TOOLS[n].label, kind: AGENT_TOOLS[n].kind, ...behaviourFor(n, scopes.includes(AGENT_TOOLS[n].scope), a.mode, a.enabled) })),
      };
    });

    const { rows: log } = await db.query<{ id: string; created_at: Date; action: string; display_name: string | null; approval_id: string | null; outcome: string | null; detail: string | null; tool: string | null; approved: string | null }>(
      `select l.id::text, l.created_at, l.action, ai.display_name, l.approval_id, l.metadata->>'outcome' as outcome, l.metadata->>'detail' as detail, l.metadata->>'tool' as tool,
              l.metadata->>'approved' as approved
       from audit_logs l left join agent_instances ai on ai.id = l.agent_instance_id
       where l.org_id = $1 and (l.action like 'crm.agent\\_tool.%' or l.action = 'crm.agent_task_requested') order by l.created_at desc, l.id desc limit 50`,
      [orgId],
    );
    const calls: ToolCallEntry[] = log.map((r) => {
      const task = r.action === "crm.agent_task_requested";
      const name = task ? "workflow_task" : (r.tool ?? r.action.replace(/^crm\.agent_tool\./, ""));
      const known = (AGENT_TOOLS as Record<string, { label: string } | undefined>)[name];
      return {
        id: r.id, at: new Date(r.created_at).toISOString(), employee: r.display_name, tool: name, toolLabel: task ? "Workflow task" : known?.label ?? "Unknown tool",
        outcome: (OUTCOMES.has(r.outcome ?? "") ? r.outcome : "failed") as ToolCallEntry["outcome"], detail: r.detail, approvalId: r.approval_id, approved: r.approved === "true",
      };
    });

    const { rows: c } = await db.query<{ calls: string; done: string; refused: string; pending: string }>(
      `select
         (select count(*) from audit_logs where org_id = $1 and action like 'crm.agent\\_tool.%' and created_at > now() - interval '7 days')::text as calls,
         (select count(*) from audit_logs where org_id = $1 and action like 'crm.agent\\_tool.%' and created_at > now() - interval '7 days' and metadata->>'outcome' in ('done', 'draft'))::text as done,
         (select count(*) from audit_logs where org_id = $1 and action like 'crm.agent\\_tool.%' and created_at > now() - interval '7 days' and result = 'denied')::text as refused,
         (select count(*) from approval_requests where org_id = $1 and status = 'pending' and (expires_at is null or expires_at > now())
            and ((kind = 'crm_update' and action->>'source' = 'agent_tool') or (kind = 'follow_up_message' and idempotency_key like 'agent-send:%')))::text as pending`,
      [orgId],
    );
    const { rows: pauseRows } = await db.query<{ scope: string; active: boolean }>(
      "select p.scope, p.active from automation_pauses p join organizations o on o.id = p.org_id where p.active and (p.org_id = $1 or (o.kind = 'agency' and p.scope = 'agency'))",
      [orgId],
    );
    const paused = new Set(pauseRows.map((p) => p.scope));
    return {
      employees,
      calls,
      counts: { calls7d: Number(c[0].calls), done7d: Number(c[0].done), refused7d: Number(c[0].refused), pendingApprovals: Number(c[0].pending) },
      pauses: { agency: paused.has("agency"), messaging: paused.has("messaging"), outbound: paused.has("outbound") },
      liveRunsVerified,
      canStop: actor.kind === "member" && actor.can("automation.pause"),
    };
  });
}
