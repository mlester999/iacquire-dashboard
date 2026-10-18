// Public booking pages, customer manage links, reminder links and booking abuse protection. Synthetic workspaces only; nothing here
// contacts a calendar provider or a messaging provider: reminders are dispatched only to an in-memory recorder (no message is sent).
import crypto from "node:crypto";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {}, replace() {}, prefetch() {} }),
  usePathname: () => "/book",
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  redirect: () => { throw new Error("NEXT_REDIRECT"); },
}));
import { withSystem } from "@/server/db";
import { createAppointmentType, createCalendar, listCalendars, setHostAvailability } from "@/server/calendars/setup";
import {
  bookingPageActor, bookNativeAppointment, cancelNativeAppointment, findByManageToken, issueManageLink, rescheduleNativeAppointment, revokeManageLinks,
} from "@/server/calendars/booking";
import {
  bookingFormToken, buildIcs, handleBook, handleIcs, handleManage, handleSlots, loadManagePage, manageFormToken, MAX_UPCOMING_PER_PERSON, resolvePublicBookingPage,
  type PublicBookBody, type PublicRequestMeta,
} from "@/server/calendars/public-booking";
import { claimDueReminders, queueClaimedReminder, reminderTemplate, reminderText, sendDueReminders } from "@/server/appointments/reminders";
import { dispatchMessage } from "@/server/messaging/send";
import { ghlProvider } from "@/server/messaging/provider";
import { memberActor } from "@/server/crm/actor";
import { createContact } from "@/server/crm/contacts";
import { savePolicy } from "@/server/appointments/settings";
import { setClientPause } from "@/server/automation/controls";
import { sha256 } from "@/server/security/crypto";
import { bookingConfirmedUrl, bookingUrl, manageUrl } from "@/lib/calendars/urls";
import { crmOrg, type CrmOrg } from "./support/crm";
import { inbound, messagingOrg, recordingProvider } from "./support/messaging";

const WEEKDAYS_9_TO_5 = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));
// Monday 19 October 2026, 08:00 in Manila (00:00 UTC).
const NOW = new Date("2026-10-19T00:00:00Z");
const at = (localHHMM: string, date = "2026-10-20") => new Date(`${date}T${localHHMM}:00+08:00`);

let ipCounter = 0;
/** Each test talks from its own address so per-visitor limits never leak between tests. */
const visitor = (over: Partial<PublicRequestMeta> = {}): PublicRequestMeta => ({
  origin: "https://app.example.test", host: "app.example.test", secFetchSite: "same-origin", ip: `198.51.100.${++ipCounter}`, now: NOW, ...over,
});

interface Page { a: CrmOrg; org: string; calendar: string; type: string; typeId: string; calendarId: string }

async function bookingPage(a: CrmOrg, opts: { calendarPublic?: boolean; typePublic?: boolean; location?: string } = {}): Promise<Page> {
  const owner = a.actor("owner");
  await setHostAvailability(owner, a.people.owner.id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });
  const cal = await createCalendar(owner, { name: `Consults ${crypto.randomBytes(2).toString("hex")}`, public: opts.calendarPublic ?? true, members: [{ userId: a.people.owner.id }] });
  const type = await createAppointmentType(owner, cal.id, {
    name: "Site visit", durationMinutes: 60, minNoticeMinutes: 60, maxDaysAhead: 30, public: opts.typePublic ?? true, locationKind: "in_person", locationDetail: opts.location ?? "12 Mango St, Makati",
  });
  const c = (await listCalendars(owner)).find((x) => x.id === cal.id)!;
  return { a, org: a.org.slug, calendar: c.slug, type: c.types.find((t) => t.id === type.id)!.slug, typeId: type.id, calendarId: cal.id };
}

const body = (p: Page, over: Partial<PublicBookBody> = {}): PublicBookBody => ({
  org: p.org, calendar: p.calendar, type: p.type, startAt: at("10:00").toISOString(), timeZone: "Asia/Manila", name: "Ana Reyes", email: "ana@example.test",
  idempotencyKey: crypto.randomUUID(), formToken: bookingFormToken(p.org, p.calendar, p.type, NOW.getTime() - 10_000), ...over,
});

const tokenOf = (manage: unknown) => decodeURIComponent(String(manage).split("/").pop()!);
const setType = (typeId: string, sql: string, params: unknown[] = []) => withSystem((db) => db.query(`update crm_appointment_types set ${sql} where id = $1`, [typeId, ...params]));
const manage = (token: string, over: Record<string, unknown>, meta = visitor()) =>
  handleManage(meta, { token, formToken: manageFormToken(token, (meta.now ?? NOW).getTime() - 10_000), ...over });
/** A workspace of its own, so one test's bookings never take another test's times (every page here shares the owner as host). */
const fresh = async (name = "Mango Clinic") => bookingPage(await crmOrg({ name, timezone: "Asia/Manila" }));

let a: CrmOrg;
let b: CrmOrg;
beforeAll(async () => {
  a = await crmOrg({ name: "Mango Clinic", timezone: "Asia/Manila" });
  b = await crmOrg({ name: "Other Clinic", timezone: "Asia/Manila" });
});

