// Changes to what customers can book and who the Lead Hunter looks for leave a trail: one audit row per real change, in the workspace that made it and in no other, with the policy-relevant
// before and after and never contact details; saving the same thing again writes nothing. Synthetic workspaces only.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import {
  addAvailabilityOverride, archiveAppointmentType, clearDayException, createAppointmentType, createCalendar, deleteAvailabilityOverride, duplicateAppointmentType, setAppointmentTypePublic,
  setDayException, setHostAvailability, updateAppointmentType,
} from "@/server/calendars/setup";
import { saveTargeting } from "@/server/leads/service";
import { crmOrg, type CrmOrg } from "./support/crm";
import { ctxFor } from "./support/fixtures";

const WEEKDAYS_9_TO_5 = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));
const WATCHED = /^(crm\.(appointment_type_|host_availability_|availability_override_)|leads\.targeting_saved)/;

interface Row { action: string; target_type: string | null; target_id: string | null; actor_user_id: string | null; actor_kind: string; metadata: Record<string, unknown> }
/** Every watched audit row of a workspace, oldest first. */
const trail = async (orgId: string): Promise<Row[]> => (await withSystem((db) => db.query<Row>(
  "select action, target_type, target_id, actor_user_id, actor_kind, metadata from audit_logs where org_id = $1 and (action like 'crm.appointment_type_%' or action like 'crm.host_availability_%' or action like 'crm.availability_override_%' or action = 'leads.targeting_saved') order by created_at, id",
  [orgId],
))).rows.filter((r) => WATCHED.test(r.action));

/** Runs a mutation and returns the audit rows it added to `own`, asserting that `others` gained nothing. */
async function added(own: CrmOrg, others: CrmOrg[], run: () => Promise<unknown>): Promise<Row[]> {
  const before = await trail(own.org.id);
  const otherBefore = await Promise.all(others.map((o) => trail(o.org.id)));
  await run();
  const after = await trail(own.org.id);
  const otherAfter = await Promise.all(others.map((o) => trail(o.org.id)));
  expect(otherAfter.map((t) => t.length)).toEqual(otherBefore.map((t) => t.length));
  return after.slice(before.length);
}

async function workspace() {
  const c = await crmOrg({ timezone: "Asia/Manila" });
  const bystander = await crmOrg({ timezone: "Asia/Manila" });
  const owner = c.actor("owner");
  await setHostAvailability(owner, c.people.owner.id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });
  const cal = await createCalendar(owner, { name: "Visits", members: [{ userId: c.people.owner.id }] });
  return { c, bystander, owner, calendarId: cal.id, others: [bystander] };
}

