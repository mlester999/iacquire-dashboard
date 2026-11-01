import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { proposeSchedulingDrafts } from "@/server/onboarding/scheduling-drafts";
import { answerDrift, planSchedulingDrafts, type LiveAppointmentType } from "@/lib/onboarding/scheduling-drafts";
import type { Answers } from "@/lib/onboarding/types";
import { addMember, createOrg, createUser } from "./support/fixtures";

// A client who changes a booking answer after the calendar went live is told how the answers now differ from it, in words. The live calendar is never edited from here.

const base = (over: Answers = {}): Answers => ({
  "a.business_name": "Brightside Roofing",
  "a.timezone": "America/Chicago",
  "b.appointments": true,
  "d.appt_types": [
    { name: "Free inspection", minutes: "30", mode: "in_person" },
    { name: "Phone quote", minutes: "15", mode: "phone" },
  ],
  "d.appt_availability": { mon: [["09:00", "17:00"]] },
  "d.appt_notice": "24h",
  ...over,
});

/** The live types a calendar drafted from `answers` really has. */
const liveFrom = (answers: Answers): LiveAppointmentType[] =>
  planSchedulingDrafts(answers).types.map((t) => ({
    name: t.name, durationMinutes: t.durationMinutes, minNoticeMinutes: t.minNoticeMinutes, bufferAfterMinutes: t.bufferAfterMinutes, requiresConfirmation: t.requiresConfirmation,
    allowCustomerChanges: t.allowCustomerChanges, changeCutoffMinutes: t.changeCutoffMinutes, meetingProvider: t.meetingProvider, meetingLink: t.meetingLink,
  }));