describe("booking page resolver", () => {
  it("shows a public calendar's public types with only public-safe details", async () => {
    const p = await bookingPage(a);
    await withSystem((db) => db.query("update crm_calendars set booking_intro = 'Pick a time that suits you.' where id = $1", [p.calendarId]));
    await setType(p.typeId, "questions = $2, require_phone = true, confirmation_message = 'See you soon.'", [JSON.stringify([{ key: "address", label: "Property address", type: "text", required: true }])]);
    const page = await resolvePublicBookingPage(p.org, p.calendar, p.type);
    expect(page).toMatchObject({
      business: { name: "Mango Clinic", slug: p.org },
      calendar: { slug: p.calendar, intro: "Pick a time that suits you." },
      type: { slug: p.type, name: "Site visit", durationMinutes: 60, locationKind: "in_person", locationLabel: "In person", requireEmail: true, requirePhone: true, questions: [{ key: "address", required: true }] },
    });
    const json = JSON.stringify(page);
    // No ids, no hosts, no internal place details, no confirmation copy before booking.
    for (const secret of [a.org.id, p.typeId, p.calendarId, a.people.owner.id, a.people.owner.email, "12 Mango St", "See you soon"]) expect(json).not.toContain(secret);
    const chooser = await resolvePublicBookingPage(p.org, p.calendar);
    expect(chooser?.type).toBeNull();
    expect(chooser?.types.map((t) => t.slug)).toEqual([p.type]);
  });

  it("hides private, archived, suspended, unknown and GoHighLevel-owned pages with the same not-found", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const p = await bookingPage(c);
    expect(await resolvePublicBookingPage(p.org, p.calendar, p.type)).not.toBeNull();
    // A private type disappears from the chooser and can't be opened directly.
    const hidden = await createAppointmentType(c.actor("owner"), p.calendarId, { name: "Staff only", durationMinutes: 30, public: false });
    const slugOf = (await listCalendars(c.actor("owner"))).find((x) => x.id === p.calendarId)!.types.find((t) => t.id === hidden.id)!.slug;
    expect(await resolvePublicBookingPage(p.org, p.calendar, slugOf)).toBeNull();
    expect((await resolvePublicBookingPage(p.org, p.calendar))?.types.map((t) => t.slug)).toEqual([p.type]);
    // Wrong or malformed slugs.
    expect(await resolvePublicBookingPage("no-such-business", p.calendar, p.type)).toBeNull();
    expect(await resolvePublicBookingPage(p.org, "../etc", p.type)).toBeNull();
    // GoHighLevel owns appointments: whole workspace, or the capability in a hybrid workspace.
    await withSystem((db) => db.query("update crm_workspaces set mode = 'ghl' where org_id = $1", [c.org.id]));
    expect(await resolvePublicBookingPage(p.org, p.calendar, p.type)).toBeNull();
    await withSystem((db) => db.query("update crm_workspaces set mode = 'hybrid' where org_id = $1", [c.org.id]));
    await withSystem((db) => db.query("insert into crm_capability_providers (org_id, capability, provider) values ($1, 'appointments', 'ghl')", [c.org.id]));
    expect(await resolvePublicBookingPage(p.org, p.calendar, p.type)).toBeNull();
    await withSystem((db) => db.query("delete from crm_capability_providers where org_id = $1", [c.org.id]));
    expect(await resolvePublicBookingPage(p.org, p.calendar, p.type)).not.toBeNull();
    await withSystem((db) => db.query("update crm_workspaces set mode = 'native' where org_id = $1", [c.org.id]));
    // A suspended or archived workspace.
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [c.org.id]));
    expect(await resolvePublicBookingPage(p.org, p.calendar, p.type)).toBeNull();
    await withSystem((db) => db.query("update organizations set status = 'active' where id = $1", [c.org.id]));
    // A private calendar, then an archived one.
    await withSystem((db) => db.query("update crm_calendars set public = false where id = $1", [p.calendarId]));
    expect(await resolvePublicBookingPage(p.org, p.calendar)).toBeNull();
    await withSystem((db) => db.query("update crm_calendars set public = true, archived_at = now() where id = $1", [p.calendarId]));
    expect(await resolvePublicBookingPage(p.org, p.calendar, p.type)).toBeNull();
    // The API gives the same answer for all of these.
    const res = await handleSlots(visitor(), { org: p.org, calendar: p.calendar, type: p.type, from: "2026-10-20", to: "2026-10-21", tz: "Asia/Manila" });
    expect(res.status).toBe(404);
    const unknown = await handleSlots(visitor(), { org: "no-such-business", calendar: p.calendar, type: p.type, from: "2026-10-20", to: "2026-10-21", tz: "Asia/Manila" });
    expect(unknown).toMatchObject({ status: 404, body: res.body });
  });
});

describe("slots", () => {
  it("returns at most 14 days of times in the invitee's time zone, without host details", async () => {
    const p = await fresh();
    const q = { org: p.org, calendar: p.calendar, type: p.type, tz: "Asia/Manila" };
    expect((await handleSlots(visitor(), { ...q, from: "2026-10-20", to: "2026-11-02" })).status).toBe(200);
    expect((await handleSlots(visitor(), { ...q, from: "2026-10-20", to: "2026-11-03" })).status).toBe(400);
    expect((await handleSlots(visitor(), { ...q, from: "2026-10-21", to: "2026-10-20" })).status).toBe(400);
    expect((await handleSlots(visitor(), { ...q, tz: "Mars/Olympus", from: "2026-10-20", to: "2026-10-20" })).status).toBe(400);
    const res = await handleSlots(visitor(), { ...q, from: "2026-10-20", to: "2026-10-20" });
    const slots = res.body.slots as Array<Record<string, unknown>>;
    expect(slots.map((s) => s.start)).toEqual(["01", "02", "03", "04", "05", "06", "07", "08"].map((h) => `2026-10-20T${h}:00:00.000Z`));
    expect(Object.keys(slots[0]).sort()).toEqual(["end", "remaining", "start"]);
    expect(res.headers?.["Cache-Control"]).toBe("no-store");
    // The same Tuesday morning in Manila is Monday evening in New York: the window follows the invitee's dates.
    const ny = await handleSlots(visitor(), { ...q, tz: "America/New_York", from: "2026-10-19", to: "2026-10-19" });
    const nyStarts = (ny.body.slots as Array<{ start: string }>).map((s) => s.start);
    expect(nyStarts).toContain("2026-10-20T01:00:00.000Z");
    expect(nyStarts.every((s) => s < "2026-10-20T04:00:00.000Z")).toBe(true);
    // Reads from another site's page are refused.
    expect((await handleSlots(visitor({ secFetchSite: "cross-site" }), { ...q, from: "2026-10-20", to: "2026-10-20" })).status).toBe(403);
  });
});

