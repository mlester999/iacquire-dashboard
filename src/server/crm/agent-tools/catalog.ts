import "server-only";
import { z } from "zod";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { LEAD_STATUSES, PREFERRED_CHANNELS } from "@/lib/crm/types";
import type { Permission } from "@/lib/permissions";

/**
 * The CRM tools a client's own AI employee can call, and what each one needs.
 *
 * Access is the intersection of three things, all decided by the server:
 *  1. the employee's role allowlist (ROLE_SCOPES), fixed in code and reviewed with the agency policy;
 *  2. the scopes on the short-lived token issued for one run (crm_agent_tokens.scopes);
 *  3. the CRM permissions those scopes map to (SCOPE_INFO), which every CRM service checks again.
 * The employee's operating mode then decides whether a permitted write runs now, waits for a person, or is refused.
 * Nothing in a request can widen any of these: the organization and the employee come from the token row.
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

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/**
 * read:     looks things up; allowed while the employee is working, in approval-required mode too.
 * write:    changes CRM records; runs now only for an autonomous employee and never for a high-impact change, otherwise it becomes a
 *           CRM update approval.
 * proposal: prepares something a person (or the existing booking and message rules) still decides on: a draft message, an approval
 *           request, an appointment request. It never sends or books by itself beyond those rules.
 */
export type AgentToolKind = "read" | "write" | "proposal";

const id = z.uuid({ error: "Use the record's id exactly as a previous tool returned it." });
const when = z.iso.datetime({ offset: true, error: "Use an ISO 8601 date and time with a time zone, like 2026-11-03T14:00:00+08:00." });
const shortText = (max: number) => z.string().trim().min(1).max(max);
const reason = z.string().trim().min(3).max(300).optional().describe("Why you are doing this, in one sentence. Shown to the person who approves it.");
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();

const contactChanges = z
  .strictObject({
    firstName: nullableText(100),
    lastName: nullableText(100),
    leadStatus: z.enum(LEAD_STATUSES).optional(),
    leadScore: z.number().int().min(0).max(100).nullable().optional(),
    preferredLanguage: nullableText(35).describe("A language code such as en or fil."),
    preferredChannel: z.enum(PREFERRED_CHANNELS).nullable().optional(),
    timezone: nullableText(64).describe("An IANA time zone such as Asia/Manila."),
    city: nullableText(100),
    region: nullableText(100),
    country: z.string().trim().regex(/^[A-Za-z]{2}$/, "Use a two-letter country code, such as PH or US.").nullable().optional(),
    postalCode: nullableText(20),
    source: nullableText(60),
  })
  .refine((v) => Object.keys(v).length > 0, { error: "Name at least one field to change." });

