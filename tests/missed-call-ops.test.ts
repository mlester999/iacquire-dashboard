// What people do with missed-call cases and policy: who may read and change them, that a stale change is refused instead of overwriting a newer
// one, that a pause really stops a queued text, that one workspace never sees another's cases, and that the numbers on the dashboard are counts
// of rows that exist. Synthetic workspaces only.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { memberActor } from "@/server/crm/actor";
import { crmEventDispatch } from "@/server/crm/dispatch";
import { dispatchMessage } from "@/server/messaging/send";
import { JOBS, runScheduledJobs } from "@/server/ops/tick";
import { recoveryStats } from "@/server/missed-calls/analytics";
import { processMissedCalls } from "@/server/missed-calls/engine";
import { assignCase, closeCase, escalateCase, getCase, listCases, openCaseFor, pauseCase, resumeCase, retryCase } from "@/server/missed-calls/ops";
import { activatePolicy, readPolicy, RECOVERY_JOB_NAME, savePolicy } from "@/server/missed-calls/policy";
import { transitionCase } from "@/server/missed-calls/cases";
import { inbound, messagingOrg } from "./support/messaging";
import { callerNumber, caseOf, count, messagesFor, minutesAfter, missedCallFrom, recoveryWorkspace, rows, T0 } from "./support/missed-calls";

const NOW = minutesAfter(5);
const run = (orgId: string, now: Date) => processMissedCalls({ now, orgId });
const denied = async (p: Promise<unknown>, pattern: RegExp) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).message).toMatch(pattern);
};

describe("reading cases", () => {
  it("lists a workspace's cases with their calls, actions and history, and keeps another workspace's out of sight", async () => {
    const a = await recoveryWorkspace({ mode: "manual" });
    const b = await recoveryWorkspace({ mode: "manual" });
    const mine = await missedCallFrom(a);
    const theirs = await missedCallFrom(b);
    await run(a.w.org.id, NOW);
    const list = await listCases(a.owner, { group: "all" });
    expect(list.rows.map((r) => r.id)).toEqual([mine.caseRow.id]);
    expect(list.counts.all).toBe(1);
    const detail = await getCase(a.owner, mine.caseRow.id);
    expect(detail.calls).toHaveLength(1);
    expect(detail.actions.map((x) => x.kind).sort()).toEqual(["assign", "notify", "task"]);
    expect(detail.events.map((e) => e.kind)).toContain("case_created");
    expect(detail.statusLabel).toBe("Waiting for your team");
    expect(detail.contact?.name).toBe("Dana Lee");
    // Another workspace's member can't read the case by id, by list, or through the conversation lookup.
    await denied(getCase(b.owner, mine.caseRow.id), /not found/i);
    expect((await listCases(b.owner, { group: "all" })).rows.map((r) => r.id)).toEqual([theirs.caseRow.id]);
    expect(await openCaseFor(b.owner, { conversationId: mine.caseRow.conversation_id! })).toBeNull();
    expect((await openCaseFor(a.owner, { contactId: mine.contact.id }))?.id).toBe(mine.caseRow.id);
  });

  it("refuses people whose role does not include calls", async () => {
    const r = await recoveryWorkspace({ mode: "manual" });
    const { caseRow } = await missedCallFrom(r);
    await denied(listCases(r.viewer), /call records/i);
    await denied(getCase(r.viewer, caseRow.id), /call records/i);
    await denied(recoveryStats(r.viewer, 30), /call records/i);
    expect(await openCaseFor(r.viewer, { contactId: caseRow.contact_id! })).toBeNull();
  });

  it("filters by what needs a person, what is waiting, and what is finished", async () => {
    const r = await recoveryWorkspace({ mode: "automatic" });
    const waiting = await missedCallFrom(r, { name: "Waiting Wendy" });
    await run(r.w.org.id, NOW);
    const done = await missedCallFrom(r, { name: "Done Dave" });
    await closeCase(r.owner, done.caseRow.id, "no_recovery");
    const l = await listCases(r.owner, { group: "waiting" });
    expect(l.rows.map((x) => x.id)).toContain(waiting.caseRow.id);
    expect((await listCases(r.owner, { group: "closed" })).rows.map((x) => x.id)).toEqual([done.caseRow.id]);
    expect((await listCases(r.owner, { group: "open" })).counts.closed).toBe(1);
  });
});