describe("booking through the public API", () => {
  it("books end to end: the contact lands in the right workspace only, the manage link works, and a repeated submit returns the same appointment", async () => {
    const p = await fresh();
    const other = await fresh("Other Clinic");
    const email = `walk-in-${crypto.randomBytes(3).toString("hex")}@example.test`;
    const req = body(p, { email, phone: "+63 917 555 0101", answers: { ignored: "x" }, notes: "Gate code 42" });
    const first = await handleBook(visitor(), req);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ ok: true, created: true, status: "confirmed" });
    const token = tokenOf(first.body.manageUrl);
    expect(first.body.confirmationUrl).toBe(bookingConfirmedUrl(p.org, p.calendar, p.type, token));
    const found = await findByManageToken(token, { now: NOW });
    expect(found).toMatchObject({ orgId: p.a.org.id, typeName: "Site visit", status: "confirmed", startAt: at("10:00").toISOString(), timezone: "Asia/Manila", canChange: true, linkIssuedFor: "booking" });

    const row = (await withSystem((db) => db.query<{ contact_id: string; booked_via: string; origin: string; description: string; idempotency_key: string }>(
      "select contact_id, booked_via, origin, description, idempotency_key from appointment_refs where id = $1", [found!.id]))).rows[0];
    expect(row).toMatchObject({ booked_via: "booking_page", origin: "booking_page", description: "Gate code 42", idempotency_key: `page:${req.idempotencyKey}` });
    const contacts = await withSystem((db) => db.query<{ org_id: string; timezone: string | null; display_name: string }>(
      "select c.org_id, c.timezone, c.display_name from contact_identities i join contacts c on c.id = i.contact_id where i.kind = 'email' and i.value = $1", [email]));
    expect(contacts.rows).toEqual([{ org_id: p.a.org.id, timezone: "Asia/Manila", display_name: "Ana Reyes" }]);
    expect(contacts.rows.some((r) => r.org_id === other.a.org.id)).toBe(false);

    // A double click or a retry: same appointment, and this answer carries its own working link.
    const again = await handleBook(visitor(), req);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, created: false });
    const second = await findByManageToken(tokenOf(again.body.manageUrl), { now: NOW });
    expect(second?.id).toBe(found!.id);
    expect(second?.linkIssuedFor).toBe("confirmation");
    const count = await withSystem((db) => db.query("select 1 from appointment_refs where org_id = $1 and contact_id = $2", [p.a.org.id, row.contact_id]));
    expect(count.rows).toHaveLength(1);
  });

  it("tells the customer when the time was just taken", async () => {
    const p = await fresh();
    expect((await handleBook(visitor(), body(p, { startAt: at("11:00").toISOString(), email: "first@example.test" }))).status).toBe(201);
    const late = await handleBook(visitor(), body(p, { startAt: at("11:00").toISOString(), email: "second@example.test" }));
    expect(late).toMatchObject({ status: 409, body: { code: "slot_taken", error: expect.stringMatching(/just taken/) } });
  });

  it("applies the type's required contact details", async () => {
    const p = await fresh();
    await setType(p.typeId, "require_email = false, require_phone = true");
    const noPhone = await handleBook(visitor(), body(p, { startAt: at("13:00").toISOString(), email: "nophone@example.test" }));
    expect(noPhone).toMatchObject({ status: 400, body: { field: "phone" } });
    expect((await handleBook(visitor(), body(p, { startAt: at("13:00").toISOString(), email: "", phone: "0917" }))).body).toMatchObject({ field: "phone" });
    const phoneOnly = await handleBook(visitor(), body(p, { startAt: at("13:00").toISOString(), email: "", phone: "+639175550199" }));
    expect(phoneOnly.status).toBe(201);
    await setType(p.typeId, "require_email = true, require_phone = false");
    expect((await handleBook(visitor(), body(p, { startAt: at("14:00").toISOString(), email: "" }))).body).toMatchObject({ field: "email" });
    expect((await handleBook(visitor(), body(p, { startAt: at("14:00").toISOString(), email: "not-an-email" }))).body).toMatchObject({ field: "email" });
    expect((await handleBook(visitor(), body(p, { startAt: at("14:00").toISOString(), name: "   " }))).body).toMatchObject({ field: "name" });
    // Required questions are checked before anything is stored.
    await setType(p.typeId, "questions = $2", [JSON.stringify([{ key: "pet", label: "Pet name", type: "select", required: true, options: ["Rex", "Tom"] }])]);
    expect((await handleBook(visitor(), body(p, { startAt: at("14:00").toISOString() }))).body).toMatchObject({ field: "answers.pet" });
    expect((await handleBook(visitor(), body(p, { startAt: at("14:00").toISOString(), answers: { pet: "Bob" } }))).body).toMatchObject({ field: "answers.pet" });
    expect((await handleBook(visitor(), body(p, { startAt: at("14:00").toISOString(), answers: { pet: "Rex" } }))).status).toBe(201);
    // The service enforces the same rule for any public booking, whatever calls it.
    await setType(p.typeId, "require_phone = true, questions = '[]'");
    const page = await bookingPageActor(p.a.org.id);
    await expect(bookNativeAppointment(page, { typeId: p.typeId, startAt: at("15:00"), contact: { firstName: "Svc", email: "svc@example.test" }, via: "website", now: NOW })).rejects.toThrow(/phone number/);
    // Staff bookings are unaffected.
    const staff = await bookNativeAppointment(p.a.actor("owner"), { typeId: p.typeId, startAt: at("15:00"), contact: { firstName: "Svc", email: "svc@example.test" }, via: "staff", now: NOW });
    expect(staff.created).toBe(true);
  });

  it("refuses a filled honeypot, a bad or too-fresh token, and a cross-site post, and stores nothing", async () => {
    const p = await fresh();
    const before = await withSystem((db) => db.query("select 1 from appointment_refs where appointment_type_id = $1", [p.typeId]));
    const honeypot = await handleBook(visitor(), { ...body(p), website: "http://spam.example" });
    expect(honeypot).toMatchObject({ status: 400, body: { code: "refused" } });
    const tooFresh = await handleBook(visitor(), body(p, { formToken: bookingFormToken(p.org, p.calendar, p.type, NOW.getTime() - 500) }));
    expect(tooFresh).toMatchObject({ status: 429, body: { code: "too_fast" } });
    const forged = await handleBook(visitor(), body(p, { formToken: `${NOW.getTime() - 10_000}.forged` }));
    expect(forged).toMatchObject({ status: 400, body: { code: "expired" } });
    // A token from another page doesn't fit this one.
    const elsewhere = await handleBook(visitor(), body(p, { formToken: bookingFormToken(p.org, p.calendar, "other-type", NOW.getTime() - 10_000) }));
    expect(elsewhere.status).toBe(400);
    const stale = await handleBook(visitor(), body(p, { formToken: bookingFormToken(p.org, p.calendar, p.type, NOW.getTime() - 7 * 3_600_000) }));
    expect(stale.body).toMatchObject({ code: "expired" });
    expect((await handleBook(visitor({ origin: "https://evil.example" }), body(p))).status).toBe(403);
    expect((await handleBook(visitor({ origin: null, secFetchSite: "cross-site" }), body(p))).status).toBe(403);
    expect((await handleBook(visitor(), { nonsense: true })).status).toBe(400);
    const after = await withSystem((db) => db.query("select 1 from appointment_refs where appointment_type_id = $1", [p.typeId]));
    expect(after.rows.length).toBe(before.rows.length);
  });

  it("limits how often one visitor can submit", async () => {
    const p = await fresh();
    const meta = visitor();
    for (let i = 0; i < 10; i++) expect((await handleBook(meta, body(p, { name: "" }))).status).toBe(400);
    const refused = await handleBook(meta, body(p));
    expect(refused).toMatchObject({ status: 429, body: { code: "rate_limited" } });
    expect(Number(refused.headers?.["Retry-After"])).toBeGreaterThan(0);
  });

  it(`caps upcoming bookings at ${MAX_UPCOMING_PER_PERSON} per email address for a type, without saying whether the address is known`, async () => {
    const p = await fresh();
    for (const t of ["09:00", "10:00", "11:00"]) expect((await handleBook(visitor(), body(p, { startAt: at(t).toISOString(), email: "keen@example.test" }))).status).toBe(201);
    const fourth = await handleBook(visitor(), body(p, { startAt: at("12:00").toISOString(), email: "KEEN@example.test" }));
    expect(fourth).toMatchObject({ status: 409, body: { code: "limit" } });
    expect(String(fourth.body.error)).not.toMatch(/keen@|already exists|registered/i);
    // Someone else can still book that time.
    expect((await handleBook(visitor(), body(p, { startAt: at("12:00").toISOString(), email: "other@example.test" }))).status).toBe(201);
  });
});

