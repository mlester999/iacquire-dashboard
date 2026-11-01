import "server-only";
import { AGENT_TOOLS } from "@/server/crm/agent-tools/catalog";
import type { AgentToolName } from "@/server/crm/agent-tools/catalog";
import type { AgentRoleKey } from "@/lib/agents";

export const HERMES_BUSINESS_MCP_SERVER = "iacquire_business";
export const HERMES_BUSINESS_MCP_TOOLSET = `mcp-${HERMES_BUSINESS_MCP_SERVER}`;
export const HERMES_BUSINESS_CONTEXT_TOOL = "get_role_workspace_context";
export type BusinessMcpToolName = AgentToolName | typeof HERMES_BUSINESS_CONTEXT_TOOL;

/**
 * The internal agency tier's tools per role, written out. They used to be derived from the shared catalog, which meant any tool added to the catalog for another tier
 * (a client tool, a new read) reached the live internal employees by itself. Now a catalog addition changes nothing here: adding a tool to an internal employee is a
 * reviewed edit of this table. Catalog order, reads and the writes the separate writes switch allows; a proposal tool is never listed.
 */
const INTERNAL_TIER_TOOLS: Record<AgentRoleKey, readonly AgentToolName[]> = {
  operations_manager: ["find_contacts", "get_contact", "create_task", "check_availability", "crm_summary_report"],
  lead_hunter: ["find_contacts", "get_contact", "apply_tag", "remove_tag", "create_task"],
  appointment_setter: ["find_contacts", "get_contact", "update_contact", "apply_tag", "remove_tag", "create_task", "check_availability", "get_conversation_history"],
  sales_assistant: [
    "find_contacts", "get_contact", "update_contact", "apply_tag", "remove_tag", "create_task", "create_opportunity", "move_opportunity_stage", "check_availability", "get_conversation_history",
  ],
  crm_manager: ["find_contacts", "get_contact", "update_contact", "apply_tag", "remove_tag", "create_task", "create_opportunity", "move_opportunity_stage", "crm_summary_report"],
  performance_analyst: ["crm_summary_report"],
};

/** Names exposed to an employee's model. Keep the route, provisioning preview and inventory check on this contract. */
export function businessMcpToolNamesForRole(role: AgentRoleKey, includeWrites = false): BusinessMcpToolName[] {
  // A role the table does not know gets only the context tool, as it did when the list was derived from the catalog.
  const crmNames = (INTERNAL_TIER_TOOLS[role] ?? []).filter((name) => {
    const kind = AGENT_TOOLS[name].kind;
    return kind === "read" || (includeWrites && kind === "write");
  });
  return [HERMES_BUSINESS_CONTEXT_TOOL, ...crmNames];
}

export function hermesMcpToolName(name: BusinessMcpToolName): string {
  return `mcp__${HERMES_BUSINESS_MCP_SERVER}__${name}`;
}

export function businessMcpRuntimeNamesForRole(role: AgentRoleKey, includeWrites = false): string[] {
  return businessMcpToolNamesForRole(role, includeWrites).map(hermesMcpToolName).sort();
}
