import { AI_GROWTH_PARTNER_ROLE_KEY, WORKFORCE_ROLE_KEYS, isWorkforceRoleKey, type WorkforceRoleKey } from "@/lib/agents";
import { PRODUCT_VERSION } from "@/lib/purchase-intents/rules";

/**
 * Which runtime identity a new purchase provisions: one reviewed table, so the answer is never scattered over purchase and onboarding.
 *
 * The key is the product the buyer agreed to, which is the only identifier a purchase carries today (PRODUCT_VERSION, frozen on the purchase row with its price). The commercial
 * terms stay intact: one Growth Partner carries the same six capability domains. This table controls runtime identity only; it does not change pricing or usage entitlements.
 *
 * A purchase whose product is not in the table (or has none) gets the Growth Partner AND says so (`defaulted`), so the purchase service can leave an audit row naming the key.
 *
 * Historical role identities remain available to existing tenants; new purchases provision one Growth Partner profile.
 */
export const PLAN_EMPLOYEES: Readonly<Record<string, readonly WorkforceRoleKey[]>> = {
  [PRODUCT_VERSION]: [AI_GROWTH_PARTNER_ROLE_KEY],
};

/** The plan keys the purchase catalogue knows. Read from the catalogue's own constant, never typed again here. */
export const KNOWN_PLAN_KEYS: readonly string[] = Object.keys(PLAN_EMPLOYEES);

export interface PlanRoles {
  /** The runtime identity the purchase provisions. Never empty. */
  roles: WorkforceRoleKey[];
  /** The key was unknown or missing, so the Growth Partner default was used. The caller records it. */
  defaulted: boolean;
}

/** The employees a purchased plan includes. `table` is a parameter so a test can prove the mechanism with a different table; production passes nothing. */
export function rolesForPlan(planKey: string | null | undefined, table: Readonly<Record<string, readonly WorkforceRoleKey[]>> = PLAN_EMPLOYEES): PlanRoles {
  const known = typeof planKey === "string" && Object.prototype.hasOwnProperty.call(table, planKey) ? table[planKey] : undefined;
  // An entry that names no real employee, or none at all, is as unusable as no entry: the full team, and said so.
  const valid = known?.filter(isWorkforceRoleKey);
  if (!valid?.length) return { roles: [AI_GROWTH_PARTNER_ROLE_KEY], defaulted: true };
  return { roles: WORKFORCE_ROLE_KEYS.filter((role) => valid.includes(role)), defaulted: false };
}
