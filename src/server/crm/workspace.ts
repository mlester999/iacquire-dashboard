import "server-only";
import { cache } from "react";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { CAPABILITY_LABELS, CRM_CAPABILITIES, type CapabilityProvider, type CrmCapability, type CrmMode } from "@/lib/crm/types";

export interface CrmWorkspace {
  orgId: string;
  mode: CrmMode;
  defaultCurrency: string;
  defaultCallingCode: string | null;
  switching: boolean;
  blueprintKey: string | null;
  initializedAt: string | null;
  capabilities: Record<CrmCapability, CapabilityProvider>;
  ghlConnected: boolean;
}

interface WorkspaceRow {
  org_id: string;
  mode: CrmMode;
  default_currency: string;
  default_calling_code: string | null;
  switching: boolean;
  blueprint_key: string | null;
  initialized_at: Date | null;
  capabilities: Array<{ capability: string; provider: CapabilityProvider }>;
  ghl_connected: boolean;
}

/** One statement so the CRM layout does not pay three hosted round trips before the page can render. */
const WORKSPACE_SQL = `select w.org_id, w.mode, w.default_currency, w.default_calling_code, w.switching, w.blueprint_key, w.initialized_at,
       coalesce((select json_agg(json_build_object('capability', p.capability, 'provider', p.provider))
                 from crm_capability_providers p where p.org_id = w.org_id), '[]'::json) as capabilities,
       exists(select 1 from ghl_location_mappings g where g.org_id = w.org_id and g.status <> 'disabled') as ghl_connected
  from crm_workspaces w where w.org_id = $1`;

/** The provider that owns a capability: the workspace mode, or in hybrid mode the explicit owner (native when none is recorded). */
export function resolveCapabilities(mode: CrmMode, rows: Array<{ capability: string; provider: CapabilityProvider }>): Record<CrmCapability, CapabilityProvider> {
  const out = {} as Record<CrmCapability, CapabilityProvider>;
  for (const cap of CRM_CAPABILITIES) {
    if (mode === "hybrid") out[cap] = rows.find((r) => r.capability === cap)?.provider ?? "native";
    else out[cap] = mode;
  }
  return out;
}

/** Loads (and if missing, creates) a client's CRM workspace. New workspaces are native. */
export async function loadWorkspace(db: Queryable, orgId: string): Promise<CrmWorkspace> {
  let { rows } = await db.query<WorkspaceRow>(WORKSPACE_SQL, [orgId]);
  if (!rows[0]) {
    const org = await db.query<{ kind: string }>("select kind from organizations where id = $1", [orgId]);
    if (org.rows[0]?.kind !== "client") throw new AppError("not_found", "This workspace has no CRM.");
    await db.query("insert into crm_workspaces (org_id, mode) values ($1, 'native') on conflict (org_id) do nothing", [orgId]);
    ({ rows } = await db.query<WorkspaceRow>(WORKSPACE_SQL, [orgId]));
  }
  const w = rows[0];
  return {
    orgId,
    mode: w.mode,
    defaultCurrency: w.default_currency,
    defaultCallingCode: w.default_calling_code,
    switching: w.switching,
    blueprintKey: w.blueprint_key,
    initializedAt: w.initialized_at ? new Date(w.initialized_at).toISOString() : null,
    capabilities: resolveCapabilities(w.mode, w.capabilities ?? []),
    ghlConnected: w.ghl_connected === true,
  };
}

/**
 * Request-scoped reuse. The CRM layout and the page's view both need the workspace; without this
 * they each opened a trusted transaction on every customer navigation. React's cache is scoped to
 * the current server render, so a provider change is visible on the next request.
 */
const workspaceForRequest = cache((orgId: string) => withSystem((db) => loadWorkspace(db, orgId)));

export async function getWorkspace(actor: CrmActor): Promise<CrmWorkspace> {
  assertCan(actor, "crm.view");
  // The workspace row is created on demand, so this uses the trusted path; the actor was already authorized for this organization.
  return workspaceForRequest(actor.orgId);
}

/**
 * Refuses a native write to a capability another system owns. This is what makes the provider choice real: the interface hiding a
 * button is not enough, every native write path calls this inside its transaction.
 */
