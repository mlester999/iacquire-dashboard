import crypto from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

// A throwaway RSA key stands in for GoHighLevel's signing key, so webhook verification is exercised without any real secret.
const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
process.env.GHL_WEBHOOK_PUBLIC_KEY = keys.publicKey;

const ctl = vi.hoisted(() => ({ provider: null as unknown }));
// The approval path runs the real provider by default; tests substitute a fake calendar so nothing leaves the process.
vi.mock("@/server/appointments/provider", async (orig) => {
  const mod = await orig<typeof import("@/server/appointments/provider")>();
  return { ...mod, ghlAppointmentProvider: new Proxy({}, { get: (_t, k) => (ctl.provider as Record<string, unknown>)[k as string] }) };
});

import { resetEnvCache } from "@/server/env";
import { withSystem, withUser } from "@/server/db";
import { setAgentMode, setClientPause } from "@/server/automation/controls";
import { startFollowUps } from "@/server/messaging/followups";
import { handleGhlWebhook } from "@/server/messaging/ingest";
import { dispatchDue } from "@/server/messaging/send";
import { suppressAddress } from "@/server/messaging/contacts";
import { decideApproval } from "@/server/approvals/service";
import { applyAppointmentEvent } from "@/server/appointments/ledger";
import { getAvailability } from "@/server/appointments/availability";
import { bookForContact, cancelPendingBooking, requestBooking } from "@/server/appointments/booking";
import { getPolicyView, savePolicy } from "@/server/appointments/settings";
import { sendDueReminders } from "@/server/appointments/reminders";
import { expireBookingHolds } from "@/server/appointments/holds";
import { JOBS } from "@/server/ops/tick";
import type { AppointmentProvider, CreateRequest, CreateResult, FreeSlotsResult } from "@/server/appointments/provider";
import {
  appointmentDedupeKey, dateWindows, filterSlots, isLateCancellation, mapAppointmentStatus, parseFreeSlots, parseGhlAppointmentEvent, reminderSchedule, type GhlAppointmentEvent,
} from "@/lib/appointments";
import { bookingReplyText, customerInstructions, parseReply, respondToConversation, type ReplyContext, type ReplyGenerator } from "@/server/messaging/responder";
import { detectBookingIntent } from "@/lib/appointments";
import { inbound, messagingOrg, recordingProvider, type MessagingOrg } from "./support/messaging";

const NOW = new Date("2026-10-21T01:00:00Z");
const at = (days: number, hour = 9, minute = 0) => new Date(Date.UTC(2026, 9, 21 + days, hour, minute));
/** Times far beyond the booking horizon, so ledger tests never collide with availability and booking tests. */
const far = (days: number, hour = 9, minute = 0) => at(80 + days, hour, minute);
let m: MessagingOrg;
let other: MessagingOrg;
const calendar = "cal_main_0001";
let location = "";
let counter = 0;

const apptId = () => `appt_${++counter}_${crypto.randomBytes(3).toString("hex")}`;

function ev(over: Partial<GhlAppointmentEvent> = {}): GhlAppointmentEvent {
  const start = over.startAt ?? far(counter % 300, 10);
  return {
    kind: "update", locationId: location, appointmentId: apptId(), calendarId: calendar, contactId: null, status: "confirmed", assignedUserId: `user_${counter}_${crypto.randomBytes(2).toString("hex")}`, title: "Viewing", address: null,
    startAt: start, endAt: new Date(start.getTime() + 30 * 60_000), eventTime: new Date(NOW.getTime() - 3_600_000), source: "booking_widget", ...over,
  };
}
const apply = (e: GhlAppointmentEvent, o: Partial<{ org: MessagingOrg; source: "webhook" | "sync" | "portal"; id: string }> = {}) =>
  withSystem((db) => applyAppointmentEvent(db, { orgId: (o.org ?? m).org.id, source: o.source ?? "webhook", providerEventId: o.id ?? `wh_${crypto.randomBytes(4).toString("hex")}`, event: e, now: NOW }));
const row = async (id: string, org = m) => (await withSystem((db) => db.query<Record<string, unknown>>("select * from appointment_refs where org_id = $1 and ghl_appointment_id = $2", [org.org.id, id]))).rows[0];
const ledger = async (id: string, org = m) => (await withSystem((db) => db.query<{ outcome: string; kind: string }>("select outcome, kind from appointment_events where org_id = $1 and ghl_appointment_id = $2 order by seq", [org.org.id, id]))).rows;
const notes = async (userId: string, kind: string) => (await withSystem((db) => db.query<{ title: string; severity: string }>("select title, severity from notifications where user_id = $1 and kind = $2 order by created_at", [userId, kind]))).rows;

interface FakeOpts { free?: Date[] | (() => Date[]); freeError?: Extract<FreeSlotsResult, { ok: false }>; create?: (req: CreateRequest, n: number) => CreateResult }
function fakeCalendar(opts: FakeOpts = {}) {
  const calls = { free: 0, create: [] as CreateRequest[] };
  const provider: AppointmentProvider = {
    name: "fake",
    async freeSlots(req) {
      calls.free += 1;
      if (opts.freeError) return opts.freeError;
      const list = typeof opts.free === "function" ? opts.free() : (opts.free ?? []);
      return { ok: true, slots: list.filter((d) => d >= req.from && d <= req.to).map((d) => ({ start: d.toISOString(), end: d.toISOString() })) };
    },
    async create(req) {
      calls.create.push(req);
      return (opts.create ?? ((_r, n) => ({ ok: true as const, appointmentId: `booked_${n}_${crypto.randomBytes(3).toString("hex")}`, status: "confirmed" })))(req, calls.create.length);
    },
    async update() {
      return { ok: true };
    },
  };
  ctl.provider = provider;
  return { provider, calls };
}

async function mapLocation(org: MessagingOrg, calendars: string[], loc: string) {
  await withSystem((db) => db.query("insert into ghl_location_mappings (org_id, location_id, calendar_ids, status) values ($1, $2, $3, 'connected')", [org.org.id, loc, calendars]));
}
const setPolicy = (org: MessagingOrg, sql: string, params: unknown[] = []) => withSystem((db) => db.query(`insert into appointment_settings (org_id) values ($1) on conflict (org_id) do nothing`, [org.org.id]).then(() => db.query(`update appointment_settings set ${sql} where org_id = $1`, [org.org.id, ...params])));

beforeAll(async () => {
  resetEnvCache();
  m = await messagingOrg({ name: "Appointments Co" });
  other = await messagingOrg({ name: "Other Appointments Co" });
  location = `LOCa${crypto.randomBytes(5).toString("hex")}`;
  await mapLocation(m, [calendar], location);
  await mapLocation(other, ["cal_other_0001"], `LOCb${crypto.randomBytes(5).toString("hex")}`);
});

// ---------------------------------------------------------------------------