describe("answerDrift, the pure comparison", () => {
  it("is empty when the answers still describe the live calendar", () => {
    const a = base({ "d.appt_buffer": "15m", "d.appt_confirmation": "manual", "d.appt_changes": "24h" });
    expect(answerDrift(a, liveFrom(a))).toEqual([]);
    expect(answerDrift(base(), liveFrom(base()))).toEqual([]);
  });

  it("names a changed buffer in plain words, once for the types that share the difference", () => {
    const live = liveFrom(base());
    const drift = answerDrift(base({ "d.appt_buffer": "15m" }), live);
    expect(drift).toEqual(["Free inspection and Phone quote: your answers now say a 15-minute gap after appointments, your live calendar has no gap after appointments."]);
  });

  it("names each kind of change: notice, confirmation, customer changes, length", () => {
    const live = liveFrom(base());
    const drift = answerDrift(base({
      "d.appt_notice": "48h", "d.appt_confirmation": "manual", "d.appt_changes": "none",
      "d.appt_types": [{ name: "Free inspection", minutes: "45", mode: "in_person" }, { name: "Phone quote", minutes: "15", mode: "phone" }],
    }), live);
    expect(drift).toContain("Free inspection: your answers now say 45 minutes long, your live calendar has 30 minutes long.");
    expect(drift).toContain("Free inspection and Phone quote: your answers now say 48 hours notice, your live calendar has 24 hours notice.");
    expect(drift).toContain("Free inspection and Phone quote: your answers now say a person confirms each booking, your live calendar has bookings are confirmed automatically.");
    expect(drift).toContain("Free inspection and Phone quote: your answers now say customers may not change a booking themselves, your live calendar has customers may change a booking any time.");
    expect(drift).toHaveLength(4);
  });

  it("never counts a question the client did not answer: a person tuning the live calendar is not drift", () => {
    const live = liveFrom(base()).map((t) => ({ ...t, bufferAfterMinutes: 20, requiresConfirmation: true, allowCustomerChanges: false, changeCutoffMinutes: 60 }));
    expect(answerDrift(base(), live)).toEqual([]);
  });

  it("matches types by name whatever the capitalisation, ignores a live type the answers do not list, and names a listed type the live calendar lacks", () => {
    const live = liveFrom(base()).map((t) => ({ ...t, name: t.name.toUpperCase() }));
    live.push({ ...live[0], name: "Walk-in estimate" });
    expect(answerDrift(base(), live)).toEqual([]);
    const missing = answerDrift(base({ "d.appt_types": [{ name: "Free inspection", minutes: "30", mode: "in_person" }, { name: "Video tour", minutes: "20", mode: "video" }] }), live);
    expect(missing).toEqual(["Video tour: your answers list this appointment type, your live calendar has none with that name."]);
  });

  it("names a changed video tool or link, only for video types the client answered about", () => {
    const video = [{ name: "Video consult", minutes: "30", mode: "video" }];
    const was = base({ "d.appt_types": video, "d.appt_video": "google_meet" });
    const live = liveFrom(was);
    expect(answerDrift(was, live)).toEqual([]);
    expect(answerDrift(base({ "d.appt_types": video, "d.appt_video": "own", "d.appt_video_link": "https://meet.example.com/room" }), live)).toEqual([
      "Video consult: your answers now say your own meeting link (https://meet.example.com/room), your live calendar has Google Meet.",
    ]);
    expect(answerDrift(base({ "d.appt_types": video }), live)).toEqual([]);
    // A phone type is never compared on the video tool.
    expect(answerDrift(base({ "d.appt_video": "own" }), liveFrom(base()))).toEqual([]);
  });

  it("does not call it a difference when the client left their own link blank and added it in calendar settings afterwards", () => {
    const video = [{ name: "Video consult", minutes: "30", mode: "video" }];
    const blank = base({ "d.appt_types": video, "d.appt_video": "own" });
    // The draft had no meeting tool; the client then put their own link on the live type.
    const live = liveFrom(blank).map((t) => ({ ...t, meetingProvider: "custom_link" as const, meetingLink: "https://meet.example.com/room" }));
    expect(answerDrift(blank, live)).toEqual([]);
    expect(answerDrift(base({ "d.appt_types": video, "d.appt_video": "own", "d.appt_video_link": "not a link" }), live)).toEqual([]);
    // Once the answers carry a link, a link that differs is still reported.
    expect(answerDrift(base({ "d.appt_types": video, "d.appt_video": "own", "d.appt_video_link": "https://other.example.com/room" }), live)).toEqual([
      "Video consult: your answers now say your own meeting link (https://other.example.com/room), your live calendar has your own meeting link (https://meet.example.com/room).",
    ]);
  });

  it("says nothing when the answers no longer describe a calendar at all", () => {
    expect(answerDrift(base({ "b.appointments": false }), liveFrom(base()))).toEqual([]);
    expect(answerDrift(base({ "d.appt_types": [] }), liveFrom(base()))).toEqual([]);
  });

  it("says nothing about hours or the time zone: those belong to the people who host", () => {
    const live = liveFrom(base());
    expect(answerDrift(base({ "d.appt_availability": { sat: [["10:00", "12:00"]] }, "a.timezone": "Asia/Manila" }), live)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const run = <T>(fn: (db: Parameters<Parameters<typeof withSystem>[0]>[0]) => Promise<T>) => withSystem(fn);
async function workspace(name = "Drift Co") {
  const org = await createOrg({ name });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  return { org, ctx: { orgId: org.id, userId: owner.id } };
}
const typeRows = (orgId: string) => run((db) => db.query("select name, duration_minutes, min_notice_minutes, buffer_after_minutes, requires_confirmation from crm_appointment_types where org_id = $1 order by position", [orgId])).then((r) => r.rows);
const activate = (orgId: string) => run((db) => db.query("update crm_calendars set status = 'active', verified_at = now() where org_id = $1", [orgId]));

describe("what a re-submission says about a calendar that is already live", () => {
  it("reports the changed buffer, leaves every type exactly as it is, and says nothing more once the answers agree again", async () => {
    const { org, ctx } = await workspace();
    await run((db) => proposeSchedulingDrafts(db, ctx, base()));
    await activate(org.id);
    const before = await typeRows(org.id);

    const changed = await run((db) => proposeSchedulingDrafts(db, ctx, base({ "d.appt_buffer": "15m" })));
    expect(changed.state).toBe("skipped");
    expect(changed.drift).toEqual(["Free inspection and Phone quote: your answers now say a 15-minute gap after appointments, your live calendar has no gap after appointments."]);
    expect(await typeRows(org.id)).toEqual(before);
    const audit = await run((db) => db.query("select 1 from audit_logs where org_id = $1 and action = 'onboarding.scheduling_drafted'", [org.id]));
    expect(audit.rows).toHaveLength(1);

    // The same answers as when the calendar was drafted: nothing differs, and the list is empty rather than missing.
    const same = await run((db) => proposeSchedulingDrafts(db, ctx, base()));
    expect(same.drift).toEqual([]);
    expect(await typeRows(org.id)).toEqual(before);
  });

  it("stops reporting once a person changed the live calendar to match the answers", async () => {
    const { org, ctx } = await workspace();
    await run((db) => proposeSchedulingDrafts(db, ctx, base()));
    await activate(org.id);
    await run((db) => db.query("update crm_appointment_types set buffer_after_minutes = 15 where org_id = $1", [org.id]));
    const out = await run((db) => proposeSchedulingDrafts(db, ctx, base({ "d.appt_buffer": "15m" })));
    expect(out.drift).toEqual([]);
  });

  it("does not report for a calendar the client made themselves, and keeps two workspaces apart", async () => {
    const manual = await workspace("Manual Co");
    await run((db) => db.query("insert into crm_calendars (org_id, name, slug, status, origin) values ($1, 'Main', 'main', 'active', 'manual')", [manual.org.id]));
    const out = await run((db) => proposeSchedulingDrafts(db, manual.ctx, base({ "d.appt_buffer": "15m" })));
    expect(out.state).toBe("skipped");
    expect(out.drift).toBeUndefined();

    const one = await workspace("Alpha Co");
    const two = await workspace("Beta Co");
    await run((db) => proposeSchedulingDrafts(db, one.ctx, base()));
    await activate(one.org.id);
    await run((db) => proposeSchedulingDrafts(db, two.ctx, base({ "d.appt_buffer": "30m" })));
    // Beta's draft has a 30-minute gap; Alpha's live calendar has none. Alpha's drift reads Alpha's own types only.
    const alpha = await run((db) => proposeSchedulingDrafts(db, one.ctx, base()));
    expect(alpha.drift).toEqual([]);
  });

  it("refreshes a calendar that is still a draft as before, with no drift to report", async () => {
    const { org, ctx } = await workspace();
    await run((db) => proposeSchedulingDrafts(db, ctx, base()));
    const out = await run((db) => proposeSchedulingDrafts(db, ctx, base({
      "d.appt_buffer": "15m", "d.appt_availability": { wed: [["10:00", "12:00"]] },
      "d.appt_types": [{ name: "Free inspection", minutes: "30", mode: "in_person" }, { name: "Phone quote", minutes: "15", mode: "phone" }, { name: "Video tour", minutes: "20", mode: "video" }],
    })));
    expect(out).toMatchObject({ state: "updated", typesAdded: 1 });
    expect(out.drift).toBeUndefined();
    // A draft's existing types are never rewritten from a later answer, and its suggested hours follow the latest answers.
    const rows = await typeRows(org.id);
    expect(rows.map((r) => [r.name, r.buffer_after_minutes])).toEqual([["Free inspection", 0], ["Phone quote", 0], ["Video tour", 15]]);
    const cal = await run((db) => db.query<{ hours_template: unknown }>("select hours_template from crm_calendars where org_id = $1", [org.id]));
    expect(cal.rows[0].hours_template).toEqual([{ weekday: 3, startMinute: 600, endMinute: 720 }]);
  });
});
