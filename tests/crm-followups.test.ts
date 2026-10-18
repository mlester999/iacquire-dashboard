// Follow-up sequences on the native CRM: when a plan starts, what stops it (events from the CRM outbox, replies, opt-outs, takeovers),
// the workspace's style inside iAcquire's limits, and the screen's numbers. Synthetic workspaces only; every send goes to a recorder.
import crypto from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
// The screen is rendered to HTML below without a browser: navigation and server actions are inert stand-ins there.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {} }), usePathname: () => "/crm/follow-ups" }));
vi.mock("@/app/actions/crm-followups", () => {
  const ok = async () => ({ ok: true, data: null });
  return { saveFollowUpSettingsAction: ok, stopContactFollowUpsAction: ok };
});
import { withSystem } from "@/server/db";
import { scopeFor } from "@/server/crm/page";
import { FollowUpsView } from "@/components/crm/views/followups-view";
import { memberActor } from "@/server/crm/actor";
import { setContactConsent } from "@/server/crm/contacts";
import { dispatchMessage, queueOutbound } from "@/server/messaging/send";
import { takeOverConversation } from "@/server/messaging/handoff";
import {
  followUpsOnEvent, getFollowUpWorkspace, planFollowUps, processDueFollowUps, saveFollowUpSettings, startFollowUps, stopContactFollowUps, type FollowUpEvent,
} from "@/server/messaging/followups";
import { createAppointmentType, createCalendar, setHostAvailability } from "@/server/calendars/setup";
import { bookNativeAppointment } from "@/server/calendars/booking";
import {
  customFollowUpIssues, effectiveDays, estimateSequenceMicros, followUpUnits, maxCustomAttempts, minGapDays, previewSchedule, type FollowUpLimits,
} from "@/components/crm/followups/sequence";
import { DEFAULT_FOLLOWUP_TEXT, smsSegments } from "@/lib/messaging";
import { inbound, messagingOrg, phone, recordingProvider, type MessagingOrg } from "./support/messaging";

let m: MessagingOrg;
beforeAll(async () => {
  m = await messagingOrg({ name: "Sequences Co" });
});

const DAY = 86_400_000;
const soon = () => new Date(Date.now() + 60_000);
const owner = (org: MessagingOrg = m) => memberActor(org.ctx("owner"));

/** The AI employee's answer, sent through the normal rule chain to a recording provider. Returns when it was sent. */
async function aiAnswer(org: MessagingOrg, conversationId: string, opts: { dedupeKey?: string } = {}) {
  const q = await withSystem((db) =>
    queueOutbound(db, { orgId: org.org.id, conversationId, scope: "reply", actor: { kind: "ai", agentId: org.salesAgentId }, body: "Thanks for asking! We have time on Thursday.", dedupeKey: opts.dedupeKey ?? `reply-to:test-${crypto.randomUUID()}` }),
  );
  expect(q.status).toBe("queued");
  const { provider } = recordingProvider();
  expect(await dispatchMessage(q.messageId, { provider })).toEqual({ status: "sent" });
  const { rows } = await withSystem((db) => db.query<{ sent_at: Date }>("select sent_at from conversation_messages where id = $1", [q.messageId]));
  return { messageId: q.messageId, sentAt: new Date(rows[0].sent_at) };
}

const plansFor = async (contactId: string) =>
  (await withSystem((db) => db.query<{ id: string; status: string; cancel_reason: string | null; conversation_id: string; max_attempts: number; created_at: Date; closed_at: Date | null }>(
    "select id, status, cancel_reason, conversation_id, max_attempts, created_at, closed_at from follow_up_plans where contact_id = $1 order by created_at, id",
    [contactId],
  ))).rows;
const stepsOf = async (planId: string) =>
  (await withSystem((db) => db.query<{ id: string; step_number: number; due_at: Date; status: string; channel: string; reason: string | null; message_id: string | null }>(
    "select id, step_number, due_at, status, channel, reason, message_id from follow_up_steps where plan_id = $1 order by step_number",
    [planId],
  ))).rows;

