import { notFound } from "next/navigation";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { assertCan, auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { campaignBuilderOptions, getCampaign, isRecipientFilter, listCampaignRecipients, previewCampaign, type CampaignDetail } from "@/server/crm/campaigns";
import { loadAudienceList } from "@/server/crm/campaigns/rules";
import { listTestDestinations } from "@/server/crm/message-templates";
import { listTags } from "@/server/crm/tags";
import { listCustomFields } from "@/server/crm/fields";
import { listAssignableMembers } from "@/server/crm/contacts";
import { listPipelines } from "@/server/crm/pipelines";
import { CampaignWorkspace } from "@/components/crm/campaigns/campaign-workspace";
import type { FilterOptions } from "@/components/crm/filter-builder";

type SP = Record<string, string | string[] | undefined>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The names a filter refers to (tags, people, stages, fields), so the audience can be described in words. */
async function filterOptionsFor(actor: CrmActor): Promise<FilterOptions> {
  const [tags, fields, members, pipelines] = await Promise.all([
    listTags(actor),
    listCustomFields(actor, "contact"),
    listAssignableMembers(actor),
    actor.can("sales.view") ? listPipelines(actor) : Promise.resolve([]),
  ]);
  return {
    tags: tags.map((t) => ({ id: t.id, name: t.name, color: t.color })),
    members,
    pipelines: pipelines.map((p) => ({ id: p.id, name: p.name, stages: p.stages.map((s) => ({ id: s.id, name: s.name })) })),
    customFields: fields.map((f) => ({ id: f.id, label: f.label, type: f.type, options: f.options })),
  };
}

/** Growth → Campaigns → one campaign: the builder and its live preview before it starts, its progress and delivery log once it has. */
export async function CampaignView({ actor, scope, id, searchParams = {} }: { actor: CrmActor; scope: CrmScope; id: string; searchParams?: SP }) {
  assertCan(actor, "campaigns.manage", "Campaigns need the “Prepare campaigns” permission, which the owner or a manager can give you.");
  if (!UUID.test(id)) notFound();
  let campaign: CampaignDetail;
  try {
    campaign = await getCampaign(actor, id);
  } catch (err) {
    if (err instanceof AppError && err.code === "not_found") notFound();
    throw err;
  }
  const notStarted = !campaign.startedAt && campaign.status !== "cancelled" && campaign.status !== "completed";
  const logParam = one(searchParams.log);
  const filter = isRecipientFilter(logParam) ? logParam : "all";
  const pageParam = Number(one(searchParams.page) ?? 1);
  const canTest = actor.can("templates.manage") || actor.can("messaging.configure");
  const [options, filterOptions, preview, recipients, destinations, list] = await Promise.all([
    notStarted ? campaignBuilderOptions(actor) : Promise.resolve(null),
    filterOptionsFor(actor),
    notStarted && (campaign.status === "draft" || campaign.status === "awaiting_approval") ? previewCampaign(actor, { campaignId: campaign.id }) : Promise.resolve(null),
    campaign.startedAt ? listCampaignRecipients(actor, campaign.id, { status: filter, page: Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1 }) : Promise.resolve(null),
    canTest ? listTestDestinations(actor, { channel: campaign.channel }) : Promise.resolve([]),
    withSystem((db) => loadAudienceList(db, actor.orgId, campaign.smartListId)),
  ]);
  await auditSupportView(actor, "campaign", campaign.id);
  return (
    <CampaignWorkspace
      scope={scope}
      campaign={JSON.parse(JSON.stringify(campaign))}
      options={options ? JSON.parse(JSON.stringify(options)) : null}
      filterOptions={filterOptions}
      preview={preview ? JSON.parse(JSON.stringify(preview)) : null}
      recipients={recipients ? JSON.parse(JSON.stringify(recipients)) : null}
      recipientFilter={filter}
      testDestinations={destinations.map((d) => ({ channel: d.channel, address: d.address, label: d.label }))}
      listFilter={list?.filter ?? null}
    />
  );
}
