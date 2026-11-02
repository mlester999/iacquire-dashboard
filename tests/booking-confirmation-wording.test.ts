// What a customer and the team are told about a booking, by whether a person still has to confirm it. When an appointment type says "a person confirms each booking", an AI booking
// lands on the calendar as `new`: the time is held, but nobody has said yes. Until a person does, nothing may call it booked or confirmed. These tests run the real flow (the responder,
// the booking service, the native calendar, the message rule chain, the approval) against synthetic workspaces; no provider is contacted and no model is called.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { memberActor } from "@/server/crm/actor";
import { decideApproval } from "@/server/approvals/service";
import { setNativeAppointmentStatus } from "@/server/calendars/booking";
import { createAppointmentType, createCalendar, setHostAvailability } from "@/server/calendars/setup";
import { respondToConversation, type ReplyGenerator } from "@/server/messaging/responder";
import { bookingCustomerText, bookingMessageKey, queueHostConfirmationMessage, reservedText, runStaleConfirmationWatch } from "@/server/appointments/confirmation-watch";
import { awaitingHostConfirmation, claimDueReminders, queueClaimedReminder } from "@/server/appointments/reminders";
import { formatSlot } from "@/lib/appointments";
import { rescheduleNativeAppointment } from "@/server/calendars/booking";
import { readPerformanceMetrics } from "@/server/workforce/performance-snapshot";
import { inbound, messagingOrg, type MessagingOrg } from "./support/messaging";

const WEEKDAYS_9_TO_5 = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));
const HOUR = 3_600_000;

/** A workspace with a messaging channel, a Sales Assistant that can book, one host working Monday to Friday 9:00-17:00 in Manila, and one native appointment type. */
async function bookingOrg(name: string, opts: { requiresConfirmation: boolean; autonomous?: boolean }) {
  const m = await messagingOrg({ name, autonomous: opts.autonomous ?? true });
  const ctx = m.ctx("owner");
  ctx.org.timezone = "UTC";
  const actor = memberActor(ctx);
  await setHostAvailability(actor, m.people.owner.id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });
  const calendar = await createCalendar(actor, { name: "Consultations", assignment: "single", public: false, isDefault: true, members: [{ userId: m.people.owner.id }] });
  // Three days' notice, so every offered start is far from "now" and the stale-confirmation window is easy to place.
  const type = await createAppointmentType(actor, calendar.id, {
    name: "Consultation", durationMinutes: 30, bufferAfterMinutes: 0, minNoticeMinutes: 72 * 60, maxDaysAhead: 60, locationKind: "phone", requiresConfirmation: opts.requiresConfirmation, public: false,
  });
  await withSystem((db) =>
    db.query(
      "insert into appointment_settings (org_id, ai_booking_enabled, reminders_enabled) values ($1, true, true) on conflict (org_id) do update set ai_booking_enabled = true, reminders_enabled = true",
      [m.org.id],
    ),
  );
  return { m, actor, ownerCtx: ctx, typeId: type.id };
}

/** The model chooses the first time the calendar offered, exactly as the responder allows. */
const takeFirstSlot: ReplyGenerator = async (ctx) => {
  if (ctx.availability?.state !== "slots") return { kind: "unavailable", reason: `no offered times: ${JSON.stringify(ctx.availability)}` };
  return { kind: "book", startIso: ctx.availability.slots[0].start, summary: "Consultation" };
};

async function askToBook(m: MessagingOrg) {
  const c = await inbound(m.org.id, { body: "I'd like to book an appointment please" });
  const out = await respondToConversation(m.org.id, c.conversationId, { generate: takeFirstSlot });
  return { ...c, out };
}
const one = async <T,>(sql: string, params: unknown[]) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const bookingOf = async (orgId: string) => (await one<{ id: string; status: string; appointment_id: string | null; approval_id: string | null; conversation_id: string | null }>("select id, status, appointment_id, approval_id, conversation_id from appointment_bookings where org_id = $1", [orgId]))[0];
const apptStatus = async (id: string) => (await one<{ status: string }>("select status from appointment_refs where id = $1", [id]))[0].status;
const messagesFor = (orgId: string, like: string) => one<{ body: string; status: string; blocked_reason: string | null; approval_id: string | null; dedupe_key: string }>(
  "select body, status, blocked_reason, approval_id, dedupe_key from conversation_messages where org_id = $1 and direction = 'outbound' and dedupe_key like $2 order by created_at", [orgId, like]);