describe("changing a case", () => {
  it("assigns it, refusing a stale owner version and anyone outside the workspace", async () => {
    const r = await recoveryWorkspace({ mode: "manual", policy: { assignUserId: null } });
    const { caseRow } = await missedCallFrom(r);
    await assignCase(r.manager, caseRow.id, r.w.people.sales.id, caseRow.owner_version);
    const after = await caseOf(r.w.org.id, (await rows<{ caller_number: string }>("select caller_number from missed_call_cases where id = $1", [caseRow.id]))[0].caller_number);
    expect(after).toMatchObject({ owner_kind: "human", owner_user_id: r.w.people.sales.id, owner_version: caseRow.owner_version + 1 });
    await denied(assignCase(r.manager, caseRow.id, r.w.people.manager.id, caseRow.owner_version), /changed who owns/i);
    const stranger = await messagingOrg();
    await denied(assignCase(r.manager, caseRow.id, stranger.people.owner.id, after.owner_version), /active member/i);
    await assignCase(r.manager, caseRow.id, null, after.owner_version);
    expect((await rows<{ owner_kind: string }>("select owner_kind from missed_call_cases where id = $1", [caseRow.id]))[0].owner_kind).toBe("unassigned");
  });

  it("lets only people who can edit contacts work a case", async () => {
    const r = await recoveryWorkspace({ mode: "manual" });
    const { caseRow } = await missedCallFrom(r);
    await denied(assignCase(r.viewer, caseRow.id, r.w.people.sales.id, caseRow.owner_version), /call records|edit contacts/i);
    await denied(closeCase(r.viewer, caseRow.id, "canceled"), /call records|edit contacts/i);
    await denied(escalateCase(r.viewer, caseRow.id), /call records|edit contacts/i);
    expect((await rows<{ state: string }>("select state from missed_call_cases where id = $1", [caseRow.id]))[0].state).toBe("detected");
  });

  it("pausing stops a queued text and keeps the worker away until the case is resumed", async () => {
    const r = await recoveryWorkspace({ mode: "automatic" });
    const { caller, contact, caseRow } = await missedCallFrom(r);
    await run(r.w.org.id, NOW);
    const [m] = await messagesFor(contact.id);
    expect(m.status).toBe("queued");
    const queued = await caseOf(r.w.org.id, caller);
    await denied(pauseCase(r.manager, caseRow.id, queued.owner_version + 3), /changed/i);
    await pauseCase(r.manager, caseRow.id, queued.owner_version);
    expect((await messagesFor(contact.id))[0]).toMatchObject({ status: "blocked", blocked_reason: "paused" });
    await dispatchMessage(m.id, { transport: r.transport.transport, now: minutesAfter(6) });
    expect(r.transport.calls).toHaveLength(0);
    const paused = await caseOf(r.w.org.id, caller);
    expect(paused.paused_at).not.toBeNull();
    const res = await run(r.w.org.id, minutesAfter(120));
    expect(res.claimed).toBe(0);
    await resumeCase(r.manager, caseRow.id, paused.owner_version);
    const resumed = await caseOf(r.w.org.id, caller);
    expect(resumed.paused_at).toBeNull();
    expect(resumed.owner_version).toBe(paused.owner_version + 1);
  });

  it("closes a case once, as recovered, closed without recovery, or canceled, and says who did it", async () => {
    const r = await recoveryWorkspace({ mode: "manual" });
    const a = await missedCallFrom(r, { name: "A" });
    await closeCase(r.manager, a.caseRow.id, "recovered", "Spoke by phone");
    const detail = await getCase(r.manager, a.caseRow.id);
    expect(detail).toMatchObject({ state: "recovered", recoveredVia: "manual" });
    expect(detail.events.at(-1)).toMatchObject({ kind: "state_changed", toState: "recovered", actor: { kind: "user" } });
    await denied(closeCase(r.manager, a.caseRow.id, "canceled"), /already finished/i);
    expect(await count("select count(*)::text as n from crm_events where org_id = $1 and type = 'recovery.completed' and entity_id = $2", [r.w.org.id, a.caseRow.id])).toBe(1);
    const b = await missedCallFrom(r, { name: "B" });
    await closeCase(r.manager, b.caseRow.id, "no_recovery");
    expect((await getCase(r.manager, b.caseRow.id)).state).toBe("completed_without_recovery");
    const audit = await rows<{ action: string; metadata: Record<string, unknown> }>("select action, metadata from audit_logs where org_id = $1 and action like 'missed_call.%' order by created_at", [r.w.org.id]);
    expect(audit.filter((x) => x.action === "missed_call.closed")).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain("Spoke by phone");
  });

  it("only a person can reopen a failed case; the engine cannot", async () => {
    const r = await recoveryWorkspace({ mode: "manual" });
    const { caseRow } = await missedCallFrom(r);
    await withSystem(async (db) => {
      const r1 = await transitionCase(db, { orgId: r.w.org.id, caseId: caseRow.id, to: "awaiting_eligibility", actor: { kind: "system" }, reason: "progress" });
      expect(r1.ok).toBe(true);
      const r2 = await transitionCase(db, { orgId: r.w.org.id, caseId: caseRow.id, to: "failed", actor: { kind: "system" }, reason: "test" });
      expect(r2.ok).toBe(true);
      const engine = await transitionCase(db, { orgId: r.w.org.id, caseId: caseRow.id, to: "awaiting_eligibility", actor: { kind: "system" }, reason: "retry" });
      expect(engine).toMatchObject({ ok: false, code: "person_only" });
      const illegal = await transitionCase(db, { orgId: r.w.org.id, caseId: caseRow.id, to: "recovered", actor: { kind: "user", userId: r.w.people.manager.id }, reason: "x" });
      expect(illegal.ok).toBe(false);
    });
    await retryCase(r.manager, caseRow.id);
    expect((await getCase(r.manager, caseRow.id)).state).toBe("awaiting_eligibility");
    await denied(retryCase(r.manager, caseRow.id), /Only a failed/i);
  });

  it("escalating tells the owners and managers, once", async () => {
    const r = await recoveryWorkspace({ mode: "manual" });
    const { caseRow } = await missedCallFrom(r);
    await escalateCase(r.manager, caseRow.id);
    await escalateCase(r.manager, caseRow.id);
    const n = await rows<{ user_id: string }>("select user_id from notifications where org_id = $1 and kind = 'missed_call_follow_up' and dedupe_key = $2", [r.w.org.id, `mcc:${caseRow.id}:escalated`]);
    expect(n.map((x) => x.user_id).sort()).toEqual([r.w.people.owner.id, r.w.people.manager.id].sort());
  });
});

