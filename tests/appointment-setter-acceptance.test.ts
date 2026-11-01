// Appointment Setter acceptance, on the production configuration: a workspace whose default zone is UTC, one host who works Monday to Friday 9:00-17:00 in Manila, a 30-minute
// "Free Consultation" with a 15-minute buffer, 24 hours' notice and "you confirm", booking page off. Everything goes through the real chat flow, the real job runner, the real
// approval and the real CRM tables; the expected times are derived below by plain arithmetic that shares no code with the calendar service. Synthetic data only: nothing here
// calls Hermes for a model answer (the mock gateway records every request, and a run would show), contacts a provider, or sends a message.
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { RATE_LIMITS } from "@/server/security/rate-limit";
import { sendChatMessage } from "@/server/chat/service";
import { decideApproval } from "@/server/approvals/service";
import { setNativeAppointmentStatus } from "@/server/calendars/booking";
import { nativeAvailability } from "@/server/calendars/native-availability";
import { createAppointmentType, createCalendar, setHostAvailability } from "@/server/calendars/setup";
import { connectHermesProfile, createConfigVersion, runHealthCheck } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { agentId, createUser, ctxFor } from "./support/fixtures";
import { crmOrg, type CrmOrg } from "./support/crm";
import { startMockHermes, type MockHermes } from "./support/mock-hermes";

const KEY = "a".repeat(40);
const PROFILE = "c-acceptance-appointment-setter";
const DAY = 86_400_000;
const MANILA_OFFSET = 8 * 3_600_000; // Manila is UTC+8 all year, so no daylight-saving rule can hide a mistake here.
const WEEKDAYS_9_TO_5 = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));

/** Every start the calendar must offer from `now`, by arithmetic: Manila weekdays, 09:00 to 16:30 every 30 minutes, at least 24 hours out, inside the next seven days. */
function offeredStarts(now: number): number[] {
  const earliest = now + DAY;
  const end = now + 7 * DAY;
  const out: number[] = [];
  const firstDay = Math.floor((now + MANILA_OFFSET) / DAY);
  for (let day = firstDay; day <= firstDay + 8; day += 1) {
    const weekday = new Date(day * DAY).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const midnight = day * DAY - MANILA_OFFSET;
    for (let minute = 9 * 60; minute + 30 <= 17 * 60; minute += 30) {
      const start = midnight + minute * 60_000;
      if (start >= earliest && start < end) out.push(start);
    }
  }
  return out;
}
const manilaMinuteOfDay = (instant: number) => Math.floor((((instant + MANILA_OFFSET) % DAY) + DAY) % DAY / 60_000);
const manilaWeekday = (instant: number) => new Date(instant + MANILA_OFFSET).getUTCDay();
const isoMinute = (instant: number) => `${new Date(instant).toISOString().slice(0, 16)}Z`;

let mock: MockHermes;
let a: CrmOrg;
let setterId: string;
let contactId: string;
let rivalContactId: string;
const owner = () => a.people.owner;
const ownerCtx = () => ctxFor(owner(), a.org, "owner");

