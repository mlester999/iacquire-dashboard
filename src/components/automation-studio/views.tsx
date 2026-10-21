import { notFound, redirect } from "next/navigation";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import type { OrgContext } from "@/server/tenancy/context";
import { memberActor } from "@/server/crm/actor";
import { scopeFor } from "@/server/crm/page";
import { assertNativeOwner } from "@/server/crm/workspace";
import { maintenanceEligibility } from "@/server/maintenance/service";
import { getMaintenancePlan } from "@/server/catalog/service";
import { studioEntitlement } from "@/server/automation-studio/entitlement";
import { getStudioState, listStudioWorkflows } from "@/server/automation-studio/studio";
import { builderAvailability } from "@/server/automation-studio/builder/service";
import { loadEditorOptions } from "@/components/crm/views/workflow-view";
import { StudioHome, type HomeWorkflow } from "@/components/automation-studio/studio-home";
import { StudioWorkspace } from "@/components/automation-studio/studio-workspace";
import { UpgradePage } from "@/components/automation-studio/upgrade-page";
import { ConnectionsPanel } from "@/components/automation-studio/connections-panel";
import { UsagePanel, type PlanSummary } from "@/components/automation-studio/usage-panel";
import { studioUsageSnapshot } from "@/server/automation-studio/usage";
import { listConnections } from "@/server/automation-studio/connections";
import { STUDIO_METRIC_LABELS, STUDIO_PLAN_MONTHLY_USD, STUDIO_SETUP_FEE_USD, type StudioEntitlement, type StudioMetric } from "@/lib/automation-studio/plan";
import { TRIGGERS } from "@/lib/crm/workflow/spec";
import { formatDate } from "@/lib/utils";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** A sentence about the plan to show on the home screen, or null when there is nothing to say. */
function planNotice(ent: StudioEntitlement, timezone: string): string | null {
  if (ent.state === "past_due" && ent.entitled) {
    return `A payment for your plan didn’t go through. Automation Studio keeps working until ${formatDate(ent.graceEndsAt, timezone)}. After that your automations are paused, not deleted, until the plan is paid again.`;
  }
  if (ent.state === "cancelling") return "Your plan is set to end once iAcquire confirms the cancellation. Your automations are paused, not deleted, when it does.";
  return null;
}

/**
 * The Automation Studio home. A workspace without the plan sees the upgrade page (and the automations it built while it had the plan, which
 * stay readable); a workspace with it sees the prompt box, its automations and the ideas to start from. Which one is decided on the server
 * from the plan, never from anything the browser sends.
 */
export async function StudioHomeView({ ctx }: { ctx: OrgContext }) {
  if (ctx.org.kind !== "client") redirect("/admin/crm");
  const actor = memberActor(ctx);
  const ent = await withSystem((db) => studioEntitlement(db, ctx.org.orgId));
  const [problem, workflows] = await Promise.all([ownerProblem(ctx.org.orgId), listStudioWorkflows(actor)]);

  if (!ent.entitled) {
    const [elig, catalog] = await Promise.all([maintenanceEligibility(ctx.org.orgId), getMaintenancePlan(ctx.user.id)]);
    const owner = ctx.can("maintenance.manage_plan");
    // The price a request records is the published plan's (requestMaintenanceEnrollment); show that one, and the approved default only when
    // the catalog has no USD price to give.
    const price = catalog?.price;
    return (
      <UpgradePage
        state={ent.state}
        reason={ent.reason}
        monthlyUsd={price?.minCents != null && price.currency === "USD" ? price.minCents / 100 : STUDIO_PLAN_MONTHLY_USD}
        setupFeeUsd={STUDIO_SETUP_FEE_USD}
        requestAllowance={catalog ? catalog.monthlyRequestAllowance : null}
        canRequest={owner && elig.eligible}
        requestNote={!elig.eligible ? elig.note : !owner ? "Only the owner of your workspace can request the plan. Ask them to open the Maintenance page." : null}
        saved={workflows.map((w) => ({ id: w.id, name: w.name }))}
      />
    );
  }

  if (problem) {
    return (
      <div className="mx-auto max-w-2xl rounded-3xl border border-line bg-surface p-8 text-center shadow-md">
        <h1 className="text-[22px] font-semibold text-ink">Automation Studio isn’t available for this workspace yet</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-muted">{problem}</p>
      </div>
    );
  }

  const [options, builder] = await Promise.all([loadEditorOptions(actor), builderAvailability()]);
  const items: HomeWorkflow[] = workflows.filter((w) => w.status !== "archived").map((w) => ({
    id: w.id,
    name: w.name,
    status: w.status,
    stepCount: w.stepCount,
    triggerLabel: w.triggerType ? TRIGGERS[w.triggerType]?.label ?? "Starts when something happens" : "No trigger yet",
    updatedAt: w.updatedAt,
    unpublishedChanges: w.unpublishedChanges,
    pausedForPlan: w.pausedForPlan,
    publishedVersion: w.publishedVersion,
  }));
  return <StudioHome workflows={items} options={JSON.parse(JSON.stringify(options))} builderReady={builder.available} builderReason={builder.reason} canBuild={actor.can("workflows.manage")} planNotice={planNotice(ent, ctx.org.timezone)} timezone={ctx.org.timezone} />;
}

/**
 * One automation in the workspace: the chat and the canvas. Reading never needs the plan, so a lapsed workspace can still open what it built
 * (read-only, with the reason); changing, testing and switching on do, and the server refuses them again whatever this page shows.
 */
