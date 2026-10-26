import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { setClientPause } from "@/server/automation/controls";
import { dispatchDue } from "@/server/messaging/send";
import { onBooking } from "@/server/messaging/followups";
import { recordConsent, suppressAddress } from "@/server/messaging/contacts";
import { JOBS } from "@/server/ops/tick";
import { enrollEligible, prepareDueSteps } from "@/server/retention/engine";
import { getLifecycleOverview, listPrograms, markCustomer, recentActivity, saveProgram, searchNonCustomers, setProgramEnabled, setRetentionPaused } from "@/server/retention/service";
import { DAILY_ENROLLMENT_CAP, DEFAULT_PROGRAMS, PROGRAM_KINDS, renderStep, stepDueAt, validateSteps, type ProgramKind } from "@/lib/retention";
import { inbound, messagingOrg, recordingProvider, type MessagingOrg } from "./support/messaging";

let m: MessagingOrg;
let other: MessagingOrg;
const hours = (h: number) => new Date(Date.now() + h * 3_600_000);
const days = (d: number) => hours(d * 24);

const program = async (org: MessagingOrg, kind: ProgramKind) => (await withSystem((db) => db.query<Record<string, unknown>>("select * from retention_programs where org_id = $1 and kind = $2", [org.org.id, kind]))).rows[0];
const enrollments = async (contactId: string, kind?: ProgramKind) =>
  (await withSystem((db) => db.query<{ id: string; status: string; cancel_reason: string | null; kind: string }>(
    "select e.id, e.status, e.cancel_reason, p.kind from retention_enrollments e join retention_programs p on p.id = e.program_id where e.contact_id = $1 and ($2::text is null or p.kind = $2) order by e.started_at", [contactId, kind ?? null]))).rows;
const steps = async (contactId: string, kind?: ProgramKind) =>
  (await withSystem((db) => db.query<{ step_key: string; status: string; reason: string | null; due_at: Date; message_id: string | null }>(
    `select s.step_key, s.status, s.reason, s.due_at, s.message_id from retention_steps s join retention_enrollments e on e.id = s.enrollment_id join retention_programs p on p.id = e.program_id
     where e.contact_id = $1 and ($2::text is null or p.kind = $2) order by s.due_at, s.step_key`, [contactId, kind ?? null]))).rows;
const message = async (id: string | null) => (await withSystem((db) => db.query<{ scope: string; purpose: string; body: string; status: string; send_after: Date; blocked_reason: string | null }>("select scope, purpose, body, status, send_after, blocked_reason from conversation_messages where id = $1", [id]))).rows[0];
const notes = async (userId: string, kind: string) => (await withSystem((db) => db.query<{ title: string }>("select title from notifications where user_id = $1 and kind = $2", [userId, kind]))).rows;

/** A contact who becomes a customer after the program was approved, with a phone and a conversation. */
async function newCustomer(org: MessagingOrg, name = "Casey Customer") {
  const c = await inbound(org.org.id, { name });
  await markCustomer(org.ctx("sales"), c.contactId);
  return c;
}

beforeAll(async () => {
  resetEnvCache();
  m = await messagingOrg({ name: "Retention Co" });
  other = await messagingOrg({ name: "Other Retention Co" });
  await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, enabled = true, mode = 'autonomous' where org_id = any($1::uuid[]) and role_key = 'crm_manager'", [[m.org.id, other.org.id]]));
});

