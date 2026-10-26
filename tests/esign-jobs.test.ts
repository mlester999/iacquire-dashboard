// The signing job (esignSync) through the real tick endpoint, against real pending work in synthetic workspaces: it must run ONLY when SCHEDULER_JOBS_ONLY names it (or the list is
// unset), and when it does its own gates must still hold: a workspace needs proposals AND signing switched on, must not be paused, suspended or archived, and a real service is
// not written to while its switch is off. Embedded Postgres only; every outbound switch is forced off for this file, and any attempt to reach the network fails the test.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const CRON = "esign-allowlist-secret-0123456789abcdef";
process.env.CRON_SECRET = CRON;
process.env.SCHEDULER_ENABLED = "true";
// Whatever the shell this runs from had exported, nothing outbound is switched on here.
for (const key of ["GHL_WRITES_ENABLED", "RESEND_WRITES_ENABLED", "TWILIO_WRITES_ENABLED", "META_WHATSAPP_WRITES_ENABLED", "META_SOCIAL_WRITES_ENABLED", "N8N_ACTIONS_ENABLED", "WORKFORCE_SCHEDULES_ENABLED", "WORKFORCE_TRIGGERS_ENABLED", "WORKFORCE_BRIEFINGS_ENABLED", "SCHEDULER_JOBS_ONLY", "PROPOSALS_PUBLIC_DISABLED", "ESIGN_WRITES_ENABLED"]) delete process.env[key];

import { resetEnvCache } from "@/server/env";
import { POST as tick } from "@/app/api/internal/tick/route";
import { JOBS } from "@/server/ops/tick";
import { JOB_LABELS } from "@/lib/ops";
import { withSystem } from "@/server/db";
import { simulatedEsign } from "@/server/esign/providers/simulated";
import { askToSign, requestRow, rows, sentForSigning, setFeature, signingOrg, type ProposalOrg } from "./support/proposals";

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

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  resetEnvCache();
  // The embedded database and this job never need the network; a call to it would be a call to a real provider.
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    throw new Error(`network access is not allowed in this test: ${String(input)}`);
  });
});
afterEach(() => setOnly(undefined));
afterAll(() => fetchSpy.mockRestore());

interface World { org: ProposalOrg; requestId: string }
const worlds = {} as Record<"on" | "off" | "paused" | "real", World>;

async function asked(prepare?: (p: ProposalOrg, requestId: string) => Promise<void>): Promise<World> {
  const org = await signingOrg();
  const sent = await sentForSigning(org);
  const { requestId } = await askToSign(org, sent.proposal.id);
  await prepare?.(org, requestId);
  return { org, requestId };
}

beforeAll(async () => {
  simulatedEsign.reset();
  worlds.on = await asked();
  worlds.off = await asked(async (p) => setFeature(p.org.id, false, "esign"));
  worlds.paused = await asked(async (p) => {
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active, reason, set_by, set_at) values ($1, 'agency', true, null, null, now())", [p.org.id]));
  });
  // A request through a real service whose write switch is off in this environment (made so with the database's guards off for this statement only).
  worlds.real = await asked(async (p, requestId) => {
    await withSystem(async (db) => {
      await db.query("set local session_replication_role = replica");
      await db.query("update esign_connections set provider = 'pandadoc', mode = 'sandbox' where org_id = $1", [p.org.id]);
      await db.query("update signature_requests set provider = 'pandadoc', mode = 'sandbox' where id = $1", [requestId]);
    });
  });
});

describe("the signing job through the real tick endpoint", () => {
  it("is registered, has a label, and runs on every tick (a request waits for a pass, so an hourly rhythm would stretch one signing request over hours)", () => {
    const job = JOBS.find((j) => j.name === "esignSync");
    expect(job).toBeDefined();
    expect(job?.everyMinutes).toBeUndefined();
    expect(JOB_LABELS.esignSync).toMatch(/signing/i);
    expect(JOBS.filter((j) => j.name === "esignSync")).toHaveLength(1);
  });

  it("does not touch pending work, or write a heartbeat, while other jobs are the ones named", async () => {
    setOnly("aiWorkRecovery, crmWorkflowRecovery");
    const ran = await runTick();
    expect(Object.keys(ran)).toEqual(inRegistryOrder(["aiWorkRecovery", "crmWorkflowRecovery"]));
    expect(Object.values(ran)).not.toContain("failed");
    for (const w of Object.values(worlds)) expect((await requestRow(w.requestId)).status, w.requestId).toBe("queued");
    expect(await heartbeatNames()).not.toContain("esignSync");
    expect(simulatedEsign.documents()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("with only esignSync named: it hands over the request of the workspace that has everything on, and leaves each of the others exactly as it was", async () => {
    setOnly("esignSync");
    const ran = await runTick();
    expect(Object.keys(ran)).toEqual(["esignSync"]);
    expect(ran.esignSync).toBeGreaterThanOrEqual(1);
    expect((await requestRow(worlds.on.requestId)).status).toBe("sent");
    // Signing switched off for the workspace: dormant.
    expect((await requestRow(worlds.off.requestId)).status).toBe("queued");
    // Paused by iAcquire: nothing is handed to anyone.
    expect((await requestRow(worlds.paused.requestId)).status).toBe("queued");
    // A real service, with its write switch off: untouched, and nothing was sent to it.
    expect(await requestRow(worlds.real.requestId)).toMatchObject({ status: "queued", attempt: 0, provider_document_id: null });
    expect(simulatedEsign.documents()).toHaveLength(1);
    const beats = await heartbeatNames();
    expect(beats).toContain("esignSync");
    expect(beats).not.toContain("proposalExpiry");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("picks the other workspaces up once their own gates open, and still never reaches a real service while its switch is off", async () => {
    await setFeature(worlds.off.org.org.id, true, "esign");
    await withSystem((db) => db.query("update automation_pauses set active = false where org_id = $1", [worlds.paused.org.org.id]));
    setOnly("esignSync");
    const ran = await runTick();
    expect(Object.keys(ran)).toEqual(["esignSync"]);
    expect(Object.values(ran)).not.toContain("failed");
    expect((await requestRow(worlds.off.requestId)).status).toBe("sent");
    expect((await requestRow(worlds.paused.requestId)).status).toBe("sent");
    expect(await requestRow(worlds.real.requestId)).toMatchObject({ status: "queued", provider_document_id: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("names a job that does not exist as an error that runs nothing, so a typo cannot start something else", async () => {
    setOnly("esignSync,esignSink");
    await withSystem((db) => db.query("update worker_job_runs set last_finished_at = now() - interval '5 minutes' where job_name = 'scheduler_tick' and last_finished_at is not null"));
    const res = await tick(new Request("http://localhost/api/internal/tick", { method: "POST", headers: { authorization: `Bearer ${CRON}` } }));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
