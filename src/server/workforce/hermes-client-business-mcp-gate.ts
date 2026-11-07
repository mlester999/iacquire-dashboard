import "server-only";
import type { Queryable } from "@/server/db";
import type { WorkforceRoleKey } from "@/lib/agents";
import type { CapabilityProvider, CrmCapability, CrmMode } from "@/lib/crm/types";
import { AGENT_TOOLS, type AgentToolName } from "@/server/crm/agent-tools/catalog";
import { resolveCapabilities } from "@/server/crm/workspace";
import { inboxEnabledFor } from "@/server/messaging/inbox-rollout";
import { employeeAbilities } from "@/server/workforce/abilities";
import { roleAbilitiesAllow } from "@/server/workforce/employee-evidence";
import { clientBusinessProposalRequiredAbility, clientBusinessProposalToolNamesForRole, clientBusinessProposalsOn, clientBusinessToolsOn } from "@/server/workforce/hermes-client-business-mcp-policy";
import { PROVISIONING_PAYMENT_CLEARED_SQL } from "@/server/workforce/provisioning";

/**
 * The call-time gate of the client business tools (src/server/workforce/hermes-client-business-mcp.ts).
 *
 * The list of tools an employee's profile offers is fixed by its role (the gateway checks it against a recorded digest), so whether a tool may answer RIGHT NOW is decided here, on
 * every call, from the workspace's own records: the plan still includes the role, the setup payment is still confirmed, the workspace's switch is still on, the employee's own
 * "Allowed actions" still leave it something to do, and the part of the workspace the tool reads exists and is iAcquire's own. Anything else answers "unavailable" with a reason in plain
 * words, never an empty list: an empty list reads as "there is nothing", and for a workspace whose CRM lives elsewhere that would be false.
 *
 * Every read here is a peek. Nothing is created, so asking a question of a workspace that has no CRM or calendar yet leaves it exactly as it was (the tool's own helpers would create the
 * workspace's CRM row on first touch).
 */

export type ClientGateReason =
  | "role_not_enabled"
  | "workspace_not_active"
  | "setup_payment_not_confirmed"
  | "workspace_switch_off"
  | "abilities_unreadable"
  | "abilities_off"
  | "crm_not_set_up"
  | "crm_elsewhere"
  | "calendar_not_set_up"
  | "calendar_elsewhere"
  | "inbox_not_enabled"
  | "tool_not_available";

export type ClientGateDecision = { ok: true } | { ok: false; reason: ClientGateReason; detail: string };

const OTHER_SYSTEM = "This workspace keeps this information in another system that is not connected to your assistant yet, so it cannot be read here.";

const closed = (reason: ClientGateReason, detail: string): ClientGateDecision => ({ ok: false, reason, detail });

/** Which part of the CRM a tool reads, for the tools that read the CRM. The conversation and calendar tools have their own rules below. */
const CRM_PART: Partial<Record<AgentToolName, CrmCapability>> = {
  find_contacts: "contacts",
  get_contact: "contacts",
  crm_summary_report: "reporting",
  list_opportunities: "opportunities",
};

/**
 * Which part of the CRM a change would land in, for the tools that may be PROPOSED. Only consulted for a proposal, so a gate asked about a change while proposals are off decides exactly
 * what it always did. A change to something this workspace keeps in another system is refused now, never sent to a person for approval (the tool's own plan refuses it as well). A task
 * is iAcquire's own whatever the CRM mode, so it has no entry.
 */
const PROPOSAL_CRM_PART: Partial<Record<AgentToolName, CrmCapability>> = {
  update_contact: "contacts",
  apply_tag: "contacts",
  remove_tag: "contacts",
  create_opportunity: "opportunities",
  move_opportunity_stage: "opportunities",
};

/** Who owns one capability of the workspace right now: "native", "ghl", or null when the workspace has no CRM record yet. Reads only. */
async function peekCapabilityOwner(db: Queryable, orgId: string, capability: CrmCapability): Promise<CapabilityProvider | null> {
  const { rows } = await db.query<{ mode: CrmMode; provider: CapabilityProvider | null }>(
    `select w.mode, p.provider from crm_workspaces w
       left join crm_capability_providers p on p.org_id = w.org_id and p.capability = $2
      where w.org_id = $1`,
    [orgId, capability],
  );
  const row = rows[0];
  if (!row) return null;
  return resolveCapabilities(row.mode, row.provider ? [{ capability, provider: row.provider }] : [])[capability];
}

