// What each legacy AI employee and the unified Growth Partner may DO, in one table, decided by the server and never by the employee's own instructions.
//
// An employee can affect the business through four doors, and every door is closed by default (deny unless this table names the role and the action):
//   capability     a durable, reviewed piece of work the portal runs for it (src/lib/workforce-capabilities.ts). Read-only reviews, or drafts a person must approve.
//   chat proposal  something a person asked for in chat that the portal turns into a PREVIEW (a booking or a change of appointment); a person confirms and the usual approvals follow.
//   crm scope      what its CRM tool token may carry (src/lib/agent-tool-scopes.ts), intersected with the run's token and the CRM permissions at call time.
//   runtime tool   what its Hermes profile can call by itself: memory, session search, a to-do list, picture analysis, and public web research for the Lead Hunter ONLY.
// Nothing here reads model output. A prompt that tells the Sales Assistant to "act as the Lead Hunter" changes nothing: the role comes from the employee's database row, and the
// table is looked up by that role. The portal tests (tests/employee-tool-policy.test.ts and the conformance suite) walk every role against every action and the real enforcement code.
import { AI_GROWTH_PARTNER_ROLE_KEY, isWorkforceRoleKey, type WorkforceRoleKey } from "@/lib/agents";
import { CAPABILITY_KEYS, WORKFORCE_CAPABILITIES, type CapabilityKey } from "@/lib/workforce-capabilities";
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

const CHAT_PROPOSALS: Record<string, { label: string; roles: readonly WorkforceRoleKey[]; effect: PolicyEffect }> = {
  "chat:booking_request": { label: "Prepare an appointment booking for confirmation", roles: ["appointment_setter", AI_GROWTH_PARTNER_ROLE_KEY], effect: "proposal" },
  "chat:appointment_change": { label: "Prepare an appointment cancellation or reschedule for approval", roles: ["appointment_setter", AI_GROWTH_PARTNER_ROLE_KEY], effect: "proposal" },
  "chat:targeting_update": { label: "Update saved lead targeting rules", roles: ["lead_hunter", AI_GROWTH_PARTNER_ROLE_KEY], effect: "proposal" },
  "chat:messaging_hours_update": { label: "Update workspace Messaging business hours", roles: [AI_GROWTH_PARTNER_ROLE_KEY], effect: "proposal" },
  "chat:partner_preferences_update": { label: "Change persistent AI Growth Partner communication preferences", roles: [AI_GROWTH_PARTNER_ROLE_KEY], effect: "proposal" },
  "chat:partner_goal_update": { label: "Set a measurable AI Growth Partner goal", roles: [AI_GROWTH_PARTNER_ROLE_KEY], effect: "proposal" },
  "chat:outbound_control": { label: "Pause or resume all outbound AI actions for this workspace", roles: [AI_GROWTH_PARTNER_ROLE_KEY], effect: "proposal" },
  "chat:crm_contact_create": { label: "Create one CRM contact after checking for duplicates", roles: [AI_GROWTH_PARTNER_ROLE_KEY], effect: "proposal" },
  "chat:crm_opportunity_create": { label: "Create one CRM opportunity linked to an existing contact", roles: [AI_GROWTH_PARTNER_ROLE_KEY], effect: "proposal" },
  "chat:crm_opportunity_move": { label: "Move one CRM opportunity within its existing pipeline", roles: [AI_GROWTH_PARTNER_ROLE_KEY], effect: "proposal" },
  "chat:appointment_policy_update": { label: "Update appointment booking rules", roles: [AI_GROWTH_PARTNER_ROLE_KEY], effect: "proposal" },
  "chat:calendar_create": { label: "Create a private calendar and hidden appointment type", roles: [AI_GROWTH_PARTNER_ROLE_KEY], effect: "proposal" },
};