const reminders = async (apptId: string) => Number((await one<{ n: number }>("select count(*)::int as n from appointment_reminders where appointment_id = $1 and status in ('scheduled', 'queued', 'sent')", [apptId]))[0].n);
const metric = async (orgId: string, key: string) => (await withSystem((db) => readPerformanceMetrics(db, orgId))).metrics.find((x) => x.key === key)?.value;

describe("a type that needs a person to confirm each booking", () => {
  it("tells the customer the time is reserved and the team will confirm it, never that it is booked or confirmed", async () => {
    const { m } = await bookingOrg("Needs Yes Co", { requiresConfirmation: true });
    const { out } = await askToBook(m);
    expect(out, JSON.stringify(out)).toMatchObject({ status: "queued" });

    const booking = await bookingOf(m.org.id);
    // The booking is recorded and the time held, but the appointment waits for a person.
    expect(booking.status).toBe("booked");
    expect(await apptStatus(booking.appointment_id as string)).toBe("new");

    const sent = await messagesFor(m.org.id, "booking-%");
    expect(sent).toHaveLength(1);
    expect(sent[0].dedupe_key).toBe(bookingMessageKey(booking.id, "new"));
    expect(sent[0].body).toMatch(/^We've reserved .+ for you\. The team will confirm it shortly\./);
    expect(sent[0].body).not.toMatch(/booked|confirmed/i);
    expect(sent[0].status).toBe("queued");
    // The one message the customer got is the reserved one: the reply the responder writes does not send a second.
    expect(await messagesFor(m.org.id, "reply-to:%")).toHaveLength(0);
  });

  it("schedules no reminder while the appointment waits, and does once the host confirms it", async () => {
    const { m, actor } = await bookingOrg("Needs Yes Reminders Co", { requiresConfirmation: true });
    await askToBook(m);
    const booking = await bookingOf(m.org.id);
    const appt = booking.appointment_id as string;
    expect(await reminders(appt)).toBe(0);
    expect(awaitingHostConfirmation({ provider: "native", status: "new" })).toBe(true);
    expect(awaitingHostConfirmation({ provider: "ghl", status: "new" })).toBe(false);
    expect(awaitingHostConfirmation({ provider: "native", status: "confirmed" })).toBe(false);

    await setNativeAppointmentStatus(actor, appt, "confirmed");
    expect(await reminders(appt)).toBeGreaterThan(0);
  });

  it("counts a waiting booking as 'Awaiting host confirmation', not as 'Appointments booked', until the host confirms it", async () => {
    const { m, actor } = await bookingOrg("Needs Yes KPI Co", { requiresConfirmation: true });
    await askToBook(m);
    const appt = (await bookingOf(m.org.id)).appointment_id as string;
    expect(await metric(m.org.id, "appointments_booked")).toBe(0);
    expect(await metric(m.org.id, "appointments_awaiting_host")).toBe(1);
    expect(await metric(m.org.id, "appointments_upcoming")).toBe(0);
    const labels = (await withSystem((db) => readPerformanceMetrics(db, m.org.id))).metrics;
    expect(labels.find((x) => x.key === "appointments_booked")?.label).toBe("Appointments booked");
    expect(labels.find((x) => x.key === "appointments_awaiting_host")?.label).toBe("Awaiting host confirmation");

    await setNativeAppointmentStatus(actor, appt, "confirmed");
    expect(await metric(m.org.id, "appointments_booked")).toBe(1);
    expect(await metric(m.org.id, "appointments_awaiting_host")).toBe(0);
  });

  it("queues exactly one confirmation message after the host confirms, and never a second", async () => {
    const { m, actor } = await bookingOrg("Needs Yes Confirm Co", { requiresConfirmation: true });
    await askToBook(m);
    const booking = await bookingOf(m.org.id);
    const appt = booking.appointment_id as string;
    expect(await messagesFor(m.org.id, "booking-confirm:%")).toHaveLength(0);

    await setNativeAppointmentStatus(actor, appt, "confirmed");
    const after = await messagesFor(m.org.id, "booking-confirm:%");
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ dedupe_key: bookingMessageKey(booking.id, "confirmed"), status: "queued" });
    expect(after[0].body).toMatch(/is now confirmed/);
    // A repeat of the confirmation (the second press, a retry) finds a settled appointment and sends nothing; the message function itself is idempotent too.
    await expect(setNativeAppointmentStatus(actor, appt, "confirmed")).rejects.toThrow(/waiting for confirmation/);
    expect(await queueHostConfirmationMessage(m.org.id, appt)).toEqual({ queued: false });
    expect(await messagesFor(m.org.id, "booking-confirm:%")).toHaveLength(1);
  });

  it("stays inside the approval policy: an employee that needs approval only drafts the confirmation message", async () => {
    const { m, actor, ownerCtx } = await bookingOrg("Needs Yes Approval Co", { requiresConfirmation: true, autonomous: false });
    const { out } = await askToBook(m);
    expect(out.status === "draft" || out.status === "queued").toBe(true);
    const waiting = await bookingOf(m.org.id);
    expect(waiting.status).toBe("awaiting_approval");
    // The approval the owner is asked for says what will really happen.
    const approval = (await one<{ expected_effect: string }>("select expected_effect from approval_requests where id = $1 and org_id = $2", [waiting.approval_id, m.org.id]))[0];
    expect(approval.expected_effect).toMatch(/waiting for the host's confirmation/);
    expect(approval.expected_effect).not.toMatch(/told it is confirmed/);

    expect((await decideApproval(ownerCtx, waiting.approval_id as string, "approve")).outcome?.status).toBe("succeeded");
    const booking = await bookingOf(m.org.id);
    expect(await apptStatus(booking.appointment_id as string)).toBe("new");
    // The reserved message went under the owner's approval of the booking, and says nothing is settled.
    const reserved = await messagesFor(m.org.id, "booking-requested:%");
    expect(reserved).toHaveLength(1);
    expect(reserved[0].body).not.toMatch(/booked|confirmed/i);

    const sendsBefore = Number((await one<{ n: number }>("select count(*)::int as n from conversation_messages where org_id = $1 and direction = 'outbound' and status in ('queued', 'sending', 'sent')", [m.org.id]))[0].n);
    const approvalsBefore = Number((await one<{ n: number }>("select count(*)::int as n from approval_requests where org_id = $1 and kind = 'follow_up_message'", [m.org.id]))[0].n);
    await setNativeAppointmentStatus(actor, booking.appointment_id as string, "confirmed");
    const confirmation = await messagesFor(m.org.id, "booking-confirm:%");
    expect(confirmation).toHaveLength(1);
    expect(confirmation[0]).toMatchObject({ status: "draft", blocked_reason: "needs_approval" });
    // Nothing went out because of the host's confirmation: a draft and a pending approval for a person.
    expect(Number((await one<{ n: number }>("select count(*)::int as n from conversation_messages where org_id = $1 and direction = 'outbound' and status in ('queued', 'sending', 'sent')", [m.org.id]))[0].n)).toBe(sendsBefore);
    expect(Number((await one<{ n: number }>("select count(*)::int as n from approval_requests where org_id = $1 and kind = 'follow_up_message' and status = 'pending'", [m.org.id]))[0].n)).toBeGreaterThanOrEqual(1);
    expect(Number((await one<{ n: number }>("select count(*)::int as n from approval_requests where org_id = $1 and kind = 'follow_up_message'", [m.org.id]))[0].n)).toBe(approvalsBefore + 1);
  });

  it("sends the customer nothing when the booking has no conversation to answer (a staff-chat booking)", async () => {
    const { m, actor } = await bookingOrg("Needs Yes No Conversation Co", { requiresConfirmation: true });
    const c = await inbound(m.org.id, { body: "Hello" });
    const { requestBooking } = await import("@/server/appointments/booking");
    // 12:00 in Manila, at least five days out, on a weekday.
    const start = new Date(Date.now() + 5 * 24 * HOUR);
    start.setUTCHours(4, 0, 0, 0);
    while ([0, 6].includes(new Date(start.getTime() + 8 * HOUR).getUTCDay())) start.setUTCDate(start.getUTCDate() + 1);
    const result = await requestBooking({ orgId: m.org.id, contactId: c.contactId, startAt: start, actor: { kind: "ai", agentId: m.salesAgentId }, requestSource: "staff_chat", requestedByUserId: m.people.owner.id });
    expect(result).toMatchObject({ status: "booked", appointmentStatus: "new" });
    expect(await messagesFor(m.org.id, "booking-%")).toHaveLength(0);
    if (result.status !== "booked") return;
    await setNativeAppointmentStatus(actor, result.appointmentId, "confirmed");
    expect(await messagesFor(m.org.id, "booking-%")).toHaveLength(0);
  });
});

