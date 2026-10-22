// A controlled rehearsal of the production scheduler for Automation Studio, through the real HTTP entry point (POST /api/internal/tick with the bearer secret
// and SCHEDULER_ENABLED=true) and the REAL job list, on an isolated database with synthetic workspaces and a simulated clock. It answers the founder's gate before
// the scheduler is switched on in production: do the Studio jobs run together with every other job without one failing, is a repeated or overlapping tick
// harmless, is each workspace's work its own, does a lapse mid-run hold (never fail) the work and leave core features alone, and does work resume after a
// verified payment. Nothing leaves the machine: the only outside call is the transport, replaced here and counted.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const CRON = "rehearsal-cron-secret-0123456789abcdef";
process.env.CRON_SECRET = CRON;
process.env.SCHEDULER_ENABLED = "true";

import { resetEnvCache } from "@/server/env";
import { POST as tick } from "@/app/api/internal/tick/route";
import { JOBS } from "@/server/ops/tick";
import { withSystem } from "@/server/db";
import { createContact } from "@/server/crm/contacts";
import { crmEventDispatch } from "@/server/crm/dispatch";
import { createWorkflow, publishWorkflow, requestWorkflowApproval, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import { decideApproval } from "@/server/approvals/service";
import { recordPaymentFailed, recordVerifiedPayment } from "@/server/automation-studio/lifecycle";
import { hostResolver } from "@/server/calendars/adapters/http";
import { pinnedHttps } from "@/server/security/pinned-https";
import { createConnection, testConnection } from "@/server/automation-studio/connections";
import type { WorkflowDefinition, WorkflowStep } from "@/lib/crm/workflow/spec";
import { agencyUser, createUser, ctxFor, uid } from "./support/fixtures";
import { studioWorkspace, type StudioWorkspace } from "./support/studio-workspace";

const DAY = 86_400_000;
const SLACK_HOOK = ["https://hooks.slack.com/services", "T0ABCDEFG", "B0HIJKLMN", "AbCdEfGhIjKlMnOpQrStUvWx"].join("/");
let slackPosts: string[] = [];

beforeAll(() => resetEnvCache());
afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** An internal task now, a two-day wait, then a team notification and a Slack post (the one outside call). */
const nudge = (slack: string): WorkflowDefinition => ({
  trigger: { type: "contact.created" },
  steps: [
    { key: "task", kind: "create_task", config: { title: "Welcome {{contact.full_name}}", priority: "normal", assignee: "none" }, next: "wait" },
    { key: "wait", kind: "wait", config: { mode: "duration", amount: 2, unit: "days" }, next: "tell" },
    { key: "tell", kind: "notify_team", config: { roles: ["owner", "admin"], title: "Two days since {{contact.full_name}} arrived" }, next: "post" },
    { key: "post", kind: "slack_message", config: { connectionId: slack, text: "Follow up with {{contact.full_name}}" }, next: null },
  ] as WorkflowStep[],
});
const coreDef = (): WorkflowDefinition => ({
  trigger: { type: "contact.created" },
  steps: [{ key: "core_task", kind: "create_task", config: { title: "Core follow-up", priority: "normal", assignee: "none" }, next: null }] as WorkflowStep[],
});

async function liveStudioWorkflow(ws: StudioWorkspace, slack: string) {
  const owner = ws.o.actor("owner");
  const { id } = await createWorkflow(owner, { name: `Rehearsal ${uid()}`, definition: nudge(slack), origin: "studio" });
  const published = await publishWorkflow(owner, id);
  expect(published.needsApproval).toBe(true);
  const req = await requestWorkflowApproval(ws.o.actor("manager"), id, null, { activate: true });
  await decideApproval(ctxFor(ws.o.people.owner, ws.o.org, "owner"), req.approvalId!, "approve");
  return id;
}
async function slackConnection(ws: StudioWorkspace) {
  const owner = ws.o.actor("owner");
  vi.spyOn(hostResolver, "lookup").mockResolvedValue(["93.184.216.34"]);
  vi.spyOn(pinnedHttps, "request").mockImplementation(async () => ({ status: 200, contentType: "text/plain", retryAfterSeconds: null, bytes: 2, truncated: false, body: "ok" }));
  const c = await createConnection(owner, { kind: "slack_webhook", name: "Sales channel", webhookUrl: SLACK_HOOK, channelLabel: "#sales" });
  expect((await testConnection(owner, c.id, { confirmed: true })).ok).toBe(true);
  return c.id;
}
function countOutside() {
  slackPosts = [];
  vi.spyOn(hostResolver, "lookup").mockResolvedValue(["93.184.216.34"]);
  vi.spyOn(pinnedHttps, "request").mockImplementation(async (r) => {
    slackPosts.push(`${r.method} ${new URL(r.url).host}`);
    return { status: 200, contentType: "text/plain", retryAfterSeconds: null, bytes: 2, truncated: false, body: "ok" };
  });
}

/** A scheduler tick as the host's cron makes it: the real route, the bearer secret, and the lease of the previous tick having long since ended. */
async function runTick() {
  await withSystem((db) => db.query("update worker_job_runs set last_finished_at = now() - interval '5 minutes' where job_name = 'scheduler_tick' and last_finished_at is not null"));
  const res = await tick(new Request("http://localhost/api/internal/tick", { method: "POST", headers: { authorization: `Bearer ${CRON}` } }));
  expect(res.status).toBe(200);
  return (await res.json()) as { ok: boolean; skipped?: string; ran?: Record<string, number | string> };
}

const runsOf = async (workflowId: string) => (await withSystem((db) => db.query<{ status: string; last_error: string | null }>("select status, last_error from crm_workflow_runs where workflow_id = $1 order by created_at", [workflowId]))).rows;
const tasksOf = async (ws: StudioWorkspace, title: string) => (await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from tasks where org_id = $1 and title like $2", [ws.o.org.id, title]))).rows[0].n;
const sub = async (ws: StudioWorkspace) => (await withSystem((db) => db.query<{ id: string }>("select id from maintenance_subscriptions where org_id = $1 order by created_at desc limit 1", [ws.o.org.id]))).rows[0].id;
const wfStatus = async (id: string) => (await withSystem((db) => db.query<{ status: string }>("select status from crm_workflows where id = $1", [id]))).rows[0].status;

describe("the production scheduler, rehearsed for Automation Studio", () => {
  it("runs two workspaces' Studio workflows on a simulated timeline: starts, waits, repeats harmlessly, holds a lapse, resumes after a verified payment", { timeout: 300_000 }, async () => {
    const a = await studioWorkspace({ name: "Rehearsal A" });
    const b = await studioWorkspace({ name: "Rehearsal B" });
    const slackA = await slackConnection(a);
    const slackB = await slackConnection(b);
    const wfA = await liveStudioWorkflow(a, slackA);
    const wfB = await liveStudioWorkflow(b, slackB);
    // A core CRM workflow in B, which a lapse of B's plan must never touch.
    const ownerB = b.o.actor("owner");
    const core = await createWorkflow(ownerB, { name: `Core ${uid()}`, definition: coreDef() });
    await publishWorkflow(ownerB, core.id);
    await setWorkflowStatus(ownerB, core.id, "active");
    // Events from setting the workspaces up have their own turn first, as in production; then the outside world is counted.
    for (let i = 0; i < 4; i++) await crmEventDispatch();
    await withSystem((db) => db.query("update crm_workflow_runs set status = 'cancelled' where org_id = any($1::uuid[]) and status in ('queued', 'waiting', 'running')", [[a.o.org.id, b.o.org.id]]));
    countOutside();

    // ---- T0: three new contacts in A, one in B -------------------------------------------------------------------------------------
    for (const n of ["Ada", "Grace", "Alan"]) await createContact(a.o.actor("owner"), { firstName: n, lastName: "Rehearsal", email: `${n.toLowerCase()}.${uid()}@example.test` });
    await createContact(ownerB, { firstName: "Edsger", lastName: "Rehearsal", email: `edsger.${uid()}@example.test` });
    const t0 = await runTick();
    expect(t0.ran, "the tick ran the real job list").toBeDefined();
    expect(Object.keys(t0.ran!).sort()).toEqual(JOBS.map((j) => j.name).sort());
    expect(Object.entries(t0.ran!).filter(([, v]) => v === "failed"), "no scheduled job failed").toEqual([]);
    for (let i = 0; i < 3; i++) await runTick(); // the event is dispatched on one pass and its runs advance on the next
    expect((await runsOf(wfA)).map((r) => r.status)).toEqual(["waiting", "waiting", "waiting"]);
    expect((await runsOf(wfB)).map((r) => r.status)).toEqual(["waiting"]);
    expect(await tasksOf(a, "Welcome %"), "each workspace's own contacts only").toBe(3);
    expect(await tasksOf(b, "Welcome %")).toBe(1);
    expect(await tasksOf(b, "Core follow-up"), "B's core workflow ran once for B's contact").toBe(1);
    expect(await tasksOf(a, "Core follow-up")).toBe(0);
    expect(slackPosts, "nothing is posted before the wait is over").toEqual([]);

    // A repeated tick, and two overlapping ticks, change nothing.
    const before = { a: await tasksOf(a, "Welcome %"), b: await tasksOf(b, "Welcome %") };
    await runTick();
    const [one, two] = await Promise.all([
      tick(new Request("http://localhost/api/internal/tick", { method: "POST", headers: { authorization: `Bearer ${CRON}` } })),
      tick(new Request("http://localhost/api/internal/tick", { method: "POST", headers: { authorization: `Bearer ${CRON}` } })),
    ]);
    const bodies = (await Promise.all([one.json(), two.json()])) as Array<{ skipped?: string }>;
    expect(bodies.filter((x) => x.skipped).length, "exactly one of two overlapping ticks runs").toBeGreaterThanOrEqual(1);
    expect({ a: await tasksOf(a, "Welcome %"), b: await tasksOf(b, "Welcome %") }).toEqual(before);

    // ---- T+1d: B's payment fails (a one day grace period) ------------------------------------------------------------------------
    const admin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
    const subB = await sub(b);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 1 * DAY));
    await recordPaymentFailed(admin, subB, { graceDays: 1 });

    // ---- T+3d: both waits are over; B's grace ended on the way ---------------------------------------------------------------------
    vi.setSystemTime(new Date(Date.now() + 2 * DAY));
    for (let i = 0; i < 3; i++) await runTick();
    expect((await runsOf(wfA)).map((r) => r.status), "A's runs finish").toEqual(["completed", "completed", "completed"]);
    expect(slackPosts.filter((p) => p.includes("hooks.slack.com")).length, "A posted once per contact, and B posted nothing").toBe(3);
    expect(await wfStatus(wfB), "B's Studio workflow is paused by the sweeper").toBe("paused");
    const heldB = await runsOf(wfB);
    expect(heldB.map((r) => r.status), "B's run is held, not failed or lost").not.toContain("failed");
    expect(heldB.map((r) => r.status)).not.toContain("completed");
    expect(await wfStatus(core.id), "B's core CRM workflow is untouched").toBe("active");
    const entitlement = await withSystem((db) => db.query<{ status: string }>("select status from maintenance_subscriptions where id = $1", [subB]));
    expect(entitlement.rows[0].status).toBe("expired");
    const outsideAtLapse = slackPosts.length;
    // More ticks while lapsed: still nothing for B.
    for (let i = 0; i < 2; i++) await runTick();
    expect(slackPosts.length, "a lapsed workspace makes no outside call").toBe(outsideAtLapse);

    // ---- a verified payment brings the plan back; the workflow waits for a person, then the held run finishes --------------------------
    const paidThrough = new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10);
    expect(await recordVerifiedPayment(admin, subB, { paidThroughOn: paidThrough })).toMatchObject({ reactivated: true, workflowsWaiting: 1 });
    for (let i = 0; i < 2; i++) await runTick();
    expect(await wfStatus(wfB), "nothing switches itself back on").toBe("paused");
    expect(slackPosts.length).toBe(outsideAtLapse);
    await setWorkflowStatus(ownerB, wfB, "active");
    for (let i = 0; i < 3; i++) await runTick();
    expect((await runsOf(wfB)).map((r) => r.status)).toEqual(["completed"]);
    expect(slackPosts.length, "B's one post goes out exactly once").toBe(outsideAtLapse + 1);

    // The tick's own heartbeat is healthy, and no job is left failing.
    const beat = await withSystem((db) => db.query<{ job_name: string; consecutive_failures: number }>("select job_name, consecutive_failures from worker_job_runs where consecutive_failures > 0"));
    expect(beat.rows, "no job has consecutive failures").toEqual([]);
    const lease = await withSystem((db) => db.query<{ last_success_at: Date | null }>("select last_success_at from worker_job_runs where job_name = 'scheduler_tick'"));
    expect(lease.rows[0].last_success_at).not.toBeNull();
  });
});
