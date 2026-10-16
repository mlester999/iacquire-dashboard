import { notFound } from "next/navigation";
import { AppError } from "@/server/errors";
import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import { getCompanyDetail } from "@/server/crm/companies";
import { listAssignableMembers } from "@/server/crm/contacts";
import { getTimeline } from "@/server/crm/timeline";
import { listNotes } from "@/server/crm/notes";
import { listTasks } from "@/server/crm/tasks";
import { listTags } from "@/server/crm/tags";
import { listPipelines } from "@/server/crm/pipelines";
import type { CrmScope } from "@/server/crm/page";
import { CompanyProfile } from "@/components/crm/company-profile";

export async function CompanyView({ actor, scope, id }: { actor: CrmActor; scope: CrmScope; id: string }) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let detail;
  try {
    detail = await getCompanyDetail(actor, id);
  } catch (err) {
    if (err instanceof AppError && err.code === "not_found") notFound();
    throw err;
  }
  const [timeline, notes, tasks, tags, members, pipelines] = await Promise.all([
    getTimeline(actor, { companyId: id }, { limit: 40 }),
    listNotes(actor, "company", id),
    listTasks(actor, { view: "all", companyId: id, limit: 100 }),
    listTags(actor),
    listAssignableMembers(actor),
    actor.can("sales.view") ? listPipelines(actor) : Promise.resolve([]),
  ]);
  await auditSupportView(actor, "company", id);
  const data = JSON.parse(JSON.stringify({ detail, timeline, notes, tasks }));
  return (
    <CompanyProfile
      scope={scope}
      {...data}
      tags={tags.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
      members={members}
      pipelines={pipelines.map((p) => ({ id: p.id, name: p.name, isDefault: p.isDefault, stages: p.stages.filter((s) => s.kind === "open").map((s) => ({ id: s.id, name: s.name })) }))}
    />
  );
}