describe("appointment types", () => {
  it("writes one row when a type is created, with the booking policy and nothing the customer typed", async () => {
    const { c, owner, calendarId, others } = await workspace();
    let typeId = "";
    const rows = await added(c, others, async () => {
      typeId = (await createAppointmentType(owner, calendarId, { name: "Roof inspection", description: "Secret internal notes about the visit", durationMinutes: 45, bufferAfterMinutes: 15, minNoticeMinutes: 120, requiresConfirmation: true, meetingProvider: "none", locationKind: "in_person" })).id;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "crm.appointment_type_created", target_type: "crm_appointment_type", target_id: typeId, actor_user_id: c.people.owner.id, actor_kind: "user" });
    expect(rows[0].metadata).toMatchObject({ calendarId, name: "Roof inspection", durationMinutes: 45, bufferAfterMinutes: 15, minNoticeMinutes: 120, requiresConfirmation: true, locationKind: "in_person", public: true });
    expect(JSON.stringify(rows[0].metadata)).not.toContain("Secret internal notes");
  });

  it("writes one row per real change with before and after, only the field names for text, and nothing for a save that changes nothing", async () => {
    const { c, owner, calendarId, others } = await workspace();
    const type = await createAppointmentType(owner, calendarId, { name: "Visit", durationMinutes: 60, minNoticeMinutes: 60 });

    const same = await added(c, others, () => updateAppointmentType(owner, type.id, { name: "Visit", durationMinutes: 60, minNoticeMinutes: 60, requiresConfirmation: false }));
    expect(same).toEqual([]);

    const policy = await added(c, others, () => updateAppointmentType(owner, type.id, { durationMinutes: 90, bufferAfterMinutes: 10, requiresConfirmation: true, changeCutoffMinutes: 1440 }));
    expect(policy).toHaveLength(1);
    expect(policy[0]).toMatchObject({ action: "crm.appointment_type_updated", target_id: type.id, actor_user_id: c.people.owner.id });
    expect(policy[0].metadata).toMatchObject({
      calendarId, textChanged: [],
      changed: { durationMinutes: [60, 90], bufferAfterMinutes: [0, 10], requiresConfirmation: [false, true], changeCutoffMinutes: [0, 1440] },
    });
    expect(Object.keys((policy[0].metadata as { changed: object }).changed).sort()).toEqual(["bufferAfterMinutes", "changeCutoffMinutes", "durationMinutes", "requiresConfirmation"]);

    const text = await added(c, others, () => updateAppointmentType(owner, type.id, { description: "Call Dana on 555-0100 before arriving", locationDetail: "Gate code 4455" }));
    expect(text).toHaveLength(1);
    expect(text[0].metadata).toMatchObject({ changed: {}, textChanged: ["description", "locationDetail"] });
    expect(JSON.stringify(text[0].metadata)).not.toContain("555-0100");
    expect(JSON.stringify(text[0].metadata)).not.toContain("4455");
  });

  it("writes one row for showing or hiding a type, duplicating one and archiving one, and none for hiding what is already hidden", async () => {
    const { c, owner, calendarId, others } = await workspace();
    const type = await createAppointmentType(owner, calendarId, { name: "Visit", durationMinutes: 60 });

    const hidden = await added(c, others, () => setAppointmentTypePublic(owner, type.id, false));
    expect(hidden).toHaveLength(1);
    expect(hidden[0]).toMatchObject({ action: "crm.appointment_type_updated", target_id: type.id });
    expect(hidden[0].metadata).toMatchObject({ changed: { public: [true, false] } });
    expect(await added(c, others, () => setAppointmentTypePublic(owner, type.id, false))).toEqual([]);

    let copyId = "";
    const copied = await added(c, others, async () => { copyId = (await duplicateAppointmentType(owner, type.id)).id; });
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({ action: "crm.appointment_type_created", target_id: copyId });
    expect(copied[0].metadata).toMatchObject({ duplicatedFrom: type.id, calendarId });

    const archived = await added(c, others, () => archiveAppointmentType(owner, copyId));
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({ action: "crm.appointment_type_archived", target_id: copyId });
    // Archiving something already archived fails and leaves nothing.
    await expect(added(c, others, () => archiveAppointmentType(owner, copyId))).rejects.toThrow(/not found/);
    expect((await trail(c.org.id)).filter((r) => r.action === "crm.appointment_type_archived")).toHaveLength(1);
  });

  it("writes nothing when the change is refused, and nothing in another workspace for a type id from this one", async () => {
    const { c, bystander, owner, calendarId } = await workspace();
    const type = await createAppointmentType(owner, calendarId, { name: "Visit", durationMinutes: 60 });
    const before = (await trail(c.org.id)).length;
    await expect(updateAppointmentType(owner, type.id, { durationMinutes: 1 })).rejects.toThrow(/Length is 5 minutes/);
    expect((await trail(c.org.id)).length).toBe(before);
    await expect(updateAppointmentType(bystander.actor("owner"), type.id, { durationMinutes: 90 })).rejects.toThrow(/not found/);
    await expect(archiveAppointmentType(bystander.actor("owner"), type.id)).rejects.toThrow(/not found/);
    expect((await trail(c.org.id)).length).toBe(before);
    expect(await trail(bystander.org.id)).toEqual([]);
  });
});

