import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/workforce/work-kick", () => ({ kickWorkJob: vi.fn() }));

import { withSystem } from "@/server/db";
import { JOB_LABELS } from "@/lib/ops";
import { resetEnvCache } from "@/server/env";
import { JOBS, runScheduledJobs } from "@/server/ops/tick";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { createConfigVersion } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { cancelWorkJob, createWorkJob, finishWorkJob, type WorkJobRow } from "@/server/workforce/jobs";
import { runReadOnlyReviewJob } from "@/server/workforce/read-only-review";
import { runDueSchedules, saveSchedule } from "@/server/workforce/schedules";
import {
  clearWorkHandlerOverrides,
  registerWorkHandler,
  runWorkJob,
  runQueuedWorkWithinBudget,
} from "@/server/workforce/work-runner";
import { hasWorkJobController } from "@/server/workforce/work-cancel";

let org: Awaited<ReturnType<typeof createOrg>>;
let owner: Awaited<ReturnType<typeof createUser>>;
let operationsManagerId: string;

async function queueReview(title = "Queued review") {
  return withSystem((db) => createWorkJob(db, {
    orgId: org.id,
    agentId: operationsManagerId,
    requestedBy: owner.id,
    capability: "proactive_review",
    title,
    idempotencyKey: `queued-runner-${crypto.randomUUID()}`,
    input: {},
  }));
}

function installCompletingHandler(onRun: (job: WorkJobRow) => void = () => undefined) {
  registerWorkHandler("proactive_review", async (job, context) => {
    onRun(job);
    const finished = await withSystem((db) => finishWorkJob(db, {
      jobId: job.id,
      orgId: job.org_id,
      workerId: context.workerId,
      status: "completed",
      stage: "completed",
      event: { kind: "notice", stage: "completed", message: "The test worker completed this review." },
    }));
    if (!finished) throw new Error("The test worker could not finish its active lease.");
  });
}

beforeAll(async () => {
  org = await createOrg({ name: "Queued Runner Test Co" });
  owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  operationsManagerId = await agentId(org.id, "operations_manager");
  await withSystem((db) => createConfigVersion(db, {
    orgId: org.id,
    agentId: operationsManagerId,
    settings: defaultSettings("operations_manager"),
    source: "onboarding",
    userId: owner.id,
    apply: true,
  }));
  await withSystem((db) => db.query(
    "update agent_instances set status = 'online', last_health_ok = true, last_health_check_at = now() where org_id = $1",
    [org.id],
  ));
}, 60000);

beforeEach(async () => {
  clearWorkHandlerOverrides();
  delete process.env.WORKFORCE_SCHEDULES_ENABLED;
  delete process.env.SCHEDULER_JOBS_ONLY;
  resetEnvCache();
  await withSystem(async (db) => {
    await db.query("delete from ai_work_schedules where org_id = $1", [org.id]);
    await db.query("delete from ai_work_jobs where org_id = $1", [org.id]);
    await db.query("delete from worker_job_runs where job_name in ('tick', 'aiWorkRecovery', 'aiWorkRunQueued')");
  });
});

afterEach(async () => {
  clearWorkHandlerOverrides();
  delete process.env.WORKFORCE_SCHEDULES_ENABLED;
  delete process.env.SCHEDULER_JOBS_ONLY;
  resetEnvCache();
  await withSystem(async (db) => {
    await db.query("delete from ai_work_schedules where org_id = $1", [org.id]);
    await db.query("delete from ai_work_jobs where org_id = $1", [org.id]);
    await db.query("delete from worker_job_runs where job_name in ('tick', 'aiWorkRecovery', 'aiWorkRunQueued')");
  });
});

afterAll(() => {
  clearWorkHandlerOverrides();
  delete process.env.WORKFORCE_SCHEDULES_ENABLED;
  delete process.env.SCHEDULER_JOBS_ONLY;
  resetEnvCache();
});

