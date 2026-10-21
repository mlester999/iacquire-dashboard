import { notFound } from "next/navigation";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { assertCan, auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { assertNativeOwner } from "@/server/crm/workspace";
import { getWorkflow, getWorkflowBuilderOptions } from "@/server/crm/workflows/definitions";
import { getRun, listRuns } from "@/server/crm/workflows/runs";
import type { WorkflowStep } from "@/lib/crm/workflow/spec";
import { formatDateTime } from "@/lib/utils";
import { WorkflowEditor, type EditorTab } from "@/components/crm/workflows/workflow-editor";
import { RunDetail } from "@/components/crm/workflows/run-detail";
import { parseRunFilter, namesFrom } from "@/components/crm/workflows/summaries";
import { runQueryFor, toRunDetailView, toRunListItem } from "@/components/crm/workflows/run-format";
import type { EditorOptions, EditorWorkflow, RunGate, VersionItem } from "@/components/crm/workflows/types";

type SP = Record<string, string | string[] | undefined>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const TABS: readonly EditorTab[] = ["builder", "runs", "versions", "settings"];
const RUNS_PAGE = 25;

/**
 * Everything the editor's pickers offer, with the names the screens show. Built on the engine's builder options (the same lists the
 * validator checks), plus what only the editor needs: each approved template's exact approved wording (shown in the approval preview and
 * the step panel), the templates that aren't approved yet (so the picker can say why), and assignment rules by name only for people who may
 * see them. Whether each AI employee and n8n automation can act right now comes from the same checks the engine makes when a step runs.
 */
export async function loadEditorOptions(actor: CrmActor): Promise<EditorOptions> {
  const o = await getWorkflowBuilderOptions(actor);
  const extra = await withSystem(async (db) => {
    const approved = await db.query<{ id: string; key: string; subject: string | null; body: string }>(
      `select t.id, t.key, v.subject, v.body from crm_message_templates t
       join crm_message_template_versions v on v.template_id = t.id and v.org_id = t.org_id and v.version = t.approved_version
       where t.org_id = $1 and t.kind = 'template' and t.status = 'approved' and t.archived_at is null`,
      [actor.orgId],
    );
    const drafts = await db.query<{ id: string; name: string; channel: "email" | "sms" | "whatsapp" | null }>(
      "select id, name, channel from crm_message_templates where org_id = $1 and kind = 'template' and status = 'draft' and archived_at is null order by lower(name) limit 200",
      [actor.orgId],
    );
    return { approved: new Map(approved.rows.map((r) => [r.id, r])), drafts: drafts.rows };
  });
  return {
    tags: o.tags,
    members: o.users,
    pipelines: o.pipelines,
    contactFields: o.fields.filter((f) => f.entity === "contact").map(({ id, key, label, type, options }) => ({ id, key, label, type, options })),
    opportunityFields: o.fields.filter((f) => f.entity === "opportunity").map(({ id, key, label, type, options }) => ({ id, key, label, type, options })),
    assignmentRules: actor.can("contacts.assign") ? o.assignmentRules.map((r) => ({ ...r, active: true })) : null,
    // Names stay with the assign permission; bare references let everyone's editor check a step's rule the way publishing does.
    assignmentRuleRefs: o.assignmentRules.map((r) => ({ id: r.id, entity: r.entity })),
    templates: o.templates.flatMap((t) => {
      const x = extra.approved.get(t.id);
      return x ? [{ id: t.id, key: x.key, name: t.name, channel: t.channel, purpose: t.purpose, version: t.version, subject: x.subject, body: x.body, contentHash: t.contentHash }] : [];
    }),
    unapprovedTemplates: extra.drafts,
    n8nMappings: o.n8nMappings,
    webhooks: o.webhookSubscriptions.map((w) => ({ ...w, active: true })),
    employees: o.agents.map((a) => ({ roleKey: a.roleKey, name: a.name, mode: a.mode, enabled: true, ready: a.ready, connected: a.connected, liveRuns: a.liveRuns })),
    calendars: o.calendars,
    appointmentTypes: o.appointmentTypes,
    forms: o.forms ?? [],
    customValues: o.customValues ?? [],
    folders: o.folders,
    connections: o.connections ?? [],
  };
}

/** Whether this workspace's workflows run in iAcquire at all (the CRM provider setting), in words when they don't. */
async function ownerProblem(orgId: string): Promise<string | null> {
  return withSystem(async (db) => {
    try {
      await assertNativeOwner(db, orgId, "workflows");
      return null;
    } catch (err) {
      if (err instanceof AppError) return err.message;
      throw err;
    }
  });
}

async function loadWorkflowOr404(actor: CrmActor, id: string) {
  if (!UUID.test(id)) notFound();
  try {
    return await getWorkflow(actor, id);
  } catch (err) {
    if (err instanceof AppError && err.code === "not_found") notFound();
    throw err;
  }
}

/** The workflow editor: the canvas and step settings, its runs, its published versions and its settings. */
export async function WorkflowView({ actor, scope, id, searchParams = {} }: { actor: CrmActor; scope: CrmScope; id: string; searchParams?: SP }) {
  assertCan(actor, "workflows.view");
  const w = await loadWorkflowOr404(actor, id);
  const tabParam = one(searchParams.tab) as EditorTab | undefined;
  const initialTab: EditorTab = tabParam && TABS.includes(tabParam) ? tabParam : "builder";
  const filter = parseRunFilter(one(searchParams.status));
  const beforeRaw = one(searchParams.before);
  const before = beforeRaw && !Number.isNaN(Date.parse(beforeRaw)) ? beforeRaw : null;
  const canManage = actor.can("workflows.manage") && !scope.readOnly;
  const [options, runs, totalRuns, problem] = await Promise.all([
    loadEditorOptions(actor),
    listRuns(actor, { workflowId: w.id, ...runQueryFor(filter), before, limit: RUNS_PAGE }),
    withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from crm_workflow_runs where workflow_id = $1 and org_id = $2", [w.id, actor.orgId])).then((r) => r.rows[0]?.n ?? 0),
    ownerProblem(actor.orgId),
  ]);
  await auditSupportView(actor, "workflow", w.id);

  const workflow: EditorWorkflow = {
    id: w.id, name: w.name, description: w.description, status: w.status, folderId: w.folderId, hourlyRunLimit: w.hourlyRunLimit,
    draft: w.draft, draftRevision: w.draftRevision, publishedVersion: w.publishedVersion, publishedVersionId: w.publishedVersionId,
    unpublishedChanges: w.unpublishedChanges, updatedAt: w.updatedAt, updatedByName: w.updatedByName,
    // The URL starts runs, so only people who can change the workflow see it.
    inboundUrl: canManage ? w.inboundUrl : null,
    inboundHidden: !canManage && !!w.inboundUrl,
  };
  const versions: VersionItem[] = w.versions.map((v) => ({ ...v, definition: v.definition }));
  const gate: RunGate = { pausedReason: problem ? null : w.pausedReason, ownerProblem: problem };
  return (
    <WorkflowEditor
      key={w.id}
      scope={scope}
      workflow={JSON.parse(JSON.stringify(workflow))}
      versions={JSON.parse(JSON.stringify(versions))}
      options={options}
      runs={{ items: runs.items.map(toRunListItem), total: totalRuns, filter, nextBefore: runs.nextBefore, paged: !!before }}
      gate={gate}
      canManage={canManage}
      initialTab={initialTab}
    />
  );
}

/** One run: every step attempt in words with links to what it touched, the steps it hasn't reached, and cancel / retry / skip. */
export async function WorkflowRunView({ actor, scope, workflowId, runId }: { actor: CrmActor; scope: CrmScope; workflowId: string; runId: string }) {
  assertCan(actor, "workflows.view");
  if (!UUID.test(workflowId) || !UUID.test(runId)) notFound();
  let run;
  try {
    run = await getRun(actor, runId);
  } catch (err) {
    if (err instanceof AppError && err.code === "not_found") notFound();
    throw err;
  }
  if (run.workflowId !== workflowId) notFound();
  const messageIds = run.steps.map((s) => s.messageId ?? (typeof s.result?.messageId === "string" ? s.result.messageId : null)).filter((x): x is string => !!x && UUID.test(x));
  const [steps, conversations, options] = await Promise.all([
    withSystem((db) => db.query<{ steps: WorkflowStep[] }>("select steps from crm_workflow_versions where id = $1 and org_id = $2", [run.versionId, actor.orgId])).then((r) => r.rows[0]?.steps ?? []),
    messageIds.length
      ? withSystem((db) => db.query<{ id: string; conversation_id: string }>("select id, conversation_id from conversation_messages where org_id = $1 and id = any($2::uuid[])", [actor.orgId, messageIds])).then((r) => Object.fromEntries(r.rows.map((x) => [x.id, x.conversation_id])))
      : Promise.resolve({} as Record<string, string>),
    loadEditorOptions(actor),
  ]);
  await auditSupportView(actor, "workflow-run", run.id);
  const view = toRunDetailView(run, steps, {
    names: namesFrom(options),
    base: scope.base,
    formatTime: (iso) => formatDateTime(iso, scope.timezone),
    conversations,
    inboxLinks: !scope.agency && actor.can("inbox.view"),
  });
  return <RunDetail scope={scope} run={JSON.parse(JSON.stringify(view))} canManage={actor.can("workflows.manage") && !scope.readOnly} />;
}