describe("manage links", () => {
  it("customers reschedule and cancel within the type's rules; repeats change nothing", async () => {
    const p = await fresh();
    const res = await handleBook(visitor(), body(p, { startAt: at("09:00").toISOString(), email: "mover@example.test" }));
    const token = tokenOf(res.body.manageUrl);
    // Slots for moving leave the booking's own time free.
    const slots = await handleSlots(visitor(), { token, from: "2026-10-20", to: "2026-10-20", tz: "Asia/Manila" });
    expect((slots.body.slots as Array<{ start: string }>).map((s) => s.start)).toContain(at("09:00").toISOString());
    const moved = await manage(token, { action: "reschedule", startAt: at("13:00").toISOString() });
    expect(moved).toMatchObject({ status: 200, body: { ok: true, changed: true, startAt: at("13:00").toISOString() } });
    expect((await manage(token, { action: "reschedule", startAt: at("13:00").toISOString() })).body).toMatchObject({ ok: true, changed: false });
    const view = await loadManagePage(token, { now: NOW });
    expect(view).toMatchObject({ appointment: { startAt: at("13:00").toISOString(), status: "confirmed", location: "In person: 12 Mango St, Makati" }, canChange: true, bookAgainUrl: bookingUrl(p.org, p.calendar, p.type) });
    // A stale page (the booking changed since it was opened) is told to reload.
    expect((await manage(token, { action: "reschedule", startAt: at("15:00").toISOString(), version: 1 })).body).toMatchObject({ code: "stale" });
    const cancelled = await manage(token, { action: "cancel", reason: "Travelling" });
    expect(cancelled.body).toMatchObject({ ok: true, changed: true });
    expect((await manage(token, { action: "cancel" })).body).toMatchObject({ ok: true, changed: false });
    expect((await manage(token, { action: "reschedule", startAt: at("16:00").toISOString() })).body).toMatchObject({ code: "not_allowed" });
    const apptId = (await findByManageToken(token, { now: NOW }))!.id;
    const audit = await withSystem((db) => db.query<{ action: string }>("select action from audit_logs where org_id = $1 and target_id = $2 order by created_at", [p.a.org.id, apptId]));
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["appointment.customer_rescheduled", "appointment.customer_cancelled"]));
  });

  it("a cutoff, or a type that doesn't allow changes, stops online changes and says whom to contact; staff can still change it", async () => {
    const p = await fresh();
    const res = await handleBook(visitor(), body(p, { startAt: at("16:00").toISOString(), email: "cutoff@example.test" }));
    const token = tokenOf(res.body.manageUrl);
    const id = (await findByManageToken(token, { now: NOW }))!.id;
    await setType(p.typeId, "change_cutoff_minutes = 1440");
    // The appointment is at 08:00 UTC on the 20th: changes close at 08:00 UTC on the 19th.
    const before = new Date("2026-10-19T07:00:00Z");
    const after = new Date("2026-10-19T09:00:00Z");
    expect(await findByManageToken(token, { now: before })).toMatchObject({ canChange: true, changeDeadline: "2026-10-19T08:00:00.000Z" });
    expect(await findByManageToken(token, { now: after })).toMatchObject({ canChange: false, cannotChangeReason: "past_cutoff" });
    const late = await manage(token, { action: "cancel" }, visitor({ now: after }));
    expect(late).toMatchObject({ status: 409, body: { code: "not_allowed", error: expect.stringContaining("Contact Mango Clinic") } });
    const page = await bookingPageActor(p.a.org.id);
    await expect(cancelNativeAppointment(page, id, { by: "customer", now: after })).rejects.toThrow(/too close/);
    await expect(rescheduleNativeAppointment(page, id, { startAt: at("09:00", "2026-10-21"), by: "customer", now: after })).rejects.toThrow(/too close/);

    await setType(p.typeId, "change_cutoff_minutes = 0, allow_customer_changes = false");
    expect(await findByManageToken(token, { now: NOW })).toMatchObject({ canChange: false, cannotChangeReason: "not_allowed", changeDeadline: null });
    expect((await manage(token, { action: "cancel" })).body).toMatchObject({ code: "not_allowed", error: expect.stringMatching(/can't be changed online/) });
    await expect(cancelNativeAppointment(page, id, { by: "customer", now: NOW })).rejects.toThrow(/can't be changed online/);
    expect((await handleSlots(visitor(), { token, from: "2026-10-20", to: "2026-10-20", tz: "Asia/Manila" })).status).toBe(409);
    // The business can always change it.
    await rescheduleNativeAppointment(p.a.actor("owner"), id, { startAt: at("09:00", "2026-10-21"), by: "staff", now: NOW });
    expect((await cancelNativeAppointment(p.a.actor("owner"), id, { by: "staff", now: NOW })).changed).toBe(true);
  });

  it("issued links work until they expire or are revoked, are stored only as a hash, and leave the booking's own link alone", async () => {
    const p = await fresh();
    const res = await handleBook(visitor(), body(p, { startAt: at("12:00").toISOString(), email: "links@example.test" }));
    const original = tokenOf(res.body.manageUrl);
    const id = (await findByManageToken(original, { now: NOW }))!.id;
    const issued = await withSystem((db) => issueManageLink(db, p.a.org.id, id, "staff", 60, NOW));
    expect(await findByManageToken(issued, { now: NOW })).toMatchObject({ id, linkIssuedFor: "staff" });
    expect(await findByManageToken(issued, { now: new Date(NOW.getTime() + 2 * 3_600_000) })).toBeNull();
    const rows = await withSystem((db) => db.query<Record<string, unknown>>("select * from crm_appointment_links where appointment_id = $1", [id]));
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].token_hash).toBe(sha256(issued));
    expect(JSON.stringify(rows.rows)).not.toContain(issued);
    const another = await withSystem((db) => issueManageLink(db, p.a.org.id, id, "reschedule", 60 * 24, NOW));
    expect(await withSystem((db) => revokeManageLinks(db, p.a.org.id, id, { token: another }))).toBe(1);
    expect(await findByManageToken(another, { now: NOW })).toBeNull();
    expect(await withSystem((db) => revokeManageLinks(db, p.a.org.id, id))).toBe(1);
    expect(await findByManageToken(issued, { now: NOW })).toBeNull();
    expect((await findByManageToken(original, { now: NOW }))?.id).toBe(id);
    // Links are issued only for this workspace's own native appointments, for a known purpose and a sane lifetime.
    await expect(withSystem((db) => issueManageLink(db, b.org.id, id, "staff", 60, NOW))).rejects.toThrow(/not found/);
    await expect(withSystem((db) => issueManageLink(db, p.a.org.id, id, "forever" as "staff", 60, NOW))).rejects.toThrow(/what the link is for/);
    await expect(withSystem((db) => issueManageLink(db, p.a.org.id, id, "staff", 0, NOW))).rejects.toThrow(/400 days/);
    expect(await findByManageToken("short")).toBeNull();
  });

  it("another workspace's link can't act on this workspace, whatever the request says", async () => {
    const pa = await fresh();
    const pb = await fresh("Other Clinic");
    const ra = await handleBook(visitor(), body(pa, { startAt: at("14:00").toISOString(), email: "cross@example.test" }));
    const rb = await handleBook(visitor(), body(pb, { startAt: at("14:00").toISOString(), email: "cross@example.test" }));
    const ta = tokenOf(ra.body.manageUrl);
    const idB = (await findByManageToken(tokenOf(rb.body.manageUrl), { now: NOW }))!.id;
    const res = await manage(ta, { action: "cancel", appointmentId: idB, orgId: pb.a.org.id, org: pb.org });
    expect(res.body).toMatchObject({ ok: true, changed: true });
    const idA = (await findByManageToken(ta, { now: NOW }))!.id;
    const statuses = await withSystem((db) => db.query<{ org_id: string; status: string }>("select org_id, status from appointment_refs where id = any($1::uuid[])", [[idB, idA]]));
    expect(Object.fromEntries(statuses.rows.map((r) => [r.org_id, r.status]))).toEqual({ [pa.a.org.id]: "cancelled", [pb.a.org.id]: "confirmed" });
    // The booking page actor of one workspace can't reach another's appointment either.
    await expect(cancelNativeAppointment(await bookingPageActor(pa.a.org.id), idB, { by: "customer", now: NOW })).rejects.toThrow(/not found/);
    // A form token for one link doesn't authorize another.
    const tb = tokenOf(rb.body.manageUrl);
    const mixed = await handleManage(visitor(), { token: tb, action: "cancel", formToken: manageFormToken(ta, NOW.getTime() - 10_000) });
    expect(mixed.status).toBe(400);
  });

  it("refuses a manage request with a filled honeypot or from another site, and limits changes per link", async () => {
    const p = await fresh();
    const res = await handleBook(visitor(), body(p, { startAt: at("15:00").toISOString(), email: "busy@example.test" }));
    const token = tokenOf(res.body.manageUrl);
    expect((await manage(token, { action: "cancel", website: "x" })).body).toMatchObject({ code: "refused" });
    expect((await manage(token, { action: "cancel" }, visitor({ origin: "https://evil.example" }))).status).toBe(403);
    expect((await manage("x".repeat(30), { action: "cancel" })).status).toBe(404);
    // Repeated moves of one booking hit the per-link limit (8 an hour), whatever address they come from.
    const results: number[] = [];
    for (let i = 0; i < 9; i++) results.push((await manage(token, { action: "reschedule", startAt: at(i % 2 ? "09:00" : "10:00", "2026-10-22").toISOString() })).status);
    expect(results.slice(0, 8).every((s) => s === 200)).toBe(true);
    expect(results[8]).toBe(429);
  });
});