async function latestEvent(orgId: string, type: string, contactId: string): Promise<FollowUpEvent> {
  const { rows } = await withSystem((db) => db.query<{ id: string; type: string; contact_id: string | null; payload: Record<string, unknown> }>(
    "select id::text as id, type, contact_id, payload from crm_events where org_id = $1 and type = $2 and contact_id = $3 order by id desc limit 1",
    [orgId, type, contactId],
  ));
  if (!rows[0]) throw new Error(`no ${type} event`);
  return { id: Number(rows[0].id), orgId, type: rows[0].type, contactId: rows[0].contact_id, payload: rows[0].payload };
}

describe("when a sequence starts", () => {
  it("starts the Balanced sequence once the AI's answer goes unanswered, dated from that answer, and only once per answer", async () => {
    const c = await inbound(m.org.id);
    const { sentAt } = await aiAnswer(m, c.conversationId);
    const run = await planFollowUps({ now: soon() });
    expect(run.planned).toBeGreaterThanOrEqual(1);
    const plans = await plansFor(c.contactId);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ status: "active", conversation_id: c.conversationId, max_attempts: 3 });
    const steps = await stepsOf(plans[0].id);
    expect(steps.map((s) => (new Date(s.due_at).getTime() - sentAt.getTime()) / DAY)).toEqual([1, 3, 7]);
    expect(steps.every((s) => s.status === "scheduled" && s.channel === "sms")).toBe(true);

    // Running again changes nothing.
    await planFollowUps({ now: soon() });
    expect(await plansFor(c.contactId)).toHaveLength(1);

    // They reply: the sequence stops, and nothing restarts until the AI answers again.
    await inbound(m.org.id, { address: c.address, body: "Is Friday possible instead?" });
    expect((await plansFor(c.contactId))[0]).toMatchObject({ status: "cancelled", cancel_reason: "customer_replied" });
    await planFollowUps({ now: soon() });
    expect(await plansFor(c.contactId)).toHaveLength(1);
    await aiAnswer(m, c.conversationId);
    await planFollowUps({ now: soon() });
    const after = await plansFor(c.contactId);
    expect(after).toHaveLength(2);
    expect(after[1].status).toBe("active");
  });

  it("leaves alone conversations a person owns, booking confirmations, people with an appointment or an open escalation, and workspaces with follow-ups off", async () => {
    const taken = await inbound(m.org.id);
    await aiAnswer(m, taken.conversationId);
    await takeOverConversation(m.ctx("manager"), taken.conversationId);

    const confirmed = await inbound(m.org.id);
    await aiAnswer(m, confirmed.conversationId, { dedupeKey: `booking-confirm:${crypto.randomUUID()}` });

    const booked = await inbound(m.org.id);
    await aiAnswer(m, booked.conversationId);
    await withSystem((db) => db.query(
      "insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, status, start_at, end_at, contact_id) values ($1, $2, 'cal_1', 'confirmed', $3, $4, $5)",
      [m.org.id, `appt_${crypto.randomUUID()}`, new Date(Date.now() + 2 * DAY), new Date(Date.now() + 2 * DAY + 3_600_000), booked.contactId],
    ));

    const escalated = await inbound(m.org.id);
    await aiAnswer(m, escalated.conversationId);
    await withSystem((db) => db.query(
      "insert into human_escalations (org_id, conversation_id, contact_id, category, urgency, summary, status) values ($1, $2, $3, 'human_requested', 'normal', 'Wants a person', 'open')",
      [m.org.id, escalated.conversationId, escalated.contactId],
    ));

    const off = await messagingOrg({ name: "Follow-ups Off Co" });
    await withSystem((db) => db.query("update messaging_settings set followup_preset = 'off' where org_id = $1", [off.org.id]));
    const quiet = await inbound(off.org.id);
    await aiAnswer(off, quiet.conversationId);

    await planFollowUps({ now: soon() });
    for (const c of [taken, confirmed, booked, escalated, quiet]) expect(await plansFor(c.contactId)).toEqual([]);
  });

  it("gives a person one sequence across SMS and WhatsApp, and sends one follow-up per step, not one per channel", async () => {
    const number = phone();
    const sms = await inbound(m.org.id, { address: number, channel: "sms" });
    const wa = await inbound(m.org.id, { address: number, channel: "whatsapp" });
    expect(wa.contactId).toBe(sms.contactId);
    const first = await aiAnswer(m, sms.conversationId);
    await aiAnswer(m, wa.conversationId);
    await planFollowUps({ now: soon() });
    const plans = await plansFor(sms.contactId);
    expect(plans).toHaveLength(1);
    // Dated from their most recent answer.
    expect(plans[0].created_at.getTime()).toBeGreaterThanOrEqual(first.sentAt.getTime());
    await processDueFollowUps({ now: new Date(Date.now() + DAY + 5 * 60_000), plan: false });
    const msgs = await withSystem((db) => db.query<{ id: string }>(
      "select m.id from conversation_messages m join conversations c on c.id = m.conversation_id where c.contact_id = $1 and m.scope = 'followup'",
      [sms.contactId],
    ));
    expect(msgs.rows).toHaveLength(1);
  });

  it("records once that someone already had the 30-day maximum, instead of checking them on every run", async () => {
    await withSystem((db) => db.query("update messaging_policy set max_followups_per_contact_30d = 0"));
    try {
      const c = await inbound(m.org.id);
      await aiAnswer(m, c.conversationId);
      await planFollowUps({ now: soon() });
      const plans = await plansFor(c.contactId);
      expect(plans).toHaveLength(1);
      expect(plans[0]).toMatchObject({ status: "cancelled", cancel_reason: "followup_limit" });
      expect(plans[0].closed_at?.getTime()).toBe(plans[0].created_at.getTime());
      expect(await stepsOf(plans[0].id)).toEqual([]);
      await planFollowUps({ now: soon() });
      expect(await plansFor(c.contactId)).toHaveLength(1);
      const view = await getFollowUpWorkspace(owner(), {});
      expect(view.stats.notStarted30d).toBeGreaterThanOrEqual(1);
    } finally {
      await withSystem((db) => db.query("update messaging_policy set max_followups_per_contact_30d = 6"));
    }
  });

  it("runs the planner as part of the scheduled follow-up job", async () => {
    const c = await inbound(m.org.id);
    await aiAnswer(m, c.conversationId);
    const r = await processDueFollowUps({ now: soon() });
    expect(r.planned).toBeGreaterThanOrEqual(1);
    expect((await plansFor(c.contactId))[0]?.status).toBe("active");
  });
});

