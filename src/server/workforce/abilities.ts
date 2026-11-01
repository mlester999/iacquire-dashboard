import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { AGENT_BY_KEY, type AgentRoleKey } from "@/lib/agents";
import { agentToolLabel } from "@/lib/agent-tools";
import { abilitiesForCapability, requiredAbilitiesForCapability } from "@/lib/employee-tool-policy";
import { isCapabilityKey, WORKFORCE_CAPABILITIES, type CapabilityKey } from "@/lib/workforce-capabilities";
import { recordActionDenied } from "@/server/workforce/action-policy";

// The "Allowed actions" switches, enforced where work starts.
//
// A workspace owner can switch an employee's abilities off (agent_config_versions.settings.disabledTools). The snapshot the employee is given and the list of things it offers
// already honour that; this module is what the dispatcher and the work runner ask, so that typing the right words, or a job queued before the switch was turned off, cannot start
// work the owner switched off. What an ability needs is decided by the reviewed tables in src/lib/employee-tool-policy.ts, never by anything the employee or a request says.

/**
 * What this employee may still do in this workspace: its role's default tools minus the ones switched off in its active configuration. Null when the employee cannot be found for
 * this workspace and role, so that a caller never acts on a guess: null fails closed. `orgId` is always named, so another tenant's employee is simply not found.
 */
export async function employeeAbilities(db: Queryable, orgId: string, agentId: string, roleKey: AgentRoleKey): Promise<ReadonlySet<string> | null> {
  const { rows } = await db.query<{ default_tools: unknown; disabled: unknown }>(
    `select r.default_tools, v.settings -> 'disabledTools' as disabled
       from agent_instances a
       join agent_roles r on r.key = a.role_key
       left join agent_config_versions v on v.id = a.active_config_version_id
      where a.id = $1 and a.org_id = $2 and a.role_key = $3`,
    [agentId, orgId, roleKey],
  );
  const row = rows[0];
  if (!row) return null;
  const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  const off = new Set(names(row.disabled));
  return new Set(names(row.default_tools).filter((tool) => !off.has(tool)));
}

export interface AbilityNeed {
  /** At least one of these must still be on. */
  anyOf: readonly string[];
  /** Every one of these must still be on. */
  allOf?: readonly string[];
}

/** The abilities that are off and block this need, in plain words for the person; null when the employee may go ahead. Null `abilities` (unreadable) blocks. Pure. */
export function missingAbilities(abilities: ReadonlySet<string> | null, need: AbilityNeed): string[] | null {
  if (abilities === null) return [...need.anyOf, ...(need.allOf ?? [])];
  const blocking: string[] = [];
  if (need.anyOf.length > 0 && !need.anyOf.some((ability) => abilities.has(ability))) blocking.push(...need.anyOf);
  for (const ability of need.allOf ?? []) if (!abilities.has(ability)) blocking.push(ability);
  return blocking.length > 0 ? [...new Set(blocking)] : null;
}

const labels = (names: readonly string[]): string => names.map((name) => `"${agentToolLabel(name)}"`).join(" or ");

export interface AbilityRefusal {
  /** What the person is told. Names the employee and the switch, and says nothing was started. */
  message: string;
  /** A short reason for the audit log. */
  reason: "ability_switched_off" | "ability_unreadable";
  abilities: string[];
}

/**
 * The decision alone: no write and no throw, so the work runner can use it where a refusal must become a blocked job. A failed read counts as "unreadable" and refuses, because
 * work the owner may have switched off is never started on a guess.
 */
export async function abilityRefusal(db: Queryable, input: { orgId: string; agentId: string; roleKey: AgentRoleKey; need: AbilityNeed }): Promise<AbilityRefusal | null> {
  let abilities: ReadonlySet<string> | null = null;
  try {
    abilities = await employeeAbilities(db, input.orgId, input.agentId, input.roleKey);
  } catch {
    abilities = null;
  }
  const missing = missingAbilities(abilities, input.need);
  if (!missing) return null;
  const name = AGENT_BY_KEY[input.roleKey]?.shortName ?? "This employee";
  if (abilities === null) return { message: `What ${name} is allowed to do could not be confirmed just now, so nothing was started.`, reason: "ability_unreadable", abilities: missing };
  return { message: `${name} has ${labels(missing)} switched off in Allowed actions. Nothing was started.`, reason: "ability_switched_off", abilities: missing };
}

/** What a reviewed capability needs, from the reviewed table. */
export const capabilityNeed = (capability: CapabilityKey): AbilityNeed => ({ anyOf: abilitiesForCapability(capability), allOf: requiredAbilitiesForCapability(capability) });

interface DeniedInput { orgId: string; agentId: string; roleKey: AgentRoleKey; actionId: string; actorUserId?: string | null }

/**
 * Writes the refusal to the audit log on its own connection (so it survives the failure it reports) and throws AppError "forbidden". Never call it inside an open transaction: the
 * audit write would be refused as a nested transaction and lost. Decide with `abilityRefusal` inside the transaction and call this after it.
 */
export async function denyAbility(input: DeniedInput, refusal: AbilityRefusal): Promise<never> {
  await recordActionDenied({
    orgId: input.orgId, agentId: input.agentId, actionId: input.actionId, actorUserId: input.actorUserId ?? null,
    actorKind: input.actorUserId ? "user" : "system", role: input.roleKey, reason: `${refusal.reason}: ${refusal.abilities.join(", ")}`,
  });
  throw new AppError("forbidden", refusal.message);
}

/**
 * Refuses (AppError "forbidden") when the employee's Allowed actions do not cover the need, after recording the denial. Starts nothing. `actionId` names what was attempted, in the
 * policy's own ids (`capability:<key>`, `chat:booking_request`). Give it a read handle (`readSystem`) or call it outside a transaction, because the denial is written separately.
 */
export async function assertAbility(db: Queryable, input: DeniedInput & { need: AbilityNeed }): Promise<void> {
  const refusal = await abilityRefusal(db, input);
  if (refusal) await denyAbility(input, refusal);
}

/**
 * The work runner's question: may this queued job still run? Looks the employee's role up from its own row, so a job can never be judged under a role it does not have. A
 * capability that is not a reviewed one is not judged here (the runner blocks it as unavailable on its own). A job whose employee cannot be found is refused.
 */
export async function jobAbilityRefusal(db: Queryable, input: { orgId: string; agentId: string; capability: string }): Promise<(AbilityRefusal & { roleKey: AgentRoleKey | null }) | null> {
  if (!isCapabilityKey(input.capability)) return null;
  let roleKey: AgentRoleKey | null = null;
  try {
    const { rows } = await db.query<{ role_key: AgentRoleKey }>("select role_key from agent_instances where id = $1 and org_id = $2", [input.agentId, input.orgId]);
    roleKey = rows[0]?.role_key ?? null;
  } catch {
    roleKey = null;
  }
  if (!roleKey) return { message: "What this employee is allowed to do could not be confirmed just now, so nothing was started.", reason: "ability_unreadable", abilities: [], roleKey: null };
  // A job filed under an employee whose role may not do this work at all is not a switch question: the handler refuses it as "not allowed", which says the true reason.
  if (!WORKFORCE_CAPABILITIES[input.capability].allowedRoles.includes(roleKey)) return null;
  const refusal = await abilityRefusal(db, { orgId: input.orgId, agentId: input.agentId, roleKey, need: capabilityNeed(input.capability) });
  return refusal ? { ...refusal, roleKey } : null;
}
