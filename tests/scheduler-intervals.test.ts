import { beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { JOBS, runScheduledJobs, type ScheduledJob } from "@/server/ops/tick";
import { JOB_ABANDONED_AFTER_MINUTES, JOB_RETRY_MINUTES, listJobRuns, runJob } from "@/server/ops/jobs";

/**
 * Slow-rhythm jobs (`everyMinutes`) were gated inside each job and returned 0 when not due. That 0 was recorded as a success, which
 * moved `last_success_at` forward on every tick, so each gated job ran once and then never again. These tests drive the real
 * scheduler path with a simulated clock (the runner takes `now`) and count what actually executes.
 */

const MIN = 60_000;
// 2026-03-08 is the US daylight-saving change; the span below crosses it so a wall-clock cadence would visibly drift.
const T0 = new Date("2026-03-07T00:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN);

beforeEach(async () => {
  await withSystem((db) => db.query("delete from worker_job_runs where job_name like 'sim\\_%' or job_name = 'tick'"));
});

interface SimJob extends ScheduledJob {
  runs: number[];
}

/** A job that records the simulated minute of each execution; `fail` makes it throw while true. */
function simJob(name: string, everyMinutes: number | undefined, clock: { now: number }, fail: { on: boolean } = { on: false }): SimJob {
  const runs: number[] = [];
  return {
    name,
    everyMinutes,
    runs,
    run: async () => {
      runs.push(clock.now);
      if (fail.on) throw new Error(`${name} failed`);
      return 1;
    },
  };
}

async function drive(jobs: SimJob[], clock: { now: number }, totalMinutes: number, step = 5) {
  for (clock.now = 0; clock.now < totalMinutes; clock.now += step) await runScheduledJobs(at(clock.now), jobs);
}

const gaps = (runs: number[]) => runs.slice(1).map((value, i) => value - runs[i]);

describe("slow-rhythm jobs keep running on every cadence", () => {
  it("hourly: once an hour, exactly 60 minutes apart, for two days of five-minute ticks", async () => {
    const clock = { now: 0 };
    const job = simJob("sim_hourly", 60, clock);
    await drive([job], clock, 48 * 60);
    expect(job.runs).toHaveLength(48);
    expect(new Set(gaps(job.runs))).toEqual(new Set([60]));
  });

  it("daily: once every 24 hours of elapsed time, across a daylight-saving change", async () => {
    const clock = { now: 0 };
    const job = simJob("sim_daily", 1440, clock);
    await drive([job], clock, 7 * 1440);
    expect(job.runs).toHaveLength(7);
    expect(new Set(gaps(job.runs))).toEqual(new Set([1440]));
    // An elapsed-time cadence is the same in UTC and shifts by an hour in New York when the clocks change; it is not a calendar slot.
    const newYorkHour = job.runs.map((m) => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(at(m))) % 24);
    expect(new Set(newYorkHour).size).toBe(2);
  });

  it("weekly: once every seven days", async () => {
    const clock = { now: 0 };
    const job = simJob("sim_weekly", 10_080, clock);
    await drive([job], clock, 22 * 1440, 60);
    expect(job.runs).toEqual([0, 10_080, 20_160, 30_240]);
  });

  it("every five minutes: on every five-minute tick; and an ungated job runs on every tick", async () => {
    const clock = { now: 0 };
    const frequent = simJob("sim_frequent", 5, clock);
    const always = simJob("sim_always", undefined, clock);
    await drive([frequent, always], clock, 120);
    expect(frequent.runs).toHaveLength(24);
    expect(always.runs).toHaveLength(24);
  });

  it("with one-minute ticks a 15-minute job still runs only every 15 minutes", async () => {
    const clock = { now: 0 };
    const job = simJob("sim_quarter", 15, clock);
    await drive([job], clock, 3 * 60, 1);
    expect(job.runs).toEqual([0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165]);
  });

  it("a tick that arrives late does not make the job run early or twice", async () => {
    const clock = { now: 0 };
    const job = simJob("sim_late", 60, clock);
    for (const minute of [0, 59, 61, 62, 119, 125]) { clock.now = minute; await runScheduledJobs(at(minute), [job]); }
    expect(job.runs).toEqual([0, 61, 125]);
  });

  it("two jobs on different cadences do not disturb each other", async () => {
    const clock = { now: 0 };
    const hourly = simJob("sim_a", 60, clock);
    const sixHourly = simJob("sim_b", 360, clock);
    await drive([hourly, sixHourly], clock, 24 * 60);
    expect(hourly.runs).toHaveLength(24);
    expect(sixHourly.runs).toEqual([0, 360, 720, 1080]);
  });
});

describe("what a skipped tick leaves behind", () => {
  it("records nothing: the heartbeat still describes the last real run", async () => {
    const clock = { now: 0 };
    const job = simJob("sim_quiet", 60, clock);
    await runScheduledJobs(at(0), [job]);
    const before = (await listJobRuns()).find((r) => r.jobName === "sim_quiet")!;
    for (const minute of [5, 10, 55]) { clock.now = minute; expect((await runScheduledJobs(at(minute), [job]))["sim_quiet"]).toBe("skipped"); }
    const after = (await listJobRuns()).find((r) => r.jobName === "sim_quiet")!;
    expect(after).toEqual(before);
    expect(after.runsTotal).toBe(1);
    expect(after.lastSuccessAt).toBe(at(0).toISOString());
    expect(after.lastStartedAt).toBe(at(0).toISOString());
  });

  it("reports a skipped job as skipped and a failed one as failed, and still advances the scheduler heartbeat", async () => {
    const clock = { now: 0 };
    const fail = { on: false };
    const ok = simJob("sim_ok", 60, clock);
    const flaky = simJob("sim_flaky", 60, clock, fail);
    expect(await runScheduledJobs(at(0), [ok, flaky])).toMatchObject({ sim_ok: 1, sim_flaky: 1 });
    fail.on = true;
    expect(await runScheduledJobs(at(60), [ok, flaky])).toMatchObject({ sim_ok: 1, sim_flaky: "failed" });
    expect(await runScheduledJobs(at(65), [ok, flaky])).toMatchObject({ sim_ok: "skipped", sim_flaky: "skipped" });
    const tick = (await listJobRuns()).find((r) => r.jobName === "tick")!;
    expect(tick.lastSuccessAt).toBe(at(65).toISOString());
  });
});

describe("failures", () => {
  it("a failed run is retried soon, not after a whole interval, and not on every tick", async () => {
    const clock = { now: 0 };
    const fail = { on: true };
    const job = simJob("sim_retry", 360, clock, fail);
    await drive([job], clock, 60);
    // Failed at 0, retried every JOB_RETRY_MINUTES (15), never on the ticks in between.
    expect(job.runs).toEqual([0, 15, 30, 45]);
    expect(JOB_RETRY_MINUTES).toBe(15);
    fail.on = false;
    clock.now = 60;
    await runScheduledJobs(at(60), [job]);
    expect(job.runs.at(-1)).toBe(60);
    // After the success the normal interval applies again, measured from that run.
    for (const minute of [65, 120, 359, 419]) { clock.now = minute; await runScheduledJobs(at(minute), [job]); }
    expect(job.runs.at(-1)).toBe(60);
    clock.now = 420;
    await runScheduledJobs(at(420), [job]);
    expect(job.runs.at(-1)).toBe(420);
  });

  it("a job on a five-minute rhythm is retried on the next tick after a failure", async () => {
    const clock = { now: 0 };
    const fail = { on: true };
    const job = simJob("sim_fast_retry", 5, clock, fail);
    await drive([job], clock, 15);
    expect(job.runs).toEqual([0, 5, 10]);
    expect((await listJobRuns()).find((r) => r.jobName === "sim_fast_retry")).toMatchObject({ consecutiveFailures: 3 });
  });

  it("one job failing does not stop or delay the others", async () => {
    const clock = { now: 0 };
    const broken = simJob("sim_broken", 60, clock, { on: true });
    const healthy = simJob("sim_healthy", 60, clock);
    await drive([broken, healthy], clock, 120);
    expect(healthy.runs).toEqual([0, 60]);
  });
});

describe("overlap and crashes", () => {
  it("never runs a job twice when two ticks overlap", async () => {
    let executions = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const body = async () => { executions += 1; await gate; return 1; };
    const first = runJob("sim_overlap", body, undefined, { everyMinutes: 60, now: at(0) });
    const second = runJob("sim_overlap", body, undefined, { everyMinutes: 60, now: at(0) });
    expect(await second).toMatchObject({ ok: true, skipped: true, reason: "running" });
    release();
    expect(await first).toMatchObject({ ok: true, value: 1 });
    expect(executions).toBe(1);
  });

  it("does not run again at the same instant after it finished", async () => {
    let executions = 0;
    const body = async () => { executions += 1; return 1; };
    await runJob("sim_instant", body, undefined, { everyMinutes: 60, now: at(0) });
    expect(await runJob("sim_instant", body, undefined, { everyMinutes: 60, now: at(0) })).toMatchObject({ skipped: true, reason: "not_due" });
    expect(executions).toBe(1);
  });

  it("treats a run that never finished as still running, then as dead, and recovers it without waiting a full interval", async () => {
    await withSystem((db) => db.query("insert into worker_job_runs (job_name, last_started_at, last_success_at) values ('sim_dead', $1, $2)", [at(0), at(-600)]));
    let executions = 0;
    const body = async () => { executions += 1; return 1; };
    expect(await runJob("sim_dead", body, undefined, { everyMinutes: 360, now: at(10) })).toMatchObject({ skipped: true, reason: "running" });
    expect(executions).toBe(0);
    expect(await runJob("sim_dead", body, undefined, { everyMinutes: 360, now: at(JOB_ABANDONED_AFTER_MINUTES + 1) })).toMatchObject({ ok: true, value: 1 });
    expect(executions).toBe(1);
  });

  it("a gated job that has never run is due immediately", async () => {
    let executions = 0;
    const result = await runJob("sim_first", async () => { executions += 1; return 1; }, undefined, { everyMinutes: 1440, now: at(0) });
    expect(result).toMatchObject({ ok: true, value: 1 });
    expect(executions).toBe(1);
  });
});

describe("the registered jobs", () => {
  const EXPECTED_SLOW: Record<string, number> = {
    aiWorkRecovery: 5,
    aiProactiveHeldReports: 5,
    aiProactiveBriefings: 5,
    supportAutoClose: 60,
    supportAttachmentCleanup: 60,
    fairUseChecks: 60,
    inactivityReview: 360,
    offboardingReminders: 360,
    crmWorkflowRecovery: 5,
    inboxAttention: 5,
    whatsappTemplateSync: 180,
    aqiTutorialEventRetention: 1440,
    phase2Retention: 1440,
    webChatRetention: 1440,
    socialAccountHealth: 360,
    socialMetrics: 360,
  };

  it("keeps setupEvidence on its own fleet-wide lease, not on an interval as well", () => {
    expect(JOBS.find((job) => job.name === "setupEvidence")?.everyMinutes).toBeUndefined();
  });

  it("keeps every job's name unique and only the intended jobs on a slow rhythm", () => {
    const names = JOBS.map((job) => job.name);
    expect(new Set(names).size).toBe(names.length);
    const slow = Object.fromEntries(JOBS.filter((job) => job.everyMinutes !== undefined).map((job) => [job.name, job.everyMinutes]));
    expect(slow).toEqual(EXPECTED_SLOW);
  });

  it("registers the Automation Studio plan sweep, and runs it on every tick", () => {
    const job = JOBS.find((entry) => entry.name === "studioEntitlementSweep");
    expect(job).toBeDefined();
    expect(job?.everyMinutes).toBeUndefined();
  });

  it("registers the AQi Operations jobs, and runs them on every tick", () => {
    for (const name of ["aqiOperationsBriefings", "aqiOperationsRetention"]) {
      const job = JOBS.find((entry) => entry.name === name);
      expect(job, name).toBeDefined();
      expect(job?.everyMinutes).toBeUndefined();
    }
  });

  it("runs the real job list: everything once, then only what is due, and nothing twice", async () => {
    const first = await runScheduledJobs(at(0));
    for (const name of Object.keys(EXPECTED_SLOW)) expect(first[name], name).not.toBe("skipped");
    // Same instant again: every slow job holds its slot; the always-on jobs run again.
    const again = await runScheduledJobs(at(0));
    for (const name of Object.keys(EXPECTED_SLOW)) expect(again[name], name).toBe("skipped");
    expect(again.messagesDispatched).not.toBe("skipped");
    expect(again.studioEntitlementSweep).not.toBe("skipped");
    expect(again.aqiOperationsBriefings).not.toBe("skipped");
    // Five minutes later only the five-minute jobs are due.
    const five = await runScheduledJobs(at(5));
    expect(Object.keys(EXPECTED_SLOW).filter((name) => five[name] !== "skipped").sort()).toEqual([
      "aiProactiveBriefings",
      "aiProactiveHeldReports",
      "aiWorkRecovery",
      "crmWorkflowRecovery",
      "inboxAttention",
    ]);
    // Sixty minutes later the jobs on an hour or faster are due, the longer ones are not. (A job that failed on the first pass is also
    // due: it is retried after fifteen minutes. On an empty database none is expected to fail, but the expectation does not depend on it.)
    const hour = await runScheduledJobs(at(60));
    const dueAtSixty = Object.keys(EXPECTED_SLOW).filter((name) => EXPECTED_SLOW[name] <= 60 || first[name] === "failed").sort();
    expect(Object.keys(EXPECTED_SLOW).filter((name) => hour[name] !== "skipped").sort()).toEqual(dueAtSixty);
    // Twenty-four hours later all of them are due.
    const day = await runScheduledJobs(at(1440));
    expect(Object.keys(EXPECTED_SLOW).filter((name) => day[name] === "skipped")).toEqual([]);
  }, 120_000);
});
