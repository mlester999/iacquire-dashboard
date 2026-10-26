// The two proposal jobs (proposalExpiry, proposalHousekeeping) through the real tick endpoint, against real pending work in synthetic workspaces: they must run ONLY when
// SCHEDULER_JOBS_ONLY names them, and when it does their own gates must still hold (a workspace has to have proposals switched on). Embedded Postgres only; every outbound
// switch is forced off for this file, and any attempt to reach the network fails the test.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const CRON = "proposals-allowlist-secret-0123456789abcdef";
process.env.CRON_SECRET = CRON;
process.env.SCHEDULER_ENABLED = "true";
// Whatever the shell this runs from had exported, nothing outbound is switched on here.
for (const key of ["GHL_WRITES_ENABLED", "RESEND_WRITES_ENABLED", "TWILIO_WRITES_ENABLED", "META_WHATSAPP_WRITES_ENABLED", "META_SOCIAL_WRITES_ENABLED", "N8N_ACTIONS_ENABLED", "WORKFORCE_SCHEDULES_ENABLED", "WORKFORCE_TRIGGERS_ENABLED", "WORKFORCE_BRIEFINGS_ENABLED", "SCHEDULER_JOBS_ONLY", "PROPOSALS_PUBLIC_DISABLED"]) delete process.env[key];

import { resetEnvCache } from "@/server/env";
import { POST as tick } from "@/app/api/internal/tick/route";
import { JOBS } from "@/server/ops/tick";
import { withSystem } from "@/server/db";
import { proposalOrg, rows, sentWithLink, setFeature } from "./support/proposals";

const JOBS_OF_PROPOSALS = ["proposalExpiry", "proposalHousekeeping"];
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
const status = async (id: string) => (await rows<{ status: string }>("select status from proposals where id = $1", [id]))[0].status;

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  resetEnvCache();
  // The embedded database and these jobs never need the network; a call to it would be a call to a real provider.
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    throw new Error(`network access is not allowed in this test: ${String(input)}`);
  });
});
afterEach(() => setOnly(undefined));
afterAll(() => fetchSpy.mockRestore());

// A proposal sent in January 2020 and valid until the end of that month, whatever today is: the jobs read the real clock.
const SENT_2020 = new Date("2020-01-02T12:00:00Z");
let world: { on: { orgId: string; proposalId: string }; off: { orgId: string; proposalId: string }; codeEmail: string };

beforeAll(async () => {
  const on = await proposalOrg();
  const off = await proposalOrg();
  const a = await sentWithLink(on, { validUntil: "2020-01-31" }, { now: SENT_2020 });
  const b = await sentWithLink(off, { validUntil: "2020-01-31" }, { now: SENT_2020 });
  await setFeature(off.org.id, false);
  // A code email from long ago, which the clean-up removes.
  await withSystem((db) => db.query("insert into email_outbox (to_email, template, subject, body_text, status, created_at) values ('old@example.test', 'proposal_code', 's', 'Code: 123456', 'captured', now() - interval '3 hours')"));
  world = { on: { orgId: on.org.id, proposalId: a.proposal.id }, off: { orgId: off.org.id, proposalId: b.proposal.id }, codeEmail: "old@example.test" };
});

describe("the proposal jobs through the real tick endpoint", () => {
  it("are registered", () => {
    for (const n of JOBS_OF_PROPOSALS) expect(JOBS.map((j) => j.name), n).toContain(n);
  });

  it("do not touch pending work, or write a heartbeat, while other jobs are the ones named", async () => {
    setOnly("aiWorkRecovery, crmWorkflowRecovery");
    const ran = await runTick();
    expect(Object.keys(ran)).toEqual(inRegistryOrder(["aiWorkRecovery", "crmWorkflowRecovery"]));
    expect(Object.values(ran)).not.toContain("failed");
    expect(await status(world.on.proposalId)).toBe("sent");
    expect(await status(world.off.proposalId)).toBe("sent");
    expect((await rows("select 1 from email_outbox where to_email = $1", [world.codeEmail])).length).toBe(1);
    const beats = await heartbeatNames();
    for (const n of JOBS_OF_PROPOSALS) expect(beats, n).not.toContain(n);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("with only proposalExpiry named: it closes the overdue proposal of a workspace that has proposals on, leaves the switched-off one, and the clean-up still waits", async () => {
    setOnly("proposalExpiry");
    const ran = await runTick();
    expect(Object.keys(ran)).toEqual(["proposalExpiry"]);
    expect(ran.proposalExpiry).toBeGreaterThanOrEqual(1);
    expect(await status(world.on.proposalId)).toBe("expired");
    expect(await status(world.off.proposalId)).toBe("sent"); // dormant: nothing changes while proposals are switched off
    expect((await rows("select 1 from email_outbox where to_email = $1", [world.codeEmail])).length).toBe(1);
    const beats = await heartbeatNames();
    expect(beats).toContain("proposalExpiry");
    expect(beats).not.toContain("proposalHousekeeping");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("with only proposalHousekeeping named: it clears the old code email and does not close anything", async () => {
    setOnly("proposalHousekeeping");
    const ran = await runTick();
    expect(Object.keys(ran)).toEqual(["proposalHousekeeping"]);
    expect(ran.proposalHousekeeping).toBeGreaterThanOrEqual(1);
    expect((await rows("select 1 from email_outbox where to_email = $1", [world.codeEmail])).length).toBe(0);
    expect(await status(world.off.proposalId)).toBe("sent");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("with the workspace switched on, the same job picks the other proposal up and nothing leaves the machine", async () => {
    await setFeature(world.off.orgId, true);
    // The jobs keep their own rhythm (hourly and daily), so the earlier runs are made to look old.
    await withSystem((db) => db.query("update worker_job_runs set last_started_at = now() - interval '2 days', last_finished_at = now() - interval '2 days' where job_name = any($1::text[])", [JOBS_OF_PROPOSALS]));
    setOnly("proposalExpiry, proposalHousekeeping");
    const ran = await runTick();
    expect(Object.keys(ran)).toEqual(["proposalExpiry", "proposalHousekeeping"]);
    expect(Object.values(ran)).not.toContain("failed");
    expect(await status(world.off.proposalId)).toBe("expired");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
