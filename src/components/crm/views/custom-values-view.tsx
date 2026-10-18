import { withSystem } from "@/server/db";
import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { listCustomValues } from "@/server/crm/custom-values";
import { CustomValuesManager } from "@/components/crm/custom-values/custom-values-manager";

/**
 * CRM Settings → Configuration Values (/crm/settings/values, and the agency's view of a client). Everyone who can open the CRM sees the
 * values and where they are used; owners and managers (fields.manage) change them. Values never hold credentials, so nothing secret is
 * loaded here.
 */
export async function CustomValuesView({ actor, scope }: { actor: CrmActor; scope: CrmScope }) {
  const [list, ws] = await Promise.all([
    listCustomValues(actor),
    // The calling code is a workspace setting, read after the actor was authorized for this organization.
    withSystem((db) => db.query<{ default_calling_code: string | null }>("select default_calling_code from crm_workspaces where org_id = $1", [actor.orgId])),
  ]);
  await auditSupportView(actor, "custom_values");
  return <CustomValuesManager scope={scope} values={JSON.parse(JSON.stringify(list.values))} limit={list.limit} defaultCallingCode={ws.rows[0]?.default_calling_code ?? null} />;
}
