// What each of the six AI employees may DO, in one table, decided by the server and never by the employee's own instructions.
//
// An employee can affect the business through four doors, and every door is closed by default (deny unless this table names the role and the action):
//   capability     a durable, reviewed piece of work the portal runs for it (src/lib/workforce-capabilities.ts). Read-only reviews, or drafts a person must approve.
//   chat proposal  something a person asked for in chat that the portal turns into a PREVIEW (a booking or a change of appointment); a person confirms and the usual approvals follow.
//   crm scope      what its CRM tool token may carry (src/lib/agent-tool-scopes.ts), intersected with the run's token and the CRM permissions at call time.
//   runtime tool   what its Hermes profile can call by itself: memory, session search, a to-do list, picture analysis, and public web research for the Lead Hunter ONLY.
// Nothing here reads model output. A prompt that tells the Sales Assistant to "act as the Lead Hunter" changes nothing: the role comes from the employee's database row, and the
// table is looked up by that role. The portal tests (tests/employee-tool-policy.test.ts and the conformance suite) walk every role against every action and the real enforcement code.
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { CAPABILITY_KEYS, WORKFORCE_CAPABILITIES } from "@/lib/workforce-capabilities";
import { AGENT_TOOL_SCOPES, ROLE_SCOPES, SCOPE_INFO } from "@/lib/agent-tool-scopes";

export type PolicyActionKind = "capability" | "chat_proposal" | "crm_scope" | "runtime_tool";
/** read: looks only. draft: prepares text or records nobody has seen. proposal: prepares an action a person still decides on. */
export type PolicyEffect = "read" | "draft" | "proposal";

export interface PolicyAction {
  id: string;
  kind: PolicyActionKind;
  label: string;
  effect: PolicyEffect;
  /** Whether a person decides before anything outside the workspace happens. */
  approval: "none" | "person_decides";
}

const CHAT_PROPOSALS: Record<string, { label: string; roles: readonly AgentRoleKey[]; effect: PolicyEffect }> = {
  "chat:booking_request": { label: "Prepare an appointment booking for confirmation", roles: ["appointment_setter"], effect: "proposal" },
  "chat:appointment_change": { label: "Prepare an appointment cancellation or reschedule for approval", roles: ["appointment_setter"], effect: "proposal" },
};

/**
 * The tools a client employee's Hermes profile may expose. The three that every profile needs, and the reviewed optional ones. Public web research belongs to the Lead Hunter
 * alone: a role that is not asked to research prospects does not get the tools to do it.
 */
export const RUNTIME_TOOL_ROLES: Record<string, { toolset: string; roles: readonly AgentRoleKey[] | "all"; optional?: boolean }> = {
  memory: { toolset: "memory", roles: "all" },
  session_search: { toolset: "session_search", roles: "all" },
  todo_list: { toolset: "todo", roles: "all" },
  vision_analyze: { toolset: "vision", roles: "all", optional: true },
  web_search: { toolset: "web", roles: ["lead_hunter"] },
  web_extract: { toolset: "web", roles: ["lead_hunter"] },
};

const runtimeAllowed = (tool: string, role: AgentRoleKey): boolean => {
  const entry = RUNTIME_TOOL_ROLES[tool];
  return Boolean(entry) && (entry.roles === "all" || entry.roles.includes(role));
};

/** Every tool the role's profile may expose (required and optional). */
export const runtimeToolsFor = (role: AgentRoleKey): string[] => Object.keys(RUNTIME_TOOL_ROLES).filter((t) => runtimeAllowed(t, role));
/** The tools it must expose to be usable at all. */
export const requiredRuntimeToolsFor = (role: AgentRoleKey): string[] => runtimeToolsFor(role).filter((t) => !RUNTIME_TOOL_ROLES[t].optional);
/** The toolsets those tools sit in: what the profile's server-side allowlist (platform_toolsets.api_server) should name. */
export const runtimeToolsetsFor = (role: AgentRoleKey): string[] => [...new Set(runtimeToolsFor(role).map((t) => RUNTIME_TOOL_ROLES[t].toolset))].sort();

export interface RuntimeExposure {
  ok: boolean;
  /** Tools the profile exposes that this role's policy does not name. */
  excess: string[];
  /** Tools this role needs that the profile does not expose. */
  missing: string[];
}

