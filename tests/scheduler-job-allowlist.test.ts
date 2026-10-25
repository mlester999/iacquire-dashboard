import { afterEach, beforeAll, describe, expect, it } from "vitest";

const CRON = "allowlist-rehearsal-secret-0123456789abcdef";
process.env.CRON_SECRET = CRON;
process.env.SCHEDULER_ENABLED = "true";

import { resetEnvCache } from "@/server/env";
import { POST as tick } from "@/app/api/internal/tick/route";
import { activeJobs, JOBS, runScheduledJobs, SCHEDULER_JOBS_ONLY_MAX_LENGTH, type ScheduledJob } from "@/server/ops/tick";
import { withSystem } from "@/server/db";
import { queueOutbound } from "@/server/messaging/send";
import { inbound, messagingOrg } from "./support/messaging";

// Staged activation of the scheduler: SCHEDULER_JOBS_ONLY limits a tick to the jobs that were approved. Unset, nothing changes.

const job = (name: string): ScheduledJob => ({ name, run: async () => 0 });
const REGISTRY = ["a", "b", "c", "d"].map(job);

const setOnly = (value: string | undefined) => {
  if (value === undefined) delete process.env.SCHEDULER_JOBS_ONLY;
  else process.env.SCHEDULER_JOBS_ONLY = value;
  resetEnvCache();
};
beforeAll(() => resetEnvCache());
afterEach(() => setOnly(undefined));

async function runTick() {
  await withSystem((db) => db.query("update worker_job_runs set last_finished_at = now() - interval '5 minutes' where job_name = 'scheduler_tick' and last_finished_at is not null"));
  return tick(new Request("http://localhost/api/internal/tick", { method: "POST", headers: { authorization: `Bearer ${CRON}` } }));
}

describe("which jobs a tick may run", () => {
  it("runs every job when nothing is set, as before", () => {
    expect(activeJobs(REGISTRY, undefined)).toEqual(REGISTRY);
    setOnly(undefined);
    expect(activeJobs()).toEqual(JOBS);
    setOnly("");
    expect(activeJobs()).toEqual(JOBS); // an empty env value is unset
    setOnly("   ");
    expect(() => activeJobs()).toThrow(/names no job/); // whitespace must not expand to every job
  });

  it("runs exactly the jobs named, in the registry's order, whatever order and spacing they were written in", () => {
    expect(activeJobs(REGISTRY, "c,a").map((j) => j.name)).toEqual(["a", "c"]);
    expect(activeJobs(REGISTRY, " d , b ,, b ").map((j) => j.name)).toEqual(["b", "d"]);
  });

  it("refuses a name that does not exist and a value that names nothing, so a typo cannot run something else", () => {
    expect(() => activeJobs(REGISTRY, "a,nope")).toThrow(/does not exist: nope/);
    expect(() => activeJobs(REGISTRY, "inboxattention")).toThrow(/does not exist/); // exact names only
    expect(() => activeJobs(REGISTRY, " , ")).toThrow(/names no job/);
    expect(() => activeJobs(REGISTRY, "__proto__")).toThrow(/does not exist/);
    expect(() => activeJobs(REGISTRY, "a".repeat(SCHEDULER_JOBS_ONLY_MAX_LENGTH + 1))).toThrow(/longer than 2000 characters/);
  });

  it("names only real jobs in the documented first steps of the activation plan", () => {
    const real = new Set(JOBS.map((j) => j.name));
    const FIRST_STEPS = ["expiredReservations", "approvalExpiry", "bookingHolds", "aiWorkRecovery", "crmWorkflowRecovery", "setupEvidence", "studioEntitlementSweep", "aqiTutorialEventRetention", "aqiOperationsRetention", "inboxAttention", "crmEventDispatch", "crmWorkflowRuns"];
    for (const n of FIRST_STEPS) expect(real.has(n), n).toBe(true);
  });
});

describe("through the real tick endpoint", () => {
  it("runs only the approved jobs, so a queued message is left waiting instead of being blocked by a dispatcher that was never approved", async () => {
    const org = await messagingOrg({ name: "Allowlist Co" });
    const c = await inbound(org.org.id);
    const queued = await withSystem((db) => queueOutbound(db, { orgId: org.org.id, conversationId: c.conversationId, scope: "reply", actor: { kind: "ai", agentId: org.salesAgentId }, body: "Waiting for its turn." }));
    expect(queued.status).toBe("queued");

    setOnly("aiWorkRecovery, crmWorkflowRecovery , inboxAttention");
    const res = await runTick();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ran: Record<string, number | string> };
    expect(Object.keys(body.ran).sort()).toEqual(["aiWorkRecovery", "crmWorkflowRecovery", "inboxAttention"]);
    expect(Object.values(body.ran)).not.toContain("failed");
    // The dispatcher was not approved: the message is exactly as it was, still queued.
    expect((await withSystem((db) => db.query<{ status: string; blocked_reason: string | null }>("select status, blocked_reason from conversation_messages where id = $1", [queued.messageId]))).rows[0]).toEqual({ status: "queued", blocked_reason: null });

    // Once the dispatcher is approved too, it does its work as always (here: blocked, because every provider write switch is off).
    setOnly("messagesDispatched");
    await runTick();
    expect((await withSystem((db) => db.query<{ status: string }>("select status from conversation_messages where id = $1", [queued.messageId]))).rows[0].status).toBe("blocked");
  });

  it("fails the tick loudly, running nothing, when the list names a job that does not exist", async () => {
    const before = await withSystem((db) => db.query<{ n: string }>("select count(*)::text as n from worker_job_runs where job_name <> 'scheduler_tick'"));
    setOnly("aiWorkRecovery,notAJob");
    const res = await runTick();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("notAJob"); // the response never carries details; the heartbeat does
    const after = await withSystem((db) => db.query<{ n: string }>("select count(*)::text as n from worker_job_runs where job_name <> 'scheduler_tick'"));
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("fails the tick closed for a whitespace-only environment allowlist without running other jobs", async () => {
    const before = await withSystem((db) => db.query<{ n: string }>("select count(*)::text as n from worker_job_runs where job_name <> 'scheduler_tick'"));
    setOnly("   ");
    const res = await runTick();
    expect(res.status).toBe(500);
    const after = await withSystem((db) => db.query<{ n: string }>("select count(*)::text as n from worker_job_runs where job_name <> 'scheduler_tick'"));
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("is what runScheduledJobs does by default, and a controlled job list still overrides it", async () => {
    setOnly("aiWorkRecovery");
    expect(Object.keys(await runScheduledJobs(new Date(Date.now() + 3_600_000)))).toEqual(["aiWorkRecovery"]);
    expect(Object.keys(await runScheduledJobs(new Date(Date.now() + 7_200_000), [job("x"), job("y")]))).toEqual(["x", "y"]);
  });
});
