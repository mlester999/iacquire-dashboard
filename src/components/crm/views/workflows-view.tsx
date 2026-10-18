import { notFound, redirect } from "next/navigation";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { assertCan, auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { listWorkflows, listWorkflowTemplates } from "@/server/crm/workflows/definitions";
import { getRun, listRuns } from "@/server/crm/workflows/runs";
import { PageTitle } from "@/components/crm/ui";
import { WorkflowsList } from "@/components/crm/workflows/workflows-list";
import { RunsList } from "@/components/crm/workflows/runs-list";
import { loadEditorOptions } from "@/components/crm/views/workflow-view";
import { namesFrom, parseRunFilter, triggerLine } from "@/components/crm/workflows/summaries";
import { runQueryFor, toRunListItem } from "@/components/crm/workflows/run-format";
import type { WorkflowListItem, WorkflowTemplateItem } from "@/components/crm/workflows/types";
import type { WorkflowStatus } from "@/components/crm/workflows/parts";
import type { TriggerConfig } from "@/lib/crm/workflow/spec";

type SP = Record<string, string | string[] | undefined>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const STATUSES: readonly WorkflowStatus[] = ["draft", "active", "paused", "archived"];

/**
 * Automation → Workflows: every workflow with what starts it, whether it runs, whether it needs the owner's approval, and how the last day
 * went; folders; and creating one blank, from a built-in template, or as a copy. Anyone who can see automations sees the list; building
 * and changing them needs "Build and change automations".
 */
export async function WorkflowsView({ actor, scope, searchParams = {} }: { actor: CrmActor; scope: CrmScope; searchParams?: SP }) {
  assertCan(actor, "workflows.view");
  const statusParam = one(searchParams.status) as WorkflowStatus | undefined;
  const [items, options, triggers] = await Promise.all([
    listWorkflows(actor, { status: "all" }),
    loadEditorOptions(actor),
    // Each draft's trigger with its filters, so the list can say "Tag added · VIP" rather than just "Tag added".
    withSystem((db) => db.query<{ id: string; trigger: TriggerConfig | null }>("select id, draft->'trigger' as trigger from crm_workflows where org_id = $1", [actor.orgId])).then((r) => new Map(r.rows.map((x) => [x.id, x.trigger]))),
  ]);
  const names = namesFrom(options);
  const workflows: WorkflowListItem[] = items.map((w) => ({
    id: w.id, name: w.name, description: w.description, status: w.status, folderId: w.folderId, folderName: w.folderName, triggerType: w.triggerType,
    triggerSummary: triggerLine(w.triggerType ? { ...(triggers.get(w.id) ?? {}), type: w.triggerType } : null, names), stepCount: w.stepCount, publishedVersion: w.publishedVersion,
    unpublishedChanges: w.unpublishedChanges, approval: w.approval, effects: w.effects, lastRunAt: w.lastRunAt, runsToday: w.runsToday, failuresToday: w.failuresToday,
    updatedAt: w.updatedAt,
  }));
  const templates: WorkflowTemplateItem[] = listWorkflowTemplates().map((t) => ({
    key: t.key, name: t.name, description: t.description, category: t.category, triggerSummary: `Starts when: ${t.triggerLabel}`, stepKinds: t.stepKinds, sendsMessages: t.sendsMessages,
    inputs: t.inputs,
  }));
  await auditSupportView(actor, "workflows");
  return (
    <WorkflowsList
      scope={scope}
      workflows={workflows}
      templates={templates}
      templateOptions={{
        tags: options.tags.map((t) => ({ id: t.id, name: t.name })),
        members: options.members.map((m) => ({ id: m.id, name: m.name })),
        pipelines: options.pipelines,
        templates: options.templates.map((t) => ({ id: t.id, name: t.name, channel: t.channel, contentHash: t.contentHash })),
      }}
      folders={options.folders}
      canManage={actor.can("workflows.manage") && !scope.readOnly}
      initialStatus={statusParam && STATUSES.includes(statusParam) ? statusParam : ""}
    />
  );
}

/**
 * Automation → Workflow Activity: runs across every workflow, newest first, filtered by outcome and workflow. A notification about a failed
 * run links here with ?run=<id>, which opens that run.
 */
export async function WorkflowActivityView({ actor, scope, searchParams = {} }: { actor: CrmActor; scope: CrmScope; searchParams?: SP }) {
  assertCan(actor, "workflows.view");
  const runParam = one(searchParams.run);
  if (runParam) {
    if (!UUID.test(runParam)) notFound();
    let workflowId: string;
    try {
      workflowId = (await getRun(actor, runParam)).workflowId;
    } catch (err) {
      if (err instanceof AppError && err.code === "not_found") notFound();
      throw err;
    }
    redirect(`${scope.base}/workflows/${workflowId}/runs/${runParam}`);
  }
  const filter = parseRunFilter(one(searchParams.status));
  const workflowParam = one(searchParams.workflow);
  const workflowId = workflowParam && UUID.test(workflowParam) ? workflowParam : null;
  const beforeRaw = one(searchParams.before);
  const before = beforeRaw && !Number.isNaN(Date.parse(beforeRaw)) ? beforeRaw : null;
  const [runs, workflows] = await Promise.all([
    listRuns(actor, { ...(workflowId ? { workflowId } : {}), ...runQueryFor(filter), before, limit: 50 }),
    listWorkflows(actor, { status: "all" }),
  ]);
  await auditSupportView(actor, "workflow-activity");
  return (
    <div>
      <PageTitle
        title="Workflow activity"
        description="Every run of every workflow, newest first: what started it, the step it's on or stopped at, and why. Open a run to see each step, cancel it, or retry a failed step."
      />
      <RunsList
        base={scope.base}
        runs={runs.items.map(toRunListItem)}
        filter={filter}
        timezone={scope.timezone}
        nextBefore={runs.nextBefore}
        paged={!!before}
        workflows={workflows.map((w) => ({ id: w.id, name: w.status === "archived" ? `${w.name} (archived)` : w.name }))}
        workflowId={workflowId}
        showWorkflow
      />
    </div>
  );
}