async function resetRateLimit() {
  await withSystem((db) => db.query("delete from rate_limit_buckets where bucket_key = $1", [`${RATE_LIMITS.agentMessageByUser.name}:${owner().id}`]));
}
async function ask(content: string, conversationId?: string) {
  await resetRateLimit();
  const sent = await sendChatMessage(ownerCtx(), { agentRole: "appointment_setter", content, clientMessageId: crypto.randomUUID(), ...(conversationId ? { conversationId } : {}) });
  const reply = (await withSystem((db) => db.query<{ content: string }>("select content from chat_messages where id = $1 and org_id = $2", [sent.assistantMessageId, a.org.id]))).rows[0].content;
  return { ...sent, reply };
}
async function waitForJob(jobId: string) {
  for (let i = 0; i < 400; i += 1) {
    const { rows } = await withSystem((db) => db.query<{ status: string; result: Record<string, unknown>; result_count: number; result_summary: string | null }>(
      "select status, result, result_count, result_summary from ai_work_jobs where id = $1 and org_id = $2", [jobId, a.org.id]));
    if (rows[0] && ["completed", "failed", "blocked", "cancelled"].includes(rows[0].status)) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("availability job did not settle");
}
async function count(sql: string) {
  return Number(((await withSystem((db) => db.query<{ n: number }>(sql, [a.org.id]))).rows[0] as { n: number }).n);
}
const bookings = () => count("select count(*)::int as n from appointment_bookings where org_id = $1");
const appointments = () => count("select count(*)::int as n from appointment_refs where org_id = $1");
const outboundMessages = () => count("select count(*)::int as n from conversation_messages where org_id = $1 and direction = 'outbound'");
const modelRuns = () => mock.requests.filter((request) => request.method === "POST" && request.path === "/v1/runs").length;
const emailOutbox = async () => Number(((await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from email_outbox"))).rows[0] as { n: number }).n);
/** Whether the booking service offers exactly this start right now (the same narrow read the chat flow makes before it previews a time). */
async function offers(start: number) {
  const result = await nativeAvailability(a.org.id, { from: new Date(start - 60_000), to: new Date(start + 60_000), timeZone: "Asia/Manila", limit: 20 });
  return result.ok && result.slots.some((slot) => new Date(slot.start).getTime() === start);
}

beforeAll(async () => {
  mock = await startMockHermes({ [PROFILE]: { key: KEY } });
  a = await crmOrg({ name: "Acceptance Consultations" }); // the workspace zone stays UTC, as on production
  const actor = a.actor("owner");
  await setHostAvailability(actor, owner().id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });
  const calendar = await createCalendar(actor, { name: "iAcquire Consultation", assignment: "single", public: false, isDefault: true, members: [{ userId: owner().id }] });
  await createAppointmentType(actor, calendar.id, {
    name: "Free Consultation", durationMinutes: 30, bufferAfterMinutes: 15, minNoticeMinutes: 24 * 60, maxDaysAhead: 60, locationKind: "phone", requiresConfirmation: true, public: false,
  });

  const admin = await createUser({ platformRole: "agency_super_admin", name: "Acceptance Admin" });
  setterId = await agentId(a.org.id, "appointment_setter");
  await withSystem((db) => createConfigVersion(db, { orgId: a.org.id, agentId: setterId, settings: defaultSettings("appointment_setter"), source: "onboarding", userId: owner().id, apply: true }));
  await connectHermesProfile({ agentId: setterId, baseUrl: mock.url, profile: PROFILE, apiKey: KEY, agencyUserId: admin.id });
  expect(await runHealthCheck(setterId, { userId: admin.id, kind: "agency" })).toMatchObject({ ok: true, status: "online" });

  await withSystem(async (db) => {
    contactId = (await db.query<{ id: string }>("insert into contacts (org_id, display_name) values ($1, 'Acceptance Prospect') returning id", [a.org.id])).rows[0].id;
    rivalContactId = (await db.query<{ id: string }>("insert into contacts (org_id, display_name) values ($1, 'Rival Prospect') returning id", [a.org.id])).rows[0].id;
  });
}, 120_000);

afterAll(async () => {
  await mock.close();
});

describe("Appointment Setter acceptance (production configuration)", () => {
  let chosen: number; // the 12:00 Manila start, at least three days out, that the booking steps use
  let conversationId: string;
  let approvalId: string;
  let bookingId: string;

  it("offers exactly the host's real open times, read in the host's zone: weekdays 9:00-16:30 in Manila, 24 hours out, nothing on the weekend", async () => {
    const before = { bookings: await bookings(), appointments: await appointments(), outbound: await outboundMessages(), runs: modelRuns() };
    const earlier = Date.now();
    const sent = await ask("Check our calendar availability for the next week");
    const job = await waitForJob(sent.jobId!);
    const later = Date.now();
    expect(job.status).toBe("completed");

    const availability = job.result.availability as {
      total: number; truncated: boolean; timeZone: string; displayTimeZone: string; hostTimeZone: string | null; slotMinutes: number;
      slots: Array<{ start: string; end: string }>; days: Array<{ date: string; weekday: string; count: number }>;
    };
    // The count is the real number, from arithmetic done here (a moving "now" can shift a boundary start, hence the one-start tolerance either side).
    const expected = [offeredStarts(earlier).length, offeredStarts(later).length];
    expect(availability.total).toBeGreaterThanOrEqual(Math.min(...expected) - 1);
    expect(availability.total).toBeLessThanOrEqual(Math.max(...expected) + 1);
    expect(availability.total).toBeGreaterThan(50); // it was capped at 50 and presented as the total
    expect(job.result_count).toBe(availability.total);
    expect(availability.truncated).toBe(false);
    expect(availability.slotMinutes).toBe(30);
    // The workspace stays in UTC; the times are read where the host works.
    expect(availability).toMatchObject({ timeZone: "UTC", hostTimeZone: "Asia/Manila", displayTimeZone: "Asia/Manila" });
    expect(job.result_summary).toBe(`Calendar availability checked: ${availability.total} bookable slots on ${availability.days.length} days in the next 7 days (Asia/Manila).`);
    // Every listed start is a real one: a weekday, 9:00 to 16:30 Manila time, on the half hour, at least 24 hours after the check began.
    expect(availability.slots.length).toBeGreaterThan(0);
    for (const slot of availability.slots) {
      const start = new Date(slot.start).getTime();
      expect([1, 2, 3, 4, 5]).toContain(manilaWeekday(start));
      expect(manilaMinuteOfDay(start)).toBeGreaterThanOrEqual(9 * 60);
      expect(manilaMinuteOfDay(start)).toBeLessThanOrEqual(16 * 60 + 30);
      expect(manilaMinuteOfDay(start) % 30).toBe(0);
      expect(start).toBeGreaterThanOrEqual(earlier + DAY - 1_000);
      expect(new Date(slot.end).getTime() - start).toBe(30 * 60_000);
    }
    // Day by day: no weekend, and every whole day in the middle of the window holds all 16 start times.
    expect(availability.days.every((day) => ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(day.weekday))).toBe(true);
    expect(availability.days.slice(1, -1).every((day) => day.count === 16)).toBe(true);
    expect(availability.days.reduce((sum, day) => sum + day.count, 0)).toBe(availability.total);
    // Read-only: nothing held, booked, sent or answered by a model.
    expect({ bookings: await bookings(), appointments: await appointments(), outbound: await outboundMessages(), runs: modelRuns() }).toEqual(before);
  });

  it("never invents availability: a weekend, before opening, after closing, inside the notice period and a time already past are each refused, and nothing is held", async () => {
    const now = Date.now();
    const target = offeredStarts(now).find((start) => start >= now + 3 * DAY)!;
    const day = Math.floor((target + MANILA_OFFSET) / DAY) * DAY - MANILA_OFFSET; // Manila midnight of a weekday three or more days out
    let saturday = day;
    while (manilaWeekday(saturday) !== 6) saturday += DAY;
    const refused: Array<[string, number]> = [
      ["a Saturday at 10:00", saturday + 10 * 3_600_000],
      ["a weekday at 08:30, before the host starts", day + 8.5 * 3_600_000],
      ["a weekday at 17:00, when the host has finished", day + 17 * 3_600_000],
      ["a weekday at 12:15, between two start times", day + 12.25 * 3_600_000],
      ["two hours from now, inside the 24-hour notice", Math.ceil((now + 2 * 3_600_000) / 1_800_000) * 1_800_000],
      ["yesterday at noon", now - DAY],
    ];
    const before = { bookings: await bookings(), appointments: await appointments(), outbound: await outboundMessages() };
    for (const [label, start] of refused) {
      const sent = await ask(`Book an appointment with Acceptance Prospect at ${isoMinute(start)}`);
      expect(sent.reply, label).not.toContain("Appointment preview");
      expect(sent.reply, label).toMatch(/did not reserve or book|No booking|isn't|can't|cannot|couldn't|past|does not currently offer/i);
      const stored = (await withSystem((db) => db.query<{ p: unknown }>("select pending_workforce_booking as p from chat_conversations where id = $1", [sent.conversationId]))).rows[0].p;
      expect(stored, label).toBeNull();
    }
    expect({ bookings: await bookings(), appointments: await appointments(), outbound: await outboundMessages() }).toEqual(before);
    expect(modelRuns()).toBe(0);
  });

  it("previews an offered time without holding it, and submits it for approval only after 'confirm booking', with nothing sent to the customer", async () => {
    const now = Date.now();
    chosen = offeredStarts(now).find((start) => start >= now + 3 * DAY && manilaMinuteOfDay(start) === 12 * 60)!;
    expect(chosen).toBeTruthy();
    expect(await offers(chosen)).toBe(true);
    const before = { appointments: await appointments(), outbound: await outboundMessages(), email: await emailOutbox() };

    const preview = await ask(`Book an appointment with Acceptance Prospect at ${isoMinute(chosen)}`);
    conversationId = preview.conversationId;
    expect(preview.reply).toContain("Appointment preview for Acceptance Prospect");
    expect(preview.reply).toContain("does not hold or book the slot");
    expect(await bookings()).toBe(0);
    expect(await offers(chosen)).toBe(true); // a preview holds nothing

    const confirm = await ask("confirm booking", conversationId);
    expect(confirm.reply).toContain("not booked yet");
    const booking = (await withSystem((db) => db.query<{ id: string; status: string; requested_by_kind: string; requested_by_user: string | null; agent_id: string | null; conversation_id: string | null; approval_id: string | null; start_at: Date }>(
      "select id, status, requested_by_kind, requested_by_user, agent_id, conversation_id, approval_id, start_at from appointment_bookings where org_id = $1", [a.org.id]))).rows;
    expect(booking).toHaveLength(1);
    expect(booking[0]).toMatchObject({ status: "awaiting_approval", requested_by_kind: "ai", requested_by_user: owner().id, agent_id: setterId, conversation_id: null });
    expect(new Date(booking[0].start_at).getTime()).toBe(chosen);
    bookingId = booking[0].id;
    approvalId = booking[0].approval_id!;
    expect(approvalId).toBeTruthy();
    const approval = (await withSystem((db) => db.query<{ kind: string; status: string }>("select kind, status from approval_requests where id = $1 and org_id = $2", [approvalId, a.org.id]))).rows[0];
    expect(approval).toEqual({ kind: "appointment_booking", status: "pending" });
    // Waiting for a person: no CRM appointment yet, and nothing went to the customer by any channel.
    expect(await appointments()).toBe(before.appointments);
    expect({ outbound: await outboundMessages(), email: await emailOutbox() }).toEqual({ outbound: before.outbound, email: before.email });
    // The time is held for the request, so a second prospect asking for it is told it is not offered.
    expect(await offers(chosen)).toBe(false);
    const rival = await ask(`Book an appointment with Rival Prospect at ${isoMinute(chosen)}`);
    expect(rival.reply).not.toContain("Appointment preview");
    expect(await bookings()).toBe(1);
    expect(rivalContactId).toBeTruthy();
  });

  it("on approval creates exactly one CRM appointment for that contact, pending the host's own confirmation, and keeps the time and its 15-minute buffer from being offered again", async () => {
    const decided = await decideApproval(ownerCtx(), approvalId, "approve");
    expect(decided.outcome?.status).toBe("succeeded");
    const booking = (await withSystem((db) => db.query<{ status: string; appointment_id: string | null }>("select status, appointment_id from appointment_bookings where id = $1", [bookingId]))).rows[0];
    expect(booking.status).toBe("booked");
    expect(await appointments()).toBe(1);
    const appointment = (await withSystem((db) => db.query<{
      id: string; provider: string; origin: string; booked_via: string; status: string; start_at: Date; end_at: Date; contact_id: string; title: string; appointment_type_id: string | null;
    }>("select id, provider, origin, booked_via, status, start_at, end_at, contact_id, title, appointment_type_id from appointment_refs where id = $1", [booking.appointment_id]))).rows[0];
    expect(appointment).toMatchObject({ provider: "native", origin: "portal_ai", booked_via: "agent", contact_id: contactId, title: "Free Consultation with Acceptance Prospect" });
    expect(new Date(appointment.start_at).getTime()).toBe(chosen);
    expect(new Date(appointment.end_at).getTime() - chosen).toBe(30 * 60_000);
    // The type says "you confirm": the appointment waits as new until the host confirms it, which is a person's act, never the employee's.
    expect(appointment.status).toBe("new");
    await setNativeAppointmentStatus(a.actor("owner"), appointment.id, "confirmed");
    expect((await withSystem((db) => db.query<{ status: string }>("select status from appointment_refs where id = $1", [appointment.id]))).rows[0].status).toBe("confirmed");

    // No double booking, and the buffer is honoured: the booked start and the half hour on either side (whose 15-minute buffer would touch it) are gone; an hour away is still open.
    expect(await offers(chosen - 3_600_000)).toBe(true);
    expect(await offers(chosen - 1_800_000)).toBe(false);
    expect(await offers(chosen)).toBe(false);
    expect(await offers(chosen + 1_800_000)).toBe(false);
    expect(await offers(chosen + 3_600_000)).toBe(true);
    const again = await ask(`Book an appointment with Rival Prospect at ${isoMinute(chosen)}`);
    expect(again.reply).not.toContain("Appointment preview");
    expect(await appointments()).toBe(1);

    // The whole acceptance ran without a model, a customer message or an email.
    expect(modelRuns()).toBe(0);
    expect(await outboundMessages()).toBe(0);
    expect(await emailOutbox()).toBe(0);
  });
});