// ---------------------------------------------------------------------------
// Allowed actions (abilities)
// ---------------------------------------------------------------------------
// The workspace owner can switch an employee's abilities off in Allowed actions (agent_config_versions.settings.disabledTools). The names are the role's default tools
// (agent_roles.default_tools). The data below says which abilities each door needs; src/server/workforce/abilities.ts reads the switches and enforces them where work starts.

/**
 * The abilities (the employee's Allowed actions) that let a role read its areas. An area is read only when the employee still has at least one of them switched on, in addition to
 * the signed-in person's own permission. The role's list applies to every area unless the role names a narrower one.
 */
export const ROLE_ABILITIES: Record<WorkforceRoleKey, readonly string[]> = {
  operations_manager: ["tasks.read"],
  lead_hunter: ["leads.stage_for_review", "research.public_web"],
  appointment_setter: ["calendar.read_availability", "appointments.read", "appointments.request_change"],
  sales_assistant: ["crm.read_opportunities"],
  crm_manager: ["crm.read"],
  performance_analyst: ["analytics.read"],
  // The unified identity receives the union of the six skill switches. Each action still checks
  // its own required permission and current switch at dispatch and again when the job runs.
  growth_partner: [
    "tasks.read", "research.public_web", "leads.stage_for_review",
    "calendar.read_availability", "appointments.read", "appointments.request_change",
    "calendar.booking_rules.update", "calendar.create", "crm.read", "crm.read_opportunities", "crm.request_update", "crm.contacts.create", "drafts.create", "analytics.read",
  ],
};

/**
 * Reviewed: the abilities a capability needs. The employee must still have at least one of them switched on, or the work is refused where it starts and blocked if it was already
 * queued. Every capability is listed (the type forces it), so a new capability cannot be added without deciding which switch governs it. The chat request list names the same
 * abilities for the capabilities it can start (tests/employee-ability-enforcement.test.ts keeps the two in step).
 */
const CAPABILITY_ABILITIES: Record<CapabilityKey, readonly string[]> = {
  lead_research: ["research.public_web"],
  lead_generation_review: ["leads.stage_for_review", "research.public_web"],
  proactive_review: ["tasks.read"],
  crm_quality_review: ["crm.read"],
  pipeline_review: ["crm.read_opportunities"],
  pipeline_followup_drafts: ["crm.read_opportunities"],
  appointment_review: ["appointments.read", "appointments.request_change"],
  appointment_availability: ["calendar.read_availability"],
  missed_call_review: ["appointments.read"],
  lead_priority_review: ["crm.read_opportunities"],
  social_performance_review: ["analytics.read"],
  receivables_review: ["analytics.read"],
  reputation_review: ["analytics.read"],
  performance_snapshot: ["analytics.read"],
};

/**
 * Abilities that must ALL be on, in addition to the "at least one" list above. Only the follow-up drafts need it: they read opportunities and also write unsent drafts, and a
 * workspace that switched off "Draft messages" must not get drafts because "Read CRM opportunities" is still on.
 */
const CAPABILITY_REQUIRED_ABILITIES: Partial<Record<CapabilityKey, readonly string[]>> = {
  pipeline_followup_drafts: ["drafts.create"],
};

/** The abilities of which the employee must still have at least one on to run this capability. Never empty. */
export const abilitiesForCapability = (capability: CapabilityKey): readonly string[] => CAPABILITY_ABILITIES[capability];
/** The abilities that must every one be on to run this capability (usually none). */
export const requiredAbilitiesForCapability = (capability: CapabilityKey): readonly string[] => CAPABILITY_REQUIRED_ABILITIES[capability] ?? [];