describe("what stops a sequence", () => {
  it("stops follow-ups when a native booking is made (appointment.booked), and does nothing the second time", async () => {
    const org = await messagingOrg({ name: "Native Booking Co" });
    const actor = owner(org);
    await setHostAvailability(actor, org.people.owner.id, { timezone: "UTC", rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 })) });
    const cal = await createCalendar(actor, { name: "Consults", assignment: "single", members: [{ userId: org.people.owner.id }] });
    const type = await createAppointmentType(actor, cal.id, { name: "Consult", durationMinutes: 30 });
    const c = await inbound(org.org.id);
    const plan = await withSystem((db) => startFollowUps(db, { orgId: org.org.id, conversationId: c.conversationId }));
    expect(plan.planId).not.toBeNull();

    await bookNativeAppointment(actor, { typeId: type.id, startAt: new Date("2026-10-20T10:00:00Z"), contact: { id: c.contactId }, via: "staff", now: new Date("2026-10-19T00:00:00Z") });
    // A native booking only records the event; the dispatcher's subscriber is what stops the sequence.
    expect((await plansFor(c.contactId))[0].status).toBe("active");
    const event = await latestEvent(org.org.id, "appointment.booked", c.contactId);
    const r = await withSystem((db) => followUpsOnEvent(db, event));
    expect(r).toMatchObject({ action: "stopped", reason: "customer_booked", cancelledPlans: 1 });
    expect((await plansFor(c.contactId))[0]).toMatchObject({ status: "cancelled", cancel_reason: "customer_booked" });
    expect((await stepsOf(plan.planId as string)).every((s) => s.status === "cancelled")).toBe(true);
    expect(await withSystem((db) => followUpsOnEvent(db, event))).toMatchObject({ action: "stopped", cancelledPlans: 0 });
  });

  it("stops follow-ups when consent is withdrawn (contact.consent_changed to revoked), but not when it is granted", async () => {
    const c = await inbound(m.org.id);
    const plan = await withSystem((db) => startFollowUps(db, { orgId: m.org.id, conversationId: c.conversationId }));
    await setContactConsent(owner(), c.contactId, { channel: "email", purpose: "marketing", status: "granted", evidence: "Ticked the newsletter box" });
    const granted = await latestEvent(m.org.id, "contact.consent_changed", c.contactId);
    expect(await withSystem((db) => followUpsOnEvent(db, granted))).toMatchObject({ action: "none" });
    expect((await plansFor(c.contactId))[0].status).toBe("active");

    // Queue the first follow-up, so cancelling also has to stop a message that hasn't gone yet.
    await withSystem((db) => db.query("update follow_up_steps set due_at = now() - interval '1 minute' where plan_id = $1 and step_number = 1", [plan.planId]));
    await processDueFollowUps({ plan: false });
    const queued = (await stepsOf(plan.planId as string))[0];
    expect(queued.status).toBe("queued");

    await setContactConsent(owner(), c.contactId, { channel: "sms", purpose: "service", status: "revoked", evidence: "" });
    const revoked = await latestEvent(m.org.id, "contact.consent_changed", c.contactId);
    expect(await withSystem((db) => followUpsOnEvent(db, revoked))).toMatchObject({ action: "stopped", reason: "consent_invalid", cancelledPlans: 1, cancelledMessages: 1 });
    expect((await plansFor(c.contactId))[0]).toMatchObject({ status: "cancelled", cancel_reason: "consent_invalid" });
    const msg = await withSystem((db) => db.query<{ status: string; blocked_reason: string }>("select status, blocked_reason from conversation_messages where id = $1", [queued.message_id]));
    expect(msg.rows[0]).toMatchObject({ status: "blocked", blocked_reason: "consent_invalid" });
    // Events this subscriber doesn't handle, and events without a contact, are ignored.
    expect(await withSystem((db) => followUpsOnEvent(db, { ...revoked, type: "contact.updated" }))).toMatchObject({ action: "none" });
    expect(await withSystem((db) => followUpsOnEvent(db, { ...revoked, contactId: null }))).toMatchObject({ action: "none" });
  });

  it("still stops on a reply, an opt-out and a person taking over (already built; checked on planner-made sequences)", async () => {
    const cases = [
      ["customer_replied", (c: Awaited<ReturnType<typeof inbound>>) => inbound(m.org.id, { address: c.address, body: "Sounds good" })],
      ["customer_opted_out", (c: Awaited<ReturnType<typeof inbound>>) => inbound(m.org.id, { address: c.address, body: "STOP" })],
      ["human_took_over", (c: Awaited<ReturnType<typeof inbound>>) => takeOverConversation(m.ctx("manager"), c.conversationId)],
    ] as const;
    for (const [reason, trigger] of cases) {
      const c = await inbound(m.org.id);
      await aiAnswer(m, c.conversationId);
      await planFollowUps({ now: soon() });
      expect((await plansFor(c.contactId))[0]?.status, reason).toBe("active");
      await trigger(c);
      expect((await plansFor(c.contactId))[0], reason).toMatchObject({ status: "cancelled", cancel_reason: reason });
    }
  });

  it("lets an owner stop one person's follow-ups, recorded on their timeline; other roles can't", async () => {
    const c = await inbound(m.org.id);
    await withSystem((db) => startFollowUps(db, { orgId: m.org.id, conversationId: c.conversationId }));
    await expect(stopContactFollowUps(memberActor(m.ctx("sales")), c.contactId)).rejects.toThrow(/owners and managers/);
    expect(await stopContactFollowUps(owner(), c.contactId)).toMatchObject({ cancelledPlans: 1 });
    expect((await plansFor(c.contactId))[0]).toMatchObject({ status: "cancelled", cancel_reason: "stopped_by_team" });
    const act = await withSystem((db) => db.query("select 1 from crm_activities where contact_id = $1 and kind = 'follow_up.stopped'", [c.contactId]));
    expect(act.rows).toHaveLength(1);
    await expect(stopContactFollowUps(owner(), c.contactId)).rejects.toThrow(/no follow-ups scheduled/);
    const other = await messagingOrg({ name: "Elsewhere Co" });
    await expect(stopContactFollowUps(owner(other), c.contactId)).rejects.toThrow(/not found/);
  });
});