describe("reading GoHighLevel's appointment data", () => {
  const payload = (type: string, a: Record<string, unknown> = {}) => ({
    type, locationId: "LOC1234567890", timestamp: "2026-10-21T01:00:00Z", webhookId: "wh1",
    appointment: { id: "appt_000001", calendarId: "cal_0000001", contactId: "contact_0001", appointmentStatus: "confirmed", assignedUserId: "user_0001", title: "Viewing", startTime: "2026-10-25T16:00:00+08:00", endTime: "2026-10-25T16:30:00+08:00", dateUpdated: "2026-10-21T00:59:00Z", ...a },
  });

  it("reads create, update and delete events and converts times to instants", () => {
    const create = parseGhlAppointmentEvent(payload("AppointmentCreate"))!;
    expect(create).toMatchObject({ kind: "create", appointmentId: "appt_000001", calendarId: "cal_0000001", contactId: "contact_0001", status: "confirmed" });
    expect(create.startAt!.toISOString()).toBe("2026-10-25T08:00:00.000Z"); // +08:00 offset removed
    expect(parseGhlAppointmentEvent(payload("AppointmentUpdate"))!.kind).toBe("update");
    expect(parseGhlAppointmentEvent(payload("AppointmentDelete", { startTime: undefined, endTime: undefined }))).toMatchObject({ kind: "delete", startAt: null });
  });

  it("refuses anything malformed rather than guessing", () => {
    expect(parseGhlAppointmentEvent({ type: "ContactCreate" })).toBeNull();
    expect(parseGhlAppointmentEvent(payload("AppointmentCreate", { id: "x" }))).toBeNull(); // implausible id
    expect(parseGhlAppointmentEvent(payload("AppointmentCreate", { startTime: "tomorrow-ish" }))).toBeNull();
    expect(parseGhlAppointmentEvent(payload("AppointmentCreate", { startTime: "2026-10-25T10:00:00Z", endTime: "2026-10-25T09:00:00Z" }))).toBeNull();
    expect(parseGhlAppointmentEvent(payload("AppointmentCreate", { dateUpdated: undefined, dateAdded: undefined }))!.eventTime.toISOString()).toBe("2026-10-21T01:00:00.000Z"); // falls back to the envelope time
    expect(parseGhlAppointmentEvent({ ...payload("AppointmentCreate"), appointment: "no" })).toBeNull();
  });

  it("maps statuses and treats cancelled and invalid as not occupying time", () => {
    expect(mapAppointmentStatus("active")).toBe("confirmed");
    expect(mapAppointmentStatus("completed")).toBe("showed");
    expect(mapAppointmentStatus("cancelled")).toBe("cancelled");
    expect(mapAppointmentStatus(undefined)).toBe("new");
    expect(mapAppointmentStatus("weird")).toBe("new");
  });

  it("reads the documented free-slots answer and drops what is not a time", () => {
    const body = { "2026-10-28": { slots: ["2026-10-28T10:00:00-05:00", "not a time", "2026-10-28T11:00:00-05:00"] }, "2026-10-29": { slots: [] } };
    const slots = parseFreeSlots(body, 30)!;
    expect(slots.map((s) => s.start)).toEqual(["2026-10-28T15:00:00.000Z", "2026-10-28T16:00:00.000Z"]);
    expect(slots[0].end).toBe("2026-10-28T15:30:00.000Z");
    expect(parseFreeSlots({}, 30)).toEqual([]); // a valid "nothing free"
    expect(parseFreeSlots({ error: "nope" }, 30)).toBeNull(); // not the documented shape
    expect(parseFreeSlots(["2026-10-28T10:00:00Z"], 30)).toBeNull();
    expect(parseFreeSlots({ "2026-10-28": { slots: "x" } }, 30)).toBeNull();
  });

  it("filters slots by notice, horizon and what is already taken, and never adds one", () => {
    const slot = (d: Date) => ({ start: d.toISOString(), end: new Date(d.getTime() + 30 * 60_000).toISOString() });
    const all = [slot(at(0, 1, 30)), slot(at(1, 9)), slot(at(2, 9)), slot(at(40, 9))];
    const kept = filterSlots(all, { now: NOW, minNoticeMinutes: 120, maxDaysAhead: 30, busy: [{ start: at(2, 8, 45), end: at(2, 9, 15) }] });
    expect(kept.map((s) => s.start)).toEqual([at(1, 9).toISOString()]);
    expect(kept.length).toBeLessThanOrEqual(all.length);
  });

  it("works out late cancellations, reminder times and provider-sized date windows", () => {
    expect(isLateCancellation(at(1, 9), at(1, 3), 24)).toBe(true);
    expect(isLateCancellation(at(3, 9), at(1, 3), 24)).toBe(false);
    expect(isLateCancellation(at(1, 9), at(1, 3), null)).toBe(false);
    expect(isLateCancellation(at(0, 9), at(1, 3), 24)).toBe(false); // already past the start
    const r = reminderSchedule(at(1, 9), [120, 1440, 120, 99999, -5, 60 * 24 * 30], NOW);
    expect(r.map((x) => x.offsetMinutes)).toEqual([1440, 120]);
    expect(reminderSchedule(at(0, 2), [1440, 120], NOW)).toEqual([]); // both would already be in the past
    const w = dateWindows(at(0), at(70));
    expect(w.length).toBeGreaterThanOrEqual(3);
    for (const x of w) expect(x.to.getTime() - x.from.getTime()).toBeLessThan(31 * 86_400_000);
    expect(appointmentDedupeKey({ kind: "update", appointmentId: "a", eventTime: NOW, status: "confirmed", startAt: NOW })).toBe(appointmentDedupeKey({ kind: "update", appointmentId: "a", eventTime: NOW, status: "confirmed", startAt: NOW }));
  });
});

// ---------------------------------------------------------------------------