export async function StudioWorkflowView({ ctx, id }: { ctx: OrgContext; id: string }) {
  if (ctx.org.kind !== "client") redirect("/admin/crm");
  if (!UUID.test(id)) notFound();
  const actor = memberActor(ctx);
  const ent = await withSystem((db) => studioEntitlement(db, ctx.org.orgId));

  let state;
  try {
    state = await getStudioState(actor, id);
  } catch (err) {
    if (err instanceof AppError && err.code === "not_found") {
      // Without the plan nothing was ever built here: send the person to the page that explains it instead of a dead end.
      if (!ent.entitled) redirect("/automation-studio");
      notFound();
    }
    throw err;
  }
  const w = state.workflow;
  // An automation built on the CRM screens stays there: it is Core and never needs the plan.
  if (w.origin !== "studio") redirect(`/crm/workflows/${w.id}`);

  const [options, builder, problem, scope] = await Promise.all([loadEditorOptions(actor), builderAvailability(), ownerProblem(ctx.org.orgId), scopeFor(actor, "/crm")]);
  const readOnlyReason = !actor.can("workflows.manage")
    ? "You can look at this automation. Changing it needs the “Build and change automations” permission."
    : !ent.entitled
      ? `${ent.reason} You can look at this automation, but changing, testing or switching it on needs the plan.`
      : problem;

  return (
    <StudioWorkspace
      key={w.id}
      scope={JSON.parse(JSON.stringify(scope))}
      workflow={{
        id: w.id,
        name: w.name,
        status: w.status,
        origin: w.origin,
        publishedVersion: w.publishedVersion,
        approval: w.approval,
        pausedForPlan: w.pausedForPlan,
        pausedReason: w.pausedReason,
        draftRevision: w.draftRevision,
        versions: w.versions.map((v) => ({ id: v.id, version: v.version, publishedAt: v.publishedAt, publishedByName: v.publishedByName, current: v.current, contentHash: v.contentHash, approval: v.approval })),
      }}
      definition={JSON.parse(JSON.stringify(w.draft))}
      messages={state.messages}
      history={state.history}
      options={JSON.parse(JSON.stringify(options))}
      builder={ent.entitled ? builder : { available: false, reason: ent.reason }}
      readOnlyReason={readOnlyReason}
    />
  );
}

/**
 * The workspace's connections to outside systems. Anyone who can see automations can see the list (never a secret); setting up, testing and
 * replacing need the permission and the plan, and revoking needs only the permission, so a workspace whose plan lapsed can still cut a credential off.
 */
export async function ConnectionsView({ ctx }: { ctx: OrgContext }) {
  if (ctx.org.kind !== "client") redirect("/admin/crm");
  const actor = memberActor(ctx);
  const ent = await withSystem((db) => studioEntitlement(db, ctx.org.orgId));
  const connections = await listConnections(actor, { includeRevoked: true });
  if (!ent.entitled && connections.length === 0) redirect("/automation-studio");
  return (
    <ConnectionsPanel
      connections={JSON.parse(JSON.stringify(connections))}
      timezone={ctx.org.timezone}
      canManage={actor.can("workflows.manage")}
      planReason={ent.entitled ? null : `${ent.reason} Setting up, verifying and replacing connections needs the plan.`}
    />
  );
}

const PLAN_TITLES: Record<StudioEntitlement["state"], string> = {
  active: "Managed Maintenance + Automation Studio", cancelling: "Managed Maintenance + Automation Studio (ending)", past_due: "A payment needs attention", pending: "Waiting for activation",
  expired: "The plan has expired", cancelled: "The plan was cancelled", declined: "The plan request wasn’t activated", none: "You’re not on the plan",
};
const COUNTERS: StudioMetric[] = ["runs_started", "steps_executed", "step_failures", "step_retries", "test_runs", "builder_messages", "employee_invocations", "integration_calls"];

/**
 * What the workspace used this month against its limits, the plan's state as iAcquire has it on record, and every automation's pause and turn-on control.
 * Anyone who can see automations can read it; the controls need the permission, and the server checks the plan again whatever this page shows.
 */
export async function UsageView({ ctx }: { ctx: OrgContext }) {
  if (ctx.org.kind !== "client") redirect("/admin/crm");
  const actor = memberActor(ctx);
  const now = new Date();
  const [ent, usage, workflows, connections] = await Promise.all([
    withSystem((db) => studioEntitlement(db, ctx.org.orgId, now)),
    withSystem((db) => studioUsageSnapshot(db, ctx.org.orgId, now)),
    listStudioWorkflows(actor),
    listConnections(actor),
  ]);
  const plan: PlanSummary = {
    state: ent.state,
    title: PLAN_TITLES[ent.state],
    detail: ent.reason,
    paidThrough: ent.paidThroughOn ? formatDate(ent.paidThroughOn, ctx.org.timezone) : null,
    graceEnds: ent.graceEndsAt ? formatDate(ent.graceEndsAt, ctx.org.timezone) : null,
    entitled: ent.entitled,
  };
  return (
    <UsagePanel
      plan={plan}
      usage={{
        period: usage.period,
        periodLabel: new Date(`${usage.period}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
        lines: usage.lines.map((l) => ({ key: l.key, label: l.label, used: l.used, limit: l.limit, state: l.state, percent: l.percent, remaining: l.remaining, custom: l.custom })),
        counters: COUNTERS.map((m) => ({ label: STUDIO_METRIC_LABELS[m], quantity: usage.counters[m].quantity })),
        hardStop: usage.hardStop,
        warnAtPercent: usage.warnAtPercent,
        note: usage.note,
      }}
      workflows={workflows.filter((w) => w.status !== "archived").map((w) => ({ id: w.id, name: w.name, status: w.status, pausedForPlan: w.pausedForPlan, stepCount: w.stepCount }))}
      canManage={actor.can("workflows.manage")}
      connectionsNeedingAttention={connections.filter((c) => c.status === "needs_attention").length}
    />
  );
}