describe("the workspace's style, inside iAcquire's limits", () => {
  const limits: FollowUpLimits = { maxAttempts: 5, maxPer30Days: 6, minHoursBetween: 20, quietHoursStart: "21:00", quietHoursEnd: "08:00", whatsappWindowHours: 24 };

  it("checks a custom sequence against the limits", () => {
    expect(customFollowUpIssues({ attempts: 3, daysBetween: [1, 2, 4], channel: "same", businessHoursOnly: true }, limits)).toEqual([]);
    expect(customFollowUpIssues({ attempts: 0, daysBetween: [1], channel: "same", businessHoursOnly: true }, limits)[0]).toMatch(/between 1 and 5/);
    expect(customFollowUpIssues({ attempts: 6, daysBetween: [1], channel: "same", businessHoursOnly: true }, limits)[0]).toMatch(/between 1 and 5/);
    expect(customFollowUpIssues({ attempts: 2, daysBetween: [0], channel: "same", businessHoursOnly: true }, limits)[0]).toMatch(/from 1 to 30/);
    expect(customFollowUpIssues({ attempts: 2, daysBetween: [31], channel: "same", businessHoursOnly: true }, limits)[0]).toMatch(/from 1 to 30/);
    expect(customFollowUpIssues({ attempts: 2, daysBetween: [1, 1], channel: "same", businessHoursOnly: true }, { ...limits, minHoursBetween: 48 })[0]).toMatch(/from 2 to 30.*48 hours/);
    expect(customFollowUpIssues({ attempts: 2, daysBetween: [2], channel: "pigeon" as never, businessHoursOnly: true }, limits)).toContain("Choose a channel.");
    expect(customFollowUpIssues(null, limits)).toHaveLength(1);
    expect(maxCustomAttempts({ ...limits, maxPer30Days: 2 })).toBe(2);
    expect(minGapDays({ ...limits, minHoursBetween: 49 })).toBe(3);
  });

  it("keeps every preset inside the agency's maximums", () => {
    expect(effectiveDays("gentle", null, limits)).toEqual([1, 4]);
    expect(effectiveDays("balanced", null, limits)).toEqual([1, 3, 7]);
    expect(effectiveDays("persistent", null, limits)).toEqual([1, 2, 4, 7, 10]);
    expect(effectiveDays("persistent", null, { ...limits, maxAttempts: 2 })).toEqual([1, 2]);
    expect(effectiveDays("persistent", null, { ...limits, maxPer30Days: 3 })).toEqual([1, 2, 4]);
    expect(effectiveDays("off", null, limits)).toEqual([]);
    expect(effectiveDays("custom", { attempts: 4, daysBetween: [2, 5], channel: "same", businessHoursOnly: true }, limits)).toEqual([2, 7, 12, 17]);
  });

  it("previews when each follow-up would go out, after quiet hours and outside business hours", () => {
    // A Wednesday 22:00 UTC: the first follow-up falls due Thursday 22:00, inside quiet hours, so it waits for 08:00 Friday.
    const p = previewSchedule({ preset: "balanced", custom: null, limits, start: new Date("2026-10-21T22:00:00Z"), timeZone: "UTC", businessHours: null });
    expect(p.steps.map((s) => s.day)).toEqual([1, 3, 7]);
    expect(p.steps[0]).toMatchObject({ dueAt: "2026-10-22T22:00:00.000Z", sendAt: "2026-10-23T08:00:00.000Z", held: true });
    const daytime = previewSchedule({ preset: "gentle", custom: null, limits, start: new Date("2026-10-21T10:00:00Z"), timeZone: "UTC", businessHours: { mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]], wed: [["09:00", "17:00"]], thu: [["09:00", "17:00"]], fri: [["09:00", "17:00"]] } });
    expect(daytime.steps[0]).toMatchObject({ sendAt: "2026-10-22T10:00:00.000Z", held: false });
    // Day 4 is a Sunday: held until Monday 09:00 for business hours.
    expect(daytime.steps[1]).toMatchObject({ dueAt: "2026-10-25T10:00:00.000Z", sendAt: "2026-10-26T09:00:00.000Z", held: true });
  });

  it("lets owners and managers choose a style, refuses anything outside the limits, and switching off stops running sequences", async () => {
    const org = await messagingOrg({ name: "Style Co" });
    await expect(saveFollowUpSettings(memberActor(org.ctx("sales")), { preset: "gentle" })).rejects.toThrow(/owners and managers/);
    await expect(saveFollowUpSettings(owner(org), { preset: "relentless" })).rejects.toThrow(/Choose a follow-up style/);
    await expect(saveFollowUpSettings(owner(org), { preset: "custom", custom: { attempts: 9, daysBetween: [1], channel: "same", businessHoursOnly: true } })).rejects.toThrow(/between 1 and 5/);
    await expect(saveFollowUpSettings(owner(org), { preset: "custom", custom: { attempts: 2, daysBetween: [45], channel: "same", businessHoursOnly: true } })).rejects.toThrow(/from 1 to 30/);
    await expect(saveFollowUpSettings(owner(org), { preset: "custom", custom: null })).rejects.toThrow();

    await saveFollowUpSettings(memberActor(org.ctx("manager")), { preset: "custom", custom: { attempts: 2, daysBetween: [2, 3, 9], channel: "same", businessHoursOnly: false } });
    let view = await getFollowUpWorkspace(owner(org));
    expect(view.preset).toBe("custom");
    // Gaps beyond the number of attempts are dropped.
    expect(view.custom).toEqual({ attempts: 2, daysBetween: [2, 3], channel: "same", businessHoursOnly: false });
    const audit = await withSystem((db) => db.query("select 1 from audit_logs where org_id = $1 and action = 'messaging.followups_changed'", [org.org.id]));
    expect(audit.rows.length).toBeGreaterThanOrEqual(1);

    // New sequences use it.
    const c = await inbound(org.org.id);
    const now = new Date();
    const plan = await withSystem((db) => startFollowUps(db, { orgId: org.org.id, conversationId: c.conversationId, now }));
    expect((await stepsOf(plan.planId as string)).map((s) => (new Date(s.due_at).getTime() - now.getTime()) / DAY)).toEqual([2, 5]);

    // Off stops the sequences that are running and starts no new ones.
    expect(await saveFollowUpSettings(owner(org), { preset: "off" })).toEqual({ stoppedPlans: 1 });
    expect((await plansFor(c.contactId))[0]).toMatchObject({ status: "cancelled", cancel_reason: "followups_turned_off" });
    view = await getFollowUpWorkspace(owner(org));
    expect(view.preset).toBe("off");
    expect(view.custom).toMatchObject({ attempts: 2 });
  });

  it("sends nothing more for a running sequence once follow-ups are switched off from any settings screen", async () => {
    const org = await messagingOrg({ name: "Switched Off Later Co" });
    const c = await inbound(org.org.id);
    const plan = await withSystem((db) => startFollowUps(db, { orgId: org.org.id, conversationId: c.conversationId, now: new Date(Date.now() - 2 * DAY) }));
    // The messaging settings page writes the preset directly, without stopping running sequences itself.
    await withSystem((db) => db.query("update messaging_settings set followup_preset = 'off' where org_id = $1", [org.org.id]));
    await processDueFollowUps({ plan: false });
    expect((await plansFor(c.contactId))[0]).toMatchObject({ status: "cancelled", cancel_reason: "followups_turned_off" });
    expect((await stepsOf(plan.planId as string)).every((s) => s.status === "cancelled" && s.message_id === null)).toBe(true);
    const sent = await withSystem((db) => db.query("select 1 from conversation_messages where org_id = $1 and scope = 'followup'", [org.org.id]));
    expect(sent.rows).toEqual([]);
  });

  it("sends on the preferred channel when the person has an address and consent there, and on theirs otherwise", async () => {
    const org = await messagingOrg({ name: "Channel Preference Co" });
    await saveFollowUpSettings(owner(org), { preset: "custom", custom: { attempts: 1, daysBetween: [1], channel: "email", businessHoursOnly: false } });
    const noEmail = await inbound(org.org.id);
    const withEmail = await inbound(org.org.id);
    await withSystem((db) => db.query("insert into contact_identities (org_id, contact_id, kind, value, verified) values ($1, $2, 'email', $3, false)", [org.org.id, withEmail.contactId, `pref-${crypto.randomUUID().slice(0, 8)}@example.test`]));
    await setContactConsent(owner(org), withEmail.contactId, { channel: "email", purpose: "service", status: "granted", evidence: "Asked for updates by email" });
    const start = new Date(Date.now() - 2 * DAY);
    const p1 = await withSystem((db) => startFollowUps(db, { orgId: org.org.id, conversationId: noEmail.conversationId, now: start }));
    const p2 = await withSystem((db) => startFollowUps(db, { orgId: org.org.id, conversationId: withEmail.conversationId, now: start }));
    expect((await stepsOf(p1.planId as string))[0].channel).toBe("email");
    await processDueFollowUps({ plan: false });

    const s1 = (await stepsOf(p1.planId as string))[0];
    expect(s1).toMatchObject({ channel: "sms", reason: "preferred_channel_unreachable", status: "queued" });
    const s2 = (await stepsOf(p2.planId as string))[0];
    expect(s2.status).toBe("queued");
    const conv = await withSystem((db) => db.query<{ channel: string; owner_kind: string; contact_id: string }>(
      "select c.channel, c.owner_kind, c.contact_id from conversation_messages m join conversations c on c.id = m.conversation_id where m.id = $1",
      [s2.message_id],
    ));
    expect(conv.rows[0]).toEqual({ channel: "email", owner_kind: "ai", contact_id: withEmail.contactId });
  });
});

