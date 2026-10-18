import { assertCan, auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { listCampaigns } from "@/server/crm/campaigns";
import { CampaignsList } from "@/components/crm/campaigns/campaigns-list";

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Growth → Campaigns: every campaign with its status, audience, message and progress. Campaigns are seen and prepared by people with
 * "Prepare campaigns"; only the workspace owner approves sending one.
 */
export async function CampaignsView({ actor, scope, searchParams = {} }: { actor: CrmActor; scope: CrmScope; searchParams?: SP }) {
  assertCan(actor, "campaigns.manage", "Campaigns need the “Prepare campaigns” permission, which the owner or a manager can give you.");
  const campaigns = await listCampaigns(actor);
  await auditSupportView(actor, "campaigns");
  return (
    <CampaignsList
      scope={scope}
      campaigns={JSON.parse(JSON.stringify(campaigns))}
      canManage={actor.can("campaigns.manage") && actor.kind === "member" && !scope.readOnly}
      initialFilter={one(searchParams.status) ?? ""}
    />
  );
}
