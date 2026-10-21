import "server-only";
import type { OpsActionTool, OpsReadTool, OpsTool } from "@/server/aqi/ops/tool";
import { HEALTH_TOOLS } from "@/server/aqi/ops/tools/health";
import { WORKSPACE_TOOLS } from "@/server/aqi/ops/tools/workspace";
import { WORKFORCE_TOOLS } from "@/server/aqi/ops/tools/workforce";
import { SUPPORT_TOOLS } from "@/server/aqi/ops/tools/support";
import { SECURITY_TOOLS } from "@/server/aqi/ops/tools/security";
import { BUSINESS_TOOLS } from "@/server/aqi/ops/tools/business";
import { INTEGRATION_TOOLS } from "@/server/aqi/ops/tools/integrations";
import { RELEASE_TOOLS } from "@/server/aqi/ops/tools/release";
import { PRODUCT_TOOLS } from "@/server/aqi/ops/tools/product";
import { BRIEFING_TOOLS } from "@/server/aqi/ops/tools/briefing";
import { TELEMETRY_TOOLS } from "@/server/aqi/ops/tools/telemetry";
import { ACTION_TOOLS } from "@/server/aqi/ops/tools/actions";

/**
 * The only place tools are registered. Role-based exposure is decided here, on the server: a viewer
 * whose role is not listed on a tool never receives it in any catalogue, planner prompt or response,
 * and the executor refuses it again at call time.
 */
export const OPS_TOOLS: readonly OpsTool[] = [
  ...HEALTH_TOOLS,
  ...WORKSPACE_TOOLS,
  ...WORKFORCE_TOOLS,
  ...SUPPORT_TOOLS,
  ...SECURITY_TOOLS,
  ...BUSINESS_TOOLS,
  ...INTEGRATION_TOOLS,
  ...RELEASE_TOOLS,
  ...PRODUCT_TOOLS,
  ...BRIEFING_TOOLS,
  ...TELEMETRY_TOOLS,
  ...ACTION_TOOLS,
];

const byId = new Map<string, OpsTool>(OPS_TOOLS.map((tool) => [tool.id, tool]));

if (byId.size !== OPS_TOOLS.length) throw new Error("Duplicate AQi Operations tool id.");

export function findOpsTool(id: string): OpsTool | null {
  return byId.get(id) ?? null;
}

export function findReadTool(id: string): OpsReadTool | null {
  const tool = byId.get(id);
  return tool?.kind === "read" ? tool : null;
}

export function findActionTool(id: string): OpsActionTool | null {
  const tool = byId.get(id);
  return tool?.kind === "action" ? tool : null;
}

/** Tools a platform role may be offered. The client roles are not agency roles and never match. */
export function toolsForRole(role: string): OpsTool[] {
  return OPS_TOOLS.filter((tool) => (tool.roles as readonly string[]).includes(role));
}