describe("program wording rules", () => {
  it("ships five programs whose own wording passes the rules, and the promotional one says how to stop", () => {
    expect(DEFAULT_PROGRAMS.map((p) => p.kind)).toEqual([...PROGRAM_KINDS]);
    for (const p of DEFAULT_PROGRAMS) expect(validateSteps(p.steps, p.purpose), p.kind).toEqual([]);
    expect(DEFAULT_PROGRAMS.find((p) => p.kind === "reengagement")).toMatchObject({ purpose: "marketing", trigger: "inactive" });
    expect(DEFAULT_PROGRAMS.filter((p) => p.purpose === "service")).toHaveLength(4);
  });

  it("rejects wording that is too long, uses unknown placeholders, is out of order or lacks an opt-out when promotional", () => {
    const ok = { key: "a", delayDays: 1, body: "Hi {name}, thanks from {business}." };
    expect(validateSteps([ok], "service")).toEqual([]);
    expect(validateSteps([{ ...ok, body: "x".repeat(500) }], "service")[0].message).toMatch(/under 480/);
    expect(validateSteps([{ ...ok, body: "Your code is {secret}" }], "service")[0].message).toMatch(/\{secret\}/);
    expect(validateSteps([ok, { ...ok, key: "b", delayDays: 0 }], "service").some((i) => /in order/.test(i.message))).toBe(true);
    expect(validateSteps([ok, { ...ok, delayDays: 2 }], "service").some((i) => /share the same/.test(i.message))).toBe(true);
    expect(validateSteps([{ ...ok, body: "Hi {name}, a deal on us!" }], "marketing")[0].message).toMatch(/opt out/);
    expect(validateSteps([{ ...ok, body: "Hi {name}, a deal on us! Reply STOP to opt out." }], "marketing")).toEqual([]);
    expect(validateSteps([], "service")[0].message).toMatch(/between 1 and 4/);
    expect(validateSteps([ok, ok, ok, ok, ok].map((s, i) => ({ ...s, key: `k${i}`, delayDays: i })), "service").some((i) => /between 1 and 4/.test(i.message))).toBe(true);
  });

  it("fills in the first name and never reads 'Hi ,'", () => {
    expect(renderStep("Hi {name}, from {business}.", { name: "Maria Santos", business: "Acme" })).toBe("Hi Maria, from Acme.");
    expect(renderStep("Hi {name}, from {business}.", { name: "", business: "Acme" })).toBe("Hi there, from Acme.");
    expect(stepDueAt(new Date("2026-10-01T00:00:00Z"), 3).toISOString()).toBe("2026-10-04T00:00:00.000Z");
  });
});

describe("approving and changing a program", () => {
  it("creates the five standard programs, all off, for each workspace separately", async () => {
    const programs = await listPrograms(m.ctx("owner"));
    expect(programs.map((p) => p.kind)).toEqual([...PROGRAM_KINDS]);
    expect(programs.every((p) => p.state === "off" && !p.enabled)).toBe(true);
    expect((await listPrograms(other.ctx("viewer"))).length).toBe(5);
    expect((await withSystem((db) => db.query("select 1 from retention_programs where org_id = $1", [m.org.id]))).rows).toHaveLength(5);
  });

  it("lets only the owner switch one on, records their authorization, and ties it to the exact wording", async () => {
    await expect(setProgramEnabled(m.ctx("manager"), "welcome", true)).rejects.toMatchObject({ code: "forbidden" });
    await expect(setProgramEnabled(m.ctx("sales"), "welcome", true)).rejects.toMatchObject({ code: "forbidden" });
    await setProgramEnabled(m.ctx("owner"), "welcome", true);
    const p = await program(m, "welcome");
    expect(p).toMatchObject({ enabled: true, approved_by: m.people.owner.id });
    expect(p.approved_hash).toBe(p.content_hash);
    const auth = (await withSystem((db) => db.query<{ kind: string; status: string; expires_at: Date }>("select kind, status, expires_at from approval_requests where id = $1", [p.approval_id]))).rows[0];
    expect(auth).toMatchObject({ kind: "standing_authorization", status: "approved" });
    expect(new Date(auth.expires_at).getTime()).toBeGreaterThan(Date.now() + 80 * 86_400_000);
    expect((await listPrograms(m.ctx("viewer"))).find((x) => x.kind === "welcome")).toMatchObject({ state: "on" });
  });

  it("withdraws the approval when the wording changes, until the owner approves the new words", async () => {
    const before = await program(m, "welcome");
    await expect(saveProgram(m.ctx("support"), "welcome", { steps: [{ key: "welcome", delayDays: 0, body: "Hi {name}!" }] })).rejects.toMatchObject({ code: "forbidden" });
    const bad = await saveProgram(m.ctx("manager"), "welcome", { steps: [{ key: "welcome", delayDays: 0, body: "Hi {name} {oops}" }] });
    expect(bad).toMatchObject({ ok: false });
    expect(await program(m, "welcome")).toMatchObject({ content_hash: before.content_hash }); // a rejected edit changes nothing
    expect(await saveProgram(m.ctx("manager"), "welcome", { steps: [{ key: "welcome", delayDays: 0, body: "Hello {name}, welcome to {business}. Reply here any time." }] })).toEqual({ ok: true });
    expect((await listPrograms(m.ctx("owner"))).find((x) => x.kind === "welcome")).toMatchObject({ state: "needs_approval", enabled: true });
    await setProgramEnabled(m.ctx("owner"), "welcome", true);
    expect((await listPrograms(m.ctx("owner"))).find((x) => x.kind === "welcome")).toMatchObject({ state: "on" });
    expect(await saveProgram(m.ctx("manager"), "welcome", { steps: [{ key: "welcome", delayDays: 0, body: "Hello {name}, welcome to {business}. Reply here any time." }] })).toEqual({ ok: true }); // same words: still approved
    expect((await listPrograms(m.ctx("owner"))).find((x) => x.kind === "welcome")).toMatchObject({ state: "on" });
  });

  it("shows a lapsed authorization as paused, and switching off is open to managers", async () => {
    await setProgramEnabled(m.ctx("owner"), "feedback_request", true);
    await withSystem((db) => db.query("update approval_requests set expires_at = now() - interval '1 day' where id = (select approval_id from retention_programs where org_id = $1 and kind = 'feedback_request')", [m.org.id]));
    expect((await listPrograms(m.ctx("owner"))).find((x) => x.kind === "feedback_request")).toMatchObject({ state: "lapsed" });
    await setProgramEnabled(m.ctx("manager"), "feedback_request", false);
    expect((await listPrograms(m.ctx("owner"))).find((x) => x.kind === "feedback_request")).toMatchObject({ state: "off" });
  });
});