describe("the confirmation names the time the appointment has now", () => {
  it("says the new time when a waiting appointment was moved before the host confirmed it, and says nothing about a time that has passed or been cancelled", async () => {
    const { m, actor } = await bookingOrg("Moved Before Yes Co", { requiresConfirmation: true });
    await askToBook(m);
    const booking = await bookingOf(m.org.id);
    const appt = booking.appointment_id as string;
    const before = (await one<{ start_at: Date; invitee_timezone: string }>("select start_at, invitee_timezone from appointment_refs where id = $1", [appt]))[0];
    // Staff move the waiting appointment a week later, the same weekday and hour (the host's hours are the same that day). The booking record keeps the time it was made for.
    const moved = new Date(new Date(before.start_at).getTime() + 7 * 24 * HOUR);
    await rescheduleNativeAppointment(actor, appt, { startAt: moved, by: "staff" });
    expect(new Date((await one<{ start_at: Date }>("select start_at from appointment_bookings where id = $1", [booking.id]))[0].start_at).getTime()).toBe(new Date(before.start_at).getTime());

    await setNativeAppointmentStatus(actor, appt, "confirmed");
    const sent = await messagesFor(m.org.id, "booking-confirm:%");
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain(formatSlot(moved.toISOString(), before.invitee_timezone));
    expect(sent[0].body).not.toContain(formatSlot(new Date(before.start_at).toISOString(), before.invitee_timezone));

    // A confirmed appointment whose time has passed, or that was cancelled, is not announced.
    const past = await bookingOrg("Passed Before Yes Co", { requiresConfirmation: true });
    await askToBook(past.m);
    const pastBooking = await bookingOf(past.m.org.id);
    // Confirmed in the records without the usual message, to ask the message function directly.
    await withSystem((db) => db.query("update appointment_refs set status = 'confirmed' where id = $1", [pastBooking.appointment_id]));
    const start = new Date((await one<{ start_at: Date }>("select start_at from appointment_refs where id = $1", [pastBooking.appointment_id]))[0].start_at);
    expect(await queueHostConfirmationMessage(past.m.org.id, pastBooking.appointment_id as string, { now: new Date(start.getTime() + HOUR) })).toEqual({ queued: false });
    expect(await messagesFor(past.m.org.id, "booking-confirm:%")).toHaveLength(0);
    await withSystem((db) => db.query("update appointment_refs set status = 'cancelled' where id = $1", [pastBooking.appointment_id]));
    expect(await queueHostConfirmationMessage(past.m.org.id, pastBooking.appointment_id as string)).toEqual({ queued: false });
    expect(await messagesFor(past.m.org.id, "booking-confirm:%")).toHaveLength(0);
  });
});