describe("add to calendar", () => {
  it("builds an .ics with UTC times, a stable UID across reschedules, and nothing the customer didn't enter", async () => {
    const p = await fresh();
    // The CRM already knows this address under another name; the calendar file must not reveal it.
    await createContact(p.a.actor("owner"), { firstName: "Private", lastName: "Name", email: "known@example.test" });
    const res = await handleBook(visitor(), body(p, { startAt: at("09:00", "2026-10-21").toISOString(), email: "known@example.test", name: "Someone Else" }));
    const token = tokenOf(res.body.manageUrl);
    const first = await handleIcs(visitor(), token);
    expect(first.status).toBe(200);
    expect(first.headers["Content-Type"]).toMatch(/^text\/calendar/);
    expect(first.headers["Cache-Control"]).toBe("no-store");
    const ics = first.body;
    expect(ics).toContain("BEGIN:VCALENDAR\r\n");
    expect(ics).toContain("DTSTART:20261021T010000Z\r\n");
    expect(ics).toContain("DTEND:20261021T020000Z\r\n");
    expect(ics).toContain("SUMMARY:Site visit with Mango Clinic\r\n");
    expect(ics).toContain("LOCATION:In person: 12 Mango St\\, Makati\r\n");
    expect(ics).toContain("STATUS:CONFIRMED");
    for (const secret of ["Private", p.a.people.owner.email, p.a.org.id, p.a.people.owner.id]) expect(ics).not.toContain(secret);
    expect(ics.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    const uid = ics.match(/UID:(.+)\r\n/)![1];
    await manage(token, { action: "reschedule", startAt: at("10:00", "2026-10-21").toISOString() });
    const moved = (await handleIcs(visitor(), token)).body;
    expect(moved.match(/UID:(.+)\r\n/)![1]).toBe(uid);
    expect(moved).toContain("DTSTART:20261021T020000Z");
    expect(moved).toContain("SEQUENCE:1");
    expect((await handleIcs(visitor(), "not-a-real-token-but-long-enough")).status).toBe(404);
    expect((await handleIcs(visitor(), null)).status).toBe(404);
  });

  it("escapes text and folds long lines without splitting characters", () => {
    const out = buildIcs({ uid: "u@x", start: "2026-10-20T01:00:00Z", end: "2026-10-20T02:00:00Z", summary: "Café; consult, with \\ notes", location: "Line one\nLine two", description: "ñ".repeat(80), url: null, status: "TENTATIVE", sequence: 0, stamp: NOW });
    expect(out).toContain("SUMMARY:Café\\; consult\\, with \\\\ notes");
    expect(out).toContain("LOCATION:Line one\\nLine two");
    const lines = out.split("\r\n");
    expect(lines.every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(lines.filter((l) => l.startsWith(" ")).length).toBeGreaterThan(0);
    expect(out.replace(/\r\n /g, "")).toContain(`DESCRIPTION:${"ñ".repeat(80)}`);
  });
});

describe("reminders", () => {
  /** A workspace whose reminders are switched on, with one flexible type (customers may change bookings) and one fixed type. */
  async function reminderClinic(name: string) {
    const m = await messagingOrg({ name });
    const owner = memberActor(m.ctx("owner"));
    await setHostAvailability(owner, m.people.owner.id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });
    const cal = await createCalendar(owner, { name: "Visits", public: true, members: [{ userId: m.people.owner.id }] });
    const flexible = await createAppointmentType(owner, cal.id, { name: "Home visit", durationMinutes: 60, minNoticeMinutes: 60, locationKind: "in_person", locationDetail: "45 Acacia Ave" });
    const fixed = await createAppointmentType(owner, cal.id, { name: "Inspection", durationMinutes: 60, minNoticeMinutes: 60, locationKind: "phone" });
    await setType(fixed.id, "allow_customer_changes = false");
    await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, enabled = true, mode = 'autonomous' where org_id = $1 and role_key = 'appointment_setter'", [m.org.id]));
    await savePolicy(m.ctx("owner"), { remindersEnabled: true, reminderOffsetsMinutes: [120] });
    return { m, owner, flexible, fixed };
  }
  const reminderMessage = async (appointmentId: string) =>
    (await withSystem((db) => db.query<{ id: string; body: string; status: string }>(
      "select m.id, m.body, m.status from appointment_reminders r join conversation_messages m on m.id = r.message_id where r.appointment_id = $1", [appointmentId]))).rows[0];
  const linksFor = async (appointmentId: string) =>
    (await withSystem((db) => db.query<{ issued_for: string; expires_at: Date; revoked_at: Date | null }>("select issued_for, expires_at, revoked_at from crm_appointment_links where appointment_id = $1", [appointmentId]))).rows;

  it("say where, store no working link, and give the customer a fresh manage link only in what is sent", async () => {
    const { m, owner, flexible, fixed } = await reminderClinic("Reminder Clinic");
    const rita = await inbound(m.org.id, { name: "Rita Reminder" });
    const tom = await inbound(m.org.id, { name: "Tom Twice" });
    const one = await bookNativeAppointment(owner, { typeId: flexible.id, startAt: at("10:00"), contact: { id: rita.contactId }, via: "staff", now: NOW });
    const two = await bookNativeAppointment(owner, { typeId: fixed.id, startAt: at("11:00"), contact: { id: tom.contactId }, via: "staff", now: NOW });

    // 10:00 Manila is 02:00 UTC, so its 2-hour reminder is due at 00:00 UTC; 11:00's is due at 01:00 UTC. Both are due, neither has started.
    const due = new Date("2026-10-20T01:01:00Z");
    const out = await sendDueReminders({ now: due });
    expect(out.queued).toBeGreaterThanOrEqual(2);
    const flexibleMsg = await reminderMessage(one.appointmentId);
    expect(flexibleMsg.status).toBe("queued");
    expect(flexibleMsg.body).toContain("Where: In person: 45 Acacia Ave.");
    // Stored for anyone who can read the inbox, a timeline or an export: a placeholder, never a working link, and no link issued yet.
    expect(flexibleMsg.body).toMatch(/To reschedule or cancel: \{\{appointment\.manage_link\}\}$/);
    expect(flexibleMsg.body).not.toContain("/book/manage/");
    expect(await linksFor(one.appointmentId)).toHaveLength(0);

    // The dispatcher issues a fresh link for the provider call only.
    const rec = recordingProvider();
    expect(await dispatchMessage(flexibleMsg.id, { provider: rec.provider, now: due })).toEqual({ status: "sent" });
    const sent = rec.calls.find((c) => c.messageId === flexibleMsg.id)!;
    expect(sent.body).not.toContain("{{");
    const link = sent.body.match(/To reschedule or cancel: (\S+)$/)![1];
    expect(link.startsWith("http://localhost:3000/book/manage/")).toBe(true);
    const viaReminder = await findByManageToken(tokenOf(link), { now: due });
    expect(viaReminder).toMatchObject({ id: one.appointmentId, linkIssuedFor: "reminder", canChange: true });
    const links = await linksFor(one.appointmentId);
    expect(links.map((r) => r.issued_for)).toEqual(["reminder"]);
    expect(new Date(links[0].expires_at).getTime()).toBeGreaterThan(at("10:00").getTime());
    // Nothing stored afterwards holds the secret: not the message, not the conversation preview.
    const token = tokenOf(link);
    const row = await withSystem((db) => db.query<Record<string, unknown>>("select * from conversation_messages where id = $1", [flexibleMsg.id]));
    expect(JSON.stringify(row.rows[0])).not.toContain(token);
    expect(row.rows[0].body).toBe(flexibleMsg.body);
    const conv = await withSystem((db) => db.query<{ last_message_preview: string }>("select last_message_preview from conversations where id = $1", [row.rows[0].conversation_id]));
    expect(conv.rows[0].last_message_preview).not.toContain(token);
    expect(conv.rows[0].last_message_preview).not.toContain("{{");

    const fixedMsg = await reminderMessage(two.appointmentId);
    expect(fixedMsg.body).toContain("Where: Phone call.");
    expect(fixedMsg.body).not.toContain("/book/manage/");
    expect(fixedMsg.body).not.toContain("manage_link");
    expect(fixedMsg.body).toContain("Reply here if you need to change it.");
    expect(await dispatchMessage(fixedMsg.id, { provider: rec.provider, now: due })).toEqual({ status: "sent" });
    expect(rec.calls.find((c) => c.messageId === fixedMsg.id)!.body).toBe(fixedMsg.body);
    expect(await linksFor(two.appointmentId)).toHaveLength(0);
  });

  it("leaves the link out when the booking can no longer be changed by the time the reminder goes, and withdraws one nobody received", async () => {
    const { m, owner, flexible } = await reminderClinic("Late Change Clinic");
    const ana = await inbound(m.org.id, { name: "Ana Late" });
    const ben = await inbound(m.org.id, { name: "Ben Blocked" });
    // 13:00 and 14:00 Manila (05:00 and 06:00 UTC): their 2-hour reminders are due at 03:00 and 04:00 UTC, and neither has started at 04:01.
    const one = await bookNativeAppointment(owner, { typeId: flexible.id, startAt: at("13:00"), contact: { id: ana.contactId }, via: "staff", now: NOW });
    const two = await bookNativeAppointment(owner, { typeId: flexible.id, startAt: at("14:00"), contact: { id: ben.contactId }, via: "staff", now: NOW });
    const due = new Date("2026-10-20T04:01:00Z");
    await sendDueReminders({ now: due });
    const first = await reminderMessage(one.appointmentId);
    const second = await reminderMessage(two.appointmentId);
    expect(first.body).toContain("{{appointment.manage_link}}");
    expect(second.body).toContain("{{appointment.manage_link}}");

    // The type stops allowing online changes before the reminder is dispatched: the sentence goes, nothing raw is sent, no link exists.
    await setType(flexible.id, "allow_customer_changes = false");
    const rec = recordingProvider();
    expect(await dispatchMessage(first.id, { provider: rec.provider, now: due })).toEqual({ status: "sent" });
    const sent = rec.calls[0].body;
    expect(sent).not.toContain("{{");
    expect(sent).not.toContain("reschedule");
    expect(sent.endsWith("Where: In person: 45 Acacia Ave.")).toBe(true);
    expect(await linksFor(one.appointmentId)).toHaveLength(0);

    // Changes allowed again, but the provider refuses before anything leaves (sending is switched off here): the link issued for that
    // attempt is withdrawn at once.
    await setType(flexible.id, "allow_customer_changes = true");
    expect(await dispatchMessage(second.id, { provider: ghlProvider, now: due })).toEqual({ status: "blocked" });
    const links = await linksFor(two.appointmentId);
    expect(links).toHaveLength(1);
    expect(links[0].revoked_at).not.toBeNull();
  });

  it("issues no link when the reminder can't go", async () => {
    const m = await messagingOrg({ name: "Paused Clinic" });
    const owner = memberActor(m.ctx("owner"));
    await setHostAvailability(owner, m.people.owner.id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });
    const cal = await createCalendar(owner, { name: "Visits", public: true, members: [{ userId: m.people.owner.id }] });
    const type = await createAppointmentType(owner, cal.id, { name: "Home visit", durationMinutes: 60, minNoticeMinutes: 60 });
    await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, enabled = true, mode = 'autonomous' where org_id = $1 and role_key = 'appointment_setter'", [m.org.id]));
    await savePolicy(m.ctx("owner"), { remindersEnabled: true, reminderOffsetsMinutes: [120] });
    const c = await inbound(m.org.id, { name: "Paula Paused" });
    const appt = await bookNativeAppointment(owner, { typeId: type.id, startAt: at("11:00", "2026-10-21"), contact: { id: c.contactId }, via: "staff", now: NOW });
    await setClientPause(m.ctx("owner"), { scope: "messaging", paused: true, reason: "test" });
    try {
      await sendDueReminders({ now: new Date("2026-10-21T01:01:00Z") });
    } finally {
      await setClientPause(m.ctx("owner"), { scope: "messaging", paused: false });
    }
    const rem = await withSystem((db) => db.query<{ status: string }>("select status from appointment_reminders where appointment_id = $1", [appt.appointmentId]));
    expect(rem.rows[0].status).toBe("blocked");
    expect(await linksFor(appt.appointmentId)).toHaveLength(0);
  });

  it("re-checks each claimed reminder before queuing it: one rescheduled, cancelled or moved after the claim is never queued for the old time", async () => {
    const { m, owner, flexible } = await reminderClinic("Race Clinic");
    const people = await Promise.all(["Rory Race", "Cara Cancel", "Moe Moved", "Nina Normal"].map((name) => inbound(m.org.id, { name })));
    const appts: Array<Awaited<ReturnType<typeof bookNativeAppointment>>> = [];
    for (const [i, p] of people.entries()) appts.push(await bookNativeAppointment(owner, { typeId: flexible.id, startAt: at(`1${3 + i}:00`), contact: { id: p.contactId }, via: "staff", now: NOW }));
    const [rescheduled, cancelled, moved, normal] = appts;
    // 13:00 to 16:00 Manila (05:00 to 08:00 UTC). All four reminders are made due at 04:00 UTC, before any of them starts.
    const due = new Date("2026-10-20T04:01:00Z");
    await withSystem((db) => db.query("update appointment_reminders set due_at = $2 where appointment_id = any($1::uuid[])", [appts.map((a) => a.appointmentId), new Date("2026-10-20T04:00:00Z")]));
    const claimed = await claimDueReminders(due);
    const mine = (id: string) => claimed.find((c) => c.appointment_id === id)!;
    expect(appts.every((a) => mine(a.appointmentId))).toBe(true);

    // Between the claim and the queuing: one is rescheduled (its reminder is re-planned), one cancelled, one moved without re-planning.
    await rescheduleNativeAppointment(owner, rescheduled.appointmentId, { startAt: at("13:00", "2026-10-22"), by: "staff", now: due });
    await cancelNativeAppointment(owner, cancelled.appointmentId, { by: "staff", now: due });
    await withSystem((db) => db.query("update appointment_refs set start_at = start_at + interval '1 day', end_at = end_at + interval '1 day' where id = $1", [moved.appointmentId]));

    expect(await queueClaimedReminder(mine(rescheduled.appointmentId), due)).toBe("skipped");
    expect(await queueClaimedReminder(mine(cancelled.appointmentId), due)).toBe("skipped");
    expect(await queueClaimedReminder(mine(moved.appointmentId), due)).toBe("skipped");
    expect(await queueClaimedReminder(mine(normal.appointmentId), due)).toBe("queued");
    // Queuing the same claim twice does nothing the second time.
    expect(await queueClaimedReminder(mine(normal.appointmentId), due)).toBe("skipped");

    const state = await withSystem((db) => db.query<{ appointment_id: string; status: string; message_id: string | null; due_at: Date }>(
      "select appointment_id, status, message_id, due_at from appointment_reminders where appointment_id = any($1::uuid[])", [appts.map((a) => a.appointmentId)]));
    const of = (id: string) => state.rows.find((r) => r.appointment_id === id)!;
    expect(of(rescheduled.appointmentId)).toMatchObject({ status: "scheduled", message_id: null });
    expect(new Date(of(rescheduled.appointmentId).due_at).getTime()).toBeGreaterThan(due.getTime());
    expect(of(cancelled.appointmentId)).toMatchObject({ status: "cancelled", message_id: null });
    // Put back to be claimed again with the new time.
    expect(of(moved.appointmentId)).toMatchObject({ status: "scheduled", message_id: null });
    expect(of(normal.appointmentId).status).toBe("queued");
    expect(of(normal.appointmentId).message_id).not.toBeNull();
    const msgs = await withSystem((db) => db.query<{ n: string }>("select count(*)::text as n from conversation_messages where org_id = $1 and scope = 'reminder'", [m.org.id]));
    expect(Number(msgs.rows[0].n)).toBe(1);
  });

  it("never cuts a link to fit the length limit", () => {
    const manageLink = `https://app.example.test${manageUrl("a".repeat(32))}`;
    const text = reminderText({ orgName: "Mango Clinic", title: "T".repeat(700), startAt: at("10:00"), timeZone: "Asia/Manila", link: `https://meet.example.test/${"m".repeat(500)}`, contactName: "Ana Reyes", location: "L".repeat(400), manageLink });
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text.endsWith(`To reschedule or cancel: ${manageLink}`)).toBe(true);
    // Stored with the placeholder, the text is laid out for a link of real length, so filling it in never pushes it past the limit.
    const stored = reminderTemplate({ orgName: "Mango Clinic", title: "T".repeat(700), startAt: at("10:00"), timeZone: "Asia/Manila", link: `https://meet.example.test/${"m".repeat(500)}`, contactName: "Ana Reyes", location: "L".repeat(400), withManageLink: true, appUrl: "https://app.example.test" });
    expect(stored.endsWith("To reschedule or cancel: {{appointment.manage_link}}")).toBe(true);
    expect(stored.replace("{{appointment.manage_link}}", manageLink)).toBe(text);
    // Without a place or a manage link the text is exactly what it was before.
    expect(reminderText({ orgName: "Mango Clinic", title: "Visit", startAt: at("10:00"), timeZone: "Asia/Manila", link: null, contactName: "Ana" })).toMatch(/^Hi Ana, a reminder from Mango Clinic: "Visit" is on .+\. Reply here if you need to change it\.$/);
  });
});

