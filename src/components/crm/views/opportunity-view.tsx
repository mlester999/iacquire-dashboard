import { notFound } from "next/navigation";
import { AppError } from "@/server/errors";
import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import { getOpportunityDetail } from "@/server/crm/opportunities";
import { listPipelines } from "@/server/crm/pipelines";
import { listAssignableMembers } from "@/server/crm/contacts";
import { getTimeline } from "@/server/crm/timeline";
import { listNotes } from "@/server/crm/notes";
import { listTasks } from "@/server/crm/tasks";
import { listTags } from "@/server/crm/tags";
import type { CrmScope } from "@/server/crm/page";
import { OpportunityProfile } from "@/components/crm/opportunity-profile";
import { listProposals } from "@/server/proposals/proposals";
import { invoicesForActor } from "@/server/invoices/search";

export async function OpportunityView({ actor, scope, id }: { actor: CrmActor; scope: CrmScope; id: string }) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let detail;
  try {
    detail = await getOpportunityDetail(actor, id);
  } catch (err) {
    if (err instanceof AppError && err.code === "not_found") notFound();
    throw err;
  }
  const [pipelines, members, timeline, notes, tasks, tags, proposals, invoices] = await Promise.all([
    listPipelines(actor),
    listAssignableMembers(actor),
    getTimeline(actor, { opportunityId: id }, { limit: 40 }),
    listNotes(actor, "opportunity", id),
    listTasks(actor, { view: "all", opportunityId: id, limit: 100 }),
    listTags(actor),
    // Proposals belong to the client's own team: an agency person looking in a support session is not offered them, and a workspace that does not have the module gets no tab.
    actor.kind === "member" && actor.can("proposals.view") ? listProposals(actor, { opportunityId: id, limit: 50 }).catch(() => null) : Promise.resolve(null),
    invoicesForActor(actor, { opportunityId: id }),
  ]);
  await auditSupportView(actor, "opportunity", id);
  const data = JSON.parse(JSON.stringify({ detail, timeline, notes, tasks, proposals, invoices }));
  return (
    <OpportunityProfile
      scope={scope}
      {...data}
      pipeline={pipelines.find((p) => p.id === detail.pipelineId) ?? null}
      members={members}
      tags={tags.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
    />
  );
}