describe("a reminder for a booking that still waits for a person", () => {
  const reminderRows = (appt: string) => one<{ status: string; reason: string | null; message_id: string | null }>("select status, reason, message_id from appointment_reminders where appointment_id = $1", [appt]);
  const reminderMessages = async (orgId: string) => Number((await one<{ n: number }>("select count(*)::int as n from conversation_messages where org_id = $1 and scope = 'reminder'", [orgId]))[0].n);

  it("is skipped when claimed, whether it is a row from before this release or one claimed before the appointment went back to waiting", async () => {
    const { m, actor } = await bookingOrg("Legacy Reminder Co", { requiresConfirmation: true });
    await askToBook(m);
    const appt = (await bookingOf(m.org.id)).appointment_id as string;
    expect(await reminders(appt)).toBe(0);
    // A reminder row planned before this release: due, scheduled, for an appointment nobody has confirmed.
    const now = new Date();
    await withSystem((db) => db.query("insert into appointment_reminders (org_id, appointment_id, offset_minutes, due_at) values ($1, $2, 60, $3)", [m.org.id, appt, new Date(now.getTime() - HOUR)]));
    const claimed = await claimDueReminders(now, 100);
    expect(claimed.some((c) => c.appointment_id === appt)).toBe(false);
    expect(await reminderRows(appt)).toEqual([{ status: "skipped", reason: "The appointment is no longer upcoming.", message_id: null }]);
    expect(await reminderMessages(m.org.id)).toBe(0);

    // Once a person confirms it, its reminders are planned as usual; one that was claimed and then found the appointment waiting again is not queued.
    await setNativeAppointmentStatus(actor, appt, "confirmed");
    expect(await reminders(appt)).toBeGreaterThan(0);
    await withSystem((db) => db.query("update appointment_reminders set due_at = $2 where appointment_id = $1 and status = 'scheduled'", [appt, new Date(now.getTime() - HOUR)]));
    const mine = (await claimDueReminders(now, 100)).filter((c) => c.appointment_id === appt);
    expect(mine.length).toBeGreaterThan(0);
    await withSystem((db) => db.query("update appointment_refs set status = 'new' where id = $1", [appt]));
    for (const c of mine) expect(await queueClaimedReminder(c, now)).toBe("skipped");
    expect((await reminderRows(appt)).filter((r) => r.status === "queued" || r.message_id)).toEqual([]);
    expect(await reminderMessages(m.org.id)).toBe(0);
  });
});

