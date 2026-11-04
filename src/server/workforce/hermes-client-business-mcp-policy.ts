import "server-only";
import { AGENT_TOOLS, toolsForRole } from "@/server/crm/agent-tools/catalog";
import type { AgentToolName } from "@/server/crm/agent-tools/catalog";
import { AI_GROWTH_PARTNER_ROLE_KEY, type WorkforceRoleKey } from "@/lib/agents";
import type { Queryable } from "@/server/db";
import { env } from "@/server/env";
import { featureOn } from "@/server/proposals/features";
import { HERMES_BUSINESS_CONTEXT_TOOL, hermesMcpToolName, type BusinessMcpToolName } from "@/server/workforce/hermes-business-mcp-policy";

/**
 * What the CLIENT tier of the business tools may offer, kept apart from the internal agency tier on purpose: a tool added to the catalog for any other reason reaches no client until it
 * is listed here and reviewed. The tier is dormant until two things agree: the deployment (HERMES_CLIENT_BUSINESS_MCP_ENABLED) and the workspace (org_features client_business_tools).
 * The route is src/app/api/internal/hermes-business/client/mcp/route.ts (handler: hermes-client-business-mcp.ts). The server name, the toolset and the runtime tool names are the internal
 * tier's, so the gateway reports the same provenance for both.
 */

export const CLIENT_BUSINESS_TOOLS_FEATURE = "client_business_tools";
export const CLIENT_BUSINESS_PROPOSALS_FEATURE = "client_business_proposals";

/**
 * The read tools each role is offered, beside the context tool. An explicit list (not derived from the catalog) so that a new catalog read tool is not offered to a client by
 * accident. It is the internal tier's reads plus list_opportunities (a client-only tool) for the roles that hold the deals scope; the role's scopes still decide what is actually
 * allowed (see clientBusinessMcpToolNamesForRole).
 */
export const CLIENT_BUSINESS_TOOL_MATRIX: Record<WorkforceRoleKey, readonly AgentToolName[]> = {
  operations_manager: ["find_contacts", "get_contact", "check_availability", "crm_summary_report", "list_opportunities"],
  lead_hunter: ["find_contacts", "get_contact"],
  appointment_setter: ["find_contacts", "get_contact", "check_availability", "get_conversation_history"],
  sales_assistant: ["find_contacts", "get_contact", "check_availability", "get_conversation_history", "list_opportunities"],
  crm_manager: ["find_contacts", "get_contact", "crm_summary_report", "list_opportunities"],
  performance_analyst: ["crm_summary_report", "list_opportunities"],
  [AI_GROWTH_PARTNER_ROLE_KEY]: [
    "find_contacts", "get_contact", "check_availability", "crm_summary_report",
    "list_opportunities", "get_conversation_history",
  ],
};

/**
 * What a client's employee is never offered, in any phase: the tools that could reach a customer or put a booking on a calendar without a person in the loop. A catalog `proposal`-kind tool
 * is already left out by the `write` filter below; this list names them so a later catalog change cannot slip one in, and so a test can say exactly what is kept out.
 */
export const CLIENT_NEVER_OFFERED_TOOLS: readonly AgentToolName[] = ["request_appointment", "prepare_message", "request_send_approval"];

/** The CRM changes a role may PROPOSE: every `write` tool its scopes allow. They only ever become approval requests. A `proposal`-kind tool (a message or a booking) is never offered. */
export function clientBusinessProposalToolNamesForRole(role: WorkforceRoleKey): AgentToolName[] {
  return toolsForRole(role).filter((name) => AGENT_TOOLS[name].kind === "write" && !CLIENT_NEVER_OFFERED_TOOLS.includes(name));
}

/** Names exposed to a client employee's model. The matrix is narrowed to read tools the role's scopes allow; proposals are added only when asked for. */
export function clientBusinessMcpToolNamesForRole(role: WorkforceRoleKey, options: { proposals?: boolean } = {}): BusinessMcpToolName[] {
  // The client tier is the one place a client-only tool (list_opportunities) can be offered, so its own matrix is what decides, narrowed by the role's scopes.
  const allowed = new Set<AgentToolName>(toolsForRole(role, { includeClientOnly: true }));
  const reads = CLIENT_BUSINESS_TOOL_MATRIX[role].filter((name) => allowed.has(name) && AGENT_TOOLS[name].kind === "read");
  return [HERMES_BUSINESS_CONTEXT_TOOL, ...reads, ...(options.proposals ? clientBusinessProposalToolNamesForRole(role) : [])];
}

export function clientBusinessMcpRuntimeNamesForRole(role: WorkforceRoleKey, options: { proposals?: boolean } = {}): string[] {
  return clientBusinessMcpToolNamesForRole(role, options).map(hermesMcpToolName).sort();
}

/**
 * Whether the client tier answers for this workspace right now. `db` is required: the workspace switch is read inside the caller's transaction, never through the three-second
 * cache, so a switch-off is seen by the very next call. The deployment flag is checked first and costs nothing.
 */
export async function clientBusinessToolsOn(orgId: string, db: Queryable): Promise<boolean> {
  if (!env().HERMES_CLIENT_BUSINESS_MCP_ENABLED) return false;
  return featureOn(orgId, CLIENT_BUSINESS_TOOLS_FEATURE, db);
}

/** Whether this workspace's employees may also propose changes: the tier itself, the deployment's proposals flag and the workspace's proposals switch must all be on. */
export async function clientBusinessProposalsOn(orgId: string, db: Queryable): Promise<boolean> {
  const e = env();
  if (!e.HERMES_CLIENT_BUSINESS_MCP_ENABLED || !e.HERMES_CLIENT_BUSINESS_MCP_PROPOSALS_ENABLED) return false;
  return (await featureOn(orgId, CLIENT_BUSINESS_TOOLS_FEATURE, db)) && (await featureOn(orgId, CLIENT_BUSINESS_PROPOSALS_FEATURE, db));
}