describe("who is enrolled", () => {
  it("never enrols customers who already existed when a program was approved", async () => {
    const early = await inbound(m.org.id, { name: "Early Edna" });
    await withSystem((db) => db.query("update contacts set lifecycle_stage = 'customer' where id = $1", [early.contactId]));
    await new Promise((r) => setTimeout(r, 20));
    await setProgramEnabled(m.ctx("owner"), "onboarding_checkin", true);
    await enrollEligible();
    expect(await enrollments(early.contactId, "onboarding_checkin")).toEqual([]); // became a customer before this program was approved
  });

  it("enrols a contact who becomes a customer afterwards, once, with each step due at the right time", async () => {
    const c = await newCustomer(m, "Fresh Fran");
    expect((await withSystem((db) => db.query("select customer_since from contacts where id = $1", [c.contactId]))).rows[0]).toMatchObject({ customer_since: expect.any(Date) });
    await enrollEligible();
    await enrollEligible(); // running twice changes nothing
    const e = await enrollments(c.contactId);
    expect(e.map((x) => x.kind).sort()).toEqual(["onboarding_checkin", "welcome"]);
    const welcome = await steps(c.contactId, "welcome");
    const checkin = await steps(c.contactId, "onboarding_checkin");
    expect(welcome).toHaveLength(1);
    expect(checkin.map((s) => s.step_key)).toEqual(["checkin_3", "checkin_14"]);
    const since = (await withSystem((db) => db.query<{ customer_since: Date }>("select customer_since from contacts where id = $1", [c.contactId]))).rows[0].customer_since;
    expect(new Date(checkin[0].due_at).getTime() - new Date(since).getTime()).toBe(3 * 86_400_000);
    expect(new Date(checkin[1].due_at).getTime() - new Date(since).getTime()).toBe(14 * 86_400_000);
  });

  it("leaves out contacts a person excluded, removed, or who aren't customers", async () => {
    const paused = await newCustomer(m, "Paused Pat");
    await setRetentionPaused(m.ctx("sales"), paused.contactId, true);
    const removed = await newCustomer(m, "Removed Rey");
    await withSystem((db) => db.query("update contacts set deleted_at = now() where id = $1", [removed.contactId]));
    const lead = await inbound(m.org.id, { name: "Just A Lead" });
    await enrollEligible();
    for (const c of [paused, removed, lead]) expect(await enrollments(c.contactId)).toEqual([]);
    await expect(markCustomer(m.ctx("viewer"), lead.contactId)).rejects.toMatchObject({ code: "forbidden" });
    await expect(markCustomer(m.ctx("sales"), paused.contactId)).rejects.toMatchObject({ code: "conflict" }); // already a customer
  });

  it("enrols appointment follow-ups only for appointments attended after the program was approved", async () => {
    await setProgramEnabled(m.ctx("owner"), "service_followup", true);
    const c = await inbound(m.org.id, { name: "Attended Al" });
    const insert = (id: string, start: Date, markedAt: Date, status = "showed") =>
      withSystem((db) => db.query("insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, title, status, start_at, end_at, contact_id, last_event_at) values ($1, $2, 'cal_x_0001', 'Visit', $3, $4, $5, $6, $7)", [m.org.id, id, status, start.toISOString(), new Date(start.getTime() + 1_800_000).toISOString(), c.contactId, markedAt.toISOString()]));
    await insert("old_appointment_1", days(-10), days(-10)); // marked attended before the program was approved
    await insert("noshow_appointment_1", hours(-3), hours(1), "noshow");
    await insert("new_appointment_001", hours(-2), hours(1)); // marked attended after approval
    await enrollEligible();
    const e = await enrollments(c.contactId, "service_followup");
    expect(e).toHaveLength(1);
    const s = (await steps(c.contactId, "service_followup"))[0];
    expect(s.step_key).toBe("thanks");
    expect(new Date(s.due_at).getTime()).toBeGreaterThan(hours(-2).getTime() + 2 * 86_400_000 - 3_600_000);
  });

  it("only enrols promotional re-engagement for customers who agreed to marketing, a few a day, and never twice in 180 days", async () => {
    await setProgramEnabled(m.ctx("owner"), "reengagement", true);
    const makeQuiet = async (name: string, marketing: boolean) => {
      const c = await inbound(m.org.id, { name });
      await withSystem(async (db) => {
        await db.query("update contacts set lifecycle_stage = 'customer', customer_since = now() - interval '200 days' where id = $1", [c.contactId]);
        await db.query("update conversations set last_message_at = now() - interval '150 days' where contact_id = $1", [c.contactId]);
        if (marketing) await recordConsent(db, { orgId: m.org.id, contactId: c.contactId, channel: "sms", purpose: "marketing", status: "granted", source: "test" });
      });
      return c;
    };
    const yes = await makeQuiet("Agreed Ada", true);
    const no = await makeQuiet("Silent Sol", false);
    const recent = await makeQuiet("Recent Rae", true);
    await withSystem((db) => db.query("update conversations set last_message_at = now() - interval '5 days' where contact_id = $1", [recent.contactId]));
    await enrollEligible();
    expect(await enrollments(yes.contactId, "reengagement")).toHaveLength(1);
    expect(await enrollments(no.contactId, "reengagement")).toEqual([]); // no marketing consent
    expect(await enrollments(recent.contactId, "reengagement")).toEqual([]); // not quiet
    await enrollEligible();
    expect(await enrollments(yes.contactId, "reengagement")).toHaveLength(1); // cooldown: once
    // The daily limit holds however many qualify.
    for (let i = 0; i < DAILY_ENROLLMENT_CAP + 4; i += 1) await makeQuiet(`Bulk ${i}`, true);
    await enrollEligible();
    const today = (await withSystem((db) => db.query<{ n: string }>("select count(*)::text as n from retention_enrollments e join retention_programs p on p.id = e.program_id where p.org_id = $1 and p.kind = 'reengagement' and e.started_at > now() - interval '1 day'", [m.org.id]))).rows[0];
    expect(Number(today.n)).toBeLessThanOrEqual(DAILY_ENROLLMENT_CAP);
  });
});

