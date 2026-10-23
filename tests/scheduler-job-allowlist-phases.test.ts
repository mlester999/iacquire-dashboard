// The jobs added by Phases 2 to 4 (leadScoreReassessment, missedCallRecovery, phase2Retention, webChatRetention, socialPublisher, socialAccountHealth, socialMetrics,
// socialCleanup) through the real tick endpoint, against real pending work in synthetic workspaces: they must run ONLY when SCHEDULER_JOBS_ONLY names them, and when it
// does name them their own gates must still hold (a workspace's missed-call policy, the provider write switches, the social write switch). Embedded Postgres only; every
// outbound switch is forced off for this file, and any attempt to reach the network fails the test.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const CRON = "allowlist-phases-secret-0123456789abcdef";
process.env.CRON_SECRET = CRON;
process.env.SCHEDULER_ENABLED = "true";
// Whatever the shell this runs from had exported, nothing outbound is switched on here.
for (const key of ["GHL_WRITES_ENABLED", "RESEND_WRITES_ENABLED", "TWILIO_WRITES_ENABLED", "META_WHATSAPP_WRITES_ENABLED", "META_SOCIAL_WRITES_ENABLED", "N8N_ACTIONS_ENABLED", "WORKFORCE_SCHEDULES_ENABLED", "WORKFORCE_TRIGGERS_ENABLED", "WORKFORCE_BRIEFINGS_ENABLED", "SCHEDULER_JOBS_ONLY"]) delete process.env[key];

import { env, resetEnvCache } from "@/server/env";
import { POST as tick } from "@/app/api/internal/tick/route";
import { JOBS } from "@/server/ops/tick";
import { withSystem } from "@/server/db";
import { createContact } from "@/server/crm/contacts";
import { requestReassessment } from "@/server/lead-scoring/queue";
import { schedulePost } from "@/server/social/posts";
import { approvedPost, connect, rows as socialRows, socialOrg } from "./support/social";
import { crmOrg } from "./support/crm";
import { callerNumber, count, messagesFor, missedCallFrom, recoveryWorkspace, rows } from "./support/missed-calls";

const PHASE_2_TO_4 = ["leadScoreReassessment", "missedCallRecovery", "phase2Retention", "webChatRetention", "socialPublisher", "socialAccountHealth", "socialMetrics", "socialCleanup"];
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

const hour = 3_600_000;
interface World {
  manual: { orgId: string; contactId: string };
  off: { orgId: string; contactId: string };
  auto: { orgId: string; contactId: string };
  scoring: { orgId: string; contactId: string };
  socialOrgId: string;
  simulatedJob: string;
  realJob: string;
  realAccount: string;
}
let world: World;

beforeAll(async () => {
  // Missed-call recovery: a manual-mode workspace (the team's part only), one whose policy is off, and one on automatic texts (activated, consent given).
  const manual = await recoveryWorkspace({ mode: "manual" });
  const manualCase = await missedCallFrom(manual, { at: new Date(Date.now() - hour) });
  const off = await recoveryWorkspace({ mode: "manual", policy: { enabled: false } });
  const offCase = await missedCallFrom(off, { at: new Date(Date.now() - hour) });
  const auto = await recoveryWorkspace({ mode: "automatic" });
  const autoCase = await missedCallFrom(auto, { at: new Date(Date.now() - hour) });

  // Lead scoring: one contact asked to be assessed an hour ago.
  const scoring = await crmOrg();
  const lead = await createContact(scoring.actor("owner"), { displayName: "Pat Rivera", phone: callerNumber() });
  await withSystem((db) => requestReassessment(db, scoring.org.id, lead.id, "test", { now: new Date(Date.now() - hour), debounceMinutes: 0 }));

  // Social media: one post for a simulated account and one for an account that is made a real (Meta) one afterwards, both due now.
  const s = await socialOrg();
  const sim = await connect(s, "facebook", "Simulated Page");
  const real = await connect(s, "facebook", "Real Page");
  const simPost = await approvedPost(s, sim.id);
  const realPost = await approvedPost(s, real.id);
  await schedulePost(s.manager, simPost.id, { asap: true });
  await schedulePost(s.manager, realPost.id, { asap: true });
  await withSystem((db) => db.query("update social_accounts set adapter = 'meta' where id = $1", [real.id]));
  const jobFor = async (postId: string) => (await socialRows<{ id: string }>("select id from social_publish_jobs where post_id = $1", [postId]))[0].id;

  world = {
    manual: { orgId: manual.w.org.id, contactId: manualCase.contact.id },
    off: { orgId: off.w.org.id, contactId: offCase.contact.id },
    auto: { orgId: auto.w.org.id, contactId: autoCase.contact.id },
    scoring: { orgId: scoring.org.id, contactId: lead.id },
    socialOrgId: s.m.org.id,
    simulatedJob: await jobFor(simPost.id),
    realJob: await jobFor(realPost.id),
    realAccount: real.id,
  };
});