describe("the policy", () => {
  it("can be changed only by an owner or manager, only from the version they saw, and only to a safe combination", async () => {
    const w = await messagingOrg({ provider: { sms: "twilio" } });
    const owner = memberActor(w.ctx("owner"));
    const sales = memberActor(w.ctx("sales"));
    await denied(savePolicy(sales, { expectedVersion: 0, enabled: true }), /owner or manager/i);
    const saved = await savePolicy(owner, { expectedVersion: 0, enabled: true, delayMinutes: 5 });
    expect(saved).toMatchObject({ enabled: true, delayMinutes: 5, version: 1, mode: "manual", actionMessage: false, activatedAt: null });
    await denied(savePolicy(owner, { expectedVersion: 0, delayMinutes: 6 }), /changed by someone else/i);
    await denied(savePolicy(owner, { expectedVersion: 1, mode: "automatic" }), /text follow-up/i);
    await denied(savePolicy(owner, { expectedVersion: 1, mode: "automatic", actionMessage: true, messageOpen: "Book now at https://example.com please" }), /Links/);
    await denied(savePolicy(owner, { expectedVersion: 1, mode: "automatic", actionMessage: true, smsConsentBasis: "inbound_call" }), /messaging rules/);
    await denied(savePolicy(owner, { expectedVersion: 1, assignUserId: (await messagingOrg()).people.owner.id }), /active member/i);
    await expect(savePolicy(owner, { expectedVersion: 1, bogus: true } as never)).rejects.toThrow();
  });

  it("must be activated by a person once the channel is ready, and any change to what a caller receives takes the activation back", async () => {
    const w = await messagingOrg({ provider: { sms: "twilio" } });
    const owner = memberActor(w.ctx("owner"));
    let p = await savePolicy(owner, { expectedVersion: 0, enabled: true, mode: "automatic", actionMessage: true });
    expect(p.activatedAt).toBeNull();
    // A workspace whose text channel is off can't be activated.
    await withSystem((db) => db.query("update messaging_channels set enabled = false where org_id = $1 and channel = 'sms'", [w.org.id]));
    await denied(activatePolicy(owner, p.version), /Not ready yet/);
    await withSystem((db) => db.query("update messaging_channels set enabled = true where org_id = $1 and channel = 'sms'", [w.org.id]));
    await denied(activatePolicy(memberActor(w.ctx("sales")), p.version), /owner or manager/i);
    p = await activatePolicy(owner, p.version);
    expect(p.activatedAt).not.toBeNull();
    expect(p.activatedBy).toBe(w.people.owner.id);
    // Delay is not about what the caller receives: activation stays.
    p = await savePolicy(owner, { expectedVersion: p.version, delayMinutes: 10 });
    expect(p.activatedAt).not.toBeNull();
    // The wording is: activation goes.
    p = await savePolicy(owner, { expectedVersion: p.version, messageOpen: "Hi, this is a different greeting from us." });
    expect(p.activatedAt).toBeNull();
    const audit = await rows<{ metadata: { changed?: string[]; activationReset?: boolean } }>("select metadata from audit_logs where org_id = $1 and action = 'missed_call.policy_saved' order by created_at desc limit 1", [w.org.id]);
    expect(audit[0].metadata).toMatchObject({ changed: expect.arrayContaining(["messageOpen"]), activationReset: true });
    expect(JSON.stringify(audit)).not.toContain("different greeting");
  });

  it("shows an honest readiness list: the sending switch and the scheduler are reported as they are", async () => {
    delete process.env.TWILIO_WRITES_ENABLED;
    const w = await messagingOrg({ provider: { sms: "twilio" } });
    const owner = memberActor(w.ctx("owner"));
    await savePolicy(owner, { expectedVersion: 0, enabled: true, mode: "assisted", actionMessage: true });
    const { readiness } = await readPolicy(owner);
    const by = Object.fromEntries(readiness.map((i) => [i.key, i]));
    expect(by.channel_sms).toMatchObject({ ok: true, blocking: true });
    expect(by.sending_sms).toMatchObject({ ok: false, blocking: false });
    expect(by.sending_sms.detail).toMatch(/held and never sent/);
    expect(by.scheduler).toMatchObject({ ok: false, blocking: false });
    expect(by.scheduler.detail).toMatch(/Pending/);
    expect(by.business_hours.ok).toBe(false);
  });
});

