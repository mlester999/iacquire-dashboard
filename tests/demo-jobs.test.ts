// The two demo jobs (demoExpiry, demoRetention) through the real tick endpoint: registered once each, in the right place, on the right rhythm, run ONLY when SCHEDULER_JOBS_ONLY
// names them, do their work against real rows in a synthetic database, and nothing leaves the machine. Embedded Postgres only; every outbound switch is forced off.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const CRON = "demo-jobs-secret-0123456789abcdef0123456789";
process.env.CRON_SECRET = CRON;
process.env.SCHEDULER_ENABLED = "true";
for (const key of ["GHL_WRITES_ENABLED", "RESEND_WRITES_ENABLED", "TWILIO_WRITES_ENABLED", "META_WHATSAPP_WRITES_ENABLED", "META_SOCIAL_WRITES_ENABLED", "N8N_ACTIONS_ENABLED", "WORKFORCE_SCHEDULES_ENABLED", "WORKFORCE_TRIGGERS_ENABLED", "WORKFORCE_BRIEFINGS_ENABLED", "SCHEDULER_JOBS_ONLY", "DEMO_ENABLED", "DEMO_PUBLIC_DISABLED"]) delete process.env[key];

import { resetEnvCache } from "@/server/env";
import { POST as tick } from "@/app/api/internal/tick/route";
import { JOBS } from "@/server/ops/tick";
import { JOB_LABELS } from "@/lib/ops";
import { withSystem } from "@/server/db";
import { rows } from "./support/demo";

const DEMO_JOBS = ["demoExpiry", "demoRetention"];
const inRegistryOrder = (wanted: string[]) => JOBS.map((j) => j.name).filter((n) => wanted.includes(n));
const setOnly = (value: string | undefined) => {
  if (value === undefined) delete process.env.SCHEDULER_JOBS_ONLY;
  else process.env.SCHEDULER_JOBS_ONLY = value;
  resetEnvCache();
};
async function runTick() {
  await withSystem((db) => db.query("update worker_job_runs set last_finished_at = now() - interval '5 minutes' where job_name = 'scheduler_tick' and last_finished_at is not null"));
  const res = await tick(new Request("http://localhost/api/internal/tick", { method: "POST", headers: { authorization: `Bearer ${CRON}` } }));
  expect(res.status).toBe(200);
  return ((await res.json()) as { ran: Record<string, number | string> }).ran;
}
const heartbeatNames = async () => (await rows<{ job_name: string }>("select job_name from worker_job_runs order by job_name")).map((r) => r.job_name);
// A moment long ago, so the real clock is always past every window and period.
const LONG_AGO = "2020-01-01T00:00:00Z";

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  resetEnvCache();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    throw new Error(`network access is not allowed in this test: ${String(input)}`);
  });
});
afterEach(() => setOnly(undefined));
afterAll(() => fetchSpy.mockRestore());

let world: { ended: string; stale: string; email: string };
beforeAll(async () => {
  // A prospect whose window ended long ago and is still marked active, and someone who never confirmed their address long ago, with the email that was sent to them.
  const ended = (await rows<{ id: string }>(
    `insert into demo_prospects (name, work_email, email_normalized, business_name, industry, status, verified_at, window_ends_at, last_seen_at, created_at)
     values ('Long Ago', 'long-ago@jobs.test', 'long-ago@jobs.test', 'Old Co', 'other', 'active', $1::timestamptz, $1::timestamptz + interval '1 day', $1::timestamptz, $1::timestamptz) returning id`, [LONG_AGO],
  ))[0].id;
  const stale = (await rows<{ id: string }>(
    `insert into demo_prospects (name, work_email, email_normalized, business_name, industry, created_at)
     values ('Never Confirmed', 'never@jobs.test', 'never@jobs.test', 'Nope Co', 'other', $1::timestamptz) returning id`, [LONG_AGO],
  ))[0].id;
  await rows("insert into email_outbox (to_email, template, subject, body_text, status, created_at) values ('never@jobs.test', 'demo_link', 's', 'link', 'captured', $1::timestamptz)", [LONG_AGO]);
  world = { ended, stale, email: "never@jobs.test" };
});

const statusOf = async (id: string) => (await rows<{ status: string; erased_at: Date | null }>("select status, erased_at from demo_prospects where id = $1", [id]))[0];