const pending = async () => ({
  cases: await rows("select id, state, attempts, process_attempts, lease_owner, next_action_at, version from missed_call_cases order by id"),
  actions: await count("select count(*)::text as n from missed_call_actions"),
  outbound: await rows("select id, status, blocked_reason from conversation_messages where direction = 'outbound' order by id"),
  scoringQueue: await rows("select contact_id, attempts, lease_owner, generation from lead_score_queue order by contact_id"),
  assessments: await count("select count(*)::text as n from lead_score_assessments"),
  publishJobs: await rows("select id, status, attempt, claimed_by from social_publish_jobs order by id"),
});
const heartbeatNames = async () => (await rows<{ job_name: string }>("select job_name from worker_job_runs order by job_name")).map((r) => r.job_name);

describe("the Phase 2 to 4 jobs through the real tick endpoint", () => {
  it("starts with every outbound switch off and all eight jobs registered", () => {
    const config = env();
    expect([config.GHL_WRITES_ENABLED, config.RESEND_WRITES_ENABLED, config.TWILIO_WRITES_ENABLED, config.META_WHATSAPP_WRITES_ENABLED, config.META_SOCIAL_WRITES_ENABLED, config.N8N_ACTIONS_ENABLED]).toEqual([false, false, false, false, false, false]);
    expect(config.SCHEDULER_ENABLED).toBe(true);
    for (const n of PHASE_2_TO_4) expect(JOBS.map((j) => j.name), n).toContain(n);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not touch their pending work, or write a heartbeat for them, while other jobs are the ones named", async () => {
    const before = await pending();
    expect(before.cases).toHaveLength(3); // the work is really there ...
    expect(before.scoringQueue).toHaveLength(1);
    expect(before.publishJobs.map((j) => j.status)).toEqual(["queued", "queued"]);
    setOnly("aiWorkRecovery, crmWorkflowRecovery, inboxAttention, studioEntitlementSweep");
    const ran = await runTick();
    expect(Object.keys(ran)).toEqual(inRegistryOrder(["aiWorkRecovery", "crmWorkflowRecovery", "inboxAttention", "studioEntitlementSweep"]));
    expect(Object.values(ran)).not.toContain("failed");
    // ... and nothing of it moved, and none of the eight (nor missedCallSweep, which runs inside missedCallRecovery) left a heartbeat.
    expect(await pending()).toEqual(before);
    const beats = await heartbeatNames();
    for (const n of [...PHASE_2_TO_4, "missedCallSweep", "messagesDispatched"]) expect(beats, n).not.toContain(n);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("with only socialPublisher named: a simulated account's post is handled in-process, and a real account's job waits while META_SOCIAL_WRITES_ENABLED is off", async () => {
    setOnly("socialPublisher");
    const ran = await runTick();
    expect(Object.keys(ran)).toEqual(["socialPublisher"]);
    expect(ran.socialPublisher).toBeGreaterThanOrEqual(1);
    const jobs = await socialRows<{ id: string; status: string; attempt: number }>("select id, status, attempt from social_publish_jobs where org_id = $1", [world.socialOrgId]);
    expect(jobs.find((j) => j.id === world.simulatedJob)?.status).toBe("succeeded");
    expect(jobs.find((j) => j.id === world.realJob)).toMatchObject({ status: "queued", attempt: 0 }); // not even picked up
    expect(fetchSpy).not.toHaveBeenCalled();
    // Nothing else was started by naming it.
    expect((await heartbeatNames()).filter((n) => PHASE_2_TO_4.includes(n))).toEqual(["socialPublisher"]);
    // The real account is set aside, so the account-health and metrics jobs below find only simulated accounts (those two read from the platform for real ones).
    await withSystem((db) => db.query("update social_accounts set status = 'disconnected' where id = $1", [world.realAccount]));
  });

  it("with exactly the eight named: those eight run and nothing else, each under its own gate, and nothing leaves the machine", async () => {
    setOnly(PHASE_2_TO_4.slice().reverse().join(","));
    const ran = await runTick();
    expect(Object.keys(ran)).toEqual(inRegistryOrder(PHASE_2_TO_4));
    expect(Object.values(ran), JSON.stringify(ran)).not.toContain("failed");

    // Lead scoring ran (rules only: no model was asked, no network): the queued contact was assessed and left the queue.
    expect(ran.leadScoreReassessment).toBeGreaterThanOrEqual(1);
    expect(await count("select count(*)::text as n from lead_score_queue where contact_id = $1", [world.scoring.contactId])).toBe(0);
    expect(await count("select count(*)::text as n from lead_score_assessments where contact_id = $1 and is_current", [world.scoring.contactId])).toBe(1);

    // Missed-call recovery ran for all three workspaces, each under its own policy.
    expect(ran.missedCallRecovery).toBeGreaterThanOrEqual(3);
    const kinds = async (orgId: string) => (await rows<{ kind: string }>("select kind from missed_call_actions where org_id = $1 order by kind", [orgId])).map((r) => r.kind);
    expect(await kinds(world.manual.orgId)).toEqual(["assign", "notify", "task"]); // manual: the team's part only
    expect(await kinds(world.off.orgId)).toEqual([]); // policy off: cases are watched, nothing is done
    expect(await messagesFor(world.manual.contactId)).toEqual([]);
    expect(await messagesFor(world.off.contactId)).toEqual([]);
    // Automatic and activated: the text is queued through the ordinary send rules, and with the dispatcher not named it stays queued (not sent, not blocked).
    const queued = await messagesFor(world.auto.contactId);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ status: "queued", blocked_reason: null, author_kind: "system" });

    // The retention jobs ran too (phase2Retention, webChatRetention) and removed nothing that is still inside its retention period.
    expect(await count("select count(*)::text as n from missed_call_cases")).toBe(3);
    // The simulated post was already out; the real account's job never moved.
    expect((await socialRows<{ status: string; attempt: number }>("select status, attempt from social_publish_jobs where id = $1", [world.realJob]))[0]).toEqual({ status: "queued", attempt: 0 });

    // Exactly these heartbeats exist: the eight, missedCallRecovery's own sweep, the four jobs the first test named, and the tick itself. No dispatcher, no campaigns, no reminders.
    const beats = (await heartbeatNames()).filter((n) => n !== "scheduler_tick" && n !== "tick");
    expect(beats.sort()).toEqual([...PHASE_2_TO_4, "missedCallSweep", "aiWorkRecovery", "crmWorkflowRecovery", "inboxAttention", "studioEntitlementSweep"].sort());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the provider write switch still holds once the dispatcher is named: the queued recovery text is blocked, not sent, and no request is made", async () => {
    expect(env().TWILIO_WRITES_ENABLED).toBe(false);
    setOnly("messagesDispatched");
    const ran = await runTick();
    expect(Object.keys(ran)).toEqual(["messagesDispatched"]);
    const after = await messagesFor(world.auto.contactId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ status: "blocked", blocked_reason: "provider_not_enabled" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("leaves the other workspaces' work alone: the policy-off and manual workspaces got no text from any pass", async () => {
    expect(await messagesFor(world.manual.contactId)).toEqual([]);
    expect(await messagesFor(world.off.contactId)).toEqual([]);
    expect(await count("select count(*)::text as n from conversation_messages where direction = 'outbound'")).toBe(1);
  });
});