/** The same rule for what a person asks for in chat that becomes a preview (not a reviewed capability): keyed like the policy action ids. */
export const CHAT_ACTION_ABILITIES: Record<string, readonly string[]> = {
  "chat:booking_request": ["appointments.request_change"],
  "chat:appointment_change": ["appointments.request_change"],
  "chat:targeting_update": ["research.public_web"],
  // A person explicitly changes their workspace Messaging settings; no autonomous messaging ability is needed.
  "chat:messaging_hours_update": [],
  // This is a direct, owner-authorized workspace settings change, not an autonomous employee tool.
  "chat:partner_preferences_update": [],
  // Goal edits are directly authorized workspace settings changes, not autonomous employee actions.
  "chat:partner_goal_update": [],
  // Workspace pause/resume is directly authorized by the signed-in owner/admin, not by model autonomy.
  "chat:outbound_control": [],
  "chat:crm_contact_create": ["crm.contacts.create"],
  "chat:crm_opportunity_create": ["crm.request_update"],
  "chat:crm_opportunity_move": ["crm.request_update"],
  "chat:appointment_policy_update": ["calendar.booking_rules.update"],
  "chat:calendar_create": ["calendar.create"],
};

/**
 * The tools a client employee's Hermes profile may expose. The three that every profile needs, and the reviewed optional ones. Public web research belongs only to the
 * unified Growth Partner and retained Lead Hunter runtime; other roles do not get the tools to do it.
 */
export const RUNTIME_TOOL_ROLES: Record<string, { toolset: string; roles: readonly WorkforceRoleKey[] | "all"; optional?: boolean }> = {
  memory: { toolset: "memory", roles: "all" },
  session_search: { toolset: "session_search", roles: "all" },
  todo_list: { toolset: "todo", roles: "all" },
  vision_analyze: { toolset: "vision", roles: "all", optional: true },
  web_search: { toolset: "web", roles: ["lead_hunter", AI_GROWTH_PARTNER_ROLE_KEY] },
  web_extract: { toolset: "web", roles: ["lead_hunter", AI_GROWTH_PARTNER_ROLE_KEY] },
};

const runtimeAllowed = (tool: string, role: WorkforceRoleKey): boolean => {
  const entry = RUNTIME_TOOL_ROLES[tool];
  return Boolean(entry) && (entry.roles === "all" || entry.roles.includes(role));
};

/** Every tool the role's profile may expose (required and optional). */
export const runtimeToolsFor = (role: WorkforceRoleKey): string[] => Object.keys(RUNTIME_TOOL_ROLES).filter((t) => runtimeAllowed(t, role));
/** The tools it must expose to be usable at all. */
export const requiredRuntimeToolsFor = (role: WorkforceRoleKey): string[] => runtimeToolsFor(role).filter((t) => !RUNTIME_TOOL_ROLES[t].optional);
/** The toolsets those tools sit in: what the profile's server-side allowlist (platform_toolsets.api_server) should name. */
export const runtimeToolsetsFor = (role: WorkforceRoleKey): string[] => [...new Set(runtimeToolsFor(role).map((t) => RUNTIME_TOOL_ROLES[t].toolset))].sort();

export interface RuntimeExposure {
  ok: boolean;
  /** Tools the profile exposes that this role's policy does not name. */
  excess: string[];
  /** Tools this role needs that the profile does not expose. */
  missing: string[];
}

/** Judges the tool names a profile actually exposes against the role's policy. Pure; the names come from the verified inventory, never from the employee. */
export function runtimeToolExposure(role: WorkforceRoleKey, exposed: readonly string[]): RuntimeExposure {
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

export function employeeActions(role: WorkforceRoleKey): PolicyAction[] {
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

/** Every action id that exists anywhere in the product, for the walk across legacy and unified roles. */
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
export function authorizeEmployeeAction(role: WorkforceRoleKey | string, actionId: string): PolicyDecision {
  if (!isWorkforceRoleKey(role)) return { allowed: false, reason: "That is not a supported AI employee role." };
  const action = employeeActions(role).find((a) => a.id === actionId);
  if (action) return { allowed: true, action };
  return { allowed: false, reason: allPolicyActionIds().includes(actionId) ? "This employee's role does not include that action." : "That action is not in the AI employee policy." };
}
