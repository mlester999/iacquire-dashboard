// Due workflow runs are leased fairly across workspaces: a workspace with a large backlog cannot use every slot of a tick while another
// workspace's single run waits, and a workspace that is alone still gets the whole tick. Every workspace here is created in this file, so the
// counts are exact. Nothing leaves the machine: every workflow only creates an internal task.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { createContact } from "@/server/crm/contacts";
import { crmEventDispatch } from "@/server/crm/dispatch";
import { createWorkflow, publishWorkflow, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import type { WorkflowDefinition, WorkflowStep } from "@/lib/crm/workflow/spec";
import { uid } from "./support/fixtures";
import { crmOrg, type CrmOrg } from "./support/crm";

const taskDef = (): WorkflowDefinition => ({
  trigger: { type: "contact.created" },
  steps: [{ key: "task", kind: "create_task", config: { title: "Follow up", priority: "normal", assignee: "none" }, next: null }] as WorkflowStep[],
});

async function liveWorkflow(o: CrmOrg) {
  const actor = o.actor("owner");
  const { id } = await createWorkflow(actor, { name: `Fair ${uid()}`, definition: taskDef() });
  await publishWorkflow(actor, id);
  await setWorkflowStatus(actor, id, "active");
  return id;
}

/** Creates `n` contacts (so `n` runs) and turns their events into queued runs without running any of them. */
async function queueRuns(o: CrmOrg, n: number) {
  for (let i = 0; i < n; i++) await createContact(o.actor("owner"), { firstName: "Lead", lastName: uid() });
  for (let i = 0; i < 20; i++) if (!(await crmEventDispatch()).claimed) break;
}

const counts = async (workflowId: string) => {
  const { rows } = await withSystem((db) => db.query<{ status: string; n: number }>("select status, count(*)::int as n from crm_workflow_runs where workflow_id = $1 group by status", [workflowId]));
  return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number | undefined>;
};

describe("fair claiming of due runs", () => {
  it("gives every workspace a share of the tick, oldest runs first within each, even when one has a far larger and older backlog", async () => {
    const big = await crmOrg();
    const small = await crmOrg();
    const single = await crmOrg();
    const wBig = await liveWorkflow(big);
    const wSmall = await liveWorkflow(small);
    const wSingle = await liveWorkflow(single);
    await queueRuns(big, 12); // created first, so every one of them is older than anything below
    await queueRuns(small, 2);
    await queueRuns(single, 1);
    expect(await counts(wBig)).toEqual({ queued: 12 });

    // Six slots: the old way would give all six to the big backlog. Fairly: one each round, three rounds.
    const result = await processWorkflowRuns({ limit: 6 });
    expect(result.claimed).toBe(6);
    expect(await counts(wSmall)).toEqual({ completed: 2 });
    expect(await counts(wSingle)).toEqual({ completed: 1 });
    expect(await counts(wBig)).toEqual({ completed: 3, queued: 9 });

    // Oldest first inside the workspace: what ran is the three oldest.
    const done = await withSystem((db) => db.query<{ id: string }>("select id from crm_workflow_runs where workflow_id = $1 and status = 'completed' order by created_at, id", [wBig]));
    const oldest = await withSystem((db) => db.query<{ id: string }>("select id from crm_workflow_runs where workflow_id = $1 order by created_at, id limit 3", [wBig]));
    expect(done.rows.map((r) => r.id)).toEqual(oldest.rows.map((r) => r.id));
  });

  it("does not hold a workspace back when it is the only one with work: it gets the whole tick", async () => {
    const only = await crmOrg();
    const w = await liveWorkflow(only);
    await queueRuns(only, 8);
    // The earlier test left nine runs of another workspace queued, so drain those first.
    for (let i = 0; i < 5; i++) await processWorkflowRuns({ limit: 100 });
    expect(await counts(w)).toEqual({ completed: 8 });
    const again = await crmOrg();
    const w2 = await liveWorkflow(again);
    await queueRuns(again, 7);
    const r = await processWorkflowRuns({ limit: 7 });
    expect(r.claimed).toBe(7);
    expect(await counts(w2)).toEqual({ completed: 7 });
  });

  it("never leases a paused workflow's runs, and never leases one run twice when two ticks overlap", async () => {
    const o = await crmOrg();
    const actor = o.actor("owner");
    const active = await liveWorkflow(o);
    const paused = await liveWorkflow(o);
    await queueRuns(o, 6); // both workflows start a run for each contact
    expect((await counts(active)).queued).toBe(6);
    await setWorkflowStatus(actor, paused, "paused");
    await Promise.all([processWorkflowRuns({ limit: 50 }), processWorkflowRuns({ limit: 50 })]);
    expect(await counts(active)).toEqual({ completed: 6 });
    expect(await counts(paused)).toEqual({ queued: 6 });
    // Each run did its work once: one task per contact for the active workflow.
    const tasks = await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from tasks where org_id = $1", [o.org.id]));
    expect(tasks.rows[0].n).toBe(6);
  });
});