/**
 * Whether this call may answer now. `db` is the caller's transaction, so every answer is one consistent read of the workspace. The context tool is not asked: it reports each area's own
 * state (empty, not set up, in another system, switched off) in its answer.
 */
export async function clientToolGate(db: Queryable, input: { orgId: string; agentId: string; roleKey: WorkforceRoleKey; tool: AgentToolName }): Promise<ClientGateDecision> {
  const { rows } = await db.query<{ enabled: boolean; active: boolean; client: boolean; paid: boolean }>(
    `select a.enabled, (o.status = 'active') as active, (o.kind = 'client' and not o.is_demo) as client, ${PROVISIONING_PAYMENT_CLEARED_SQL} as paid
       from agent_instances a join organizations o on o.id = a.org_id
      where a.id = $1 and a.org_id = $2 and a.role_key = $3`,
    [input.agentId, input.orgId, input.roleKey],
  );
  const row = rows[0];
  if (!row || !row.enabled) return closed("role_not_enabled", "This employee is not part of your plan, so it cannot read your business information.");
  if (!row.client || !row.active) return closed("workspace_not_active", "This workspace is not active, so business information cannot be read.");
  if (!row.paid) return closed("setup_payment_not_confirmed", "Your setup payment has not been confirmed yet, so this employee cannot read your business information.");
  if (!(await clientBusinessToolsOn(input.orgId, db))) return closed("workspace_switch_off", "Business tools are switched off for this workspace.");

  const abilities = await employeeAbilities(db, input.orgId, input.agentId, input.roleKey).catch(() => null);
  if (abilities === null) return closed("abilities_unreadable", "What this employee is allowed to do could not be confirmed just now, so nothing was read.");
  if (!roleAbilitiesAllow(input.roleKey, abilities)) return closed("abilities_off", "Every action this employee may take is switched off in Allowed actions, so nothing was read.");

  // A change passes only as a PROPOSAL: the deployment's flag, the workspace's switch (read in this same transaction, so a switch-off is seen by the very next call) and the role's own
  // list of changes it may ask for must all agree. A tool that is not a plain read or such a change (a message, a booking) never passes. Everything below is then the same as for a read.
  const kind = AGENT_TOOLS[input.tool].kind;
  const proposing = kind === "write" && clientBusinessProposalToolNamesForRole(input.roleKey).includes(input.tool) && (await clientBusinessProposalsOn(input.orgId, db));
  const requiredAbility = proposing ? clientBusinessProposalRequiredAbility(input.roleKey, input.tool) : null;
  if (requiredAbility && !abilities.has(requiredAbility)) {
    return closed("abilities_off", "CRM updates are switched off in this Growth Partner's Allowed actions, so nothing was prepared for approval.");
  }
  const part = proposing ? PROPOSAL_CRM_PART[input.tool] : CRM_PART[input.tool];
  if (part) {
    const owner = await peekCapabilityOwner(db, input.orgId, part);
    if (owner === null) return closed("crm_not_set_up", "This workspace's CRM is not set up yet, so there is nothing to read.");
    if (owner !== "native") return closed("crm_elsewhere", OTHER_SYSTEM);
  }
  if (input.tool === "check_availability") {
    const owner = await peekCapabilityOwner(db, input.orgId, "appointments");
    if (owner === null) return closed("calendar_not_set_up", "No booking calendar is set up yet, so availability cannot be checked.");
    if (owner !== "native") return closed("calendar_elsewhere", OTHER_SYSTEM);
    const calendar = await db.query("select 1 from crm_calendars where org_id = $1 and archived_at is null limit 1", [input.orgId]);
    if (!calendar.rows.length) return closed("calendar_not_set_up", "No booking calendar is set up yet, so availability cannot be checked.");
  }
  if (input.tool === "get_conversation_history") {
    // The history is read from the native inbox, so it answers only for a workspace whose conversations are iAcquire's own: for one kept elsewhere, "no conversation found" would be false.
    const owner = await peekCapabilityOwner(db, input.orgId, "conversations");
    if (owner === null) return closed("crm_not_set_up", "This workspace's CRM is not set up yet, so there is nothing to read.");
    if (owner !== "native") return closed("crm_elsewhere", OTHER_SYSTEM);
    if (!(await inboxEnabledFor(input.orgId, db))) return closed("inbox_not_enabled", "The shared inbox is not switched on for this workspace yet, so conversations cannot be read.");
  }
  if (kind === "read" || proposing) return { ok: true };
  return closed("tool_not_available", kind === "write" ? "Asking for changes is not switched on for this workspace, so this tool is not available." : "This tool is not available.");
}
