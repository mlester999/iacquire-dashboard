import "server-only";
import { AI_GROWTH_PARTNER_ROLE_KEY } from "@/lib/agents";
import { deriveGrowthPartnerCapabilityAccess } from "@/lib/ai-growth-partner-capability-access";
import { employeeAbilities } from "@/server/workforce/abilities";
import { withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import type { OrgContext } from "@/server/tenancy/context";

/** Current member access and the unified runtime's saved ability switches for the Control Center. */
export async function getGrowthPartnerCapabilityAccess(
  ctx: OrgContext,
  input: { partnerExists: boolean; runtimeAgentId: string | null; runtimeReady: boolean },
) {
  if (!ctx.can("agents.use")) throw new AppError("forbidden", "You don't have access to the AI Growth Partner.");

  return withUser(ctx.user.id, async (db) => {
    const activeAbilities = input.runtimeAgentId
      ? await employeeAbilities(db, ctx.org.orgId, input.runtimeAgentId, AI_GROWTH_PARTNER_ROLE_KEY)
      : null;
    return deriveGrowthPartnerCapabilityAccess({
      ...input,
      can: (permission) => ctx.can(permission),
      activeAbilities,
    });
  });
}
