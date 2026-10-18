import "server-only";

/**
 * The reviewed Hermes capability surface for a client-facing AI employee.
 *
 * This module is deliberately dependency-free so the HTTP adapter, the provisioning runbook,
 * the health check and the tests all read the same policy. A toolset that is not named here is
 * not reviewed, even if it looks harmless.
 */
export const PORTAL_SAFE_TOOLSETS = ["memory", "session_search", "todo", "vision", "web"] as const;

/**
 * Defence in depth for the profile runbook. A blocklist is not a substitute for the server-side
 * `platform_toolsets.api_server` allowlist: a future toolset name that is not in this list could
 * still be enabled, which is why complete runtime inventory verification is still required.
 */
export const PORTAL_DISABLED_TOOLSETS = [
  "browser",
  "code_execution",
  "computer_use",
  "connections",
  "cronjob",
  "delegation",
  "file",
  "image_gen",
  "skills",
  "terminal",
  "catalog",
  "kanban",
] as const;

/** Enabled toolset names that are not explicitly reviewed. Unknown future names are denied. */
export function unauthorizedToolsets(enabled: readonly string[]): string[] {
  const safe = new Set<string>(PORTAL_SAFE_TOOLSETS);
  return [...new Set(enabled.filter((name) => !safe.has(name)))].sort();
}

/** Tool Search bridge names. They must never appear in a profile's effective catalog. */
export const TOOL_SEARCH_BRIDGE_TOOLS = ["tool_search", "tool_describe", "tool_call"] as const;

/** Remote connector tools are only in scope when the `connections` toolset is enabled. */
export const CONNECTOR_ACCESS_TOOL = "manage_connections";
export const CONNECTOR_TOOL_PREFIX = "connectors__";

/** True when a tool name is a Tool Search bridge, a connector tool, or the connector manager. */
export function isToolSearchOrConnectorName(name: string): boolean {
  return (
    (TOOL_SEARCH_BRIDGE_TOOLS as readonly string[]).includes(name) ||
    name === CONNECTOR_ACCESS_TOOL ||
    name.startsWith(CONNECTOR_TOOL_PREFIX)
  );
}