describe("host availability and exceptions", () => {
  it("writes one row when a host's hours, zone or acceptance really change, and none for saving the same hours again", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const bystander = await crmOrg({ timezone: "Asia/Manila" });
    const owner = c.actor("owner");
    const who = c.people.owner.id;

    const first = await added(c, [bystander], () => setHostAvailability(owner, who, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 }));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ action: "crm.host_availability_changed", target_type: "crm_host", target_id: who, actor_user_id: who });
    expect(first[0].metadata).toMatchObject({ userId: who, timezone: [null, "Asia/Manila"], accepting: [null, true], ranges: 5, before: 0 });

    // The same hours in a different order and the same zone: nothing changed.
    expect(await added(c, [bystander], () => setHostAvailability(owner, who, { timezone: "Asia/Manila", rules: [...WEEKDAYS_9_TO_5].reverse() }))).toEqual([]);

    const shorter = await added(c, [bystander], () => setHostAvailability(owner, who, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5.slice(0, 3) }));
    expect(shorter).toHaveLength(1);
    expect(shorter[0].metadata).toMatchObject({ timezone: ["Asia/Manila", "Asia/Manila"], ranges: 3, before: 5 });

    const zone = await added(c, [bystander], () => setHostAvailability(owner, who, { timezone: "America/Chicago", rules: WEEKDAYS_9_TO_5.slice(0, 3) }));
    expect(zone).toHaveLength(1);
    expect(zone[0].metadata).toMatchObject({ timezone: ["Asia/Manila", "America/Chicago"] });

    const paused = await added(c, [bystander], () => setHostAvailability(owner, who, { timezone: "America/Chicago", accepting: false, rules: WEEKDAYS_9_TO_5.slice(0, 3) }));
    expect(paused).toHaveLength(1);
    expect(paused[0].metadata).toMatchObject({ accepting: [true, false] });
    expect(await trail(bystander.org.id)).toEqual([]);
  });

  it("writes nothing when saving hours is refused", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const before = (await trail(c.org.id)).length;
    await expect(setHostAvailability(c.actor("sales"), c.people.owner.id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 })).rejects.toThrow(/calendar management/);
    await expect(setHostAvailability(c.actor("owner"), c.people.owner.id, { timezone: "Mars/Olympus", rules: WEEKDAYS_9_TO_5 })).rejects.toThrow(/valid time zone/);
    expect((await trail(c.org.id)).length).toBe(before);
  });

  it("writes one row for each single exception added or removed, without the reason's words", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const bystander = await crmOrg({ timezone: "Asia/Manila" });
    const owner = c.actor("owner");
    await setHostAvailability(owner, c.people.owner.id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });
    let id = "";
    const addedRows = await added(c, [bystander], async () => {
      id = (await addAvailabilityOverride(owner, { userId: c.people.owner.id, date: "2026-11-03", startMinute: null, endMinute: null, reason: "Dentist, call 555-0100" })).id;
    });
    expect(addedRows).toHaveLength(1);
    expect(addedRows[0]).toMatchObject({ action: "crm.availability_override_added", target_type: "crm_availability_override", target_id: id, actor_user_id: c.people.owner.id });
    expect(addedRows[0].metadata).toMatchObject({ userId: c.people.owner.id, date: "2026-11-03", wholeDay: true });
    expect(JSON.stringify(addedRows[0].metadata)).not.toContain("555-0100");

    const removedRows = await added(c, [bystander], () => deleteAvailabilityOverride(owner, id));
    expect(removedRows).toHaveLength(1);
    expect(removedRows[0]).toMatchObject({ action: "crm.availability_override_removed", target_id: id });
    expect(removedRows[0].metadata).toMatchObject({ userId: c.people.owner.id, date: "2026-11-03", removed: 1 });
    // Another workspace cannot remove it, and nothing is written for the attempt.
    await expect(deleteAvailabilityOverride(bystander.actor("owner"), id)).rejects.toThrow(/doesn't exist/);
    expect(await trail(bystander.org.id)).toEqual([]);
  });

  it("writes one row when a day is changed or cleared, none when the day is set the same way again, and records a workspace holiday too", async () => {
    const c = await crmOrg({ timezone: "Asia/Manila" });
    const bystander = await crmOrg({ timezone: "Asia/Manila" });
    const owner = c.actor("owner");
    await setHostAvailability(owner, c.people.owner.id, { timezone: "Asia/Manila", rules: WEEKDAYS_9_TO_5 });
    const closed = { userId: c.people.owner.id, date: "2026-11-04", windows: null };

    const first = await added(c, [bystander], () => setDayException(owner, closed));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ action: "crm.availability_override_added" });
    expect(first[0].metadata).toMatchObject({ userId: c.people.owner.id, date: "2026-11-04", wholeDay: true, windows: 0, replaced: 0 });
    expect(await added(c, [bystander], () => setDayException(owner, { ...closed, reason: "A different reason" }))).toEqual([]);

    const shortened = await added(c, [bystander], () => setDayException(owner, { ...closed, windows: [{ startMinute: 13 * 60, endMinute: 15 * 60 }] }));
    expect(shortened).toHaveLength(1);
    expect(shortened[0].metadata).toMatchObject({ wholeDay: false, windows: 1, replaced: 1 });

    const holiday = await added(c, [bystander], () => setDayException(owner, { userId: null, date: "2026-12-25", windows: null }));
    expect(holiday).toHaveLength(1);
    expect(holiday[0].metadata).toMatchObject({ userId: null, date: "2026-12-25", wholeDay: true });

    const cleared = await added(c, [bystander], () => clearDayException(owner, { userId: c.people.owner.id, date: "2026-11-04" }));
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({ action: "crm.availability_override_removed" });
    expect(cleared[0].metadata).toMatchObject({ userId: c.people.owner.id, date: "2026-11-04", removed: 1 });
    // Clearing a day that has nothing fails and writes nothing.
    await expect(added(c, [bystander], () => clearDayException(owner, { userId: c.people.owner.id, date: "2026-11-04" }))).rejects.toThrow(/doesn't exist/);
    expect(await trail(bystander.org.id)).toEqual([]);
  });
});