describe("the demo jobs in the registry", () => {
  it("are registered once each, on their rhythms, before the dispatcher and after the signing job, with plain names for the health page", () => {
    const names = JOBS.map((j) => j.name);
    for (const n of DEMO_JOBS) expect(names.filter((x) => x === n), n).toHaveLength(1);
    expect(JOBS.find((j) => j.name === "demoExpiry")?.everyMinutes).toBe(15);
    expect(JOBS.find((j) => j.name === "demoRetention")?.everyMinutes).toBe(1440);
    expect(names.indexOf("demoExpiry")).toBeGreaterThan(names.indexOf("esignSync"));
    expect(names.indexOf("demoRetention")).toBeLessThan(names.indexOf("messagesDispatched"));
    for (const n of DEMO_JOBS) expect(JOB_LABELS[n], n).toBeTruthy();
  });
});

describe("the demo jobs through the real tick endpoint", () => {
  it("do not touch anything, or write a heartbeat, while other jobs are the ones named", async () => {
    setOnly("aiWorkRecovery, crmWorkflowRecovery");
    const ran = await runTick();
    expect(Object.keys(ran)).toEqual(inRegistryOrder(["aiWorkRecovery", "crmWorkflowRecovery"]));
    expect(Object.values(ran)).not.toContain("failed");
    expect((await statusOf(world.ended)).status).toBe("active");
    expect(await rows("select 1 from demo_prospects where id = $1", [world.stale])).toHaveLength(1);
    const beats = await heartbeatNames();
    for (const n of DEMO_JOBS) expect(beats, n).not.toContain(n);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("with only demoExpiry named: it records the old window as over and removes nobody", async () => {
    setOnly("demoExpiry");
    const ran = await runTick();
    expect(Object.keys(ran)).toEqual(["demoExpiry"]);
    expect(ran.demoExpiry).toBeGreaterThanOrEqual(1);
    expect((await statusOf(world.ended)).status).toBe("expired");
    expect(await rows("select 1 from demo_prospects where id = $1", [world.stale])).toHaveLength(1);
    const beats = await heartbeatNames();
    expect(beats).toContain("demoExpiry");
    expect(beats).not.toContain("demoRetention");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("with only demoRetention named: it removes the person who never confirmed and the old conversation, and sends nothing", async () => {
    setOnly("demoRetention");
    const ran = await runTick();
    expect(Object.keys(ran)).toEqual(["demoRetention"]);
    expect(ran.demoRetention).toBeGreaterThanOrEqual(2);
    expect(await rows("select 1 from demo_prospects where id = $1", [world.stale])).toHaveLength(0);
    expect(await rows("select 1 from email_outbox where to_email = $1", [world.email])).toHaveLength(0);
    expect((await statusOf(world.ended)).erased_at).not.toBeNull();
    expect(await rows("select name, work_email from demo_prospects where id = $1", [world.ended])).toEqual([{ name: null, work_email: null }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keep their own rhythm: a second tick at once runs neither again, and a day later both are due", async () => {
    setOnly("demoExpiry, demoRetention");
    const first = await runTick();
    expect(Object.keys(first)).toEqual(["demoExpiry", "demoRetention"]);
    const second = await runTick();
    expect(second).toEqual({ demoExpiry: "skipped", demoRetention: "skipped" });
    await withSystem((db) => db.query("update worker_job_runs set last_started_at = now() - interval '2 days', last_finished_at = now() - interval '2 days' where job_name = any($1::text[])", [DEMO_JOBS]));
    const later = await runTick();
    expect(Object.values(later)).not.toContain("skipped");
    expect(Object.values(later)).not.toContain("failed");
  });

  it("do nothing, and fail at nothing, on an installation where nobody ever asked for a demo", async () => {
    await withSystem((db) => db.query("delete from demo_prospects"));
    await withSystem((db) => db.query("update worker_job_runs set last_started_at = now() - interval '2 days', last_finished_at = now() - interval '2 days' where job_name = any($1::text[])", [DEMO_JOBS]));
    setOnly("demoExpiry, demoRetention");
    expect(await runTick()).toEqual({ demoExpiry: 0, demoRetention: 0 });
  });
});
