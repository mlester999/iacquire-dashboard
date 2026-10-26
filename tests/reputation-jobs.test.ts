// The two internal reputation jobs: the one-time reminder about low feedback nobody acknowledged (feedbackSla) and the daily count of finished appointments with no recorded
// outcome (appointmentOutcomeNudge). Both only tell the team something; neither writes to a customer or marks anything attended. Run through the real tick endpoint for the
// gating, and directly for the rules. Synthetic workspaces on embedded Postgres; every outbound switch is off and a network call fails the test.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const CRON = "reputation-jobs-secret-0123456789abcdef";
process.env.CRON_SECRET = CRON;
process.env.SCHEDULER_ENABLED = "true";
for (const key of ["GHL_WRITES_ENABLED", "RESEND_WRITES_ENABLED", "TWILIO_WRITES_ENABLED", "META_WHATSAPP_WRITES_ENABLED", "META_SOCIAL_WRITES_ENABLED", "N8N_ACTIONS_ENABLED", "SCHEDULER_JOBS_ONLY"]) delete process.env[key];

import { resetEnvCache } from "@/server/env";
import { POST as tick } from "@/app/api/internal/tick/route";
import { JOBS } from "@/server/ops/tick";
import { withSystem } from "@/server/db";
import { setFeedbackFollowUp } from "@/server/crm/reviews";
import { setTaskStatus } from "@/server/crm/tasks";
import { saveReputationSettings } from "@/server/reputation/settings";
import { OUTCOME_GRACE_HOURS, OUTCOME_LOOKBACK_DAYS, runFeedbackSla, runOutcomeNudge, SLA_LOOKBACK_DAYS } from "@/server/reputation/jobs";
import { all, count, giveFeedback, one, reputationShop, shopCustomer } from "./support/reputation";

const hours = (h: number) => new Date(Date.now() - h * 3_600_000);
const ago = (id: string, h: number) => withSystem((db) => db.query("update customer_feedback set received_at = $2 where id = $1", [id, hours(h)]));
const remindersFor = (feedbackId: string) => all<{ user_id: string; title: string; body: string; link: string; severity: string }>(
  "select user_id, title, body, link, severity from notifications where dedupe_key = $1 order by user_id", [`feedback-sla:${feedbackId}`]);
const reminderCount = async (orgId: string) => count("select count(*)::text as n from notifications where org_id = $1 and kind = 'feedback_follow_up_overdue'", [orgId]);

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  resetEnvCache();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    throw new Error(`network access is not allowed in this test: ${String(input)}`);
  });
});
afterEach(() => {
  delete process.env.SCHEDULER_JOBS_ONLY;
  resetEnvCache();
});
afterAll(() => fetchSpy.mockRestore());