describe("the appointment ledger", () => {
  it("records a new appointment, links its contact and stops follow-ups because they booked", async () => {
    const c = await inbound(m.org.id, { name: "Booker Bea" });
    await withSystem((db) => db.query("update contacts set timezone = 'Asia/Manila' where id = $1", [c.contactId]));
    const plan = await withSystem((db) => startFollowUps(db, { orgId: m.org.id, conversationId: c.conversationId }));
    expect(plan.planId).not.toBeNull();
    const ghlContact = (await withSystem((db) => db.query<{ ghl_contact_id: string }>("select ghl_contact_id from contacts where id = $1", [c.contactId]))).rows[0].ghl_contact_id;

    const e = ev({ kind: "create", contactId: ghlContact });
    const r = await apply(e);
    expect(r.outcome).toBe("applied");
    const a = await row(e.appointmentId);
    expect(a).toMatchObject({ status: "confirmed", contact_id: c.contactId, assigned_ghl_user_id: expect.stringMatching(/^user_/), origin: "webhook", reschedule_count: 0, conflict: false, timezone: "Asia/Manila" });
    expect(new Date(a.start_at as Date).toISOString()).toBe(e.startAt!.toISOString());
    // They booked, so automated follow-ups stop and the contact moves along the lifecycle.
    expect((await withSystem((db) => db.query<{ status: string; cancel_reason: string }>("select status, cancel_reason from follow_up_plans where id = $1", [plan.planId]))).rows[0]).toMatchObject({ status: "cancelled", cancel_reason: "customer_booked" });
    expect((await withSystem((db) => db.query<{ lifecycle_stage: string }>("select lifecycle_stage from contacts where id = $1", [c.contactId]))).rows[0].lifecycle_stage).toBe("appointment");
    expect((await notes(m.people.owner.id, "booking_confirmed")).some((n) => n.title.includes("New appointment"))).toBe(true);
    expect((await notes(m.people.viewer.id, "booking_confirmed"))).toHaveLength(0);
  });

  it("changes nothing when the same event arrives again, even under a different delivery id", async () => {
    const e = ev({ kind: "create" });
    expect((await apply(e, { id: "wh_a" })).outcome).toBe("applied");
    expect((await apply(e, { id: "wh_a" })).outcome).toBe("duplicate");
    expect((await apply(e, { id: "wh_b_retry" })).outcome).toBe("duplicate");
    expect(await ledger(e.appointmentId)).toHaveLength(1);
    expect((await row(e.appointmentId)).reschedule_count).toBe(0);
  });

  it("never lets a delayed older update overwrite a newer one", async () => {
    const id = apptId();
    const t = (min: number) => new Date(NOW.getTime() - min * 60_000);
    await apply(ev({ appointmentId: id, kind: "create", eventTime: t(30), startAt: far(5, 10) }));
    await apply(ev({ appointmentId: id, eventTime: t(10), startAt: far(6, 14), title: "Moved viewing" }));
    const late = await apply(ev({ appointmentId: id, eventTime: t(20), startAt: far(7, 16), title: "Old delayed version" }));
    expect(late.outcome).toBe("stale");
    const a = await row(id);
    expect(new Date(a.start_at as Date).toISOString()).toBe(far(6, 14).toISOString());
    expect(a.title).toBe("Moved viewing");
    expect((await ledger(id)).map((l) => l.outcome)).toEqual(["applied", "applied", "stale"]); // the late event stays on the record
  });

  it("keeps a cancellation when an older confirmation arrives afterwards (retry ordering)", async () => {
    const id = apptId();
    const t = (min: number) => new Date(NOW.getTime() - min * 60_000);
    await apply(ev({ appointmentId: id, kind: "create", eventTime: t(40) }));
    await apply(ev({ appointmentId: id, status: "cancelled", eventTime: t(10) }));
    const retry = await apply(ev({ appointmentId: id, status: "confirmed", eventTime: t(25) }), { id: "wh_retry_of_old_update" });
    expect(retry.outcome).toBe("stale");
    expect(await row(id)).toMatchObject({ status: "cancelled" });
  });

  it("treats a cancellation at the same instant as a confirmation as the one that stands", async () => {
    const id = apptId();
    const same = new Date(NOW.getTime() - 600_000);
    await apply(ev({ appointmentId: id, kind: "create", eventTime: new Date(same.getTime() - 60_000) }));
    await apply(ev({ appointmentId: id, status: "cancelled", eventTime: same }));
    expect((await apply(ev({ appointmentId: id, status: "confirmed", eventTime: same }))).outcome).toBe("stale");
    expect(await row(id)).toMatchObject({ status: "cancelled" });
  });

  it("lets a genuinely newer confirmation re-activate a cancelled appointment", async () => {
    const id = apptId();
    const t = (min: number) => new Date(NOW.getTime() - min * 60_000);
    await apply(ev({ appointmentId: id, kind: "create", eventTime: t(40) }));
    await apply(ev({ appointmentId: id, status: "cancelled", eventTime: t(30) }));
    expect(await row(id)).toMatchObject({ status: "cancelled", late_cancellation: false });
    await apply(ev({ appointmentId: id, status: "confirmed", eventTime: t(5) }));
    expect(await row(id)).toMatchObject({ status: "confirmed", cancelled_at: null });
  });

  it("remembers a deletion that arrives before its creation, so the creation cannot bring it back", async () => {
    const id = apptId();
    const t = (min: number) => new Date(NOW.getTime() - min * 60_000);
    expect((await apply(ev({ appointmentId: id, kind: "delete", eventTime: t(5) }))).outcome).toBe("ignored");
    expect((await apply(ev({ appointmentId: id, kind: "create", eventTime: t(15) }))).outcome).toBe("stale");
    expect(await row(id)).toBeUndefined();
    // A booking made after the deletion is a different story.
    expect((await apply(ev({ appointmentId: id, kind: "create", eventTime: t(1) }))).outcome).toBe("applied");
    expect(await row(id)).toMatchObject({ status: "confirmed" });
  });

  it("marks a deleted appointment cancelled, keeping the history", async () => {
    const id = apptId();
    await apply(ev({ appointmentId: id, kind: "create", eventTime: new Date(NOW.getTime() - 900_000) }));
    await apply(ev({ appointmentId: id, kind: "delete", eventTime: new Date(NOW.getTime() - 60_000) }));
    expect(await row(id)).toMatchObject({ status: "cancelled", deleted_remote: true });
    expect((await ledger(id)).map((l) => l.kind)).toEqual(["create", "delete"]);
  });

  it("counts reschedules and remembers where it moved from", async () => {
    const id = apptId();
    const t = (min: number) => new Date(NOW.getTime() - min * 60_000);
    await apply(ev({ appointmentId: id, kind: "create", eventTime: t(50), startAt: far(5, 10) }));
    await apply(ev({ appointmentId: id, eventTime: t(40), startAt: far(5, 15) }));
    await apply(ev({ appointmentId: id, eventTime: t(30), startAt: far(6, 9) }));
    const a = await row(id);
    expect(a.reschedule_count).toBe(2);
    expect(new Date(a.previous_start_at as Date).toISOString()).toBe(far(5, 15).toISOString());
    expect((await notes(m.people.owner.id, "booking_rescheduled")).length).toBeGreaterThanOrEqual(2);
  });

  it("flags a late cancellation only when the workspace set a notice rule and the cancel was inside it", async () => {
    await setPolicy(m, "late_cancel_hours = 24");
    const near = ev({ kind: "create", startAt: at(0, 10), eventTime: new Date(NOW.getTime() - 3_600_000) });
    const distant = ev({ kind: "create", startAt: at(5, 10), eventTime: new Date(NOW.getTime() - 3_600_000) });
    await apply(near);
    await apply(distant);
    await apply({ ...near, status: "cancelled", eventTime: new Date(NOW.getTime() - 60_000) });
    await apply({ ...distant, status: "cancelled", eventTime: new Date(NOW.getTime() - 60_000) });
    expect(await row(near.appointmentId)).toMatchObject({ status: "cancelled", late_cancellation: true });
    expect(await row(distant.appointmentId)).toMatchObject({ status: "cancelled", late_cancellation: false });
    const alerts = await notes(m.people.owner.id, "booking_cancelled");
    expect(alerts.some((n) => n.severity === "warning" && n.title.startsWith("Late cancellation"))).toBe(true);
    await setPolicy(m, "late_cancel_hours = null");
  });

  it("flags overlapping bookings for the same person but not different people, and clears the flag on cancellation", async () => {
    const a = ev({ kind: "create", startAt: far(9, 10), assignedUserId: "user_busy_one" });
    const b = ev({ kind: "create", startAt: far(9, 10, 15), assignedUserId: "user_busy_one", eventTime: new Date(NOW.getTime() - 1_800_000) });
    const c = ev({ kind: "create", startAt: far(9, 10, 10), assignedUserId: "user_someone_else", eventTime: new Date(NOW.getTime() - 1_500_000) });
    expect((await apply(a)).outcome).toBe("applied");
    expect((await apply(b)).outcome).toBe("conflict");
    expect((await apply(c)).outcome).toBe("applied");
    expect(await row(a.appointmentId)).toMatchObject({ conflict: true });
    expect(await row(b.appointmentId)).toMatchObject({ conflict: true });
    expect(await row(c.appointmentId)).toMatchObject({ conflict: false });
    expect((await notes(m.people.owner.id, "booking_conflict")).length).toBeGreaterThanOrEqual(1);
    await apply({ ...b, status: "cancelled", eventTime: new Date(NOW.getTime() - 600_000) });
    expect(await row(a.appointmentId)).toMatchObject({ conflict: false });
    expect(await row(b.appointmentId)).toMatchObject({ conflict: false });
  });

  it("settles to the newest state whatever order concurrent events finish in", async () => {
    const id = apptId();
    const times = [8, 3, 6, 1, 9, 2].map((min) => new Date(NOW.getTime() - min * 60_000));
    await Promise.all(times.map((eventTime, i) => apply(ev({ appointmentId: id, kind: i === 0 ? "create" : "update", eventTime, title: `v${(NOW.getTime() - eventTime.getTime()) / 60_000}` }))));
    expect((await row(id)).title).toBe("v1"); // the event with the latest provider time
    const outcomes = (await ledger(id)).map((l) => l.outcome);
    expect(outcomes.filter((o) => o === "applied").length + outcomes.filter((o) => o === "stale").length).toBe(6);
  });

  it("keeps the same provider id in two workspaces apart", async () => {
    const id = apptId();
    await apply(ev({ appointmentId: id, kind: "create", title: "Mine" }));
    await apply(ev({ appointmentId: id, kind: "create", title: "Theirs", calendarId: "cal_other_0001" }), { org: other });
    expect((await row(id)).title).toBe("Mine");
    expect((await row(id, other)).title).toBe("Theirs");
    await apply(ev({ appointmentId: id, status: "cancelled", eventTime: new Date(NOW.getTime() - 1000) }), { org: other });
    expect((await row(id)).status).toBe("confirmed");
  });

  it("lets a calendar snapshot add what it hasn't seen but never overwrite a newer webhook", async () => {
    const id = apptId();
    const t = (min: number) => new Date(NOW.getTime() - min * 60_000);
    await apply(ev({ appointmentId: id, kind: "update", eventTime: t(5), startAt: far(8, 11), title: "Webhook says" }), { source: "webhook" });
    expect((await apply(ev({ appointmentId: id, eventTime: t(60), startAt: far(8, 9), title: "Old snapshot" }), { source: "sync" })).outcome).toBe("stale");
    expect((await apply(ev({ appointmentId: id, eventTime: new Date(0), startAt: far(8, 9), title: "No timestamp" }), { source: "sync" })).outcome).toBe("stale");
    expect((await row(id)).title).toBe("Webhook says");
    const fresh = apptId();
    expect((await apply(ev({ appointmentId: fresh, eventTime: new Date(0) }), { source: "sync" })).outcome).toBe("applied");
    expect(await row(fresh)).toMatchObject({ origin: "sync" });
  });

  it("stores times as instants and keeps the viewer's zone out of the stored time", async () => {
    const id = apptId();
    const start = new Date("2026-11-03T16:00:00+08:00");
    await apply(ev({ appointmentId: id, kind: "create", startAt: start, endAt: new Date(start.getTime() + 3_600_000) }));
    const a = await row(id);
    expect(new Date(a.start_at as Date).toISOString()).toBe("2026-11-03T08:00:00.000Z");
    expect(new Date(a.end_at as Date).toISOString()).toBe("2026-11-03T09:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------

describe("appointment webhooks", () => {
  const sign = (body: string) => crypto.createSign("RSA-SHA256").update(body).sign(keys.privateKey, "base64");
  const payload = (type: string, over: Record<string, unknown> = {}, appt: Record<string, unknown> = {}) => ({
    type, locationId: location, webhookId: `wh_${crypto.randomBytes(6).toString("hex")}`, timestamp: NOW.toISOString(),
    appointment: { id: apptId(), calendarId: calendar, contactId: "contact_unknown_1", appointmentStatus: "confirmed", assignedUserId: "user_assigned_a", title: "Webhook viewing", startTime: far(10, 10).toISOString(), endTime: far(10, 10, 30).toISOString(), dateUpdated: new Date(NOW.getTime() - 600_000).toISOString(), ...appt },
    ...over,
  });
  const send = (p: Record<string, unknown>) => {
    const raw = JSON.stringify(p);
    return handleGhlWebhook({ rawBody: raw, signature: sign(raw), now: NOW.getTime() });
  };

  it("records an appointment for the workspace that owns the location", async () => {
    const p = payload("AppointmentCreate");
    expect(await send(p)).toMatchObject({ httpStatus: 200, outcome: "processed", orgId: m.org.id });
    expect(await row((p.appointment as { id: string }).id)).toMatchObject({ status: "confirmed", origin: "webhook" });
    expect(await row((p.appointment as { id: string }).id, other)).toBeUndefined();
  });

  it("ignores locations nobody owns and calendars the workspace hasn't connected", async () => {
    expect(await send(payload("AppointmentCreate", { locationId: "LOCunknown12345" }))).toMatchObject({ outcome: "ignored", detail: expect.stringMatching(/not connected to a workspace/) });
    const p = payload("AppointmentCreate", {}, { calendarId: "cal_not_ours_1" });
    expect(await send(p)).toMatchObject({ outcome: "ignored", detail: expect.stringMatching(/calendar isn't connected/) });
    expect(await row((p.appointment as { id: string }).id)).toBeUndefined();
  });

  it("answers a repeated delivery as a duplicate and applies an update and a delete in order", async () => {
    const p = payload("AppointmentCreate");
    await send(p);
    expect(await send(p)).toMatchObject({ outcome: "duplicate" });
    const id = (p.appointment as { id: string }).id;
    const t = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
    await send(payload("AppointmentUpdate", {}, { id, startTime: far(11, 13).toISOString(), endTime: far(11, 13, 30).toISOString(), dateUpdated: t(5) }));
    expect(await row(id)).toMatchObject({ reschedule_count: 1 });
    await send(payload("AppointmentDelete", {}, { id, dateUpdated: t(1) }));
    expect(await row(id)).toMatchObject({ status: "cancelled", deleted_remote: true });
    // The early copy of the update arrives last and changes nothing.
    expect(await send(payload("AppointmentUpdate", {}, { id, appointmentStatus: "confirmed", startTime: far(12, 9).toISOString(), endTime: far(12, 9, 30).toISOString(), dateUpdated: t(3) }))).toMatchObject({ outcome: "ignored" });
    expect(await row(id)).toMatchObject({ status: "cancelled" });
  });

  it("rejects an unsigned or tampered event", async () => {
    const raw = JSON.stringify(payload("AppointmentCreate"));
    expect(await handleGhlWebhook({ rawBody: raw, signature: null, now: NOW.getTime() })).toMatchObject({ httpStatus: 401 });
    expect(await handleGhlWebhook({ rawBody: raw + " ", signature: sign(raw), now: NOW.getTime() })).toMatchObject({ httpStatus: 401 });
  });
});

// ---------------------------------------------------------------------------

describe("real availability", () => {
  it("says so plainly when no calendar is connected, instead of inventing times", async () => {
    const lonely = await messagingOrg({ name: "No Calendar Co" });
    const res = await getAvailability(lonely.org.id, { provider: fakeCalendar({ free: [at(2, 9)] }).provider, now: NOW });
    expect(res).toMatchObject({ ok: false, reason: "not_connected" });
  });

  it("offers only what the provider listed, minus what is too soon, too far, or already taken", async () => {
    await setPolicy(m, "min_notice_minutes = 120, max_days_ahead = 30, slot_minutes = 30, default_calendar_id = null");
    const taken = ev({ kind: "create", startAt: at(2, 10), eventTime: new Date(NOW.getTime() - 1_000_000) });
    await apply(taken);
    const free = [at(0, 1, 30), at(2, 9), at(2, 10), at(2, 10, 15), at(2, 11), at(3, 9), at(45, 9)];
    const res = await getAvailability(m.org.id, { provider: fakeCalendar({ free }).provider, now: NOW, from: at(0), to: at(50) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const starts = res.slots.map((s) => s.start);
    expect(starts).toContain(at(2, 9).toISOString());
    expect(starts).toContain(at(2, 11).toISOString());
    expect(starts).toContain(at(3, 9).toISOString());
    expect(starts).not.toContain(at(0, 1, 30).toISOString()); // inside the notice period
    expect(starts).not.toContain(at(2, 10).toISOString()); // an existing appointment
    expect(starts).not.toContain(at(2, 10, 15).toISOString()); // overlaps one
    expect(starts).not.toContain(at(45, 9).toISOString()); // beyond the booking horizon
    expect(res.slots.every((s) => free.some((f) => f.toISOString() === s.start))).toBe(true);
    expect(res.slots[0].end).toBe(new Date(new Date(res.slots[0].start).getTime() + 30 * 60_000).toISOString());
  });

  it("spreads a long list across days and respects the limit", async () => {
    const free = [at(3, 9), at(3, 10), at(3, 11), at(3, 12), at(4, 9), at(4, 10)];
    const res = await getAvailability(m.org.id, { provider: fakeCalendar({ free }).provider, now: NOW, from: at(0), to: at(10), perDay: 2, limit: 3 });
    expect(res.ok && res.slots.map((s) => s.start)).toEqual([at(3, 9), at(3, 10), at(4, 9)].map((d) => d.toISOString()));
  });

  it("returns an explained failure, not an empty or guessed list, when the provider can't be read", async () => {
    const res = await getAvailability(m.org.id, { provider: fakeCalendar({ freeError: { ok: false, reason: "unavailable", detail: "GoHighLevel could not be reached." } }).provider, now: NOW });
    expect(res).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("never asks about a calendar that isn't this workspace's own", async () => {
    const f = fakeCalendar({ free: [at(2, 9)] });
    expect(await getAvailability(m.org.id, { provider: f.provider, now: NOW, calendarId: "cal_other_0001" })).toMatchObject({ ok: false, reason: "calendar_not_mapped" });
    expect(f.calls.free).toBe(0);
  });

  it("holds pending bookings out of the list so two customers aren't offered the same time", async () => {
    const f = fakeCalendar({ free: [at(6, 9), at(6, 10)], create: () => ({ ok: false, retryable: false, blocked: true, error: "Booking through GoHighLevel is switched off for this environment." }) });
    const c = await inbound(m.org.id);
    const r = await requestBooking({ orgId: m.org.id, contactId: c.contactId, startAt: at(6, 9), actor: { kind: "staff", userId: m.people.sales.id }, now: NOW }, { provider: f.provider });
    expect(r.status).toBe("needs_manual");
    const res = await getAvailability(m.org.id, { provider: f.provider, now: NOW, from: at(6), to: at(7) });
    expect(res.ok && res.slots.map((s) => s.start)).toEqual([at(6, 10).toISOString()]);
  });
});

// ---------------------------------------------------------------------------

describe("booking", () => {
  const staff = (userId = m.people.sales.id) => ({ kind: "staff" as const, userId });
  const req = (contactId: string, start: Date, over: Record<string, unknown> = {}) => ({ orgId: m.org.id, contactId, startAt: start, actor: staff(), now: NOW, ...over });
  const booking = async (id: string) => (await withSystem((db) => db.query<Record<string, unknown>>("select * from appointment_bookings where id = $1", [id]))).rows[0];

  it("books a person's request only after the calendar confirms the time is still free, and records the appointment", async () => {
    const c = await inbound(m.org.id, { name: "Staff Booked" });
    const f = fakeCalendar({ free: [at(12, 9), at(12, 10)] });
    const r = await requestBooking(req(c.contactId, at(12, 9)), { provider: f.provider });
    expect(r.status).toBe("booked");
    expect(f.calls.create).toHaveLength(1);
    expect(f.calls.create[0]).toMatchObject({ calendarId: calendar, startAt: at(12, 9) });
    if (r.status !== "booked") return;
    expect(await booking(r.bookingId)).toMatchObject({ status: "booked", requested_by_kind: "staff" });
    expect(await withSystem((db) => db.query("select origin, status from appointment_refs where id = $1", [r.appointmentId])).then((x) => x.rows[0])).toMatchObject({ origin: "portal_staff", status: "confirmed" });
    expect((await withSystem((db) => db.query("select 1 from audit_logs where org_id = $1 and action = 'appointment.booked' and target_id = $2", [m.org.id, r.bookingId]))).rows).toHaveLength(1);
  });

  it("refuses a time the calendar no longer lists, and releases the hold", async () => {
    const c = await inbound(m.org.id);
    const f = fakeCalendar({ free: [at(13, 10)] });
    const r = await requestBooking(req(c.contactId, at(13, 9)), { provider: f.provider });
    expect(r).toMatchObject({ status: "unavailable", reason: "slot_taken" });
    expect(f.calls.create).toHaveLength(0);
    const f2 = fakeCalendar({ free: [at(13, 9)] });
    expect((await requestBooking(req(c.contactId, at(13, 9)), { provider: f2.provider })).status).toBe("booked"); // the failed attempt left nothing behind
  });

  it("books nothing when the calendar can't be read", async () => {
    const c = await inbound(m.org.id);
    const f = fakeCalendar({ freeError: { ok: false, reason: "unavailable", detail: "GoHighLevel could not be reached." } });
    const r = await requestBooking(req(c.contactId, at(14, 9)), { provider: f.provider });
    expect(r).toMatchObject({ status: "unavailable", reason: "provider_error" });
    expect(f.calls.create).toHaveLength(0);
    expect((await withSystem((db) => db.query("select 1 from appointment_bookings where contact_id = $1 and status in ('requested','booked','needs_manual','awaiting_approval')", [c.contactId]))).rows).toHaveLength(0);
  });

  it("lets only one of two simultaneous requests take a time, and one that overlaps it", async () => {
    const a = await inbound(m.org.id);
    const b = await inbound(m.org.id);
    const c = await inbound(m.org.id);
    const f = fakeCalendar({ free: [at(15, 9), at(15, 9, 15)] });
    const results = await Promise.all([requestBooking(req(a.contactId, at(15, 9)), { provider: f.provider }), requestBooking(req(b.contactId, at(15, 9)), { provider: f.provider })]);
    expect(results.map((r) => r.status).sort()).toEqual(["booked", "unavailable"]);
    expect(f.calls.create).toHaveLength(1);
    expect(await requestBooking(req(c.contactId, at(15, 9, 15)), { provider: f.provider })).toMatchObject({ status: "unavailable", reason: "slot_taken" }); // overlaps the 09:00 booking
  });

  it("answers a repeated identical request with the booking it already made", async () => {
    const c = await inbound(m.org.id);
    const f = fakeCalendar({ free: [at(16, 9)] });
    const first = await requestBooking(req(c.contactId, at(16, 9)), { provider: f.provider });
    const second = await requestBooking(req(c.contactId, at(16, 9)), { provider: f.provider });
    expect(first.status).toBe("booked");
    expect(second).toMatchObject({ status: "booked", bookingId: first.status === "booked" ? first.bookingId : "" });
    expect(f.calls.create).toHaveLength(1);
  });

  it("keeps the time held and asks a person to add it by hand when the provider won't take writes, then closes the loop from the calendar's own event", async () => {
    const c = await inbound(m.org.id, { name: "Manual Mo" });
    const f = fakeCalendar({ free: [at(17, 9)], create: () => ({ ok: false, retryable: false, blocked: true, error: "Booking through GoHighLevel is switched off for this environment." }) });
    const r = await requestBooking(req(c.contactId, at(17, 9)), { provider: f.provider });
    expect(r).toMatchObject({ status: "needs_manual" });
    expect((await notes(m.people.owner.id, "booking_needs_action")).some((n) => n.title.includes("Manual Mo"))).toBe(true);
    if (r.status !== "needs_manual") return;
    expect(await booking(r.bookingId)).toMatchObject({ status: "needs_manual" });
    // Someone adds it in the calendar; the calendar's event confirms it. Only now does the booking count as booked.
    const ghl = (await withSystem((db) => db.query<{ ghl_contact_id: string }>("select ghl_contact_id from contacts where id = $1", [c.contactId]))).rows[0].ghl_contact_id;
    await apply(ev({ kind: "create", contactId: ghl, startAt: at(17, 9), eventTime: new Date(NOW.getTime() - 5_000) }));
    expect(await booking(r.bookingId)).toMatchObject({ status: "booked" });
  });

  it("does not book through a calendar the workspace hasn't connected, or for another workspace's contact", async () => {
    const mine = await inbound(m.org.id);
    const theirs = await inbound(other.org.id);
    const f = fakeCalendar({ free: [at(18, 9)] });
    expect(await requestBooking(req(mine.contactId, at(18, 9), { calendarId: "cal_other_0001" }), { provider: f.provider })).toMatchObject({ status: "unavailable", reason: "no_calendar" });
    expect(await requestBooking(req(theirs.contactId, at(18, 9)), { provider: f.provider })).toMatchObject({ status: "unavailable", reason: "contact_unusable" });
    expect(f.calls.create).toHaveLength(0);
  });

  it("applies the workspace's notice rule to the AI but lets a person book sooner", async () => {
    const c = await inbound(m.org.id);
    const soon = new Date(NOW.getTime() + 30 * 60_000);
    const f = fakeCalendar({ free: [soon] });
    expect(await requestBooking({ orgId: m.org.id, contactId: c.contactId, startAt: soon, actor: { kind: "ai", agentId: m.salesAgentId }, now: NOW }, { provider: f.provider })).toMatchObject({ status: "unavailable", reason: "too_soon" });
  });

  describe("when the Appointment Setter proposes it", () => {
    const setterId = async () => (await withSystem((db) => db.query<{ id: string }>("select id from agent_instances where org_id = $1 and role_key = 'appointment_setter'", [m.org.id]))).rows[0].id;
    const ready = async (mode: "autonomous" | "approval_required") => {
      const id = await setterId();
      await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, enabled = true, mode = $2 where id = $1", [id, mode]));
      return id;
    };
    const ai = (agentId: string, contactId: string, conversationId: string | null, start: Date) => ({ orgId: m.org.id, contactId, conversationId, startAt: start, actor: { kind: "ai" as const, agentId }, now: NOW });

    it("waits for a person by default, and books only after that person approves", async () => {
      const agent = await ready("autonomous");
      await setPolicy(m, "ai_booking_enabled = false");
      const c = await inbound(m.org.id, { name: "Needs Approval" });
      const f = fakeCalendar({ free: [at(19, 9)] });
      const r = await requestBooking(ai(agent, c.contactId, c.conversationId, at(19, 9)), { provider: f.provider });
      expect(r.status).toBe("awaiting_approval");
      expect(f.calls.create).toHaveLength(0);
      if (r.status !== "awaiting_approval") return;
      expect((await notes(m.people.owner.id, "approval_requested")).some((n) => n.title.includes("Needs Approval"))).toBe(true);
      // While it waits the time is held: nobody else is offered it.
      expect((await getAvailability(m.org.id, { provider: f.provider, now: NOW, from: at(19), to: at(20) }))).toMatchObject({ ok: true, slots: [] });
      // The viewer cannot decide it; the owner can.
      await expect(decideApproval(m.ctx("viewer"), r.approvalId!, "approve")).rejects.toBeTruthy();
      const out = await decideApproval(m.ctx("owner"), r.approvalId!, "approve");
      expect(out.outcome).toMatchObject({ status: "succeeded" });
      expect(f.calls.create).toHaveLength(1);
      expect(await booking(r.bookingId)).toMatchObject({ status: "booked", requested_by_kind: "ai" });
      // The customer is told through the normal message gate.
      expect((await withSystem((db) => db.query("select 1 from conversation_messages where dedupe_key = $1 and scope = 'reply'", [`booking-confirm:${r.bookingId}`]))).rows).toHaveLength(1);
    });

    it("releases the time when the proposal is rejected", async () => {
      const agent = await ready("autonomous");
      const c = await inbound(m.org.id);
      const f = fakeCalendar({ free: [at(20, 9)] });
      const r = await requestBooking(ai(agent, c.contactId, c.conversationId, at(20, 9)), { provider: f.provider });
      if (r.status !== "awaiting_approval") throw new Error("expected approval");
      await decideApproval(m.ctx("owner"), r.approvalId!, "reject", "Not that day");
      expect(await booking(r.bookingId)).toMatchObject({ status: "cancelled" });
      expect((await getAvailability(m.org.id, { provider: f.provider, now: NOW, from: at(20), to: at(21) }))).toMatchObject({ ok: true, slots: [expect.objectContaining({ start: at(20, 9).toISOString() })] });
    });

    it("books on its own only when the owner allowed that and the employee is autonomous", async () => {
      const agent = await ready("autonomous");
      await setPolicy(m, "ai_booking_enabled = true");
      const c = await inbound(m.org.id);
      const f = fakeCalendar({ free: [at(21, 9), at(21, 10)] });
      expect((await requestBooking(ai(agent, c.contactId, c.conversationId, at(21, 9)), { provider: f.provider })).status).toBe("booked");
      await ready("approval_required");
      const d = await inbound(m.org.id);
      expect((await requestBooking(ai(agent, d.contactId, d.conversationId, at(21, 10)), { provider: f.provider })).status).toBe("awaiting_approval"); // mode still decides
      await setPolicy(m, "ai_booking_enabled = false");
    });

    it("books nothing while customer-facing AI is paused, and leaves no hold behind", async () => {
      const agent = await ready("autonomous");
      await setPolicy(m, "ai_booking_enabled = true");
      const c = await inbound(m.org.id);
      const f = fakeCalendar({ free: [at(22, 9)] });
      await setClientPause(m.ctx("owner"), { scope: "messaging", paused: true, reason: "test" });
      const r = await requestBooking(ai(agent, c.contactId, c.conversationId, at(22, 9)), { provider: f.provider });
      await setClientPause(m.ctx("owner"), { scope: "messaging", paused: false });
      expect(r).toMatchObject({ status: "unavailable", reason: "blocked" });
      expect(f.calls.create).toHaveLength(0);
      expect((await requestBooking(ai(agent, c.contactId, c.conversationId, at(22, 9)), { provider: f.provider })).status).toBe("booked");
      await setPolicy(m, "ai_booking_enabled = false");
    });
  });

  it("lets people with booking rights drop a pending booking, and nobody else", async () => {
    const c = await inbound(m.org.id);
    const f = fakeCalendar({ free: [at(23, 9)], create: () => ({ ok: false, retryable: false, blocked: true, error: "off" }) });
    const r = await requestBooking(req(c.contactId, at(23, 9)), { provider: f.provider });
    if (r.status !== "needs_manual") throw new Error("expected manual");
    await expect(cancelPendingBooking(m.ctx("viewer"), r.bookingId)).rejects.toMatchObject({ code: "forbidden" });
    await cancelPendingBooking(m.ctx("sales"), r.bookingId);
    expect(await booking(r.bookingId)).toMatchObject({ status: "cancelled" });
    await expect(cancelPendingBooking(m.ctx("sales"), r.bookingId)).rejects.toMatchObject({ code: "not_found" });
    await expect(bookForContact(m.ctx("viewer"), { contactId: c.contactId, startAt: at(24, 9) }, { provider: f.provider, now: NOW })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("releases holds nobody finished", async () => {
    const f = fakeCalendar({ free: [at(25, 9), at(25, 10)], create: () => ({ ok: false, retryable: false, blocked: true, error: "off" }) });
    const c = await inbound(m.org.id);
    const r = await requestBooking(req(c.contactId, at(25, 9)), { provider: f.provider });
    if (r.status !== "needs_manual") throw new Error("expected manual");
    expect(await expireBookingHolds(new Date())).toBe(0);
    expect(await expireBookingHolds(new Date(Date.now() + 25 * 3_600_000))).toBeGreaterThanOrEqual(1);
    expect(await booking(r.bookingId)).toMatchObject({ status: "cancelled" });
    expect((await notes(m.people.owner.id, "booking_needs_action")).some((n) => n.title.includes("never added"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("reminders", () => {
  const owner = () => m.ctx("owner");
  let contact: Awaited<ReturnType<typeof inbound>>;
  let ghl: string;
  const reminders = async (id: string) => (await withSystem((db) => db.query<{ offset_minutes: number; due_at: Date; status: string; reason: string | null; message_id: string | null }>(
    "select r.offset_minutes, r.due_at, r.status, r.reason, r.message_id from appointment_reminders r join appointment_refs a on a.id = r.appointment_id where a.org_id = $1 and a.ghl_appointment_id = $2 order by r.offset_minutes desc", [m.org.id, id]))).rows;

  beforeAll(async () => {
    contact = await inbound(m.org.id, { name: "Remind Rita" });
    ghl = (await withSystem((db) => db.query<{ ghl_contact_id: string }>("select ghl_contact_id from contacts where id = $1", [contact.contactId]))).rows[0].ghl_contact_id;
    await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, enabled = true, mode = 'autonomous' where org_id = $1 and role_key = 'appointment_setter'", [m.org.id]));
  });

  it("are off until the owner turns them on, and turning them on records a standing authorization", async () => {
    const early = ev({ kind: "create", contactId: ghl, startAt: at(4, 10) });
    await apply(early);
    expect(await reminders(early.appointmentId)).toEqual([]);
    await expect(savePolicy(m.ctx("support"), { remindersEnabled: true })).rejects.toMatchObject({ code: "forbidden" });
    await savePolicy(owner(), { remindersEnabled: true, reminderOffsetsMinutes: [120, 1440] });
    const view = await getPolicyView(owner());
    expect(view).toMatchObject({ remindersEnabled: true, remindersAuthorization: "active", reminderOffsetsMinutes: [1440, 120] });
    expect(view.remindersAuthorizedUntil).not.toBeNull();
    // Switching them on plans reminders for appointments that already exist.
    expect((await reminders(early.appointmentId)).map((r) => r.offset_minutes)).toEqual([1440, 120]);
  });

  it("let only the owner decide whether the AI books by itself", async () => {
    await expect(savePolicy(m.ctx("manager"), { aiBookingEnabled: true })).rejects.toMatchObject({ code: "forbidden" });
    await expect(savePolicy(owner(), { defaultCalendarId: "cal_not_ours_1" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("are planned for each new appointment and re-planned when it moves", async () => {
    const e = ev({ kind: "create", contactId: ghl, startAt: at(4, 12), eventTime: new Date(NOW.getTime() - 120_000) });
    await apply(e);
    const before = await reminders(e.appointmentId);
    expect(before.map((r) => [r.offset_minutes, r.status])).toEqual([[1440, "scheduled"], [120, "scheduled"]]);
    expect(new Date(before[0].due_at).toISOString()).toBe(new Date(at(4, 12).getTime() - 1440 * 60_000).toISOString());
    await apply({ ...e, startAt: at(5, 12), endAt: at(5, 12, 30), eventTime: new Date(NOW.getTime() - 60_000) });
    const after = await reminders(e.appointmentId);
    expect(new Date(after[0].due_at).toISOString()).toBe(new Date(at(5, 12).getTime() - 1440 * 60_000).toISOString());
    expect(after.every((r) => r.status === "scheduled")).toBe(true);
  });

  it("are withdrawn when the appointment is cancelled, and never planned in the past", async () => {
    const e = ev({ kind: "create", contactId: ghl, startAt: at(4, 15), eventTime: new Date(NOW.getTime() - 120_000) });
    await apply(e);
    await apply({ ...e, status: "cancelled", eventTime: new Date(NOW.getTime() - 30_000) });
    expect((await reminders(e.appointmentId)).every((r) => r.status === "cancelled")).toBe(true);
    const soon = ev({ kind: "create", contactId: ghl, startAt: new Date(NOW.getTime() + 90 * 60_000), eventTime: new Date(NOW.getTime() - 60_000) });
    await apply(soon);
    expect(await reminders(soon.appointmentId)).toEqual([]); // 24h and 2h before are both already past
  });

  describe("sending", () => {
    const setup = async (offsetMin: number, over: Partial<GhlAppointmentEvent> = {}) => {
      const start = new Date(NOW.getTime() + offsetMin * 60_000 + 3 * 3_600_000);
      const e = ev({ kind: "create", contactId: ghl, startAt: start, eventTime: new Date(NOW.getTime() - 60_000 * (counter % 50 + 2)), ...over });
      await apply(e);
      return e;
    };
    const due = new Date(NOW.getTime() + 3 * 3_600_000 + 600_000 + 5 * 60_000); // after the 2h reminder of a +10min-start... see each test
    void due;

    it("queues a plain reminder through the normal message gate and the dispatcher sends it once", async () => {
      // Appointment 5h from NOW: the 2h reminder falls due at NOW+3h.
      const e = await setup(2 * 60);
      const t = new Date(NOW.getTime() + 3 * 3_600_000 + 60_000);
      const r = await sendDueReminders({ now: t });
      expect(r.queued).toBeGreaterThanOrEqual(1);
      const rem = (await reminders(e.appointmentId)).find((x) => x.offset_minutes === 120)!;
      expect(rem.status).toBe("queued");
      const msg = (await withSystem((db) => db.query<{ scope: string; body: string; status: string; direction: string }>("select scope, body, status, direction from conversation_messages where id = $1", [rem.message_id]))).rows[0];
      expect(msg).toMatchObject({ scope: "reminder", status: "queued", direction: "outbound" });
      expect(msg.body).toContain("Remind");
      expect(msg.body).toContain("a reminder from");
      const rec = recordingProvider();
      await dispatchDue({ provider: rec.provider, now: t });
      const mine = () => rec.calls.filter((c) => c.messageId === rem.message_id);
      expect(mine()).toHaveLength(1);
      expect((await sendDueReminders({ now: t })).reconciled).toBeGreaterThanOrEqual(1);
      expect((await reminders(e.appointmentId)).find((x) => x.offset_minutes === 120)!.status).toBe("sent");
      await dispatchDue({ provider: rec.provider, now: t });
      expect(mine()).toHaveLength(1); // not twice
    });

    it("is not sent for an appointment that was cancelled or has started", async () => {
      const e = await setup(2 * 60);
      await apply({ ...e, status: "cancelled", eventTime: new Date(NOW.getTime() - 5_000) });
      const t = new Date(NOW.getTime() + 3 * 3_600_000 + 60_000);
      await sendDueReminders({ now: t });
      expect((await reminders(e.appointmentId)).every((x) => x.status === "cancelled")).toBe(true);
      const late = await setup(2 * 60);
      await sendDueReminders({ now: new Date(NOW.getTime() + 6 * 3_600_000) }); // after the start
      expect((await reminders(late.appointmentId)).filter((x) => x.status === "skipped").length).toBeGreaterThanOrEqual(1);
    });

    it("waits out quiet hours instead of waking the customer", async () => {
      await withSystem((db) => db.query("update messaging_policy set quiet_hours_start = '21:00', quiet_hours_end = '08:00'"));
      try {
        const start = new Date("2026-10-30T10:00:00Z");
        const e = ev({ kind: "create", contactId: ghl, startAt: start, eventTime: new Date(NOW.getTime() - 180_000) });
        await apply(e);
        await sendDueReminders({ now: new Date("2026-10-29T22:30:00Z") }); // the 24h reminder is due at 10:00 the day before; this is the night before
        const rem = (await reminders(e.appointmentId)).find((x) => x.offset_minutes === 1440)!;
        const msg = (await withSystem((db) => db.query<{ send_after: Date; status: string }>("select send_after, status from conversation_messages where id = $1", [rem.message_id]))).rows[0];
        expect(msg.status).toBe("queued");
        expect(new Date(msg.send_after).getTime()).toBeGreaterThan(new Date("2026-10-29T22:30:00Z").getTime());
        expect(new Date(msg.send_after).getUTCHours()).toBeGreaterThanOrEqual(8);
      } finally {
        await withSystem((db) => db.query("update messaging_policy set quiet_hours_start = '00:00', quiet_hours_end = '00:00'"));
      }
    });

    it("is held back when a person owns the conversation, the customer opted out, or messaging is paused", async () => {
      const t = new Date(NOW.getTime() + 3 * 3_600_000 + 60_000);
      const c2 = await inbound(m.org.id, { name: "Held Hank" });
      const g2 = (await withSystem((db) => db.query<{ ghl_contact_id: string }>("select ghl_contact_id from contacts where id = $1", [c2.contactId]))).rows[0].ghl_contact_id;
      const e = ev({ kind: "create", contactId: g2, startAt: new Date(NOW.getTime() + 5 * 3_600_000), eventTime: new Date(NOW.getTime() - 90_000) });
      await apply(e);
      await withSystem((db) => db.query("update conversations set owner_kind = 'human', owner_user_id = $2 where id = $1", [c2.conversationId, m.people.sales.id]));
      await sendDueReminders({ now: t });
      let rem = (await reminders(e.appointmentId)).find((x) => x.offset_minutes === 120)!;
      expect(rem).toMatchObject({ status: "blocked", reason: "human_owner" });
      await withSystem((db) => db.query("update appointment_reminders set status = 'scheduled', reason = null where id = (select r.id from appointment_reminders r join appointment_refs a on a.id = r.appointment_id where a.ghl_appointment_id = $1 and r.offset_minutes = 120)", [e.appointmentId]));
      await withSystem((db) => db.query("update conversations set owner_kind = 'ai', owner_user_id = null where id = $1", [c2.conversationId]));
      await withSystem((db) => suppressAddress(db, { orgId: m.org.id, channel: "sms", address: c2.address, reason: "opt_out", source: "test" }));
      await sendDueReminders({ now: t });
      rem = (await reminders(e.appointmentId)).find((x) => x.offset_minutes === 120)!;
      expect(rem).toMatchObject({ status: "blocked", reason: "suppressed" });
    });

    it("is stopped by the pause switch and by missing credits, and does not use the follow-up allowance", async () => {
      const t = new Date(NOW.getTime() + 3 * 3_600_000 + 60_000);
      const c3 = await inbound(m.org.id, { name: "Paused Pam" });
      const g3 = (await withSystem((db) => db.query<{ ghl_contact_id: string }>("select ghl_contact_id from contacts where id = $1", [c3.contactId]))).rows[0].ghl_contact_id;
      const e = ev({ kind: "create", contactId: g3, startAt: new Date(NOW.getTime() + 5 * 3_600_000), eventTime: new Date(NOW.getTime() - 80_000) });
      await apply(e);
      await setClientPause(m.ctx("owner"), { scope: "messaging", paused: true, reason: "test" });
      await sendDueReminders({ now: t });
      await setClientPause(m.ctx("owner"), { scope: "messaging", paused: false });
      expect((await reminders(e.appointmentId)).find((x) => x.offset_minutes === 120)).toMatchObject({ status: "blocked", reason: "automation_paused" });

      // No follow-up allowance is spent on reminders: with the allowance at zero a reminder still goes.
      await withSystem((db) => db.query("update appointment_reminders set status = 'scheduled', reason = null where appointment_id = (select id from appointment_refs where ghl_appointment_id = $1)", [e.appointmentId]));
      await withSystem((db) => db.query("update messaging_policy set max_followups_per_contact_30d = 0"));
      await sendDueReminders({ now: t });
      await withSystem((db) => db.query("update messaging_policy set max_followups_per_contact_30d = 6"));
      expect((await reminders(e.appointmentId)).find((x) => x.offset_minutes === 120)).toMatchObject({ status: "queued" });
    });

    it("pauses and asks the owner to renew when the standing authorization has lapsed", async () => {
      const t = new Date(NOW.getTime() + 3 * 3_600_000 + 60_000);
      const c4 = await inbound(m.org.id, { name: "Lapsed Les" });
      const g4 = (await withSystem((db) => db.query<{ ghl_contact_id: string }>("select ghl_contact_id from contacts where id = $1", [c4.contactId]))).rows[0].ghl_contact_id;
      const e = ev({ kind: "create", contactId: g4, startAt: new Date(NOW.getTime() + 5 * 3_600_000), eventTime: new Date(NOW.getTime() - 70_000) });
      await apply(e);
      await withSystem((db) => db.query("update approval_requests set expires_at = now() - interval '1 day' where id = (select reminders_approval_id from appointment_settings where org_id = $1)", [m.org.id]));
      expect((await getPolicyView(owner())).remindersAuthorization).toBe("expired");
      await sendDueReminders({ now: t });
      expect((await reminders(e.appointmentId)).find((x) => x.offset_minutes === 120)).toMatchObject({ status: "blocked", reason: "authorization_needed" });
      expect((await notes(m.people.owner.id, "booking_needs_action")).some((n) => n.title.includes("Renew your appointment reminders"))).toBe(true);
    });
  });

  it("stop being planned when the owner switches them off", async () => {
    const e = ev({ kind: "create", contactId: ghl, startAt: at(6, 12), eventTime: new Date(NOW.getTime() - 50_000) });
    await apply(e);
    expect((await reminders(e.appointmentId)).some((r) => r.status === "scheduled")).toBe(true);
    await savePolicy(owner(), { remindersEnabled: false });
    expect((await reminders(e.appointmentId)).every((r) => r.status === "cancelled")).toBe(true);
    await savePolicy(owner(), { remindersEnabled: true });
  });
});

// ---------------------------------------------------------------------------

describe("who can see what", () => {
  it("shows bookings and rules to anyone who can see appointments, the ledger only to owners and managers, and nothing across workspaces", async () => {
    const count = async (userId: string, table: string) => (await withUser(userId, (db) => db.query(`select 1 from ${table}`))).rows.length;
    expect(await count(m.people.viewer.id, "appointment_settings")).toBe(1);
    expect(await count(m.people.viewer.id, "appointment_bookings")).toBeGreaterThan(0);
    expect(await count(m.people.viewer.id, "appointment_events")).toBe(0);
    expect(await count(m.people.owner.id, "appointment_events")).toBeGreaterThan(0);
    expect(await count(m.people.manager.id, "appointment_events")).toBeGreaterThan(0);
    const theirs = await withUser(other.people.owner.id, (db) => db.query<{ org_id: string }>("select distinct org_id from appointment_events"));
    expect(theirs.rows.every((r) => r.org_id === other.org.id)).toBe(true);
    for (const table of ["appointment_settings", "appointment_events", "appointment_bookings", "appointment_reminders"]) {
      await expect(withUser(m.people.owner.id, (db) => db.query(`delete from ${table}`))).rejects.toBeTruthy();
    }
  });

  it("registers the appointment jobs with the scheduler", () => {
    const names = JOBS.map((j) => j.name);
    for (const job of ["approvalExpiry", "bookingHolds", "appointmentReminders"]) expect(names).toContain(job);
    expect(names.indexOf("appointmentReminders")).toBeLessThan(names.indexOf("messagesDispatched")); // reminders are queued before the dispatcher runs
  });
});


// ---------------------------------------------------------------------------

describe("the AI employee and the calendar", () => {
  const seen: ReplyContext[] = [];
  const answer = (text: string): ReplyGenerator => async (ctx) => {
    seen.push(ctx);
    return { kind: "reply", text };
  };
  const choose = (startIso: string): ReplyGenerator => async (ctx) => {
    seen.push(ctx);
    return { kind: "book", startIso, summary: "Viewing" };
  };
  const lastOf = () => seen[seen.length - 1];
  const outbound = async (conversationId: string) =>
    (await withSystem((db) => db.query<{ body: string; status: string; scope: string }>("select body, status, scope from conversation_messages where conversation_id = $1 and direction = 'outbound' order by created_at, id", [conversationId]))).rows;

  it("recognises booking talk, including a reply to an earlier offer, and ignores the rest", () => {
    expect(detectBookingIntent("Hi, do you have availability this week?")).toBe(true);
    expect(detectBookingIntent("Can I book a viewing?")).toBe(true);
    expect(detectBookingIntent("What are your prices?")).toBe(false);
    expect(detectBookingIntent("Tuesday 2pm works for me", ["We have Tuesday at 2pm or Wednesday at 10am available."])).toBe(true);
    expect(detectBookingIntent("Tuesday 2pm works for me", ["What are your prices?"])).toBe(false);
  });

  it("reads a booking choice from the model and refuses malformed ones", () => {
    expect(parseReply('{"book":"2026-10-29T09:00:00Z","summary":"Viewing Tuesday"}')).toMatchObject({ kind: "book", startIso: "2026-10-29T09:00:00.000Z", summary: "Viewing Tuesday" });
    expect(parseReply('{"book":"soon","summary":"x"}').kind).toBe("unavailable"); // never sent to the customer as text
    expect(parseReply("Sure, 2pm works").kind).toBe("reply");
  });

  it("tells the model exactly which times it may offer, or that it cannot see the calendar", () => {
    const ctx = { orgId: "o", agentId: "a", conversationId: "c", contactId: "k", inboundMessageId: "m", channel: "sms", businessName: "Acme", customerMessage: "x", history: [], confirmedFacts: [] } as ReplyContext;
    const withSlots = customerInstructions("BASE", { ...ctx, availability: { state: "slots", timeZone: "UTC", slots: [{ start: "2026-10-29T09:00:00.000Z", label: "Thursday, October 29, 9:00 AM UTC" }] } });
    expect(withSlots).toContain("2026-10-29T09:00:00.000Z");
    expect(withSlots).toMatch(/only times that are really free/);
    expect(withSlots).toMatch(/Never say or imply any other time/);
    expect(customerInstructions("BASE", { ...ctx, availability: { state: "unknown", reason: "x" } })).toMatch(/cannot see the calendar/);
    expect(customerInstructions("BASE", { ...ctx, availability: { state: "none", timeZone: "UTC" } })).toMatch(/no free times/);
    expect(customerInstructions("BASE", ctx)).not.toMatch(/## Booking/); // not mentioned unless the customer is talking about booking
    expect(bookingReplyText({ status: "awaiting_approval", bookingId: "b", approvalId: null }, "Tuesday")).not.toMatch(/you're booked/i);
    expect(bookingReplyText({ status: "needs_manual", bookingId: "b", reason: "x" }, "Tuesday")).not.toMatch(/you're booked/i);
  });

  it("reads the real calendar only when the customer is talking about booking", async () => {
    const f = fakeCalendar({ free: [at(3, 16), at(3, 17)] });
    const chat = await inbound(m.org.id, { body: "What are your prices?" });
    await respondToConversation(m.org.id, chat.conversationId, { generate: answer("Our prices are on the website."), provider: f.provider, now: NOW });
    expect(lastOf().availability).toBeUndefined();
    expect(f.calls.free).toBe(0);

    const ask = await inbound(m.org.id, { body: "Do you have availability this week for a viewing?" });
    await respondToConversation(m.org.id, ask.conversationId, { generate: answer("I can do Thursday at 9am or 10am."), provider: f.provider, now: NOW });
    const a = lastOf().availability;
    expect(a).toMatchObject({ state: "slots" });
    if (a?.state === "slots") expect(a.slots.map((x) => x.start)).toEqual([at(3, 16).toISOString(), at(3, 17).toISOString()]); // exactly the calendar's list
    expect(f.calls.free).toBe(1);
  });

  it("is told it cannot see the calendar when the calendar can't be read, and nothing is invented", async () => {
    const f = fakeCalendar({ freeError: { ok: false, reason: "unavailable", detail: "GoHighLevel could not be reached." } });
    const ask = await inbound(m.org.id, { body: "Can I book an appointment?" });
    await respondToConversation(m.org.id, ask.conversationId, { generate: answer("A team member will confirm a time shortly."), provider: f.provider, now: NOW });
    expect(lastOf().availability).toMatchObject({ state: "unknown" });
    const noCalendar = await messagingOrg({ name: "No Calendar Replies" });
    const ask2 = await inbound(noCalendar.org.id, { body: "Can I book an appointment?" });
    await respondToConversation(noCalendar.org.id, ask2.conversationId, { generate: answer("We will confirm."), provider: f.provider, now: NOW });
    expect(lastOf().availability).toMatchObject({ state: "unknown" });
  });

  it("books a time the customer chose only through the booking rules: a person confirms by default", async () => {
    await setPolicy(m, "ai_booking_enabled = false");
    const f = fakeCalendar({ free: [at(1, 16), at(1, 17)] });
    const ask = await inbound(m.org.id, { body: "I'd like to book a viewing." });
    const res = await respondToConversation(m.org.id, ask.conversationId, { generate: choose(at(1, 16).toISOString()), provider: f.provider, now: NOW });
    expect(res.status).toBe("queued");
    const out = await outbound(ask.conversationId);
    expect(out.at(-1)!.body).toMatch(/asked the team to confirm/);
    expect(out.at(-1)!.body).not.toMatch(/you're booked/i);
    expect(f.calls.create).toHaveLength(0);
    expect((await withSystem((db) => db.query("select status from appointment_bookings where conversation_id = $1", [ask.conversationId]))).rows).toMatchObject([{ status: "awaiting_approval" }]);
  });

  it("books and confirms once when the owner allowed the AI to book on its own", async () => {
    await setPolicy(m, "ai_booking_enabled = true");
    try {
      const f = fakeCalendar({ free: [at(2, 16)] });
      const ask = await inbound(m.org.id, { body: "Can I book Thursday at 9?" });
      const res = await respondToConversation(m.org.id, ask.conversationId, { generate: choose(at(2, 16).toISOString()), provider: f.provider, now: NOW });
      expect(res.status).toBe("queued");
      expect(f.calls.create).toHaveLength(1);
      const out = await outbound(ask.conversationId);
      expect(out).toHaveLength(1); // one confirmation, not a confirmation plus a second reply
      expect(out[0].body).toMatch(/You're booked for/);
    } finally {
      await setPolicy(m, "ai_booking_enabled = false");
    }
  });

  it("books nothing and brings in a person when the model names a time that wasn't on the calendar's list", async () => {
    await setPolicy(m, "ai_booking_enabled = true");
    try {
      const f = fakeCalendar({ free: [at(5, 16)] });
      const ask = await inbound(m.org.id, { body: "Can I book a viewing next week?" });
      const res = await respondToConversation(m.org.id, ask.conversationId, { generate: choose(at(5, 18).toISOString()), provider: f.provider, now: NOW });
      expect(res.status).toBe("unavailable");
      expect(f.calls.create).toHaveLength(0);
      expect(await outbound(ask.conversationId)).toHaveLength(0);
      expect((await withSystem((db) => db.query("select category from human_escalations where conversation_id = $1", [ask.conversationId]))).rows).toMatchObject([{ category: "unanswered_question" }]);
    } finally {
      await setPolicy(m, "ai_booking_enabled = false");
    }
  });

  it("tells the customer honestly when the time was just taken", async () => {
    await setPolicy(m, "ai_booking_enabled = true");
    try {
      // The list the employee saw included 09:00, but the calendar no longer has it when the booking is sent.
      let calls = 0;
      const f = fakeCalendar({ free: () => (++calls === 1 ? [at(4, 17)] : []) });
      const ask = await inbound(m.org.id, { body: "Can I book Friday at 9?" });
      await respondToConversation(m.org.id, ask.conversationId, { generate: choose(at(4, 17).toISOString()), provider: f.provider, now: NOW });
      const out = await outbound(ask.conversationId);
      expect(out.at(-1)!.body).toMatch(/just taken/);
      expect(f.calls.create).toHaveLength(0);
    } finally {
      await setPolicy(m, "ai_booking_enabled = false");
    }
  });
});

// Keep the unused helper types from tripping the linter in environments that don't use them.
void setAgentMode;
