import { listPipelines } from "@/server/crm/pipelines";
import { getBoard, getPipelineMetrics } from "@/server/crm/opportunities";
import { listAssignableMembers } from "@/server/crm/contacts";
import { getWorkspace } from "@/server/crm/workspace";
import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { PipelineBoard } from "@/components/crm/pipeline-board";
import { GhlOwnedNotice } from "@/components/crm/ghl-owned";
import { PageTitle } from "@/components/crm/ui";

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const CLOSED_WINDOWS = [7, 30, 90, 365];

export async function PipelineView({ actor, scope, searchParams }: { actor: CrmActor; scope: CrmScope; searchParams: SP }) {
  const ws = await getWorkspace(actor);
  if (ws.capabilities.opportunities === "ghl") return <GhlOwnedNotice what="Pipelines and deals" agency={scope.agency} />;
  const pipelines = await listPipelines(actor, { ensureDefault: !scope.readOnly && actor.can("opportunities.edit") });
  if (!pipelines.length) {
    return <PageTitle title="Pipelines" description="There's no pipeline yet. Someone who can manage pipelines can create the first one." />;
  }
  const requested = one(searchParams.p);
  const pipeline = pipelines.find((p) => p.id === requested) ?? pipelines.find((p) => p.isDefault) ?? pipelines[0];
  const q = one(searchParams.q)?.slice(0, 80) ?? "";
  const mine = one(searchParams.mine) === "1";
  const closedRaw = Number(one(searchParams.closed));
  const closed = CLOSED_WINDOWS.includes(closedRaw) ? closedRaw : 30;
  const [columns, metrics, members] = await Promise.all([
    getBoard(actor, pipeline.id, { search: q, mine, closedDays: closed }),
    getPipelineMetrics(actor, pipeline.id),
    listAssignableMembers(actor),
  ]);
  await auditSupportView(actor, "pipeline", pipeline.id);
  return (
    <PipelineBoard
      scope={scope}
      pipelines={pipelines}
      pipelineId={pipeline.id}
      columns={JSON.parse(JSON.stringify(columns))}
      metrics={metrics}
      members={members}
      state={{ q, mine, closed }}
    />
  );
}
