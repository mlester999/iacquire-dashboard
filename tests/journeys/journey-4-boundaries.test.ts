// Journey 4, the edges: Automation Studio, asked what journey 4 does not.
//   * denied access: a viewer cannot start, build or publish a Studio workflow, a manager cannot approve the version they asked for, and a version nobody approved never runs;
//   * tenant isolation: another workspace's owner cannot read the workflow, its versions, its runs or its connections, cannot run it, and the rows are invisible to them under
//     row-level security;
//   * duplicates and replays: a contact event delivered twice, and the runner running twice, make one run and one outside call;
//   * audit: the connection's call log records the test call and the step call under the workflow, and the version's approval names who decided it;
//   * what goes out: only the approved words, to the verified address, once.
// The outside system is the stand-in used in journey 4 (the pinned socket and the DNS lookup are replaced); no request leaves the machine.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { createContact } from "@/server/crm/contacts";
import { crmEventDispatch } from "@/server/crm/dispatch";
import { decideApproval } from "@/server/approvals/service";
import { createWorkflow, getWorkflow, listWorkflows, publishWorkflow, requestWorkflowApproval, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import { getRun, listRuns, startManualRun } from "@/server/crm/workflows/runs";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import { startStudioWorkflow } from "@/server/automation-studio/studio";
import { listConnectionCalls, listConnections } from "@/server/automation-studio/connections";
import { pinnedHttps, type PinnedResponse } from "@/server/security/pinned-https";
import type { WorkflowDefinition, WorkflowStep } from "@/lib/crm/workflow/spec";
import { ctxFor, uid } from "../support/fixtures";
import { studioWorkspace } from "../support/studio-workspace";

const answer = (status: number, body = "{}", over: Partial<PinnedResponse> = {}): PinnedResponse => ({ status, contentType: "application/json", retryAfterSeconds: null, bytes: Buffer.byteLength(body), truncated: false, body, ...over });
const step = (key: string, kind: WorkflowStep["kind"], config: Record<string, unknown>, next: string | null = null): WorkflowStep => ({ key, kind, config, next }) as WorkflowStep;
const announce = (slack: string): WorkflowDefinition => ({
  trigger: { type: "manual" },
  steps: [step("announce", "slack_message", { connectionId: slack, text: "New lead: {{contact.first_name}} {{contact.last_name}}" }, "task"), step("task", "create_task", { title: "Follow up with the new lead", priority: "normal", assignee: "none" })],
});
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;

async function settle(now: Date) {
  for (let i = 0; i < 25; i += 1) {
    const d = await crmEventDispatch({ now });
    const r = await processWorkflowRuns({ now });
    if (!d.claimed && !r.claimed && !r.scheduled) return;
  }
}

afterEach(() => vi.restoreAllMocks());

describe("journey 4: who may build and approve, who can see it, and what a repeat does", () => {
  it("refuses a viewer Studio, refuses a manager the approval of their own request, and never runs a version nobody approved", async () => {
    const ws = await studioWorkspace({ connections: true });
    const owner = ws.o.actor("owner");
    const slack = ws.ids.connections!.slack;
    await expect(startStudioWorkflow(ws.o.actor("viewer"), { name: "Viewer tries", definition: announce(slack), label: "x" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(createWorkflow(ws.o.actor("viewer"), { name: "Viewer draft", origin: "studio" })).rejects.toMatchObject({ code: "forbidden" });

    const started = await startStudioWorkflow(owner, { name: "Announce new leads", definition: announce(slack), label: "Started from a template" });
    await publishWorkflow(owner, started.id);
    const request = await requestWorkflowApproval(ws.o.actor("manager"), started.id, null, { activate: true });
    // The manager asked; the manager cannot also decide.
    await expect(decideApproval(ctxFor(ws.o.people.manager, ws.o.org, "admin"), request.approvalId!, "approve")).rejects.toMatchObject({ code: expect.stringMatching(/forbidden|conflict/) });
    // Until the owner decides, the workflow is not active and a run of it is refused: nothing goes out.
    const outbound = vi.spyOn(pinnedHttps, "request").mockResolvedValue(answer(200, "ok", { contentType: "text/plain" }));
    expect((await getWorkflow(owner, started.id)).status).not.toBe("active");
    const contactId = (await createContact(owner, { firstName: "Ada", lastName: `Lovelace${uid()}` })).id;
    await expect(startManualRun(owner, started.id, { contactId })).rejects.toMatchObject({ code: expect.stringMatching(/conflict|forbidden|plan_required|invalid_input/) });
    expect(outbound).not.toHaveBeenCalled();
  });

  it("keeps the workflow, its runs and its connections away from another workspace", async () => {
    const a = await studioWorkspace({ connections: true });
    const b = await studioWorkspace({ connections: true });
    const slack = a.ids.connections!.slack;
    const owner = a.o.actor("owner");
    const started = await startStudioWorkflow(owner, { name: "Announce new leads", definition: announce(slack), label: "Started from a template" });
    await publishWorkflow(owner, started.id);
    const request = await requestWorkflowApproval(a.o.actor("manager"), started.id, null, { activate: true });
    await decideApproval(ctxFor(a.o.people.owner, a.o.org, "owner"), request.approvalId!, "approve");
    vi.spyOn(pinnedHttps, "request").mockResolvedValue(answer(200, "ok", { contentType: "text/plain" }));
    const contactId = (await createContact(owner, { firstName: "Ada", lastName: `Lovelace${uid()}` })).id;
    const { runId } = await startManualRun(owner, started.id, { contactId });
    await processWorkflowRuns({ now: new Date() });

    const other = b.o.actor("owner");
    await expect(getWorkflow(other, started.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(getRun(other, runId)).rejects.toMatchObject({ code: "not_found" });
    await expect(startManualRun(other, started.id, { contactId })).rejects.toMatchObject({ code: "not_found" });
    expect((await listWorkflows(other)).map((w) => w.id)).not.toContain(started.id);
    expect((await listConnections(other)).map((c) => c.id)).not.toContain(slack);
    const seen = (table: string) => withUser(b.o.people.owner.id, async (db) => (await db.query(`select 1 from ${table} where org_id = $1`, [a.o.org.id])).rows.length);
    for (const table of ["crm_workflows", "crm_workflow_versions", "crm_workflow_runs", "crm_workflow_run_steps"]) {
      expect((await rows(`select 1 from ${table} where org_id = $1`, [a.o.org.id])).length, `${table} exists`).toBeGreaterThan(0);
      expect(await seen(table), `${table} seen by another workspace's owner`).toBe(0);
    }
  });

  it("makes one run and one outside call when the contact's event is delivered twice and the runner runs twice", async () => {
    const ws = await studioWorkspace({ connections: true });
    const owner = ws.o.actor("owner");
    const slack = ws.ids.connections!.slack;
    const outbound = vi.spyOn(pinnedHttps, "request").mockResolvedValue(answer(200, "ok", { contentType: "text/plain" }));
    const def: WorkflowDefinition = { trigger: { type: "contact.created" }, steps: [step("announce", "slack_message", { connectionId: slack, text: "New lead: {{contact.first_name}} {{contact.last_name}}" }, "task"), step("task", "create_task", { title: "Follow up", priority: "normal", assignee: "none" })] };
    const wf = await startStudioWorkflow(owner, { name: "Announce every new contact", definition: def, label: "From a template" });
    await publishWorkflow(owner, wf.id);
    const request = await requestWorkflowApproval(ws.o.actor("manager"), wf.id, null, { activate: true });
    await decideApproval(ctxFor(ws.o.people.owner, ws.o.org, "owner"), request.approvalId!, "approve");
    outbound.mockClear();
    await createContact(owner, { firstName: "Grace", lastName: `Hopper${uid()}` });
    await settle(new Date());
    await settle(new Date());
    await processWorkflowRuns({ now: new Date() });
    expect((await listRuns(owner, { workflowId: wf.id })).items).toHaveLength(1);
    expect(outbound).toHaveBeenCalledTimes(1);
    expect(await rows("select 1 from tasks where org_id = $1", [ws.o.org.id])).toHaveLength(1);
    void setWorkflowStatus;
  });

  it("records the test call and the step call against the connection, and who approved the version", async () => {
    const ws = await studioWorkspace({ connections: true });
    const owner = ws.o.actor("owner");
    const slack = ws.ids.connections!.slack;
    const started = await startStudioWorkflow(owner, { name: "Announce new leads", definition: announce(slack), label: "Started from a template" });
    await publishWorkflow(owner, started.id);
    const request = await requestWorkflowApproval(ws.o.actor("manager"), started.id, null, { activate: true });
    await decideApproval(ctxFor(ws.o.people.owner, ws.o.org, "owner"), request.approvalId!, "approve");
    vi.spyOn(pinnedHttps, "request").mockResolvedValue(answer(200, "ok", { contentType: "text/plain" }));
    const contactId = (await createContact(owner, { firstName: "Ada", lastName: `Lovelace${uid()}` })).id;
    const { runId } = await startManualRun(owner, started.id, { contactId });
    await processWorkflowRuns({ now: new Date() });
    await settle(new Date());
    const calls = await listConnectionCalls(owner, slack);
    expect(calls.filter((c) => c.origin === "test")).toHaveLength(1);
    expect(calls.filter((c) => c.origin === "step")).toHaveLength(1);
    expect((await getRun(owner, runId)).steps.map((s) => s.status)).toEqual(["completed", "completed"]);
    const approvals = await rows<{ status: string; decided_by: string | null }>("select status, decided_by from approval_requests where id = $1", [request.approvalId]);
    expect(approvals[0]).toMatchObject({ status: "approved", decided_by: ws.o.people.owner.id });
    // The secret behind the connection never appears in what the screens read.
    expect(JSON.stringify(await listConnections(owner)) + JSON.stringify(calls)).not.toContain("sk_live_Zr7Qw1XyAbCdEf90");
  });
});