describe("scheduler queued AI work runner", () => {
  it("registers and labels the runner directly after recovery without an interval gate", () => {
    const recoveryIndex = JOBS.findIndex((job) => job.name === "aiWorkRecovery");
    expect(JOBS[recoveryIndex + 1]?.name).toBe("aiWorkRunQueued");
    expect(JOBS[recoveryIndex + 1]?.everyMinutes).toBeUndefined();
    expect(JOB_LABELS.aiWorkRunQueued).toBe("Run queued AI work");
  });

  it("runs a recovered job through only aiWorkRecovery and aiWorkRunQueued", async () => {
    installCompletingHandler();
    const created = await queueReview("Recovered review");
    await withSystem((db) => db.query(
      `update ai_work_jobs set status = 'running', stage = 'preparing', attempts = 1,
              lease_owner = 'dead-worker', lease_expires_at = now() - interval '1 minute'
        where id = $1`,
      [created.id],
    ));

    const jobs = JOBS.filter((job) => job.name === "aiWorkRecovery" || job.name === "aiWorkRunQueued");
    const ran = await runScheduledJobs(new Date(), jobs);
    expect(ran).toMatchObject({ aiWorkRecovery: 1, aiWorkRunQueued: 1 });
    const { rows } = await withSystem((db) => db.query<{ status: string; attempts: number }>(
      "select status, attempts from ai_work_jobs where id = $1",
      [created.id],
    ));
    expect(rows[0]).toEqual({ status: "completed", attempts: 2 });
  }, 30000);

  it("fires an enabled schedule again after a restart when its old queued job has gone stale", async () => {
    process.env.WORKFORCE_SCHEDULES_ENABLED = "true";
    resetEnvCache();
    const schedule = await saveSchedule(ctxFor(owner, org, "owner"), {
      capability: "proactive_review",
      cadence: "hourly",
      enabled: true,
    });
    await withSystem((db) => db.query(
      "update ai_work_schedules set next_run_at = now() - interval '1 minute' where id = $1",
      [schedule.id],
    ));
    const first = await runDueSchedules({ now: new Date() });
    expect(first.created).toBe(1);
    const stuckJobId = first.jobIds[0];
    expect(hasWorkJobController(stuckJobId)).toBe(false);

    // Model a process restart: only the durable queue and schedule remain; local overrides are gone.
    clearWorkHandlerOverrides();
    await withSystem(async (db) => {
      await db.query("update ai_work_jobs set created_at = now() - interval '31 minutes' where id = $1", [stuckJobId]);
      await db.query("update ai_work_schedules set next_run_at = now() - interval '61 minutes' where id = $1", [schedule.id]);
    });

    const next = await runDueSchedules({ now: new Date() });
    expect(next.created).toBe(1);
    expect(next.jobIds[0]).not.toBe(stuckJobId);
    const { rows } = await withSystem((db) => db.query<{ status: string; failure_code: string; failure_message: string }>(
      "select status, failure_code, failure_message from ai_work_jobs where id = $1",
      [stuckJobId],
    ));
    expect(rows[0]).toMatchObject({ status: "cancelled", failure_code: "stale_queued" });
    expect(rows[0].failure_message).toMatch(/30 minutes.*cancelled as stale/i);
  }, 30000);

  it("cancels stale queued work with a visible reason so it cannot hold a schedule", async () => {
    process.env.WORKFORCE_SCHEDULES_ENABLED = "true";
    resetEnvCache();
    const schedule = await saveSchedule(ctxFor(owner, org, "owner"), {
      capability: "proactive_review",
      cadence: "hourly",
      enabled: true,
    });
    const stale = await queueReview("Stale scheduled review");
    await withSystem(async (db) => {
      await db.query("update ai_work_jobs set created_at = now() - interval '31 minutes' where id = $1", [stale.id]);
      await db.query("update ai_work_schedules set last_job_id = $2, next_run_at = now() - interval '1 minute' where id = $1", [schedule.id, stale.id]);
    });

    expect(await runQueuedWorkWithinBudget()).toBe(0);
    const run = await runDueSchedules({ now: new Date() });
    expect(run.created).toBe(1);
    const { rows: jobRows } = await withSystem((db) => db.query<{ status: string; failure_code: string; failure_message: string }>(
      "select status, failure_code, failure_message from ai_work_jobs where id = $1",
      [stale.id],
    ));
    const { rows: events } = await withSystem((db) => db.query<{ kind: string; stage: string; message: string }>(
      "select kind, stage, message from ai_work_events where job_id = $1 order by id",
      [stale.id],
    ));
    expect(jobRows[0]).toMatchObject({ status: "cancelled", failure_code: "stale_queued" });
    expect(jobRows[0].failure_message).toMatch(/queued for over 30 minutes/i);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "notice",
      stage: "cancelled",
      message: expect.stringMatching(/30 minutes.*cancelled as stale/i),
    }));
  }, 30000);

  it("lets a stop request commit during a read-only scan and never reports that scan as completed", async () => {
    const scanStarted = deferred();
    const continueScan = deferred();
    registerWorkHandler("proactive_review", async (job) => {
      await runReadOnlyReviewJob(job, {
        capability: "proactive_review",
        allowedRoles: ["operations_manager"],
        scanningMessage: "Reading synthetic records.",
        analyzingMessage: "Checking synthetic records.",
        checks: [async (db) => {
          scanStarted.resolve();
          await continueScan.promise;
          await db.query("select 1 as checked");
          return null;
        }],
        limitations: "Synthetic cancellation test.",
        subject: "Cancellation",
      });
    });
    const created = await queueReview("Cancel during scan");
    const running = runWorkJob(created.id);
    await scanStarted.promise;

    const stopRequest = cancelWorkJob(ctxFor(owner, org, "owner"), created.id)
      .then((outcome) => ({ ok: true as const, outcome }), (error: unknown) => ({ ok: false as const, error }));
    let stopResult: Awaited<typeof stopRequest> | { ok: false; error: Error } | null = null;
    try {
      stopResult = await Promise.race([
        stopRequest,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
      ]);
    } finally {
      continueScan.resolve();
    }

    expect(stopResult).toMatchObject({ ok: true, outcome: "cancel_requested" });
    await running;
    const { rows } = await withSystem((db) => db.query<{
      status: string;
      stage: string;
      failure_code: string | null;
      result_summary: string | null;
    }>(
      "select status, stage, failure_code, result_summary from ai_work_jobs where id = $1",
      [created.id],
    ));
    expect(rows[0]).toMatchObject({ status: "cancelled", stage: "cancelled", failure_code: "cancelled", result_summary: null });
    const { rows: events } = await withSystem((db) => db.query<{ stage: string; message: string }>(
      "select stage, message from ai_work_events where job_id = $1 order by id",
      [created.id],
    ));
    expect(events).toContainEqual(expect.objectContaining({
      stage: "cancelled",
      message: "The work was stopped before it completed.",
    }));
  }, 30000);

  it("stops starting jobs when the budget has less than the minimum lease window left", async () => {
    let handlerRuns = 0;
    installCompletingHandler(() => { handlerRuns += 1; });
    const queued = await Promise.all([queueReview("Budget one"), queueReview("Budget two"), queueReview("Budget three")]);
    const clockValues = [1_000, 1_000, 31_001];
    let clockIndex = 0;
    const ran = await runQueuedWorkWithinBudget({
      budgetMs: 60_000,
      now: () => clockValues[Math.min(clockIndex++, clockValues.length - 1)],
    });
    expect(ran).toBe(1);
    expect(handlerRuns).toBe(1);

    const withoutLeaseWindow = await runQueuedWorkWithinBudget({ budgetMs: 29_999, now: () => 0 });
    expect(withoutLeaseWindow).toBe(0);
    const { rows } = await withSystem((db) => db.query<{ id: string; status: string }>(
      "select id, status from ai_work_jobs where id = any($1::uuid[]) order by created_at",
      [queued.map((job) => job.id)],
    ));
    expect(rows.filter((row) => row.status === "completed")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "queued")).toHaveLength(2);
  }, 30000);

  it("cancels a queued cancellation request in recovery without invoking its handler", async () => {
    let handlerRuns = 0;
    installCompletingHandler(() => { handlerRuns += 1; });
    const created = await queueReview("Stop before start");
    await withSystem((db) => db.query(
      "update ai_work_jobs set cancel_requested_at = now() where id = $1",
      [created.id],
    ));

    const jobs = JOBS.filter((job) => job.name === "aiWorkRecovery" || job.name === "aiWorkRunQueued");
    const ran = await runScheduledJobs(new Date(), jobs);
    expect(ran.aiWorkRecovery).toBe(1);
    expect(ran.aiWorkRunQueued).toBe(0);
    expect(handlerRuns).toBe(0);
    const { rows } = await withSystem((db) => db.query<{ status: string; attempts: number }>(
      "select status, attempts from ai_work_jobs where id = $1",
      [created.id],
    ));
    expect(rows[0]).toEqual({ status: "cancelled", attempts: 0 });
  }, 30000);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