describe("feedbackSla: the one reminder about low feedback nobody acknowledged", () => {
  it("tells the owner, the managers and the task's assignee once, after the workspace's time, without repeating what the customer wrote", async () => {
    const s = await reputationShop("Reminder Shop");
    const contactId = await shopCustomer(s, { firstName: "Lena", ownerId: s.m.people.sales.id });
    const g = await giveFeedback(s, contactId, { rating: "1", comment: "The wait was far too long." });
    const id = g.result.feedbackId!;

    // Five hours in: not yet (24 hours is the standard).
    await ago(id, 5);
    expect(await runFeedbackSla()).toBe(0);
    expect(await remindersFor(id)).toEqual([]);

    await ago(id, 30);
    expect(await runFeedbackSla()).toBeGreaterThanOrEqual(1);
    const notes = await remindersFor(id);
    expect(notes.map((n) => n.user_id).sort()).toEqual([s.m.people.owner.id, s.m.people.manager.id, s.m.people.sales.id].sort());
    for (const n of notes) {
      expect(n).toMatchObject({ severity: "warning", title: "Low feedback is waiting for a follow-up", link: "/crm/reviews?tab=feedback" });
      expect(n.body).toMatch(/Lena .* gave low private feedback about 30 hours ago and nobody has acknowledged it yet\./);
      expect(`${n.title} ${n.body}`).not.toMatch(/wait was far|too long/i);
    }
    expect(await one("select sla_notified_at is not null as done from customer_feedback where id = $1", [id])).toEqual({ done: true });
    expect(await count("select count(*)::text as n from audit_logs where org_id = $1 and action = 'reputation.sla_reminder_sent' and target_id = $2", [s.m.org.id, id])).toBe(1);

    // Once only: another run, a later run, and a run after the item is set back to new all stay quiet.
    expect(await runFeedbackSla()).toBe(0);
    await ago(id, 60);
    expect(await runFeedbackSla()).toBe(0);
    await setFeedbackFollowUp(s.owner, id, "new");
    expect(await runFeedbackSla()).toBe(0);
    expect(await remindersFor(id)).toHaveLength(3);
  });

  it("follows the workspace's own time, and stays quiet when the workspace switched the reminder off", async () => {
    const s = await reputationShop("Four Hour Shop");
    await saveReputationSettings(s.owner, { acknowledgeWithinHours: 4 }, 0);
    const g = await giveFeedback(s, await shopCustomer(s), { rating: "1" });
    await ago(g.result.feedbackId!, 3);
    await runFeedbackSla();
    expect(await reminderCount(s.m.org.id)).toBe(0);
    await ago(g.result.feedbackId!, 5);
    await runFeedbackSla();
    expect(await reminderCount(s.m.org.id)).toBeGreaterThan(0);

    const quiet = await reputationShop("Quiet Shop");
    await saveReputationSettings(quiet.owner, { slaRemindersEnabled: false }, 0);
    const q = await giveFeedback(quiet, await shopCustomer(quiet), { rating: "1" });
    await ago(q.result.feedbackId!, 50);
    await runFeedbackSla();
    expect(await reminderCount(quiet.m.org.id)).toBe(0);
    expect((await one<{ sla_notified_at: Date | null }>("select sla_notified_at from customer_feedback where id = $1", [q.result.feedbackId])).sla_notified_at).toBeNull();
  });

  it("does not remind about feedback that was acknowledged, resolved, followed up by finishing its task, taken in the inbox, old, not low, or in a workspace that is not active", async () => {
    const s = await reputationShop("Skipped Shop");
    const make = async (rating: number, opts: { ownerId?: string } = {}) => {
      const g = await giveFeedback(s, await shopCustomer(s, { ownerId: opts.ownerId ?? s.m.people.sales.id }), { rating });
      await ago(g.result.feedbackId!, 40);
      return g;
    };
    const acknowledged = await make(1);
    await setFeedbackFollowUp(s.manager, acknowledged.result.feedbackId!, "acknowledged");
    const resolved = await make(1);
    await setFeedbackFollowUp(s.manager, resolved.result.feedbackId!, "resolved");
    const taskDone = await make(1);
    const taskId = (await one<{ escalated_task_id: string }>("select escalated_task_id from customer_feedback where id = $1", [taskDone.result.feedbackId])).escalated_task_id;
    await setTaskStatus(s.sales, taskId, "done");
    const taken = await make(1);
    const esc = await one<{ escalation_id: string }>("select escalation_id from customer_feedback where id = $1", [taken.result.feedbackId]);
    await withSystem((db) => db.query("update human_escalations set status = 'claimed', claimed_by = $2, claimed_at = now() where id = $1", [esc.escalation_id, s.m.people.support.id]));
    const old = await make(1);
    await ago(old.result.feedbackId!, (SLA_LOOKBACK_DAYS + 2) * 24);
    const fine = await make(4);
    const waiting = await make(1);

    await runFeedbackSla();
    for (const [name, x] of Object.entries({ acknowledged, resolved, taskDone, taken, old, fine })) expect(await remindersFor(x.result.feedbackId!), name).toEqual([]);
    expect((await remindersFor(waiting.result.feedbackId!)).length).toBeGreaterThan(0);

    // A workspace that is not active is left alone, then reminded once it is.
    const sleepy = await reputationShop("Suspended Shop");
    const z = await giveFeedback(sleepy, await shopCustomer(sleepy), { rating: "1" });
    await ago(z.result.feedbackId!, 40);
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [sleepy.m.org.id]));
    await runFeedbackSla();
    expect(await reminderCount(sleepy.m.org.id)).toBe(0);
    await withSystem((db) => db.query("update organizations set status = 'active' where id = $1", [sleepy.m.org.id]));
    await runFeedbackSla();
    expect(await reminderCount(sleepy.m.org.id)).toBeGreaterThan(0);
  });

  it("never reaches another workspace's people, and two runs at once announce an item only once", async () => {
    const a = await reputationShop("Race Shop A");
    const b = await reputationShop("Race Shop B");
    const g = await giveFeedback(a, await shopCustomer(a), { rating: "1" });
    await ago(g.result.feedbackId!, 40);
    const [r1, r2] = await Promise.all([runFeedbackSla(), runFeedbackSla()]);
    expect(r1 + r2).toBeGreaterThanOrEqual(1);
    expect(await remindersFor(g.result.feedbackId!)).toHaveLength(2);
    expect(await reminderCount(b.m.org.id)).toBe(0);
    const people = (await remindersFor(g.result.feedbackId!)).map((n) => n.user_id);
    expect(people).not.toContain(b.m.people.owner.id);
    expect(await count("select count(*)::text as n from customer_feedback where id = $1 and sla_notified_at is not null", [g.result.feedbackId])).toBe(1);
  });

  it("works through a bounded batch", async () => {
    const s = await reputationShop("Batch Shop");
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const g = await giveFeedback(s, await shopCustomer(s), { rating: "1" });
      await ago(g.result.feedbackId!, 40 + i);
      ids.push(g.result.feedbackId!);
    }
    expect(await runFeedbackSla({ limit: 2 })).toBeGreaterThanOrEqual(2);
    const done = await count("select count(*)::text as n from customer_feedback where org_id = $1 and sla_notified_at is not null", [s.m.org.id]);
    expect(done).toBeLessThanOrEqual(2);
    await runFeedbackSla();
    expect(await count("select count(*)::text as n from customer_feedback where org_id = $1 and sla_notified_at is not null", [s.m.org.id])).toBe(3);
  });
});

