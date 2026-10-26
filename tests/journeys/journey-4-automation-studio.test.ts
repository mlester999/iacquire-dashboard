// Journey 4: Automation Studio from the plan gate to a finished run, and what a lapsed plan does (and does not) stop.
//
// The workspace asks for Studio without the plan and is refused on the server; with the plan it verifies a connection to an outside system, builds a workflow
// through Studio's own records, publishes it, has the owner approve the version (an outside call needs that), runs it once, and reads the run back from history.
// Then the plan lapses: the sweeper pauses the Studio workflow, the run history and the definition stay readable, and a core CRM workflow keeps running.
//
// External boundaries, simulated here and only here:
//   * the outside system a connection talks to: tests/support/studio-workspace.ts sets the connections up with the DNS lookup and the pinned socket replaced,
//     and this file replaces the same two seams again for the run. The requests are answered by the test, recorded, and never leave the machine. The Slack
//     webhook address is a made-up one in the fixture.
//   * the language model: not used here. The workflow is started from a definition, not from the AI builder, so no model is asked anything.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { createContact } from "@/server/crm/contacts";
import { crmEventDispatch } from "@/server/crm/dispatch";
import { decideApproval } from "@/server/approvals/service";
import { createWorkflow, getWorkflow, listWorkflows, publishWorkflow, requestWorkflowApproval, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import { getRun, listRuns, startManualRun } from "@/server/crm/workflows/runs";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import { getStudioState, startStudioWorkflow } from "@/server/automation-studio/studio";
import { listConnectionCalls, listConnections } from "@/server/automation-studio/connections";
import { sweepStudioEntitlements } from "@/server/automation-studio/lifecycle";
import { studioUsageSnapshot } from "@/server/automation-studio/usage";
import { pinnedHttps, type PinnedResponse } from "@/server/security/pinned-https";
import type { WorkflowDefinition, WorkflowStep } from "@/lib/crm/workflow/spec";
import { ctxFor, uid } from "../support/fixtures";
import { studioWorkspace } from "../support/studio-workspace";

const answer = (status: number, body = "{}", over: Partial<PinnedResponse> = {}): PinnedResponse => ({
  status, contentType: "application/json", retryAfterSeconds: null, bytes: Buffer.byteLength(body), truncated: false, body, ...over,
});

const step = (key: string, kind: WorkflowStep["kind"], config: Record<string, unknown>, next: string | null = null): WorkflowStep => ({ key, kind, config, next }) as WorkflowStep;

/** A Studio automation a person would build by hand: announce a new lead to the team's channel, then give someone a task. */
const announceDefinition = (slackConnectionId: string): WorkflowDefinition => ({
  trigger: { type: "manual" },
  steps: [
    step("announce", "slack_message", { connectionId: slackConnectionId, text: "New lead: {{contact.first_name}} {{contact.last_name}}" }, "task"),
    step("task", "create_task", { title: "Follow up with the new lead", priority: "normal", assignee: "none" }),
  ],
});

/** A workflow built in the CRM screens: one task, no premium step, so no plan is needed for it. */
const coreDefinition = (title: string): WorkflowDefinition => ({
  trigger: { type: "contact.created" },
  steps: [step("task", "create_task", { title, priority: "normal", assignee: "none" })],
});

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const usage = (orgId: string, at = new Date()) => withSystem((db) => studioUsageSnapshot(db, orgId, at));
const taskCount = async (orgId: string) => Number((await rows<{ n: string }>("select count(*)::text as n from tasks where org_id = $1", [orgId]))[0].n);

/** Dispatches events and advances runs until nothing is left to do. */
async function settle(now: Date) {
  for (let i = 0; i < 25; i += 1) {
    const d = await crmEventDispatch({ now });
    const r = await processWorkflowRuns({ now });
    if (!d.claimed && !r.claimed && !r.scheduled) return;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Automation Studio from entitlement to run history, and the lapse rule", () => {
  it("refuses Studio without the plan, then builds, publishes, runs and records one workflow; a lapse pauses Studio only", async () => {
    // 1. The gate is the server's, not the menu's. A workspace without the plan cannot start a Studio workflow, and nothing is created by the attempt.
    const gated = await studioWorkspace({ plan: false });
    await expect(startStudioWorkflow(gated.o.actor("owner"), { prompt: "Announce every new lead in Slack" })).rejects.toMatchObject({ code: "plan_required" });
    await expect(createWorkflow(gated.o.actor("owner"), { name: "Studio draft", origin: "studio" })).rejects.toMatchObject({ code: "plan_required" });
    expect(await listWorkflows(gated.o.actor("owner"))).toHaveLength(0);

    // 2. The workspace the journey continues in has the active plan and two verified connections. Verifying them was done with the outside world replaced
    // by the fixture; the connection log still records the test call honestly.
    const ws = await studioWorkspace({ connections: true });
    const owner = ws.o.actor("owner");
    const manager = ws.o.actor("manager");
    const connections = ws.ids.connections;
    expect(connections).toBeTruthy();
    const { slack: slackConnectionId, http: httpConnectionId } = connections!;
    const listed = await listConnections(owner);
    expect(listed.map((c) => `${c.kind}:${c.status}`).sort()).toEqual(["http:active", "slack_webhook:active"]);
    expect(listed.map((c) => c.id)).toEqual(expect.arrayContaining([httpConnectionId, slackConnectionId]));
    const tests = await listConnectionCalls(owner, slackConnectionId);
    expect(tests.filter((c) => c.origin === "test")).toMatchObject([{ outcome: "sent" }]);
    expect(JSON.stringify(listed)).not.toContain("sk_live_Zr7Qw1XyAbCdEf90");

    // 3. The person starts the automation in Studio from a definition. Studio keeps its own records around the workflow: the working copy is the CRM
    // workflow's draft, and the change is in its trail. Nothing was asked of a model.
    const started = await startStudioWorkflow(owner, { name: "Announce new leads", definition: announceDefinition(slackConnectionId), label: "Started from a template" });
    expect(started.pendingMessageId).toBeNull();
    const state = await getStudioState(owner, started.id);
    expect(state.workflow).toMatchObject({ origin: "studio", status: "draft" });
    expect(state.workflow.draft.trigger).toMatchObject({ type: "manual" });
    expect(state.workflow.draft.steps.map((s) => s.kind)).toEqual(["slack_message", "create_task"]);
    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toMatchObject({ source: "template", label: "Started from a template" });

    // 4. Publishing freezes the definition into a version. A version that calls an outside system needs the owner's approval of that exact version before it
    // may run; the manager asks, the owner decides, and only then is the workflow switched on.
    const published = await publishWorkflow(owner, started.id);
    expect(published.needsApproval).toBe(true);
    expect((await getWorkflow(owner, started.id)).premiumFeatures).toEqual(expect.arrayContaining(["studio_workflow", "slack_message"]));
    const request = await requestWorkflowApproval(manager, started.id, null, { activate: true });
    const decided = await decideApproval(ctxFor(ws.o.people.owner, ws.o.org, "owner"), request.approvalId!, "approve");
    expect(decided.outcome?.status).toBe("succeeded");
    expect((await getWorkflow(owner, started.id)).status).toBe("active");

    // 5. The run. The outside system is the stand-in: the pinned socket (the one place an outside call leaves through) is replaced, the request is recorded,
    // and Slack answers "ok".
    const outbound = vi.spyOn(pinnedHttps, "request").mockResolvedValue(answer(200, "ok", { contentType: "text/plain" }));
    const contactId = (await createContact(owner, { firstName: "Ada", lastName: `Lovelace${uid()}` })).id;
    const { runId } = await startManualRun(owner, started.id, { contactId });
    await processWorkflowRuns({ now: new Date() });
    // A manual run is not started by the contact's own event, so that event is cleared here: otherwise it would still be waiting when the core workflow is
    // switched on later, and would meet it as a second run.
    await settle(new Date());

    expect(outbound).toHaveBeenCalledTimes(1);
    const sent = outbound.mock.calls[0][0];
    expect(sent.method).toBe("POST");
    expect(sent.url).toMatch(/^https:\/\/hooks\.slack\.com\/services\//);
    expect(JSON.parse(sent.body ?? "{}").text).toMatch(/^New lead: Ada Lovelace/);

    // 6. Run history is written from what happened: one completed run, both steps recorded, the call logged against the connection, and the task created.
    const run = await getRun(owner, runId);
    expect(run).toMatchObject({ status: "completed", startedVia: "manual", workflowId: started.id });
    expect(run.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["slack_message:completed", "create_task:completed"]);
    expect(run.steps[0].result).toMatchObject({ status: "sent", host: "hooks.slack.com" });
    expect(run.canCancel).toBe(false);
    const history = await listRuns(owner, { workflowId: started.id });
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({ id: runId, status: "completed", startedVia: "manual", contact: { id: contactId } });
    expect((await listConnectionCalls(owner, slackConnectionId)).filter((c) => c.origin === "step")).toMatchObject([{ outcome: "sent", method: "SLACK" }]);
    expect(await taskCount(ws.o.org.id)).toBe(1);
    // What the plan metered: one run, two steps, one outside call. The connection that was only tested is not counted as a workflow call.
    const used = await usage(ws.o.org.id);
    expect(used.counters.runs_started.quantity).toBe(1);
    expect(used.counters.steps_executed.quantity).toBe(2);
    expect(used.counters.integration_calls.quantity).toBe(1);

    // 7. The plan lapses. The run-level gate reads the plan again on every entry point, so starting the workflow is refused even before anything pauses it.
    await withSystem((db) => db.query("update maintenance_subscriptions set status = 'expired', expired_at = now() where org_id = $1", [ws.o.org.id]));
    await expect(startManualRun(owner, started.id, { contactId })).rejects.toMatchObject({ code: "plan_required" });

    // The sweeper then pauses the Studio workflow rather than deleting or failing anything, and the definition, the versions and the run history can still be
    // read.
    const swept = await sweepStudioEntitlements(new Date());
    expect(swept.workspacesLapsed).toBeGreaterThanOrEqual(1);
    expect(swept.workflowsPaused).toBeGreaterThanOrEqual(1);
    const paused = await getWorkflow(owner, started.id);
    expect(paused).toMatchObject({ status: "paused", pausedForPlan: true });
    expect(paused.versions).toHaveLength(1);
    const keptStudio = await getStudioState(owner, started.id);
    expect(keptStudio.workflow.draft.steps).toHaveLength(2);
    expect(keptStudio.history).toHaveLength(1);
    expect((await listRuns(owner, { workflowId: started.id })).items.map((r) => r.id)).toEqual([runId]);

    // Nothing starts while the workflow is paused either (the engine does not claim runs of a paused workflow), and turning it back on needs a person and the
    // plan. Pausing it (again) stays possible, so nobody is stuck.
    await expect(startManualRun(owner, started.id, { contactId })).rejects.toMatchObject({ code: "conflict" });
    await expect(setWorkflowStatus(owner, started.id, "active")).rejects.toMatchObject({ code: "plan_required" });
    await expect(setWorkflowStatus(owner, started.id, "paused")).resolves.toMatchObject({ status: "paused" });

    // 8. Only Studio is affected. A core CRM workflow built in the CRM screens is neither premium nor paused, and it still runs to completion on a new
    // contact after the lapse, which is the line the lapse policy promises.
    const core = await createWorkflow(owner, { name: `Core follow-up ${uid()}`, definition: coreDefinition("Core task after lapse") });
    await publishWorkflow(owner, core.id);
    await setWorkflowStatus(owner, core.id, "active");
    expect(await getWorkflow(owner, core.id)).toMatchObject({ origin: "crm", status: "active" });

    await createContact(owner, { firstName: "Grace", lastName: `Hopper${uid()}` });
    await settle(new Date());
    const coreRuns = await listRuns(owner, { workflowId: core.id });
    expect(coreRuns.items.map((r) => r.status)).toEqual(["completed"]);
    // The Studio workflow stayed paused, so it started nothing, and the core workflow's task is the only new one.
    expect((await listRuns(owner, { workflowId: started.id })).items).toHaveLength(1);
    expect(await taskCount(ws.o.org.id)).toBe(2);
    expect((await withSystem((db) => studioUsageSnapshot(db, ws.o.org.id, new Date()))).counters.runs_started.quantity).toBe(1);
  });
});
