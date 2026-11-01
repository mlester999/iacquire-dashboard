// A calendar that passed verification can stop being valid without anyone touching it: the host's hours go, the host pauses, a Google account is disconnected, a time zone stops being real.
// These tests activate a calendar, break it each of those ways, and check that every drift is recorded ONCE (audit, stored record, one notice for owners and admins), that running the
// check again adds nothing, that recovery is recorded, and that another workspace is never touched. Synthetic workspaces only; nothing here contacts a calendar provider.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import {
  archiveAppointmentType, archiveCalendar, createAppointmentType, createCalendar, setHostAvailability, updateCalendar, type AppointmentTypeInput,
} from "@/server/calendars/setup";
import { activateCalendar } from "@/server/calendars/activation";
import { disconnectCalendar, markNeedsReauth } from "@/server/calendars/connections";
import { failingDigest, reverifyAfterCommit, reverifyCalendarsAfterChange } from "@/server/calendars/reverify";
import { revokeMember } from "@/server/settings/service";
import { ctxFor } from "./support/fixtures";
import { crmOrg, type CrmOrg, type CrmWho } from "./support/crm";

const WEEKDAYS_9_TO_5 = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));
const ZONE = "America/Chicago";

/**
 * A calendar that has been through activation: hosts with hours, one type, then made a draft the way a Blueprint or the onboarding draft leaves it and activated, so it carries
 * `verified_at`. (A calendar nobody ever activated has no baseline to drift from.)
 */
async function verifiedCalendar(c: CrmOrg, opts: { hosts?: CrmWho[]; type?: Partial<AppointmentTypeInput> } = {}) {
  const owner = c.actor("owner");
  const hosts = opts.hosts ?? ["owner"];
  for (const h of hosts) await setHostAvailability(owner, c.people[h].id, { timezone: ZONE, rules: WEEKDAYS_9_TO_5 });
  const cal = await createCalendar(owner, { name: `Visits ${crypto.randomBytes(2).toString("hex")}`, assignment: hosts.length > 1 ? "round_robin" : "single", members: hosts.map((h) => ({ userId: c.people[h].id })) });
  const type = await createAppointmentType(owner, cal.id, { name: "Site visit", durationMinutes: 60, minNoticeMinutes: 60, maxDaysAhead: 30, ...opts.type });
  await withSystem((db) => db.query("update crm_calendars set status = 'draft', public = false, is_default = false where id = $1", [cal.id]));
  const done = await activateCalendar(owner, cal.id);
  expect(done.activated, done.verification.checks.filter((x) => !x.ok).map((x) => x.detail).join(" ")).toBe(true);
  return { calendarId: cal.id, typeId: type.id };
}

const row = async (id: string) =>
  (await withSystem((db) => db.query<{ verification: Record<string, unknown>; status: string; verified_at: Date | null }>("select verification, status, verified_at from crm_calendars where id = $1", [id]))).rows[0];
const drift = async (id: string) => (await row(id)).verification.drift as { failing: string[]; digest: string; seq: number; reason: string } | undefined;
const audits = async (orgId: string, action: string) => (await withSystem((db) => db.query("select 1 from audit_logs where org_id = $1 and action = $2", [orgId, action]))).rows.length;
const notices = async (orgId: string, userId: string, keyLike: string) =>
  (await withSystem((db) => db.query("select 1 from notifications where org_id = $1 and user_id = $2 and dedupe_key like $3", [orgId, userId, keyLike]))).rows.length;
const driftNotices = (c: CrmOrg, who: CrmWho, calendarId: string) => notices(c.org.id, c.people[who].id, `calendar-drift:${calendarId}:%`);
const recoveredNotices = (c: CrmOrg, who: CrmWho, calendarId: string) => notices(c.org.id, c.people[who].id, `calendar-recovered:${calendarId}:%`);
const connect = (c: CrmOrg, who: CrmWho, provider: "google" | "microsoft") =>
  withSystem(async (db) => (await db.query<{ id: string }>(
    "insert into crm_calendar_connections (org_id, user_id, provider, account_label, status, write_events, external_calendar_id) values ($1, $2, $3, $4, 'connected', true, 'primary') returning id",
    [c.org.id, c.people[who].id, provider, `${who}-${provider}-${crypto.randomBytes(3).toString("hex")}@example.test`],
  )).rows[0].id);