export const TOOL_INPUTS = {
  find_contacts: z.strictObject({
    query: shortText(80).describe("Part of a name, email address or phone number."),
    limit: z.number().int().min(1).max(25).optional(),
  }),
  get_contact: z.strictObject({ contactId: id }),
  update_contact: z.strictObject({
    contactId: id,
    changes: contactChanges.describe("Only these fields can be changed. Email addresses, phone numbers, owners and consent stay with people."),
    reason,
  }),
  apply_tag: z.strictObject({
    contactIds: z.array(id).min(1).max(25),
    tags: z.array(shortText(50)).min(1).max(5).describe("Names of tags that already exist in this workspace."),
    reason,
  }),
  remove_tag: z.strictObject({
    contactIds: z.array(id).min(1).max(25),
    tags: z.array(shortText(50)).min(1).max(5),
    reason,
  }),
  create_task: z.strictObject({
    title: shortText(200),
    description: z.string().trim().max(2000).optional(),
    dueAt: when.optional(),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    contactId: id.optional(),
    opportunityId: id.optional(),
    assigneeId: id.optional().describe("A teammate's user id. Leave out to leave the task unassigned."),
    reason,
  }),
  create_opportunity: z.strictObject({
    name: shortText(200),
    contactId: id.optional(),
    pipelineId: id.optional(),
    stageId: id.optional().describe("An open stage. Leave out to start in the pipeline's first stage."),
    value: z.number().min(0).max(999_999_999_999).optional(),
    currency: z.string().trim().regex(/^[A-Za-z]{3}$/, "Use a three-letter currency code.").optional(),
    expectedCloseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-30.").optional(),
    description: z.string().trim().max(2000).optional(),
    reason,
  }),
  move_opportunity_stage: z.strictObject({
    opportunityId: id,
    stageId: id,
    lostReason: z.string().trim().min(3).max(300).optional().describe("Required when the stage marks the deal as lost."),
    reason,
  }),
  check_availability: z.strictObject({
    appointmentTypeId: id.optional().describe("An appointment type or calendar id. Leave out for the default calendar."),
    from: when.optional(),
    days: z.number().int().min(1).max(14).optional(),
    limit: z.number().int().min(1).max(30).optional(),
  }),
  request_appointment: z.strictObject({
    contactId: id,
    startAt: when.describe("A start time exactly as check_availability returned it."),
    appointmentTypeId: id.optional(),
    title: z.string().trim().max(200).optional(),
  }),
  get_conversation_history: z
    .strictObject({
      conversationId: id.optional(),
      contactId: id.optional(),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .refine((v) => Boolean(v.conversationId) !== Boolean(v.contactId), { error: "Give either a conversationId or a contactId." }),
  prepare_message: z.strictObject({
    conversationId: id,
    body: shortText(2000),
  }),
  request_send_approval: z.strictObject({
    messageId: id.describe("The draft id prepare_message returned."),
    note: z.string().trim().max(300).optional(),
  }),
  crm_summary_report: z.strictObject({
    periodDays: z.number().int().min(1).max(90).optional(),
  }),
} as const;

export type AgentToolName = keyof typeof TOOL_INPUTS;
export type ToolInput<N extends AgentToolName> = z.infer<(typeof TOOL_INPUTS)[N]>;

export interface AgentToolDef {
  name: AgentToolName;
  label: string;
  /** What the tool does, for the employee's tool list. Plain and specific. */
  description: string;
  kind: AgentToolKind;
  scope: AgentToolScope;
  permissions: readonly Permission[];
  /** Always needs a person's approval, whatever the employee's mode (anything that would reach a customer). */
  alwaysApproval?: boolean;
  /** When a single call becomes high-impact (and so always needs approval), in the client's words. */
  highImpactWhen?: string;
}

export const AGENT_TOOLS: Record<AgentToolName, AgentToolDef> = {
  find_contacts: {
    name: "find_contacts", label: "Find contacts", kind: "read", scope: "contacts:read", permissions: ["contacts.view"],
    description: "Search this workspace's contacts by name, email or phone. Returns up to 25 matches with id, name, email, phone and lead status.",
  },
  get_contact: {
    name: "get_contact", label: "Read a contact", kind: "read", scope: "contacts:read", permissions: ["contacts.view"],
    description: "Read one contact: name, contact details, lead status, owner, tags, open deals, open tasks and upcoming appointments.",
  },
  update_contact: {
    name: "update_contact", label: "Update contact details", kind: "write", scope: "contacts:write", permissions: ["contacts.edit"],
    description: "Change a contact's name, lead status, lead score, language, preferred channel, time zone, location or source. Email, phone, owner and consent are not editable here.",
  },
  apply_tag: {
    name: "apply_tag", label: "Add tags", kind: "write", scope: "tags:write", permissions: ["contacts.edit"],
    description: "Add existing tags to contacts. Tagging more than one contact at once always waits for approval.",
    highImpactWhen: "it changes more than one contact",
  },
  remove_tag: {
    name: "remove_tag", label: "Remove tags", kind: "write", scope: "tags:write", permissions: ["contacts.edit"],
    description: "Remove tags from contacts. Changing more than one contact at once always waits for approval.",
    highImpactWhen: "it changes more than one contact",
  },
  create_task: {
    name: "create_task", label: "Create a task", kind: "write", scope: "tasks:write", permissions: ["tasks.manage"],
    description: "Create a task for the team, optionally linked to a contact or deal and assigned to a teammate.",
  },
  create_opportunity: {
    name: "create_opportunity", label: "Create a deal", kind: "write", scope: "opportunities:write", permissions: ["opportunities.edit"],
    description: "Create a deal in an open stage of a pipeline, optionally linked to a contact.",
  },
  move_opportunity_stage: {
    name: "move_opportunity_stage", label: "Move a deal", kind: "write", scope: "opportunities:write", permissions: ["opportunities.edit"],
    description: "Move an open deal to another stage. Marking a deal won or lost always waits for approval; reopening a closed deal is for people only.",
    highImpactWhen: "it marks the deal won or lost",
  },
  check_availability: {
    name: "check_availability", label: "Check availability", kind: "read", scope: "calendar:read", permissions: ["appointments.view"],
    description: "List free appointment times on this workspace's own calendars for the next few days.",
  },
  request_appointment: {
    name: "request_appointment", label: "Request an appointment", kind: "proposal", scope: "appointments:request", permissions: ["appointments.book"],
    description: "Ask to book a contact at a free time. The time is held and the workspace's booking rules decide: usually a person confirms it in the Approval Center first.",
  },
  get_conversation_history: {
    name: "get_conversation_history", label: "Read conversation history", kind: "read", scope: "conversations:read", permissions: ["inbox.view"],
    description: "Read the recent messages of a conversation this employee handles (up to 50, newest last). Internal notes are never included.",
  },
  prepare_message: {
    name: "prepare_message", label: "Draft a message", kind: "proposal", scope: "messages:draft", permissions: ["inbox.reply"],
    description: "Write a draft reply in a conversation this employee handles. The draft is never sent by itself.",
  },
  request_send_approval: {
    name: "request_send_approval", label: "Ask to send a draft", kind: "proposal", scope: "messages:draft", permissions: ["inbox.reply"],
    description: "Ask a person to approve sending a draft. Even after approval, consent, opt-outs, quiet hours and pauses are checked again before anything is sent.",
    alwaysApproval: true,
  },
  crm_summary_report: {
    name: "crm_summary_report", label: "CRM summary counts", kind: "read", scope: "reports:read", permissions: ["analytics.view"],
    description: "Counts only: contacts, new contacts, open and closed deals, open and overdue tasks, upcoming appointments and open conversations.",
  },
};

export const AGENT_TOOL_NAMES = Object.keys(AGENT_TOOLS) as AgentToolName[];
export const isAgentToolName = (value: unknown): value is AgentToolName => typeof value === "string" && Object.prototype.hasOwnProperty.call(AGENT_TOOLS, value);

/** The tools a role can ever use (before a token narrows them). */
export function toolsForRole(roleKey: string): AgentToolName[] {
  if (!isAgentRole(roleKey)) return [];
  const scopes = new Set<AgentToolScope>(ROLE_SCOPES[roleKey]);
  return AGENT_TOOL_NAMES.filter((n) => scopes.has(AGENT_TOOLS[n].scope));
}

/** Tool definitions in the shape an agent runtime lists them (name, description, JSON Schema of the arguments). */
export function toolManifest(names: readonly AgentToolName[]) {
  return names.map((n) => ({
    name: n,
    description: AGENT_TOOLS[n].description,
    kind: AGENT_TOOLS[n].kind,
    input_schema: z.toJSONSchema(TOOL_INPUTS[n], { io: "input", unrepresentable: "any" }),
  }));
}