describe("routes", () => {
  it("the booking route answers JSON and refuses anything that isn't", async () => {
    const { POST } = await import("@/app/api/public/booking/book/route");
    const res = await POST(new Request("http://localhost/api/public/booking/book", { method: "POST", headers: { "content-type": "text/plain", origin: "http://localhost" }, body: "hi" }));
    expect(res.status).toBe(415);
    const bad = await POST(new Request("http://localhost/api/public/booking/book", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: "{" }));
    expect(bad.status).toBe(400);
    const notFound = await POST(new Request("http://localhost/api/public/booking/book", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", "x-forwarded-for": "192.0.2.77" },
      body: JSON.stringify({ org: "nobody-here", calendar: "none", type: "none", startAt: at("10:00").toISOString(), timeZone: "UTC", name: "X", email: "x@example.test", idempotencyKey: crypto.randomUUID(), formToken: bookingFormToken("nobody-here", "none", "none", Date.now() - 10_000) }),
    }));
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get("cache-control")).toBe("no-store");
  });

  it("booking pages are public; pages carrying a manage secret are never cached or indexed", async () => {
    const { NextRequest } = await import("next/server");
    const { proxy } = await import("@/proxy");
    const page = await proxy(new NextRequest("http://localhost/book/mango-clinic/consults"));
    expect(page.headers.get("location")).toBeNull();
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const managePage = await proxy(new NextRequest("http://localhost/book/manage/abcdefghijklmnopqrstuvwxyz"));
    expect(managePage.headers.get("location")).toBeNull();
    expect(managePage.headers.get("cache-control")).toBe("no-store");
    expect(managePage.headers.get("x-robots-tag")).toContain("noindex");
    expect(managePage.headers.get("referrer-policy")).toBe("no-referrer");
    const confirmed = await proxy(new NextRequest("http://localhost/book/mango-clinic/consults/site-visit/confirmed?booking=abc"));
    expect(confirmed.headers.get("cache-control")).toBe("no-store");
    const crm = await proxy(new NextRequest("http://localhost/crm"));
    expect(crm.headers.get("location")).toContain("/login");
  });
});