describe("a verified calendar that stops being valid", () => {
  it("records each drift once (hours removed, host paused, Meet host disconnected, invalid zone), tells owners and admins once, and records recovery", async () => {
    const c = await crmOrg({ timezone: ZONE });
    const other = await crmOrg({ timezone: ZONE });
    const otherCal = await verifiedCalendar(other);
    const owner = c.actor("owner");
    const cal = await verifiedCalendar(c);
    expect((await row(cal.calendarId)).verified_at).not.toBeNull();
    expect(await drift(cal.calendarId)).toBeUndefined();

    // (a) The host's hours are removed through the settings service.
    await setHostAvailability(owner, c.people.owner.id, { timezone: ZONE, rules: [] });
    const a = await drift(cal.calendarId);
    expect(a?.failing).toEqual(["hours", "slot"]);
    expect(a?.reason).toBe("host_hours_changed");
    expect(a?.digest).toBe(failingDigest(["hours", "slot"]));
    expect(await audits(c.org.id, "crm.calendar_verification_drifted")).toBe(1);
    expect(await driftNotices(c, "owner", cal.calendarId)).toBe(1);
    expect(await driftNotices(c, "manager", cal.calendarId)).toBe(1);
    expect(await driftNotices(c, "sales", cal.calendarId)).toBe(0);
    // The calendar itself is untouched: still active, still the same page state.
    expect((await row(cal.calendarId)).status).toBe("active");

    // Running the check again, from any path, records nothing new.
    for (const reason of ["again", "and_again"]) {
      const rerun = await withSystem((db) => reverifyCalendarsAfterChange(db, c.org.id, reason));
      expect(rerun).toMatchObject({ checked: 1, unchanged: 1, drifted: [], recovered: [] });
    }
    await setHostAvailability(owner, c.people.owner.id, { timezone: ZONE, rules: [] });
    expect(await audits(c.org.id, "crm.calendar_verification_drifted")).toBe(1);
    expect(await driftNotices(c, "owner", cal.calendarId)).toBe(1);

    // Recovery is recorded: the stored drift is removed, one audit row, one notice.
    await setHostAvailability(owner, c.people.owner.id, { timezone: ZONE, rules: WEEKDAYS_9_TO_5 });
    expect(await drift(cal.calendarId)).toBeUndefined();
    expect(await audits(c.org.id, "crm.calendar_verification_recovered")).toBe(1);
    expect(await recoveredNotices(c, "owner", cal.calendarId)).toBe(1);

    // (b) The host pauses new bookings: only the open-time check fails.
    await setHostAvailability(owner, c.people.owner.id, { timezone: ZONE, accepting: false, rules: WEEKDAYS_9_TO_5 });
    expect((await drift(cal.calendarId))?.failing).toEqual(["slot"]);
    expect(await audits(c.org.id, "crm.calendar_verification_drifted")).toBe(2);
    await setHostAvailability(owner, c.people.owner.id, { timezone: ZONE, accepting: true, rules: WEEKDAYS_9_TO_5 });
    expect(await drift(cal.calendarId)).toBeUndefined();
    expect(await audits(c.org.id, "crm.calendar_verification_recovered")).toBe(2);

    // (d) A zone that is not a real one, by direct SQL (no write path involved): the next check notices.
    await withSystem((db) => db.query("update crm_host_settings set timezone = 'Mars/Olympus' where org_id = $1 and user_id = $2", [c.org.id, c.people.owner.id]));
    expect(await reverifyAfterCommit(c.org.id, "sweep")).toMatchObject({ drifted: [{ calendarId: cal.calendarId, failing: ["slot", "timezone"] }] });
    expect(await audits(c.org.id, "crm.calendar_verification_drifted")).toBe(3);
    await withSystem((db) => db.query("update crm_host_settings set timezone = $3 where org_id = $1 and user_id = $2", [c.org.id, c.people.owner.id, ZONE]));
    expect(await reverifyAfterCommit(c.org.id, "sweep")).toMatchObject({ recovered: [cal.calendarId] });

    // The same problem coming back later is announced again (each change has its own counter), not swallowed as a repeat.
    await setHostAvailability(owner, c.people.owner.id, { timezone: ZONE, rules: [] });
    expect((await drift(cal.calendarId))?.seq).toBeGreaterThan(a?.seq ?? 0);
    expect(await driftNotices(c, "owner", cal.calendarId)).toBe(4);

    // Another workspace is untouched by any of it.
    expect(await drift(otherCal.calendarId)).toBeUndefined();
    expect(await audits(other.org.id, "crm.calendar_verification_drifted")).toBe(0);
    expect(await audits(other.org.id, "crm.calendar_verification_recovered")).toBe(0);
    expect(await notices(other.org.id, other.people.owner.id, "calendar-%")).toBe(0);
  });

  it("notices a disconnected Meet host and a connection that needs a new sign-in, once each, and a reconnect is recorded as recovery", async () => {
    const c = await crmOrg({ timezone: ZONE });
    const owner = c.actor("owner");
    const connectionId = await connect(c, "owner", "google");
    const cal = await verifiedCalendar(c, { type: { locationKind: "video", meetingProvider: "google_meet" } });
    expect(await drift(cal.calendarId)).toBeUndefined();

    // (c) The host disconnects Google: a Meet link can no longer be made through their account.
    await disconnectCalendar(owner, connectionId);
    expect((await drift(cal.calendarId))?.failing).toEqual(["connections"]);
    expect((await drift(cal.calendarId))?.reason).toBe("calendar_disconnected");
    expect(await audits(c.org.id, "crm.calendar_verification_drifted")).toBe(1);
    expect(await driftNotices(c, "owner", cal.calendarId)).toBe(1);
    expect(await reverifyAfterCommit(c.org.id, "sweep")).toMatchObject({ unchanged: 1, drifted: [], recovered: [] });
    expect(await audits(c.org.id, "crm.calendar_verification_drifted")).toBe(1);

    // A new connection (the same checks run again) clears it.
    const second = await connect(c, "owner", "google");
    expect(await reverifyAfterCommit(c.org.id, "calendar_connected")).toMatchObject({ recovered: [cal.calendarId] });
    expect(await audits(c.org.id, "crm.calendar_verification_recovered")).toBe(1);

    // The provider stops accepting the saved sign-in: the connection check fails again, and the break is recorded in the same pass that marks it.
    await withSystem((db) => markNeedsReauth(db, { id: second, orgId: c.org.id, userId: c.people.owner.id, provider: "google", accountLabel: "owner-google@example.test", lastSuccessAt: null, createdAt: new Date() }, "Google no longer accepts the saved sign-in."));
    expect((await drift(cal.calendarId))?.failing).toEqual(["connections"]);
    expect((await drift(cal.calendarId))?.reason).toBe("connection_needs_reauth");
    expect(await audits(c.org.id, "crm.calendar_verification_drifted")).toBe(2);
    // Marking it a second time changes nothing and records nothing.
    await withSystem((db) => markNeedsReauth(db, { id: second, orgId: c.org.id, userId: c.people.owner.id, provider: "google", accountLabel: "owner-google@example.test", lastSuccessAt: null, createdAt: new Date() }, "again"));
    expect(await audits(c.org.id, "crm.calendar_verification_drifted")).toBe(2);
  });

  it("is run by the other calendar write paths too: a changed host list, an archived type, a new type, an archived calendar", async () => {
    const c = await crmOrg({ timezone: ZONE });
    const owner = c.actor("owner");
    const cal = await verifiedCalendar(c);

    // A host list that gives the calendar a host with no hours.
    await updateCalendar(owner, cal.calendarId, { assignment: "round_robin", members: [{ userId: c.people.owner.id }, { userId: c.people.sales.id }] });
    // (A host with no saved settings also has no time zone of their own, which the checks say too.)
    expect((await drift(cal.calendarId))?.failing).toEqual(["hours", "timezone"]);
    expect((await drift(cal.calendarId))?.reason).toBe("calendar_hosts_changed");
    await setHostAvailability(owner, c.people.sales.id, { timezone: ZONE, rules: WEEKDAYS_9_TO_5 });
    expect(await drift(cal.calendarId)).toBeUndefined();

    // A new Meet type with nobody connected.
    const meet = await createAppointmentType(owner, cal.calendarId, { name: "Video call", durationMinutes: 30, minNoticeMinutes: 60, locationKind: "video", meetingProvider: "google_meet" });
    expect((await drift(cal.calendarId))?.failing).toEqual(["connections"]);
    expect((await drift(cal.calendarId))?.reason).toBe("appointment_type_added");
    // Archiving it puts the calendar back in order.
    await archiveAppointmentType(owner, meet.id);
    expect(await drift(cal.calendarId)).toBeUndefined();
    expect(await audits(c.org.id, "crm.calendar_verification_recovered")).toBe(2);

    // The last type archived: nothing left to book.
    const only = (await withSystem((db) => db.query<{ id: string }>("select id from crm_appointment_types where calendar_id = $1 and archived_at is null", [cal.calendarId]))).rows;
    expect(only).toHaveLength(1);
    await archiveAppointmentType(owner, only[0].id);
    expect((await drift(cal.calendarId))?.failing).toEqual(["slot", "types"]);

    // Archiving another calendar re-checks the rest: a break made behind the services' back (hours removed by SQL) is recorded then.
    const spare = await createCalendar(owner, { name: "Spare", members: [{ userId: c.people.owner.id }] });
    const solo = await verifiedCalendar(c, { hosts: ["setter"] });
    await withSystem((db) => db.query("delete from crm_availability_rules where org_id = $1 and user_id = $2", [c.org.id, c.people.setter.id]));
    expect(await drift(solo.calendarId)).toBeUndefined();
    await archiveCalendar(owner, spare.id);
    expect((await drift(solo.calendarId))?.failing).toEqual(["hours", "slot"]);
    expect((await drift(solo.calendarId))?.reason).toBe("calendar_archived");
  });

  it("never watches a calendar nobody verified, the agency's own workspace or a demo workspace, and never writes for them", async () => {
    const c = await crmOrg({ timezone: ZONE });
    const owner = c.actor("owner");
    // An active calendar made by hand (never activated) has no baseline: removing its hours records nothing.
    await setHostAvailability(owner, c.people.owner.id, { timezone: ZONE, rules: WEEKDAYS_9_TO_5 });
    const manual = await createCalendar(owner, { name: "By hand", members: [{ userId: c.people.owner.id }] });
    await createAppointmentType(owner, manual.id, { name: "Visit", durationMinutes: 60 });
    await setHostAvailability(owner, c.people.owner.id, { timezone: ZONE, rules: [] });
    expect(await withSystem((db) => reverifyCalendarsAfterChange(db, c.org.id, "t"))).toMatchObject({ checked: 0, drifted: [] });
    expect(await audits(c.org.id, "crm.calendar_verification_drifted")).toBe(0);

    for (const flag of ["demo", "agency"] as const) {
      const w = await crmOrg({ timezone: ZONE });
      const verified = await verifiedCalendar(w);
      await withSystem((db) => (flag === "demo" ? db.query("update organizations set is_demo = true where id = $1", [w.org.id]) : db.query("update organizations set kind = 'agency' where id = $1", [w.org.id])));
      await withSystem((db) => db.query("delete from crm_availability_rules where org_id = $1", [w.org.id]));
      const res = await withSystem((db) => reverifyCalendarsAfterChange(db, w.org.id, "t"));
      expect(res).toMatchObject({ checked: 0, skipped: flag });
      expect(await drift(verified.calendarId)).toBeUndefined();
      expect(await audits(w.org.id, "crm.calendar_verification_drifted")).toBe(0);
      expect(await notices(w.org.id, w.people.owner.id, "calendar-%")).toBe(0);
    }
    expect(await withSystem((db) => reverifyCalendarsAfterChange(db, crypto.randomUUID(), "t"))).toMatchObject({ checked: 0, skipped: "unknown_workspace" });
  });

  it("two checks started together record the same change once", async () => {
    // The embedded test database runs one transaction at a time, so this proves that a second check finds the first one's record, not the row lock: that is held by the order test below.
    const c = await crmOrg({ timezone: ZONE });
    const cal = await verifiedCalendar(c);
    await withSystem((db) => db.query("delete from crm_availability_rules where org_id = $1 and user_id = $2", [c.org.id, c.people.owner.id]));
    await Promise.all([reverifyAfterCommit(c.org.id, "race_a"), reverifyAfterCommit(c.org.id, "race_b")]);
    expect(await audits(c.org.id, "crm.calendar_verification_drifted")).toBe(1);
    expect(await driftNotices(c, "owner", cal.calendarId)).toBe(1);
  });

  it("locks the calendar rows before it reads their stored drift, so two real checks cannot both record one change", () => {
    const src = readFileSync(path.resolve(import.meta.dirname, "..", "src/server/calendars/reverify.ts"), "utf8");
    const body = src.slice(src.indexOf("export async function reverifyCalendarsAfterChange"), src.indexOf("export async function reverifyAfterCommit"));
    const lock = body.indexOf("order by created_at, id for update");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(body.indexOf("verifyCalendarInTx("));
    expect(lock).toBeLessThan(body.indexOf("storedDigestOf(stored)"));
  });

  it("a failing re-check inside a sync's own transaction never undoes the sync's marking of the sign-in", async () => {
    const c = await crmOrg({ timezone: ZONE });
    const connectionId = await connect(c, "owner", "google");
    const cal = await verifiedCalendar(c, { type: { locationKind: "video", meetingProvider: "google_meet" } });
    const trigger = `refuse_drift_${crypto.randomBytes(3).toString("hex")}`;
    await withSystem(async (db) => {
      await db.query(`create function ${trigger}() returns trigger language plpgsql as $$ begin raise exception 'refused for the test'; end $$`);
      await db.query(`create trigger ${trigger} before update of verification on crm_calendars for each row when (new.verification ? 'drift') execute function ${trigger}()`);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // The marking and the re-check share one transaction, as in the sync. The re-check's own write is refused by the database; the savepoint must keep the rest of the transaction alive.
      await withSystem((db) => markNeedsReauth(db, { id: connectionId, orgId: c.org.id, userId: c.people.owner.id, provider: "google", accountLabel: "owner-google@example.test", lastSuccessAt: null, createdAt: new Date() }, "Google no longer accepts the saved sign-in."));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("calendar re-check after connection_needs_reauth failed"), expect.anything());
    } finally {
      warn.mockRestore();
      await withSystem(async (db) => {
        await db.query(`drop trigger ${trigger} on crm_calendars`);
        await db.query(`drop function ${trigger}()`);
      });
    }
    const marked = await withSystem((db) => db.query<{ status: string }>("select status from crm_calendar_connections where id = $1", [connectionId]));
    expect(marked.rows[0].status).toBe("needs_reauth");
    expect(await audits(c.org.id, "crm.calendar_reauth_required")).toBe(1);
    expect(await notices(c.org.id, c.people.owner.id, "crm-cal-reauth:%")).toBe(1);
    // The failed pass recorded nothing, so the next check records the drift properly.
    expect(await drift(cal.calendarId)).toBeUndefined();
    expect(await reverifyAfterCommit(c.org.id, "next")).toMatchObject({ drifted: [{ calendarId: cal.calendarId, failing: ["connections"] }] });
  });

  it("removing a host from the team re-checks the calendar at once: the drift is recorded and the owner told, without waiting for another calendar change", async () => {
    const c = await crmOrg({ timezone: ZONE });
    const cal = await verifiedCalendar(c, { hosts: ["sales"] });
    expect(await drift(cal.calendarId)).toBeUndefined();
    await revokeMember(ctxFor(c.people.owner, c.org, "owner"), c.people.sales.id);
    expect((await drift(cal.calendarId))?.failing).toContain("hosts");
    expect((await drift(cal.calendarId))?.reason).toBe("member_removed");
    expect(await audits(c.org.id, "crm.calendar_verification_drifted")).toBe(1);
    expect(await driftNotices(c, "owner", cal.calendarId)).toBe(1);
  });

  it("a failing check never fails the person's change", async () => {
    const c = await crmOrg({ timezone: ZONE });
    const owner = c.actor("owner");
    const cal = await verifiedCalendar(c);
    // The re-check itself fails (the database refuses to store a drift record); the pause the person saved is still saved, and the problem is logged without details.
    const trigger = `refuse_drift_${crypto.randomBytes(3).toString("hex")}`;
    await withSystem(async (db) => {
      await db.query(`create function ${trigger}() returns trigger language plpgsql as $$ begin raise exception 'refused for the test'; end $$`);
      await db.query(`create trigger ${trigger} before update of verification on crm_calendars for each row when (new.verification ? 'drift') execute function ${trigger}()`);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await setHostAvailability(owner, c.people.owner.id, { timezone: ZONE, accepting: false, rules: WEEKDAYS_9_TO_5 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("calendar re-check after host_hours_changed failed"), expect.anything());
    } finally {
      warn.mockRestore();
      await withSystem(async (db) => {
        await db.query(`drop trigger ${trigger} on crm_calendars`);
        await db.query(`drop function ${trigger}()`);
      });
    }
    const saved = await withSystem((db) => db.query<{ accepting: boolean }>("select accepting from crm_host_settings where org_id = $1 and user_id = $2", [c.org.id, c.people.owner.id]));
    expect(saved.rows[0].accepting).toBe(false);
    expect(await drift(cal.calendarId)).toBeUndefined();
    // Nothing was recorded for the failed pass, so the next one records the drift properly.
    expect(await reverifyAfterCommit(c.org.id, "next")).toMatchObject({ drifted: [{ calendarId: cal.calendarId, failing: ["slot"] }] });
  });
});