describe("the dashboard counts what happened", () => {
  it("counts calls, cases, texts, replies and recoveries from the rows that exist, and reports no revenue it cannot see", async () => {
    const r = await recoveryWorkspace({ mode: "automatic" });
    // An answered call (no case), a missed call that gets a text and a reply, and a missed call nobody follows up (no consent).
    await missedCallFrom(r, { consent: true, over: { status: "completed", durationSeconds: 200, hasTranscript: true } });
    const replied = await missedCallFrom(r, { name: "Replies Rita" });
    const silent = await missedCallFrom(r, { name: "No Consent Nick", consent: false });
    await run(r.w.org.id, NOW);
    const [m] = await messagesFor(replied.contact.id);
    await dispatchMessage(m.id, { transport: r.transport.transport, now: minutesAfter(6) });
    await run(r.w.org.id, minutesAfter(8));
    await inbound(r.w.org.id, { provider: "twilio", address: replied.caller, providerMessageId: "stat_reply", body: "Yes, please call me", receivedAt: minutesAfter(9) });
    await crmEventDispatch({ now: minutesAfter(9) });
    await run(r.w.org.id, minutesAfter(10));
    const stats = await recoveryStats(r.owner, 30);
    expect(stats.calls).toMatchObject({ inbound: 3, missed: 2, answered: 1 });
    expect(stats.cases).toMatchObject({ total: 2, recovered: 1, open: 1 });
    expect(stats.funnel).toMatchObject({ eligible: 1, attempts: 1, contacted: 1, responded: 1, appointments: 0, recovered: 1, suppressed: 1, failed: 0 });
    expect(stats.rates).toEqual({ recoveryRate: 50, responseRate: 100 });
    expect(stats.speed.casesWithAnAction).toBe(2);
    expect(stats.association).toMatchObject({ wonDeals: 0, wonValueByCurrency: [] });
    expect(silent.caseRow.id).toBeTruthy();
    await denied(recoveryStats(r.owner, 5), /7, 30 or 90/);
  });

  it("is empty, not invented, for a workspace with no calls", async () => {
    const r = await recoveryWorkspace({ mode: "manual" });
    const stats = await recoveryStats(r.owner, 30);
    expect(stats.calls).toMatchObject({ inbound: 0, missed: 0, answered: 0 });
    expect(stats.cases.total).toBe(0);
    expect(stats.rates).toEqual({ recoveryRate: null, responseRate: null });
    expect(stats.speed.medianMinutesToFirstAction).toBeNull();
  });
});

describe("the scheduler", () => {
  it("registers the recovery job once, in the shared registry, and runs it with the others", async () => {
    expect(JOBS.filter((j) => j.name === RECOVERY_JOB_NAME)).toHaveLength(1);
    const r = await recoveryWorkspace({ mode: "manual" });
    await missedCallFrom(r);
    const out = await runScheduledJobs(undefined, JOBS.filter((j) => j.name === RECOVERY_JOB_NAME));
    expect(out[RECOVERY_JOB_NAME]).toBeTypeOf("number");
    const beat = await rows<{ last_success_at: Date | null }>("select last_success_at from worker_job_runs where job_name = $1", [RECOVERY_JOB_NAME]);
    expect(beat[0].last_success_at).not.toBeNull();
    void T0;
    void callerNumber;
  });
});