describe("booking screens", () => {
  const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<!-- -->/g, "");

  it("render the booking flow, the manage panel and the not-found page with labelled, public-only content", async () => {
    const { BookingFlow } = await import("@/app/book/_components/booking-flow");
    const { ManagePanel } = await import("@/app/book/_components/manage-panel");
    const { AppointmentDetails } = await import("@/app/book/_components/details");
    const { default: NotFound } = await import("@/app/book/not-found");
    const p = await fresh();
    const page = (await resolvePublicBookingPage(p.org, p.calendar, p.type))!;
    const flow = html(React.createElement(BookingFlow, {
      business: page.business, calendar: { name: page.calendar.name }, type: page.type!, slugs: { org: p.org, calendar: p.calendar, type: p.type },
      formToken: bookingFormToken(p.org, p.calendar, p.type), typeCount: 1, renderedAt: NOW.getTime(),
    }));
    expect(flow).toContain("<h1");
    expect(flow).toContain("Site visit");
    expect(flow).toContain("Choose a date and time");
    expect(flow).toContain('role="grid"');
    expect(flow).toContain('aria-label="Previous month"');
    expect(flow).toContain('<label for="bf-tz" class="sr-only">Time zone</label>');
    expect(flow).not.toContain("All appointment types");
    expect(flow).not.toContain(p.typeId);

    const res = await handleBook(visitor(), body(p, { startAt: at("10:00").toISOString(), email: "screens@example.test" }));
    const token = tokenOf(res.body.manageUrl);
    const view = JSON.parse(JSON.stringify(await loadManagePage(token, { now: NOW })));
    const panel = html(React.createElement(ManagePanel, { view, token, formToken: manageFormToken(token), renderedAt: NOW.getTime() }));
    expect(panel).toContain("Your booking");
    expect(panel).toContain("Confirmed");
    expect(panel).toContain(">Reschedule<");
    expect(panel).toContain("Cancel booking");
    expect(panel).toContain(`href="/api/public/booking/ics?token=${token}"`);
    expect(panel).toContain("In person: 12 Mango St, Makati");
    expect(panel).not.toContain("Ana Reyes");

    await setType(p.typeId, "allow_customer_changes = false");
    await withSystem((db) => db.query("update company_profiles set contact_email = 'desk@mango.example.test' where org_id = $1", [p.a.org.id]));
    const locked = JSON.parse(JSON.stringify(await loadManagePage(token, { now: NOW })));
    const lockedPanel = html(React.createElement(ManagePanel, { view: locked, token, formToken: manageFormToken(token), renderedAt: NOW.getTime() }));
    expect(lockedPanel).not.toContain(">Reschedule<");
    expect(lockedPanel).toContain("doesn&#x27;t take changes to this booking online");
    expect(lockedPanel).toContain('href="mailto:desk@mango.example.test"');

    const details = html(React.createElement(AppointmentDetails, { view }));
    expect(details).toContain("Tuesday, October 20, 2026");
    expect(details).toContain("Manila time (GMT+8)");
    const missing = html(React.createElement(NotFound));
    expect(missing).toContain("This page isn&#x27;t available");
    expect(missing).not.toContain("workspace");
  });
});