describe("appointmentOutcomeNudge: a daily count of finished appointments nobody has marked", () => {
  const appointment = (orgId: string, status: string, endHoursAgo: number, n: number) => withSystem((db) => db.query(
    `insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, status, start_at, end_at) values ($1, $2, 'cal-1', $3, $4, $5)`,
    [orgId, `nudge-${n}-${Math.random().toString(36).slice(2)}`, status, hours(endHoursAgo + 1), hours(endHoursAgo)],
  ));
  const noticesFor = (orgId: string) => all<{ user_id: string; title: string; body: string; link: string; kind: string; severity: string }>(
    "select user_id, title, body, link, kind, severity from notifications where org_id = $1 and dedupe_key like 'outcome-nudge:%' order by user_id", [orgId]);

  it("is off until the workspace switches it on, and then counts only appointments that ended and were never marked", async () => {
    const s = await reputationShop("Nudge Shop");
    await appointment(s.m.org.id, "confirmed", OUTCOME_GRACE_HOURS + 1, 1);
    await appointment(s.m.org.id, "new", OUTCOME_GRACE_HOURS + 30, 2);
    await appointment(s.m.org.id, "confirmed", 1, 3); // ended an hour ago: still inside the grace time
    await appointment(s.m.org.id, "showed", 5, 4);
    await appointment(s.m.org.id, "noshow", 5, 5);
    await appointment(s.m.org.id, "cancelled", 5, 6);
    await appointment(s.m.org.id, "confirmed", (OUTCOME_LOOKBACK_DAYS + 2) * 24, 7); // too old to nag about
    await appointment(s.m.org.id, "confirmed", -30, 8); // in the future
    const statusesBefore = await all("select ghl_appointment_id, status from appointment_refs where org_id = $1 order by ghl_appointment_id", [s.m.org.id]);

    expect(await runOutcomeNudge()).toBeGreaterThanOrEqual(0);
    expect(await noticesFor(s.m.org.id)).toEqual([]); // switched off: nothing

    await saveReputationSettings(s.owner, { outcomeNudgesEnabled: true }, 0);
    expect(await runOutcomeNudge()).toBeGreaterThanOrEqual(1);
    const notes = await noticesFor(s.m.org.id);
    expect(notes.map((n) => n.user_id).sort()).toEqual([s.m.people.owner.id, s.m.people.manager.id].sort());
    for (const n of notes) {
      expect(n).toMatchObject({ kind: "booking_needs_action", severity: "info", title: "Record how 2 appointments went", link: "/appointments" });
      expect(n.body).toMatch(/Follow-ups after a visit only start once you do/);
    }
    // Same day, same notice: no second one. Nothing was marked attended (or anything else) for anyone.
    await runOutcomeNudge();
    expect(await noticesFor(s.m.org.id)).toHaveLength(2);
    expect(await all("select ghl_appointment_id, status from appointment_refs where org_id = $1 order by ghl_appointment_id", [s.m.org.id])).toEqual(statusesBefore);
    expect(await count("select count(*)::text as n from crm_events where org_id = $1 and type = 'appointment.showed'", [s.m.org.id])).toBe(0);
    expect(await count("select count(*)::text as n from conversation_messages where org_id = $1 and direction = 'outbound' and author_kind <> 'system'", [s.m.org.id])).toBe(0);

    // The next day is a new notice (the date is part of its key); by then a third appointment (the one that ended an hour ago) has also passed its grace time.
    const tomorrow = new Date(Date.now() + 24 * 3_600_000);
    await runOutcomeNudge({ now: tomorrow });
    const later = await noticesFor(s.m.org.id);
    expect(later).toHaveLength(4);
    expect(later.filter((n) => n.title === "Record how 3 appointments went")).toHaveLength(2);
  });

  it("says nothing to a workspace with nothing waiting, and never to another workspace", async () => {
    const withWork = await reputationShop("Nudge Work Shop");
    const empty = await reputationShop("Nudge Empty Shop");
    const off = await reputationShop("Nudge Off Shop");
    await saveReputationSettings(withWork.owner, { outcomeNudgesEnabled: true }, 0);
    await saveReputationSettings(empty.owner, { outcomeNudgesEnabled: true }, 0);
    await appointment(withWork.m.org.id, "confirmed", 6, 21);
    await appointment(off.m.org.id, "confirmed", 6, 22);
    await runOutcomeNudge();
    expect((await noticesFor(withWork.m.org.id)).map((n) => n.title)).toEqual(["Record how 1 appointment went", "Record how 1 appointment went"]);
    expect(await noticesFor(empty.m.org.id)).toEqual([]);
    expect(await noticesFor(off.m.org.id)).toEqual([]);
  });
});

