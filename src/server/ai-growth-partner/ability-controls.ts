import "server-only";
import { z } from "zod";
import { AI_GROWTH_PARTNER_ROLE_KEY } from "@/lib/agents";
import { agentSettingsSchema } from "@/lib/agent-settings";
import { ROLE_ABILITIES } from "@/lib/employee-tool-policy";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import type { OrgContext } from "@/server/tenancy/context";
import { createConfigVersion } from "@/server/workforce/service";

const reviewedAbilities = ROLE_ABILITIES[AI_GROWTH_PARTNER_ROLE_KEY];

const abilityKeys = z.array(z.enum(reviewedAbilities)).min(1).max(reviewedAbilities.length);
const restrictionSchema = z.strictObject({ expectedVersionId: z.uuid(), restrict: abilityKeys });
const restorationSchema = z.strictObject({ expectedVersionId: z.uuid(), restore: abilityKeys });

export type GrowthPartnerAbilityControls =
  | { state: "setup_required" }
  | {
    state: "ready" | "review_pending";
    versionId: string;
    version: number;
    abilities: { key: string; restricted: boolean }[];
  };

function assertOwnerAccess(ctx: OrgContext) {
  if (ctx.org.kind !== "client" || (ctx.role !== "owner" && ctx.role !== "admin") ||
      !ctx.can("agents.use") || !ctx.can("agents.configure")) {
    throw new AppError("forbidden", "Only a workspace owner or admin can manage Growth Partner actions.");
  }
}

async function readActiveConfig(db: Queryable, orgId: string) {
  return (await db.query<{
    runtime_id: string;
    version_id: string;
    version: number;
    default_tools: string[];
    settings: unknown;
    has_open_version: boolean;
  }>(
    `select runtime.id as runtime_id, active.id as version_id, active.version, active.settings, role.default_tools,
            exists (
              select 1 from agent_config_versions candidate
              where candidate.org_id = runtime.org_id and candidate.agent_instance_id = runtime.id
                and (candidate.status in ('pending_approval', 'pending_agency_review')
                     or (candidate.status = 'draft' and candidate.version > active.version))
            ) as has_open_version
       from ai_growth_partners partner
       join agent_instances runtime on runtime.id = partner.runtime_agent_instance_id
         and runtime.org_id = partner.org_id and runtime.role_key = $2
       join agent_roles role on role.key = runtime.role_key
       join agent_config_versions active on active.id = runtime.active_config_version_id
         and active.org_id = runtime.org_id and active.agent_instance_id = runtime.id and active.status = 'applied'
       where partner.org_id = $1`,
    [orgId, AI_GROWTH_PARTNER_ROLE_KEY],
  )).rows[0];
}

export async function getGrowthPartnerAbilityControls(ctx: OrgContext): Promise<GrowthPartnerAbilityControls> {
  assertOwnerAccess(ctx);
  return withUser(ctx.user.id, async (db) => {
    const row = await readActiveConfig(db, ctx.org.orgId);
    if (!row) return { state: "setup_required" };
    const settings = agentSettingsSchema.safeParse(row.settings);
    if (!settings.success) throw new AppError("unavailable", "The applied configuration could not be read.");
    return {
      state: row.has_open_version ? "review_pending" : "ready",
      versionId: row.version_id,
      version: row.version,
      abilities: reviewedAbilities.filter((key) => row.default_tools.includes(key)).map((key) => ({
        key,
        restricted: settings.data.disabledTools.includes(key),
      })),
    };
  });
}

/** A restriction can only add to disabledTools. */
export async function restrictGrowthPartnerAbilities(ctx: OrgContext, input: unknown) {
  assertOwnerAccess(ctx);
  const parsed = restrictionSchema.safeParse(input);
  if (!parsed.success) throw new AppError("invalid_input", "Choose one or more reviewed actions to switch off.");
  return changeGrowthPartnerAbilities(ctx, parsed.data.expectedVersionId, parsed.data.restrict, "restrict");
}

/** Restoring a role-default ability must produce a held version for the agency reviewer. */
export async function requestGrowthPartnerAbilityRestoration(ctx: OrgContext, input: unknown) {
  assertOwnerAccess(ctx);
  const parsed = restorationSchema.safeParse(input);
  if (!parsed.success) throw new AppError("invalid_input", "Choose one or more reviewed actions to restore.");
  return changeGrowthPartnerAbilities(ctx, parsed.data.expectedVersionId, parsed.data.restore, "restore");
}

async function changeGrowthPartnerAbilities(ctx: OrgContext, expectedVersionId: string, keys: string[], change: "restrict" | "restore") {
  const orgId = ctx.org.orgId;
  return withSystem(async (db) => {
    // Serialize with the version writer. Read the active pointer and open versions after obtaining
    // the lock so a concurrent save cannot slip between our stale check and the new version.
    const locked = (await db.query<{ id: string }>(
      `select runtime.id
         from ai_growth_partners partner
         join agent_instances runtime on runtime.id = partner.runtime_agent_instance_id
           and runtime.org_id = partner.org_id and runtime.role_key = $2
         where partner.org_id = $1
         for update of runtime`,
      [orgId, AI_GROWTH_PARTNER_ROLE_KEY],
    )).rows[0];
    if (!locked) throw new AppError("not_found", "This workspace has no configured Growth Partner runtime.");
    const row = await readActiveConfig(db, orgId);
    if (!row || row.runtime_id !== locked.id || row.version_id !== expectedVersionId) {
      throw new AppError("conflict", "The applied configuration changed. Refresh this page and review the current actions.");
    }
    const active = agentSettingsSchema.safeParse(row.settings);
    if (!active.success) throw new AppError("unavailable", "The applied configuration could not be read.");
    if (!keys.every((key) => row.default_tools.includes(key))) {
      throw new AppError("invalid_input", "One or more actions are unavailable in this workspace.");
    }

    const current = active.data.disabledTools;
    const restoring = change === "restore";
    const changed = [...new Set(keys)].filter((key) => current.includes(key) === restoring);
    if (!changed.length) return { version: row.version, status: "unchanged" as const };
    if (row.has_open_version) {
      throw new AppError("conflict", "A configuration change is open. Resolve it before making another change.");
    }
    const disabledTools = restoring ? current.filter((key) => !changed.includes(key)) : [...current, ...changed];
    const result = await createConfigVersion(db, {
      orgId,
      agentId: locked.id,
      settings: { ...active.data, disabledTools },
      source: "client_edit",
      changeRequest: `${restoring ? "Restore" : "Restrict"} Growth Partner actions: ${changed.join(", ")}`,
      userId: ctx.user.id,
      apply: !restoring,
    });
    if (restoring && result.status !== "pending_agency_review") {
      throw new AppError("unavailable", "The restoration request could not enter agency review.");
    }
    return { version: result.version, status: result.status === "applied" ? "applied" as const : "review_pending" as const };
  });
}
