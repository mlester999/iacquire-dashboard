import { describe, expect, it } from "vitest";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import { AGENT_TOOLS, toolsForRole, type AgentToolName } from "@/server/crm/agent-tools/catalog";
import {
  businessMcpRuntimeNamesForRole,
  businessMcpToolNamesForRole,
  HERMES_BUSINESS_CONTEXT_TOOL,
  HERMES_BUSINESS_MCP_SERVER,
} from "@/server/workforce/hermes-business-mcp-policy";

describe("internal Hermes business tool policy", () => {
  it("keeps each of the six employee catalogs limited to its role's read tools by default", () => {
    expect(AGENT_ROLE_KEYS).toHaveLength(6);
    for (const role of AGENT_ROLE_KEYS) {
      const exposed = businessMcpToolNamesForRole(role);
      expect(exposed[0]).toBe(HERMES_BUSINESS_CONTEXT_TOOL);
      const tools = exposed.filter((name): name is AgentToolName => name !== HERMES_BUSINESS_CONTEXT_TOOL);
      expect(tools).toEqual(toolsForRole(role).filter((name) => AGENT_TOOLS[name].kind === "read"));
      expect(tools.every((name) => AGENT_TOOLS[name].kind === "read")).toBe(true);
      expect(tools.some((name) => AGENT_TOOLS[name].kind === "proposal")).toBe(false);
    }
  });

  it("adds only role-allowed write tools when the separate writes switch is enabled", () => {
    for (const role of AGENT_ROLE_KEYS) {
      const exposed = businessMcpToolNamesForRole(role, true);
      expect(exposed).toEqual([
        HERMES_BUSINESS_CONTEXT_TOOL,
        ...toolsForRole(role).filter((name) => AGENT_TOOLS[name].kind !== "proposal"),
      ]);
      const tools = exposed.filter((name): name is AgentToolName => name !== HERMES_BUSINESS_CONTEXT_TOOL);
      expect(tools.some((name) => AGENT_TOOLS[name].kind === "proposal")).toBe(false);
    }
  });

  it("uses Hermes namespaced tool identifiers", () => {
    for (const role of AGENT_ROLE_KEYS) {
      expect(businessMcpRuntimeNamesForRole(role)).toEqual(
        businessMcpToolNamesForRole(role).map((name) => `mcp__${HERMES_BUSINESS_MCP_SERVER}__${name}`).sort(),
      );
    }
  });
});