export async function assertNativeOwner(db: Queryable, orgId: string, capability: CrmCapability): Promise<void> {
  const { rows } = await db.query<{ mode: CrmMode; switching: boolean; provider: CapabilityProvider | null }>(
    `select w.mode, w.switching, p.provider from crm_workspaces w
     left join crm_capability_providers p on p.org_id = w.org_id and p.capability = $2
     where w.org_id = $1`,
    [orgId, capability],
  );
  const w = rows[0];
  if (!w) {
    await loadWorkspace(db, orgId);
    return;
  }
  const owner: CapabilityProvider = w.mode === "hybrid" ? (w.provider ?? "native") : w.mode;
  if (owner !== "native") {
    throw new AppError("conflict", `${CAPABILITY_LABELS[capability]} are managed in GoHighLevel for this workspace. Change them there, or move this capability to iAcquire CRM in Settings → CRM provider.`);
  }
}

/** Whether automations that could act twice must wait (a provider switch is cutting over). */
export async function isSwitching(db: Queryable, orgId: string): Promise<boolean> {
  const { rows } = await db.query<{ switching: boolean }>("select switching from crm_workspaces where org_id = $1", [orgId]);
  return rows[0]?.switching === true;
}

export async function updateWorkspaceSettings(actor: CrmActor, input: { defaultCurrency?: string; defaultCallingCode?: string | null }): Promise<void> {
  if (!actor.can("workspace.manage_profile") && !actor.can("crm.provider.manage")) assertCan(actor, "workspace.manage_profile");
  if (input.defaultCurrency !== undefined && !/^[A-Z]{3}$/.test(input.defaultCurrency)) throw new AppError("invalid_input", "Use a three-letter currency code such as USD or PHP.");
  if (input.defaultCallingCode && !/^[0-9]{1,3}$/.test(input.defaultCallingCode)) throw new AppError("invalid_input", "Use the country calling code digits only, for example 63.");
  await crmWrite(actor, async (db) => {
    await loadWorkspace(db, actor.orgId);
    await db.query(
      `update crm_workspaces set default_currency = coalesce($2, default_currency),
         default_calling_code = case when $3::boolean then $4 else default_calling_code end, updated_by = $5 where org_id = $1`,
      [actor.orgId, input.defaultCurrency ?? null, input.defaultCallingCode !== undefined, input.defaultCallingCode || null, actor.userId],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.workspace_settings_updated", targetType: "crm_workspace", targetId: actor.orgId, result: "success", metadata: { defaultCurrency: input.defaultCurrency ?? null, defaultCallingCode: input.defaultCallingCode ?? null } }, db);
  });
}

/** Counts for the CRM overview. Everything is a count of real rows; nothing is estimated. */
export async function workspaceCounts(actor: CrmActor) {
  assertCan(actor, "crm.view");
  return crmRead(actor, async (db) => {
    // Seven former round trips become one; permission-gated counts return NULL, not zero, so the
    // UI still omits a capability the person cannot use.
    const { rows } = await db.query<{
      contacts: number | null;
      new_this_week: number | null;
      unassigned: number | null;
      companies: number | null;
      tags: number;
      smart_lists: number;
      custom_fields: number;
    }>(
      `select
         case when $2::boolean then (select count(*)::int from contacts where org_id = $1 and deleted_at is null and archived_at is null) end as contacts,
         case when $2::boolean then (select count(*)::int from contacts where org_id = $1 and deleted_at is null and created_at > now() - interval '7 days') end as new_this_week,
         case when $2::boolean then (select count(*)::int from contacts where org_id = $1 and deleted_at is null and archived_at is null and assigned_user_id is null) end as unassigned,
         case when $3::boolean then (select count(*)::int from crm_companies where org_id = $1 and deleted_at is null and archived_at is null) end as companies,
         (select count(*)::int from crm_tags where org_id = $1) as tags,
         (select count(*)::int from crm_smart_lists where org_id = $1 and archived_at is null) as smart_lists,
         (select count(*)::int from crm_custom_fields where org_id = $1 and archived_at is null) as custom_fields`,
      [actor.orgId, actor.can("contacts.view"), actor.can("companies.view")],
    );
    const row = rows[0];
    return {
      contacts: row.contacts,
      newThisWeek: row.new_this_week,
      unassigned: row.unassigned,
      companies: row.companies,
      tags: row.tags,
      smartLists: row.smart_lists,
      customFields: row.custom_fields,
    };
  });
}