describe("a type that does not need a person to confirm", () => {
  it("keeps the booked message and the reminders it always had", async () => {
    const { m } = await bookingOrg("No Yes Needed Co", { requiresConfirmation: false });
    const { out } = await askToBook(m);
    expect(out).toMatchObject({ status: "queued" });
    const booking = await bookingOf(m.org.id);
    expect(await apptStatus(booking.appointment_id as string)).toBe("confirmed");
    const sent = await messagesFor(m.org.id, "booking-%");
    expect(sent).toHaveLength(1);
    expect(sent[0].dedupe_key).toBe(bookingMessageKey(booking.id, "confirmed"));
    expect(sent[0].body).toMatch(/^You're booked for .+\. We look forward to seeing you\. Reply here if you need to change it\.$/);
    expect(await reminders(booking.appointment_id as string)).toBeGreaterThan(0);
    expect(await metric(m.org.id, "appointments_booked")).toBe(1);
    expect(await metric(m.org.id, "appointments_awaiting_host")).toBe(0);
    // Nothing to confirm later: no second message can ever be queued for it.
    expect(await queueHostConfirmationMessage(m.org.id, booking.appointment_id as string)).toEqual({ queued: false });
    expect(await messagesFor(m.org.id, "booking-%")).toHaveLength(1);
  });

  it("asks the owner to approve a booking that 'is confirmed' only when that is what will happen", async () => {
    const { m } = await bookingOrg("No Yes Approval Co", { requiresConfirmation: false, autonomous: false });
    await askToBook(m);
    const waiting = await bookingOf(m.org.id);
    const approval = (await one<{ expected_effect: string }>("select expected_effect from approval_requests where id = $1 and org_id = $2", [waiting.approval_id, m.org.id]))[0];
    expect(approval.expected_effect).toMatch(/told it is confirmed/);
  });
});

describe("the words themselves", () => {
  it("never say booked or confirmed while a person has yet to confirm, and keep the old booked words otherwise", () => {
    const when = "Tuesday 10:00 AM";
    expect(bookingCustomerText("new", when)).toBe(reservedText(when));
    expect(reservedText(when)).toContain("We've reserved Tuesday 10:00 AM for you. The team will confirm it shortly");
    expect(reservedText(when)).not.toMatch(/booked|confirmed/i);
    expect(bookingCustomerText("confirmed", when)).toBe("You're booked for Tuesday 10:00 AM. We look forward to seeing you. Reply here if you need to change it.");
  });

  it("use different message keys for the reserved message and the confirmation, so a booking can send each at most once", () => {
    expect(bookingMessageKey("b1", "new")).toBe("booking-requested:b1");
    expect(bookingMessageKey("b1", "confirmed")).toBe("booking-confirm:b1");
  });
});

describe("a booking nobody confirms", () => {
  const stale = (orgId: string) => one<{ user_id: string }>("select distinct user_id from notifications where org_id = $1 and dedupe_key like 'booking-confirm-stale:%'", [orgId]);
  const staleCount = async (orgId: string) => Number((await one<{ n: number }>("select count(*)::int as n from notifications where org_id = $1 and dedupe_key like 'booking-confirm-stale:%'", [orgId]))[0].n);

  it("reminds the owners, admins and the host once a day, and stops when it is confirmed", async () => {
    const { m, actor } = await bookingOrg("Stale Watch Co", { requiresConfirmation: true });
    await askToBook(m);
    const appt = (await bookingOf(m.org.id)).appointment_id as string;

    // Just booked, and the time is days away: nothing to say yet.
    await runStaleConfirmationWatch({ now: new Date() });
    expect(await stale(m.org.id)).toHaveLength(0);

    // It has now waited three days. The watch's own clock is placed at a fixed hour so "the same day" cannot cross midnight.
    await withSystem((db) => db.query("update appointment_refs set created_at = now() - interval '3 days' where id = $1", [appt]));
    const today = new Date();
    today.setUTCHours(10, 0, 0, 0);
    const first = await runStaleConfirmationWatch({ now: today });
    expect(first.notified).toBeGreaterThanOrEqual(1);
    expect((await stale(m.org.id)).map((r) => r.user_id).sort()).toEqual([m.people.owner.id, m.people.manager.id].sort());
    // The same day again: nobody is told twice.
    expect((await runStaleConfirmationWatch({ now: new Date(today.getTime() + HOUR) })).notified).toBe(0);
    expect(await staleCount(m.org.id)).toBe(2);
    // The next day it is a new day: a new reminder for the same people.
    expect((await runStaleConfirmationWatch({ now: new Date(today.getTime() + 24 * HOUR) })).notified).toBeGreaterThanOrEqual(1);
    expect(await staleCount(m.org.id)).toBe(4);

    // Confirmed: it drops out of the watch.
    await setNativeAppointmentStatus(actor, appt, "confirmed");
    await runStaleConfirmationWatch({ now: new Date(today.getTime() + 48 * HOUR) });
    expect(await staleCount(m.org.id)).toBe(4);
  });

  it("also speaks up when the time is close, skips a suspended workspace, and never tells another workspace's people", async () => {
    const mine = await bookingOrg("Stale Close Co", { requiresConfirmation: true });
    const other = await bookingOrg("Stale Quiet Co", { requiresConfirmation: true });
    await askToBook(mine.m);
    await askToBook(other.m);
    const startOf = async (orgId: string) => new Date((await one<{ start_at: Date }>("select start_at from appointment_refs where org_id = $1", [orgId]))[0].start_at);
    // Two hours before the start, the booking is flagged even though it was only just made.
    const close = new Date((await startOf(mine.m.org.id)).getTime() - 2 * HOUR);
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [other.m.org.id]));
    await runStaleConfirmationWatch({ now: close });
    expect(await staleCount(mine.m.org.id)).toBeGreaterThanOrEqual(2);
    expect(await staleCount(other.m.org.id)).toBe(0);
    await withSystem((db) => db.query("update organizations set status = 'active' where id = $1", [other.m.org.id]));
  });
});