describe("through the tick endpoint", () => {
  const releaseLease = () => withSystem((db) => db.query("update worker_job_runs set last_finished_at = now() - interval '5 minutes' where job_name = 'scheduler_tick' and last_finished_at is not null"));
  async function runTick() {
    await releaseLease();
    const res = await tick(new Request("http://localhost/api/internal/tick", { method: "POST", headers: { authorization: `Bearer ${CRON}` } }));
    expect(res.status).toBe(200);
    return ((await res.json()) as { ran: Record<string, number | string> }).ran;
  }
  const setOnly = (value: string) => {
    process.env.SCHEDULER_JOBS_ONLY = value;
    resetEnvCache();
  };
  const heartbeats = async () => (await all<{ job_name: string }>("select job_name from worker_job_runs order by job_name")).map((r) => r.job_name);

  it("registers both jobs with their rhythm, and every job name stays a plain name the allowlist can select", () => {
    expect(JOBS.find((j) => j.name === "feedbackSla")).toMatchObject({ everyMinutes: 15 });
    expect(JOBS.find((j) => j.name === "appointmentOutcomeNudge")).toMatchObject({ everyMinutes: 1440 });
    for (const n of ["feedbackSla", "appointmentOutcomeNudge"]) expect(n).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
  });

  it("runs them only when they are named: leaves pending work and heartbeats untouched otherwise, and does exactly their work when named", async () => {
    const s = await reputationShop("Tick Shop");
    await saveReputationSettings(s.owner, { outcomeNudgesEnabled: true }, 0);
    const g = await giveFeedback(s, await shopCustomer(s), { rating: "1" });
    await ago(g.result.feedbackId!, 40);
    await appointment2(s.m.org.id);

    setOnly("aiWorkRecovery, crmWorkflowRecovery");
    const idle = await runTick();
    expect(Object.keys(idle)).toEqual(JOBS.map((j) => j.name).filter((n) => ["aiWorkRecovery", "crmWorkflowRecovery"].includes(n)));
    expect(await remindersFor(g.result.feedbackId!)).toEqual([]);
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and dedupe_key like 'outcome-nudge:%'", [s.m.org.id])).toBe(0);
    const beats = await heartbeats();
    expect(beats).not.toContain("feedbackSla");
    expect(beats).not.toContain("appointmentOutcomeNudge");

    setOnly("appointmentOutcomeNudge,feedbackSla");
    const ran = await runTick();
    expect(Object.keys(ran)).toEqual(JOBS.map((j) => j.name).filter((n) => ["feedbackSla", "appointmentOutcomeNudge"].includes(n)));
    expect(Object.values(ran)).not.toContain("failed");
    expect(ran.feedbackSla).toBeGreaterThanOrEqual(1);
    expect(ran.appointmentOutcomeNudge).toBeGreaterThanOrEqual(1);
    expect((await remindersFor(g.result.feedbackId!)).length).toBe(2);
    // Nothing else started, nothing went out: no dispatcher ran, and no network call was made.
    expect(await heartbeats()).toEqual(expect.not.arrayContaining(["messagesDispatched", "retentionPrograms"]));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

async function appointment2(orgId: string) {
  await withSystem((db) => db.query(
    "insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, status, start_at, end_at) values ($1, $2, 'cal-1', 'confirmed', $3, $4)",
    [orgId, `tick-${Math.random().toString(36).slice(2)}`, hours(8), hours(7)],
  ));
}