/** Judges the tool names a profile actually exposes against the role's policy. Pure; the names come from the verified inventory, never from the employee. */
export function runtimeToolExposure(role: AgentRoleKey, exposed: readonly string[]): RuntimeExposure {
  const names = new Set(exposed);
  const excess = [...names].filter((t) => !runtimeAllowed(t, role)).sort();
  const missing = requiredRuntimeToolsFor(role).filter((t) => !names.has(t)).sort();
  return { ok: excess.length === 0 && missing.length === 0, excess, missing };
}

/**
 * Whether an over-wide profile is only REPORTED on screen, or also refused a connection and a run.
 *
 * The default is "enforce", because the table above is a security boundary, not a display preference: a Sales Assistant whose profile still carries the `web` toolset can be
 * talked into an outbound request by anything it reads, and the role table says that toolset belongs to the Lead Hunter alone. Enforcing narrows what the gateway is told to
 * enable (src/server/workforce/provisioning.ts) and makes the health check refuse a profile that exposes more (src/server/integrations/hermes/inventory.ts). A deployment
 * that needs the old report-only behaviour during a profile migration sets WORKFORCE_ROLE_TOOL_ENFORCEMENT=report deliberately; a typo, an empty value or any other word
 * stays on the strict side.
 */
export type RoleToolEnforcement = "report" | "enforce";
export const roleToolEnforcement = (vars: Record<string, string | undefined> = process.env): RoleToolEnforcement => (vars.WORKFORCE_ROLE_TOOL_ENFORCEMENT === "report" ? "report" : "enforce");

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export function employeeActions(role: AgentRoleKey): PolicyAction[] {
  const out: PolicyAction[] = [];
  for (const key of CAPABILITY_KEYS) {
    const def = WORKFORCE_CAPABILITIES[key];
    if (!def.allowedRoles.includes(role)) continue;
    out.push({
      id: `capability:${key}`, kind: "capability", label: def.label,
      effect: def.risk === "read_only" ? "read" : "draft",
      approval: def.risk === "read_only" ? "none" : "person_decides",
    });
  }
  for (const [id, p] of Object.entries(CHAT_PROPOSALS)) if (p.roles.includes(role)) out.push({ id, kind: "chat_proposal", label: p.label, effect: p.effect, approval: "person_decides" });
  for (const scope of ROLE_SCOPES[role]) {
    const write = scope.endsWith(":write") || scope === "appointments:request" || scope === "messages:draft";
    out.push({ id: `crm:${scope}`, kind: "crm_scope", label: SCOPE_INFO[scope].label, effect: scope === "messages:draft" || scope === "appointments:request" ? "proposal" : write ? "draft" : "read", approval: write ? "person_decides" : "none" });
  }
  for (const tool of runtimeToolsFor(role)) out.push({ id: `runtime:${tool}`, kind: "runtime_tool", label: tool, effect: "read", approval: "none" });
  return out;
}

/** Every action id that exists anywhere in the product, for the walk across all six roles. */
export function allPolicyActionIds(): string[] {
  return [
    ...CAPABILITY_KEYS.map((k) => `capability:${k}`),
    ...Object.keys(CHAT_PROPOSALS),
    ...AGENT_TOOL_SCOPES.map((s) => `crm:${s}`),
    ...Object.keys(RUNTIME_TOOL_ROLES).map((t) => `runtime:${t}`),
  ];
}

export type PolicyDecision = { allowed: true; action: PolicyAction } | { allowed: false; reason: string };

/** Deny by default: an action the table does not list for this role is refused, whatever the request says. */
export function authorizeEmployeeAction(role: AgentRoleKey | string, actionId: string): PolicyDecision {
  if (!(AGENT_ROLE_KEYS as readonly string[]).includes(role)) return { allowed: false, reason: "That is not one of the six AI employee roles." };
  const action = employeeActions(role as AgentRoleKey).find((a) => a.id === actionId);
  if (action) return { allowed: true, action };
  return { allowed: false, reason: allPolicyActionIds().includes(actionId) ? "This employee's role does not include that action." : "That action is not in the AI employee policy." };
}
