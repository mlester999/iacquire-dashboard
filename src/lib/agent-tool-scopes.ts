// Which CRM scopes each AI employee role may ever hold, and what each scope carries. Pure and client-safe: the server-only tool catalog (src/server/crm/agent-tools/catalog.ts)
// re-exports all of it, and the employee tool policy (src/lib/employee-tool-policy.ts) reads the same table, so there is one list of what a role may do to the CRM.
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import type { Permission } from "@/lib/permissions";

/*
 * Access is the intersection of three things, all decided by the server:
 *  1. the employee's role allowlist (ROLE_SCOPES), fixed in code and reviewed with the agency policy;
 *  2. the scopes on the short-lived token issued for one run (crm_agent_tokens.scopes);
 *  3. the CRM permissions those scopes map to (SCOPE_INFO), which every CRM service checks again.
 */

export const AGENT_TOOL_SCOPES = [
  "contacts:read",
  "contacts:write",
  "tags:write",
  "tasks:write",
  "opportunities:read",
  "opportunities:write",
  "calendar:read",
  "appointments:request",
  "conversations:read",
  "messages:draft",
  "reports:read",
] as const;
export type AgentToolScope = (typeof AGENT_TOOL_SCOPES)[number];

export const isAgentToolScope = (value: unknown): value is AgentToolScope => typeof value === "string" && (AGENT_TOOL_SCOPES as readonly string[]).includes(value);

/** What each scope lets the employee do, in the client's words, and the CRM permissions it carries. */
export const SCOPE_INFO: Record<AgentToolScope, { label: string; permissions: readonly Permission[] }> = {
  "contacts:read": { label: "Look up contacts", permissions: ["crm.view", "contacts.view"] },
  "contacts:write": { label: "Update contact details", permissions: ["crm.view", "contacts.view", "contacts.edit"] },
  "tags:write": { label: "Add and remove tags", permissions: ["crm.view", "contacts.view", "contacts.edit"] },
  "tasks:write": { label: "Create tasks", permissions: ["crm.view", "tasks.manage"] },
  "opportunities:read": { label: "See deals", permissions: ["crm.view", "sales.view"] },
  "opportunities:write": { label: "Create and move deals", permissions: ["crm.view", "sales.view", "opportunities.edit"] },
  "calendar:read": { label: "Check calendar availability", permissions: ["appointments.view"] },
  "appointments:request": { label: "Request appointments", permissions: ["appointments.view", "appointments.book"] },
  "conversations:read": { label: "Read its own conversations", permissions: ["inbox.view"] },
  "messages:draft": { label: "Draft messages for approval", permissions: ["inbox.view", "inbox.reply"] },
  "reports:read": { label: "Read CRM summary counts", permissions: ["crm.view", "analytics.view"] },
};

/**
 * Which scopes each AI employee role may ever hold. A token can carry fewer, never more. Reopening or deleting records, exports,
 * imports, bulk changes outside the approval path, campaigns and permission changes are not available to any role.
 */
export const ROLE_SCOPES: Record<AgentRoleKey, readonly AgentToolScope[]> = {
  operations_manager: ["contacts:read", "tasks:write", "opportunities:read", "calendar:read", "reports:read"],
  lead_hunter: ["contacts:read", "tags:write", "tasks:write"],
  appointment_setter: ["contacts:read", "contacts:write", "tags:write", "tasks:write", "calendar:read", "appointments:request", "conversations:read", "messages:draft"],
  sales_assistant: ["contacts:read", "contacts:write", "tags:write", "tasks:write", "opportunities:read", "opportunities:write", "calendar:read", "conversations:read", "messages:draft"],
  crm_manager: ["contacts:read", "contacts:write", "tags:write", "tasks:write", "opportunities:read", "opportunities:write", "reports:read"],
  performance_analyst: ["opportunities:read", "reports:read"],
};

export const isAgentRole = (value: unknown): value is AgentRoleKey => typeof value === "string" && (AGENT_ROLE_KEYS as readonly string[]).includes(value);

/** The scopes an employee of this role holds with this token: role allowlist ∩ token scopes. */
export function effectiveScopes(roleKey: string, tokenScopes: readonly string[]): AgentToolScope[] {
  if (!isAgentRole(roleKey)) return [];
  const allowed = new Set<string>(ROLE_SCOPES[roleKey]);
  return AGENT_TOOL_SCOPES.filter((s) => allowed.has(s) && tokenScopes.includes(s));
}

/** The CRM permissions those scopes carry. This is the agent actor's whole permission set. */
export function permissionsForScopes(scopes: readonly AgentToolScope[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const s of scopes) for (const p of SCOPE_INFO[s].permissions) out.add(p);
  return out;
}