describe("lead targeting", () => {
  const ownerCtx = (c: CrmOrg) => ctxFor(c.people.owner, c.org, "owner");

  it("writes one row when the targeting really changes, with the changed rules before and after, and none when the same rules are saved again", async () => {
    const c = await crmOrg();
    const bystander = await crmOrg();
    const ctx = ownerCtx(c);

    const first = await added(c, [bystander], () => saveTargeting(ctx, { industries: ["Roofing"], countries: ["US"] }));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ action: "leads.targeting_saved", target_type: "lead_targeting_profile", actor_user_id: c.people.owner.id, actor_kind: "user" });
    expect(first[0].metadata).toMatchObject({ first: true, changedKeys: ["industries", "countries"], changed: { industries: { before: [], after: ["Roofing"] }, countries: { before: [], after: ["US"] } } });

    const stamp = async () => (await withSystem((db) => db.query<{ updated_at: Date }>("select updated_at from lead_targeting_profiles where org_id = $1", [c.org.id]))).rows[0].updated_at.toISOString();
    const savedAt = await stamp();
    expect(await added(c, [bystander], () => saveTargeting(ctx, { industries: ["Roofing"], countries: ["US"] }))).toEqual([]);
    expect(await stamp()).toBe(savedAt);

    const second = await added(c, [bystander], () => saveTargeting(ctx, { industries: ["Roofing", "Solar"], countries: ["US"], businessSize: "2-10", minimumCriteria: "Owns the building" }));
    expect(second).toHaveLength(1);
    expect(second[0].metadata).toMatchObject({
      first: false, changedKeys: ["industries", "businessSize", "minimumCriteria"],
      changed: { industries: { before: ["Roofing"], after: ["Roofing", "Solar"] }, businessSize: { before: "any", after: "2-10" }, minimumCriteria: { before: "", after: "Owns the building" } },
    });
    // The other workspace's targeting is its own: it has no row and no trail.
    expect(await trail(bystander.org.id)).toEqual([]);
    expect((await withSystem((db) => db.query("select 1 from lead_targeting_profiles where org_id = $1", [bystander.org.id]))).rows).toHaveLength(0);
  });

  it("still creates the row on a first save of the defaults, and bounds what a long list leaves in the trail", async () => {
    const c = await crmOrg();
    const ctx = ownerCtx(c);
    const empty = await added(c, [], () => saveTargeting(ctx, {}));
    expect(empty).toHaveLength(1);
    expect(empty[0].metadata).toMatchObject({ first: true, changedKeys: [] });
    expect((await withSystem((db) => db.query("select 1 from lead_targeting_profiles where org_id = $1", [c.org.id]))).rows).toHaveLength(1);

    const excluded = Array.from({ length: 30 }, (_, i) => `Competitor number ${i} ${"x".repeat(90)}`);
    const big = await added(c, [], () => saveTargeting(ctx, { excluded }));
    expect(big).toHaveLength(1);
    const kept = (big[0].metadata as { changed: { excluded: { after: string[] } } }).changed.excluded.after;
    expect(kept).toHaveLength(20);
    expect(kept.every((v) => v.length <= 120)).toBe(true);
    // The saved rules themselves are untouched by the bound.
    const stored = (await withSystem((db) => db.query<{ criteria: { excluded: string[] } }>("select criteria from lead_targeting_profiles where org_id = $1", [c.org.id]))).rows[0];
    expect(stored.criteria.excluded).toHaveLength(30);
  });

  it("writes nothing when the person may not change targeting or the rules are invalid", async () => {
    const c = await crmOrg();
    const before = (await trail(c.org.id)).length;
    await expect(saveTargeting(ctxFor(c.people.viewer, c.org, "viewer"), { industries: ["Roofing"] })).rejects.toThrow(/Only owners and admins/);
    await expect(saveTargeting(ownerCtx(c), { businessSize: "enormous" })).rejects.toThrow();
    expect((await trail(c.org.id)).length).toBe(before);
    expect((await withSystem((db) => db.query("select 1 from lead_targeting_profiles where org_id = $1", [c.org.id]))).rows).toHaveLength(0);
  });
});