describe("the Follow-up Sequences screen", () => {
  it("estimates cost only from published rates and says when a rate isn't published", async () => {
    const org = await messagingOrg({ name: "Rates Co", provider: { sms: "twilio" }, publishNativeRates: false });
    const view = await getFollowUpWorkspace(owner(org));
    const sms = view.channels.find((c) => c.channel === "sms")!;
    const email = view.channels.find((c) => c.channel === "email")!;
    expect(sms).toMatchObject({ provider: "twilio", clientMicrosPerUnit: null });
    expect(estimateSequenceMicros(sms.clientMicrosPerUnit, "sms", view.businessName, 3)).toBeNull();
    const published = await withSystem((db) => db.query<{ c: string }>(
      "select r.client_micros_per_unit::text as c from usage_unit_rates r join usage_rate_versions v on v.id = r.rate_version_id where r.provider = 'ghl' and r.unit_type = 'email_send' order by v.version desc limit 1",
    ));
    expect(email).toMatchObject({ provider: "ghl", clientMicrosPerUnit: Number(published.rows[0].c) });
    expect(estimateSequenceMicros(email.clientMicrosPerUnit, "email", view.businessName, 3)).toBe(3 * Math.ceil(Number(published.rows[0].c)));
    // SMS is priced per segment of the text that is actually sent.
    expect(followUpUnits("sms", "Rates Co", 2)).toEqual([1, 2].map((n) => Math.max(1, smsSegments(DEFAULT_FOLLOWUP_TEXT("Rates Co", n)))));
    expect(estimateSequenceMicros(8000, "sms", "Rates Co", 2)).toBe(followUpUnits("sms", "Rates Co", 2).reduce((s, u) => s + 8000 * u, 0));
  });

  it("shows who is due next to people who can see every conversation, and only counts to everyone else", async () => {
    const org = await messagingOrg({ name: "Screen Co" });
    const c = await inbound(org.org.id, { name: "Dana Due" });
    await withSystem((db) => startFollowUps(db, { orgId: org.org.id, conversationId: c.conversationId }));
    const full = await getFollowUpWorkspace(owner(org));
    expect(full.canSeePeople).toBe(true);
    expect(full.stats).toMatchObject({ active: 1, started30d: 1 });
    expect(full.upcoming.filter((u) => u.contactId === c.contactId).map((u) => u.stepNumber)).toEqual([1, 2, 3]);
    expect(full.upcoming[0]).toMatchObject({ contactName: "Dana Due", conversationId: c.conversationId, status: "scheduled", maxAttempts: 3 });
    expect(full.limits).toMatchObject({ maxAttempts: 5, maxPer30Days: 6 });
    const sales = await getFollowUpWorkspace(memberActor(org.ctx("sales")));
    expect(sales).toMatchObject({ canSeePeople: false, upcoming: [], history: [] });
    expect(sales.stats.active).toBe(1);
  });

  it("renders the screen: style, preview, published-rate costs, who is due next and delivery history", async () => {
    const org = await messagingOrg({ name: "Render Co", provider: { sms: "twilio" }, publishNativeRates: false });
    const c = await inbound(org.org.id, { name: "Rhea Render" });
    await withSystem((db) => startFollowUps(db, { orgId: org.org.id, conversationId: c.conversationId }));
    const actor = owner(org);
    const page = renderToStaticMarkup(await FollowUpsView({ actor, scope: await scopeFor(actor, "/crm") })).replace(/<!-- -->/g, "");
    expect(page).toContain("Follow-up sequences");
    expect(page).toContain("Balanced");
    expect(page).toContain("3 follow-ups: days 1, 3 and 7");
    expect(page).toContain("Rate not published");
    expect(page).toContain("Rhea Render");
    expect(page).toContain("Stop follow-ups");
    expect(page).toContain(`href="/inbox?conversation=${c.conversationId}"`);
    expect(page).toContain("Save follow-up style");

    const sales = memberActor(org.ctx("sales"));
    const limited = renderToStaticMarkup(await FollowUpsView({ actor: sales, scope: await scopeFor(sales, "/crm") })).replace(/<!-- -->/g, "");
    expect(limited).not.toContain("Rhea Render");
    expect(limited).not.toContain("Save follow-up style");
    expect(limited).toContain("Only owners and managers can change how follow-ups work.");
  });
});
