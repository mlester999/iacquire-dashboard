import { listPipelines } from "@/server/crm/pipelines";
import { listOpportunities } from "@/server/crm/opportunities";
import { listAssignableMembers } from "@/server/crm/contacts";
import { getWorkspace } from "@/server/crm/workspace";
import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { OpportunitiesTable } from "@/components/crm/opportunities-table";
import { GhlOwnedNotice } from "@/components/crm/ghl-owned";

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const UUID = /^[0-9a-f-]{36}$/i;
const SORTS = ["name", "value", "created_at", "updated_at", "expected_close_date", "stage_entered_at"] as const;
type Sort = (typeof SORTS)[number];

export async function OpportunitiesView({ actor, scope, searchParams }: { actor: CrmActor; scope: CrmScope; searchParams: SP }) {
  const ws = await getWorkspace(actor);
  if (ws.capabilities.opportunities === "ghl") return <GhlOwnedNotice what="Pipelines and deals" agency={scope.agency} />;
  const id = (k: string) => { const v = one(searchParams[k]); return v && UUID.test(v) ? v : null; };
  const statusRaw = one(searchParams.status);
  const status = statusRaw === "won" || statusRaw === "lost" || statusRaw === "all" ? statusRaw : "open";
  const sortRaw = one(searchParams.sort);
  const sort = SORTS.includes(sortRaw as Sort) ? (sortRaw as Sort) : null;
  const dir = one(searchParams.dir) === "asc" ? "asc" : "desc";
  const page = Math.max(1, Number(one(searchParams.page)) || 1);
  const q = one(searchParams.q)?.slice(0, 80) ?? "";
  const pipeline = id("pipeline");
  const [pipelines, members, data] = await Promise.all([
    listPipelines(actor),
    listAssignableMembers(actor),
    listOpportunities(actor, { pipelineId: pipeline, stageId: pipeline ? id("stage") : null, status, ownerId: id("owner"), search: q, sort: sort ? { by: sort, dir } : undefined, page, pageSize: 25 }),
  ]);
  await auditSupportView(actor, "opportunities");
  return (
    <OpportunitiesTable
      scope={scope}
      rows={data.rows}
      total={data.total}
      page={data.page}
      pageSize={data.pageSize}
      pipelines={pipelines}
      members={members}
      state={{ pipeline, stage: pipeline ? id("stage") : null, status, owner: id("owner"), q, sort, dir }}
    />
  );
}
