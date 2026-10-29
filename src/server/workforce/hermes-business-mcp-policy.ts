import "server-only";
import { AGENT_TOOLS, toolsForRole } from "@/server/crm/agent-tools/catalog";
import type { AgentToolName } from "@/server/crm/agent-tools/catalog";
import type { AgentRoleKey } from "@/lib/agents";

export const HERMES_BUSINESS_MCP_SERVER = "iacquire_business";
export const HERMES_BUSINESS_MCP_TOOLSET = `mcp-${HERMES_BUSINESS_MCP_SERVER}`;
export const HERMES_BUSINESS_CONTEXT_TOOL = "get_role_workspace_context";
export type BusinessMcpToolName = AgentToolName | typeof HERMES_BUSINESS_CONTEXT_TOOL;

/** Names exposed to an employee's model. Keep the route, provisioning preview and inventory check on this contract. */
export function businessMcpToolNamesForRole(role: AgentRoleKey, includeWrites = false): BusinessMcpToolName[] {
  const crmNames = toolsForRole(role).filter((name) => {
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