describe("sending", () => {
  it("sends through the normal message rules: purpose, scope, filled-in wording and the AI disclosure", async () => {
    const c = await newCustomer(m, "Sending Sam");
    await enrollEligible();
    const r = await prepareDueSteps({ now: hours(1) });
    expect(r.queued).toBeGreaterThanOrEqual(1);
    const s = (await steps(c.contactId, "welcome"))[0];
    expect(s.status).toBe("queued");
    const msg = await message(s.message_id);
    expect(msg).toMatchObject({ scope: "retention", purpose: "service", status: "queued" });
    expect(msg.body).toContain("Hello Sending, welcome to");
    // Any conversation already holding an AI message gets no repeat of the disclosure; a first AI message always carries it.
    expect(msg.body).toMatch(/I'm an AI assistant for|Hello Sending/);
    const rec = recordingProvider();
    await dispatchDue({ provider: rec.provider, now: hours(1) });
    const mine = () => rec.calls.filter((x) => x.messageId === s.message_id);
    expect(mine()).toHaveLength(1);
    expect((await prepareDueSteps({ now: hours(1) })).reconciled).toBeGreaterThanOrEqual(1);
    expect((await steps(c.contactId, "welcome"))[0].status).toBe("sent");
    expect((await enrollments(c.contactId, "welcome"))[0].status).toBe("completed");
    await dispatchDue({ provider: rec.provider, now: hours(2) });
    expect(mine()).toHaveLength(1); // once
    const feed = await recentActivity(m.ctx("owner"));
    expect(feed.some((f) => f.contactName === "Sending Sam" && f.status === "sent")).toBe(true);
  });

  it("holds the second program message back until the minimum spacing has passed, whatever program it came from", async () => {
    const c = await newCustomer(m, "Spacing Stu");
    await enrollEligible();
    // Make a later step due now so two program messages are ready together.
    await withSystem((db) => db.query("update retention_steps set due_at = now() - interval '1 hour' where enrollment_id in (select id from retention_enrollments where contact_id = $1)", [c.contactId]));
    await prepareDueSteps({ now: hours(1), limit: 50 });
    const rec = recordingProvider();
    await dispatchDue({ provider: rec.provider, now: hours(1), limit: 50 });
    const queued = (await steps(c.contactId)).filter((s) => s.message_id);
    const sentNow = queued.filter((s) => rec.calls.some((x) => x.messageId === s.message_id));
    expect(sentNow).toHaveLength(1);
    const waiting = queued.find((s) => !rec.calls.some((x) => x.messageId === s.message_id))!;
    expect(waiting).toBeTruthy();
    const w = await message(waiting.message_id);
    expect(w.status).toBe("queued");
    expect(new Date(w.send_after).getTime()).toBeGreaterThanOrEqual(hours(1).getTime() + 70 * 3_600_000);
  });

  it("stops a customer's whole program when the per-customer limit is reached", async () => {
    await withSystem((db) => db.query("update messaging_policy set max_retention_per_contact_30d = 1"));
    try {
      const c = await newCustomer(m, "Limit Lou");
      await enrollEligible();
      await withSystem((db) => db.query("update retention_steps set due_at = now() - interval '1 hour' where enrollment_id in (select id from retention_enrollments where contact_id = $1 and program_id = (select id from retention_programs where org_id = $2 and kind = 'welcome'))", [c.contactId, m.org.id]));
      await prepareDueSteps({ now: hours(1) });
      const rec = recordingProvider();
      await dispatchDue({ provider: rec.provider, now: hours(1) });
      expect(rec.calls.some((x) => x.contactRef.length > 0)).toBe(true);
      await withSystem((db) => db.query("update retention_steps set due_at = now() - interval '1 hour' where enrollment_id in (select id from retention_enrollments where contact_id = $1 and program_id = (select id from retention_programs where org_id = $2 and kind = 'onboarding_checkin'))", [c.contactId, m.org.id]));
      await prepareDueSteps({ now: hours(1) });
      const blocked = (await steps(c.contactId, "onboarding_checkin")).filter((s) => s.status === "blocked");
      expect(blocked.some((s) => s.reason === "retention_limit")).toBe(true);
      expect((await enrollments(c.contactId, "onboarding_checkin"))[0]).toMatchObject({ status: "cancelled", cancel_reason: "retention_limit" });
    } finally {
      await withSystem((db) => db.query("update messaging_policy set max_retention_per_contact_30d = 4"));
    }
  });

  const dueNow = (contactId: string, kind: ProgramKind) =>
    withSystem((db) => db.query("update retention_steps set due_at = now() - interval '1 hour' where enrollment_id in (select e.id from retention_enrollments e join retention_programs p on p.id = e.program_id where e.contact_id = $1 and p.kind = $2)", [contactId, kind]));

  it("never sends once the customer opted out, a person owns the conversation, or messaging is paused", async () => {
    const optOut = await newCustomer(m, "Optout Oz");
    const owned = await newCustomer(m, "Owned Ola");
    const paused = await newCustomer(m, "Paused Pia");
    await enrollEligible();
    for (const c of [optOut, owned]) await dueNow(c.contactId, "onboarding_checkin");
    await withSystem((db) => suppressAddress(db, { orgId: m.org.id, channel: "sms", address: optOut.address, reason: "opt_out", source: "test" }));
    await withSystem((db) => db.query("update conversations set owner_kind = 'human', owner_user_id = $2 where id = $1", [owned.conversationId, m.people.sales.id]));
    await prepareDueSteps({ now: hours(1), limit: 100 });
    expect((await steps(optOut.contactId, "onboarding_checkin")).some((s) => s.reason === "suppressed")).toBe(true);
    expect((await steps(owned.contactId, "onboarding_checkin")).some((s) => s.reason === "human_owner")).toBe(true);
    for (const c of [optOut, owned]) expect((await enrollments(c.contactId, "onboarding_checkin"))[0].status).toBe("cancelled");
    await dueNow(paused.contactId, "onboarding_checkin"); // becomes due only now, while messaging is paused
    await setClientPause(m.ctx("owner"), { scope: "messaging", paused: true, reason: "test" });
    try {
      await prepareDueSteps({ now: hours(1), limit: 100 });
    } finally {
      await setClientPause(m.ctx("owner"), { scope: "messaging", paused: false });
    }
    expect((await steps(paused.contactId, "onboarding_checkin")).some((s) => s.reason === "automation_paused")).toBe(true);
    const rec = recordingProvider();
    await dispatchDue({ provider: rec.provider, now: hours(1), limit: 100 });
    const stuck = (await steps(optOut.contactId)).concat(await steps(owned.contactId)).filter((s) => s.message_id);
    for (const s of stuck) expect(rec.calls.some((x) => x.messageId === s.message_id)).toBe(false);
  });

  it("needs explicit marketing consent for promotional messages, and a message carries its own opt-out", async () => {
    const make = async (name: string, grant: boolean) => {
      const c = await inbound(m.org.id, { name });
      await withSystem(async (db) => {
        await db.query("update contacts set lifecycle_stage = 'customer', customer_since = now() - interval '200 days' where id = $1", [c.contactId]);
        await db.query("update conversations set last_message_at = now() - interval '150 days' where contact_id = $1", [c.contactId]);
        await recordConsent(db, { orgId: m.org.id, contactId: c.contactId, channel: "sms", purpose: "marketing", status: "granted", source: "test" });
      });
      await enrollEligible();
      if (!grant) await withSystem((db) => recordConsent(db, { orgId: m.org.id, contactId: c.contactId, channel: "sms", purpose: "marketing", status: "revoked", source: "test" }));
      return c;
    };
    await withSystem((db) => db.query("update retention_enrollments set started_at = now() - interval '3 days' where program_id = (select id from retention_programs where org_id = $1 and kind = 'reengagement')", [m.org.id]));
    const agreed = await make("Marketing Mia", true);
    const withdrew = await make("Withdrew Wes", false);
    for (const c of [agreed, withdrew]) await dueNow(c.contactId, "reengagement");
    await prepareDueSteps({ now: hours(1), limit: 100 });
    const a = (await steps(agreed.contactId, "reengagement"))[0];
    expect(a.status).toBe("queued");
    const msg = await message(a.message_id);
    expect(msg).toMatchObject({ purpose: "marketing", scope: "retention" });
    expect(msg.body).toMatch(/STOP/);
    expect((await steps(withdrew.contactId, "reengagement"))[0]).toMatchObject({ status: "blocked", reason: "no_consent" });
  });

  it("blocks sending when credits run out, and when the AI employee isn't ready", async () => {
    const broke = await messagingOrg({ name: "No Credit Retention", credits: 0 });
    await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, enabled = true, mode = 'autonomous' where org_id = $1 and role_key = 'crm_manager'", [broke.org.id]));
    await setProgramEnabled(broke.ctx("owner"), "welcome", true);
    const c = await newCustomer(broke, "Broke Bo");
    await enrollEligible();
    await prepareDueSteps({ now: hours(1) });
    expect((await steps(c.contactId, "welcome"))[0]).toMatchObject({ status: "blocked", reason: "credits" });

    const offline = await messagingOrg({ name: "Offline Retention" });
    await setProgramEnabled(offline.ctx("owner"), "welcome", true);
    await withSystem((db) => db.query("update agent_instances set status = 'offline', last_health_ok = false where org_id = $1 and role_key = 'crm_manager'", [offline.org.id]));
    const d = await newCustomer(offline, "Offline Ola");
    await enrollEligible();
    await prepareDueSteps({ now: hours(1) });
    expect((await steps(d.contactId, "welcome"))[0]).toMatchObject({ status: "blocked", reason: "agent_not_ready" });
  });

  it("sends under the owner's standing authorization even when the employee normally asks first", async () => {
    const cautious = await messagingOrg({ name: "Cautious Retention" });
    await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, enabled = true, mode = 'approval_required' where org_id = $1 and role_key = 'crm_manager'", [cautious.org.id]));
    await setProgramEnabled(cautious.ctx("owner"), "welcome", true);
    const c = await newCustomer(cautious, "Cautious Cal");
    await enrollEligible();
    await prepareDueSteps({ now: hours(1) });
    const s = (await steps(c.contactId, "welcome"))[0];
    expect(s.status).toBe("queued");
    expect((await message(s.message_id)).status).toBe("queued"); // not held as a draft
  });

  it("skips a message that is far overdue rather than sending it late", async () => {
    const c = await newCustomer(m, "Stale Stan");
    await enrollEligible();
    await dueNow(c.contactId, "welcome");
    await prepareDueSteps({ now: days(10), limit: 100 });
    expect((await steps(c.contactId, "welcome"))[0]).toMatchObject({ status: "skipped", reason: "too_late" });
  });
});

describe("stopping", () => {
  const live = async (name: string) => {
    const c = await newCustomer(m, name);
    await enrollEligible();
    return c;
  };

  it("ends the program when the customer replies, and only ends re-engagement when they book", async () => {
    const c = await live("Replying Rhea");
    expect((await enrollments(c.contactId)).every((e) => e.status === "active")).toBe(true);
    await withSystem((db) => onBooking(db, m.org.id, c.contactId));
    expect((await enrollments(c.contactId)).every((e) => e.status === "active")).toBe(true); // a booking doesn't end a welcome
    await inbound(m.org.id, { address: c.address, body: "Thanks, got a question" });
    const after = await enrollments(c.contactId);
    expect(after.every((e) => e.status === "cancelled" && e.cancel_reason === "customer_replied")).toBe(true);
    expect((await steps(c.contactId)).every((s) => s.status === "cancelled")).toBe(true);
  });

  it("releases a queued message when the customer replies before it goes out", async () => {
    const c = await live("Queued Quin");
    await prepareDueSteps({ now: hours(1) });
    const queued = (await steps(c.contactId, "welcome"))[0];
    expect(queued.status).toBe("queued");
    await inbound(m.org.id, { address: c.address, body: "STOP texting me" });
    expect((await message(queued.message_id)).status).toBe("blocked");
    const rec = recordingProvider();
    await dispatchDue({ provider: rec.provider, now: hours(1) });
    expect(rec.calls.some((x) => x.messageId === queued.message_id)).toBe(false);
  });

  it("cancels everything planned the moment a program is switched off, including queued messages", async () => {
    const c = await live("Switched Off Sid");
    await prepareDueSteps({ now: hours(1) });
    const queued = (await steps(c.contactId, "welcome"))[0];
    await setProgramEnabled(m.ctx("manager"), "welcome", false);
    expect((await enrollments(c.contactId, "welcome"))[0]).toMatchObject({ status: "cancelled", cancel_reason: "program_off" });
    expect((await message(queued.message_id)).status).toBe("blocked");
    const rec = recordingProvider();
    await dispatchDue({ provider: rec.provider, now: hours(1) });
    expect(rec.calls.some((x) => x.messageId === queued.message_id)).toBe(false);
    await setProgramEnabled(m.ctx("owner"), "welcome", true); // back on for the tests below
  });

  it("holds sending and asks the owner when the wording changed or the authorization lapsed", async () => {
    const c = await live("Changed Chad");
    await dueNow2(c.contactId, "onboarding_checkin");
    await saveProgram(m.ctx("manager"), "onboarding_checkin", { steps: [{ key: "checkin_3", delayDays: 3, body: "Hi {name}, a new check-in text from {business}." }, { key: "checkin_14", delayDays: 14, body: "Hi {name}, two weeks in. Everything OK with {business}?" }] });
    const r = await prepareDueSteps({ now: hours(1), limit: 100 });
    expect(r.blocked).toBeGreaterThanOrEqual(1);
    expect((await steps(c.contactId, "onboarding_checkin")).some((s) => s.status === "blocked" && s.reason === "authorization_needed")).toBe(true);
    expect((await notes(m.people.owner.id, "retention_attention")).length).toBeGreaterThanOrEqual(1);
    expect((await notes(m.people.manager.id, "retention_attention")).length).toBe(0); // only the owner is asked
    await setProgramEnabled(m.ctx("owner"), "onboarding_checkin", true);
  });

  it("stops planned messages for a customer a person excluded, and for an appointment that was changed", async () => {
    const c = await live("Excluded Eli");
    await setRetentionPaused(m.ctx("support"), c.contactId, true);
    expect((await enrollments(c.contactId)).every((e) => e.status === "cancelled" && e.cancel_reason === "contact_excluded")).toBe(true);
    await setRetentionPaused(m.ctx("support"), c.contactId, false);
    await expect(setRetentionPaused(m.ctx("viewer"), c.contactId, true)).rejects.toMatchObject({ code: "forbidden" });

    const a = await inbound(m.org.id, { name: "Changed Cora" });
    await withSystem((db) => db.query("insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, title, status, start_at, end_at, contact_id, last_event_at) values ($1, 'changed_appointment_1', 'cal_x_0001', 'Visit', 'showed', now() - interval '1 hour', now() - interval '30 minutes', $2, now() + interval '1 minute')", [m.org.id, a.contactId]));
    await enrollEligible();
    expect(await enrollments(a.contactId, "service_followup")).toHaveLength(1);
    await withSystem((db) => db.query("update appointment_refs set status = 'noshow' where ghl_appointment_id = 'changed_appointment_1'"));
    await dueNow2(a.contactId, "service_followup");
    await prepareDueSteps({ now: days(3), limit: 100 });
    expect((await steps(a.contactId, "service_followup"))[0]).toMatchObject({ status: "cancelled", reason: "appointment_changed" });
  });

  const dueNow2 = (contactId: string, kind: ProgramKind) =>
    withSystem((db) => db.query("update retention_steps set due_at = now() - interval '1 hour' where enrollment_id in (select e.id from retention_enrollments e join retention_programs p on p.id = e.program_id where e.contact_id = $1 and p.kind = $2)", [contactId, kind]));
});

describe("lifecycle, access and the scheduler", () => {
  it("counts every lifecycle stage and lists customers with their programs", async () => {
    const o = await getLifecycleOverview(m.ctx("owner"));
    expect(o.stages.map((s) => s.stage)).toEqual(["lead_captured", "validated", "qualified", "follow_up", "appointment", "human_sales", "won", "lost", "customer", "retention"]);
    expect(o.stages.find((s) => s.stage === "customer")!.count).toBeGreaterThan(3);
    expect(o.customers.some((c) => c.name === "Fresh Fran" && c.activePrograms >= 0)).toBe(true);
    expect((await getLifecycleOverview(other.ctx("owner"))).customers).toEqual([]);
  });

  it("shows each workspace only its own programs and activity, and lets nobody change them directly", async () => {
    expect((await withUser(m.people.viewer.id, (db) => db.query("select org_id from retention_programs"))).rows.every((r) => (r as { org_id: string }).org_id === m.org.id)).toBe(true);
    expect((await withUser(other.people.owner.id, (db) => db.query("select 1 from retention_steps where org_id = $1", [m.org.id]))).rows).toHaveLength(0);
    for (const table of ["retention_programs", "retention_enrollments", "retention_steps"]) {
      await expect(withUser(m.people.owner.id, (db) => db.query(`delete from ${table}`))).rejects.toBeTruthy();
    }
    await expect(withUser(m.people.owner.id, (db) => db.query("update retention_programs set enabled = true"))).rejects.toBeTruthy();
    expect(await recentActivity(m.ctx("owner"))).not.toEqual([]);
    expect((await recentActivity(other.ctx("owner"))).every((r) => r.contactName !== "Sending Sam")).toBe(true);
  });

  it("runs from the scheduler before the dispatcher", () => {
    const names = JOBS.map((j) => j.name);
    expect(names).toContain("retentionPrograms");
    expect(names.indexOf("retentionPrograms")).toBeLessThan(names.indexOf("messagesDispatched"));
  });
});

describe("finding a contact to mark as a customer", () => {
  // A mangled escape in the search made the whole query fail at run time (three placeholders, two values), so the Retention page's "add a customer" search never worked.
  it("finds people who are not customers yet by name, email or the digits of their phone, in any case, and only them", async () => {
    const quill = await inbound(m.org.id, { name: "Zedekiah Quillfeather" });
    await withSystem((db) => db.query("update contacts set email = 'zed.quill@example.test' where id = $1", [quill.contactId]));
    const names = async (q: string) => (await searchNonCustomers(m.ctx("sales"), q)).map((r) => r.name);
    expect(await names("quillfeather")).toEqual(["Zedekiah Quillfeather"]);
    expect(await names("ZEDEKIAH")).toEqual(["Zedekiah Quillfeather"]);
    expect(await names("zed.quill@")).toEqual(["Zedekiah Quillfeather"]);
    expect(await names(quill.address.slice(-7))).toContain("Zedekiah Quillfeather");
    expect(await names(`+${quill.address.slice(1, 5)} ${quill.address.slice(5)}`)).toContain("Zedekiah Quillfeather");
    const found = (await searchNonCustomers(m.ctx("sales"), "quillfeather"))[0];
    expect(found).toMatchObject({ id: quill.contactId, detail: `Phone ending ${quill.address.slice(-3)}`, stage: expect.any(String) });
    // Once they are a customer they are not offered again.
    await markCustomer(m.ctx("sales"), quill.contactId);
    expect(await names("quillfeather")).toEqual([]);
  });

  it("treats the search characters of LIKE as plain characters, and does not match every phone number when only letters are typed", async () => {
    await inbound(m.org.id, { name: "Percent Pat" });
    const names = async (q: string) => (await searchNonCustomers(m.ctx("sales"), q)).map((r) => r.name);
    for (const wildcard of ["%%", "__", "%_", "\\\\", "%a%"]) expect(await names(wildcard), wildcard).toEqual([]);
    // Two letters that match no name or email find nobody, although every contact here has a phone number.
    expect(await names("zq")).toEqual([]);
    // Fewer than two characters, and the empty search, are not searches.
    expect(await names("a")).toEqual([]);
    expect(await names("   ")).toEqual([]);
    // Two digits are a name search only (no phone is matched on so little).
    expect(await names("91")).toEqual([]);
  });

  it("is for people who may edit contacts, and shows each workspace only its own contacts", async () => {
    const mine = await inbound(m.org.id, { name: "Isolated Ivo Pennywhistle" });
    await expect(searchNonCustomers(m.ctx("viewer"), "pennywhistle")).rejects.toMatchObject({ code: "forbidden" });
    expect((await searchNonCustomers(other.ctx("owner"), "pennywhistle"))).toEqual([]);
    expect((await searchNonCustomers(m.ctx("owner"), "pennywhistle")).map((r) => r.id)).toEqual([mine.contactId]);
  });
});