describe("booking screens: what customers are told, where focus goes, and which day is today", () => {
  const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<!-- -->/g, "");

  it("promise no confirmation message, since none is sent to the customer: screens, server messages and the owner's placeholder", async () => {
    const { readFileSync } = await import("node:fs");
    const files = [
      "src/app/book/_components/booking-flow.tsx", "src/app/book/_components/manage-panel.tsx", "src/components/website/render/booking-pages.tsx",
      "src/components/crm/scheduling/settings/calendar-dialog.tsx", "src/server/calendars/public-booking.ts", "src/server/calendars/booking.ts", "src/server/sites/booking.ts",
    ];
    for (const f of files) {
      const src = readFileSync(`${process.cwd()}/${f}`, "utf8");
      expect(src, f).not.toMatch(/confirmations and reminders|so the booking can be confirmed|so we can confirm|We'll confirm by email/);
    }
    // The details step says what the details are for and points the customer at the link shown after booking.
    const flow = readFileSync(`${process.cwd()}/src/app/book/_components/booking-flow.tsx`, "utf8");
    expect(flow).toContain("will use these details to manage this appointment and to contact you about it");
    expect(flow).toContain("so ${business.name} can reach you.");
  });

  it("move focus into 'Choose a new time': its heading is a focus target, and the slot picker counts today from the server's clock", async () => {
    const { NewTimeCard } = await import("@/app/book/_components/manage-panel");
    const { BookingFlow } = await import("@/app/book/_components/booking-flow");
    const { bookingWindow } = await import("@/app/book/_components/slot-picker");
    const p = await fresh();
    const res = await handleBook(visitor(), body(p, { startAt: at("11:00").toISOString(), email: "focus@example.test" }));
    const token = tokenOf(res.body.manageUrl);
    const view = JSON.parse(JSON.stringify(await loadManagePage(token, { now: NOW })));
    const noop = () => undefined;
    const card = html(React.createElement(NewTimeCard, {
      view, timeZone: "Asia/Manila", onTimeZone: noop, detected: null, renderedAt: NOW.getTime(), source: { kind: "manage", token },
      reloadKey: 0, slot: null, onSelect: noop, busy: false, onKeep: noop, onConfirm: noop,
    }));
    expect(card).toMatch(/<h2 id="mp-new-time" tabindex="-1"[^>]*>Choose a new time<\/h2>/);
    expect(card).toContain(">Keep current time<");
    expect(card).toContain("October 2026");

    // 23:59 and 00:01 in Manila on either side of midnight: "today" follows the time the page was rendered, whatever the device clock says.
    expect(bookingWindow(Date.parse("2026-10-19T15:59:00Z"), "Asia/Manila", 30)).toEqual({ today: "2026-10-19", horizon: "2026-11-18" });
    expect(bookingWindow(Date.parse("2026-10-19T16:01:00Z"), "Asia/Manila", 30)).toEqual({ today: "2026-10-20", horizon: "2026-11-19" });
    expect(bookingWindow(Date.parse("2026-10-19T16:01:00Z"), "America/New_York", 0).today).toBe("2026-10-19");
    const page = (await resolvePublicBookingPage(p.org, p.calendar, p.type))!;
    const flowAt = (renderedAt: number) => html(React.createElement(BookingFlow, {
      business: page.business, calendar: { name: page.calendar.name }, type: page.type!, slugs: { org: p.org, calendar: p.calendar, type: p.type },
      formToken: bookingFormToken(p.org, p.calendar, p.type), typeCount: 1, renderedAt,
    }));
    const before = flowAt(Date.parse("2026-10-19T15:59:00Z"));
    expect(before).toContain('aria-label="Monday, October 19, today.');
    expect(before).not.toContain("October 20, today");
    const after = flowAt(Date.parse("2026-10-19T16:01:00Z"));
    expect(after).toContain('aria-label="Tuesday, October 20, today.');
    // Rendering is a function of the render time alone, so the server's HTML and the browser's first render can't disagree.
    expect(flowAt(Date.parse("2026-10-19T16:01:00Z"))).toBe(after);
    expect(flowAt(Date.parse("2026-01-05T04:00:00Z"))).toContain("January 2026");
  });
});
