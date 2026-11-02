import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { PRODUCT_VERSION } from "@/lib/purchase-intents/rules";

/**
 * Which AI employees a purchase includes: ONE reviewed table, so the answer is never scattered over the purchase flow, the questionnaire and the launch panel.
 *
 * The key is the product the buyer agreed to, which is the only identifier a purchase carries today (PRODUCT_VERSION, frozen on the purchase row with its price). There is no
 * multi-plan catalogue yet, so there is one entry, and it is all six employees: exactly what every purchase has always received. The CONTENTS of this table are the founder's decision
 * (the plan-to-employees approval). Until the founder decides, every entry stays at all six; a plan with fewer employees is added here, as a reviewed change, together with its price.
 *
 * A purchase whose product is not in the table (or has none) gets all six AND says so (`defaulted`), so the purchase service can leave an audit row naming the key. Failing to the
 * full team is deliberate: it is today's behaviour, so a missing entry can never take an employee away from someone who paid for the team.
 *
 * A plan with fewer roles creates the other employees registered but switched off ("not entitled"), the way every partial-plan client already is; the questionnaire and the launch panel
 * treat an employee that is not in the plan as not applicable (see planScope in src/lib/onboarding/engine.ts and the launch readiness judge).
 */
export const PLAN_EMPLOYEES: Readonly<Record<string, readonly AgentRoleKey[]>> = {
  [PRODUCT_VERSION]: AGENT_ROLE_KEYS,
};

/** The plan keys the purchase catalogue knows. Read from the catalogue's own constant, never typed again here. */
export const KNOWN_PLAN_KEYS: readonly string[] = Object.keys(PLAN_EMPLOYEES);

export interface PlanRoles {
  /** The employees the purchase includes, in the product's own order. Never empty. */
  roles: AgentRoleKey[];
  /** The key was unknown or missing, so the full team was used. The caller records it. */
  defaulted: boolean;
}

/** The employees a purchased plan includes. `table` is a parameter so a test can prove the mechanism with a different table; production passes nothing. */
export function rolesForPlan(planKey: string | null | undefined, table: Readonly<Record<string, readonly AgentRoleKey[]>> = PLAN_EMPLOYEES): PlanRoles {
  const known = typeof planKey === "string" && Object.prototype.hasOwnProperty.call(table, planKey) ? table[planKey] : undefined;
  // An entry that names no real employee, or none at all, is as unusable as no entry: the full team, and said so.
  const valid = known?.filter((role) => (AGENT_ROLE_KEYS as readonly string[]).includes(role));
  if (!valid?.length) return { roles: [...AGENT_ROLE_KEYS], defaulted: true };
  // The product's own order, each employee once, whatever order or repeats the table was written with.
  return { roles: AGENT_ROLE_KEYS.filter((role) => valid.includes(role)), defaulted: false };
}
