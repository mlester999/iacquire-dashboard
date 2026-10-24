import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { proposeSchedulingDrafts } from "@/server/onboarding/scheduling-drafts";
import { verifyCalendarInTx } from "@/server/calendars/activation";
import { loadBookingContext } from "@/server/calendars/availability";
import type { Answers } from "@/lib/onboarding/types";
import { addMember, createOrg, createUser } from "./support/fixtures";
import { clearSetupPayment } from "./support/billing";

// Booking rules from the onboarding answers become a DRAFT calendar and appointment types, and nothing else: the draft takes no bookings, has no host and goes live only
// through the checks that already exist. These run on the real migrations (embedded Postgres), so every constraint of a draft is the database's own.

const answers = (over: Answers = {}): Answers => ({
  "a.business_name": "Brightside Roofing",
  "a.timezone": "America/Chicago",
  "b.appointments": true,
  "d.appt_types": [
    { name: "Free inspection", minutes: "30", mode: "in_person" },
    { name: "Phone quote", minutes: "15", mode: "phone" },
  ],
  "d.appt_availability": { mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]] },
  "d.appt_notice": "24h",
  ...over,
});

async function workspace(name = "Draft Co") {
  const org = await createOrg({ name });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  return { org, owner, ctx: { orgId: org.id, userId: owner.id } };
}
const run = <T>(fn: (db: Parameters<Parameters<typeof withSystem>[0]>[0]) => Promise<T>) => withSystem(fn);
const calendars = (orgId: string) => run((db) => db.query<Record<string, unknown>>("select id, name, slug, status, origin, public, is_default, timezone, hours_template, description, created_by, archived_at from crm_calendars where org_id = $1 order by created_at", [orgId])).then((r) => r.rows);
const types = (orgId: string) => run((db) => db.query<Record<string, unknown>>("select t.id, t.calendar_id, t.name, t.slug, t.duration_minutes, t.location_kind, t.meeting_provider, t.min_notice_minutes, t.public, t.position, t.requires_confirmation, t.capacity from crm_appointment_types t where t.org_id = $1 order by t.position", [orgId])).then((r) => r.rows);

describe("drafting a calendar from the booking answers", () => {
  it("creates one draft calendar with the listed types, hours and time zone, owned by the person who submitted", async () => {
    const { org, ctx, owner } = await workspace();
    const outcome = await run((db) => proposeSchedulingDrafts(db, ctx, answers()));
    expect(outcome).toMatchObject({ state: "created", typesAdded: 2, skipped: [] });
    const [cal] = await calendars(org.id);
    expect(cal).toMatchObject({ name: "Appointments", status: "draft", origin: "onboarding", public: false, is_default: false, timezone: "America/Chicago", created_by: owner.id });
    expect(cal.hours_template).toEqual([{ weekday: 1, startMinute: 540, endMinute: 1020 }, { weekday: 2, startMinute: 540, endMinute: 1020 }]);
    expect(String(cal.description)).toMatch(/takes no bookings/);
    const rows = await types(org.id);
    expect(rows.map((r) => [r.name, r.duration_minutes, r.location_kind, r.min_notice_minutes, r.position])).toEqual([
      ["Free inspection", 30, "in_person", 1440, 1],
      ["Phone quote", 15, "phone", 1440, 2],
    ]);
    for (const r of rows) expect(r).toMatchObject({ calendar_id: cal.id, meeting_provider: "none", capacity: 1, requires_confirmation: false, public: true });
    const audit = await run((db) => db.query<{ metadata: { types: number } }>("select metadata from audit_logs where org_id = $1 and action = 'onboarding.scheduling_drafted'", [org.id]));
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata.types).toBe(2);
  });

  it("is a draft in every way that matters: no host, refused by the booking paths, and failing the activation checks until someone assigns a host", async () => {
    const { org, ctx } = await workspace();
    await run((db) => proposeSchedulingDrafts(db, ctx, answers()));
    const [cal] = await calendars(org.id);
    const [first] = await types(org.id);
    const members = await run((db) => db.query("select 1 from crm_calendar_members where calendar_id = $1", [cal.id]));
    expect(members.rows).toHaveLength(0);
    await expect(run((db) => loadBookingContext(db, org.id, String(first.id)))).rejects.toThrow();
    const check = await run((db) => verifyCalendarInTx(db, org.id, String(cal.id)));
    expect(check.ok).toBe(false);
    expect(check.checks.find((c) => c.key === "hosts")?.ok).toBe(false);
    // The database itself refuses a public or default draft (0054).
    await expect(run((db) => db.query("update crm_calendars set public = true where id = $1", [cal.id]))).rejects.toThrow();
    await expect(run((db) => db.query("update crm_calendars set is_default = true where id = $1", [cal.id]))).rejects.toThrow();
  });

  it("does nothing the second time with the same answers", async () => {
    const { org, ctx } = await workspace();
    await run((db) => proposeSchedulingDrafts(db, ctx, answers()));
    const again = await run((db) => proposeSchedulingDrafts(db, ctx, answers()));
    expect(again).toMatchObject({ state: "unchanged", typesAdded: 0 });
    expect(await calendars(org.id)).toHaveLength(1);
    expect(await types(org.id)).toHaveLength(2);
    const audit = await run((db) => db.query("select 1 from audit_logs where org_id = $1 and action = 'onboarding.scheduling_drafted'", [org.id]));
    expect(audit.rows).toHaveLength(1);
  });

  it("adds a newly listed type to the draft, refreshes its suggested hours, and leaves every type already there exactly as it is", async () => {
    const { org, ctx } = await workspace();
    await run((db) => proposeSchedulingDrafts(db, ctx, answers()));
    // A person tuned the first type in Calendars & Types in the meantime.
    await run((db) => db.query("update crm_appointment_types set duration_minutes = 45, min_notice_minutes = 60 where org_id = $1 and name = 'Free inspection'", [org.id]));
    const next = answers({
      "d.appt_types": [{ name: "Free inspection", minutes: "30", mode: "in_person" }, { name: "Phone quote", minutes: "15", mode: "phone" }, { name: "Video tour", minutes: "20", mode: "video" }],
      "d.appt_availability": { wed: [["10:00", "12:00"]] },
    });
    const outcome = await run((db) => proposeSchedulingDrafts(db, ctx, next));
    expect(outcome).toMatchObject({ state: "updated", typesAdded: 1 });
    const rows = await types(org.id);
    expect(rows.map((r) => [r.name, r.duration_minutes, r.min_notice_minutes, r.position])).toEqual([
      ["Free inspection", 45, 60, 1],
      ["Phone quote", 15, 1440, 2],
      ["Video tour", 20, 1440, 3],
    ]);
    expect(rows[2].location_kind).toBe("video");
    const [cal] = await calendars(org.id);
    expect(cal.hours_template).toEqual([{ weekday: 3, startMinute: 600, endMinute: 720 }]);
    expect(await calendars(org.id)).toHaveLength(1);
  });

  it("never removes a type the owner took out of the questionnaire", async () => {
    const { org, ctx } = await workspace();
    await run((db) => proposeSchedulingDrafts(db, ctx, answers()));
    const outcome = await run((db) => proposeSchedulingDrafts(db, ctx, answers({ "d.appt_types": [{ name: "Free inspection", minutes: "30", mode: "in_person" }] })));
    expect(outcome.state).toBe("unchanged");
    expect(await types(org.id)).toHaveLength(2);
  });

  it("matches an existing type by name whatever its capitalisation, and ignores archived types when it does", async () => {
    const { org, ctx } = await workspace();
    await run((db) => proposeSchedulingDrafts(db, ctx, answers()));
    const out = await run((db) => proposeSchedulingDrafts(db, ctx, answers({ "d.appt_types": [{ name: "FREE INSPECTION", minutes: "30", mode: "in_person" }] })));
    expect(out.state).toBe("unchanged");
    await run((db) => db.query("update crm_appointment_types set archived_at = now() where org_id = $1 and name = 'Free inspection'", [org.id]));
    const again = await run((db) => proposeSchedulingDrafts(db, ctx, answers({ "d.appt_types": [{ name: "Free inspection", minutes: "30", mode: "in_person" }] })));
    expect(again).toMatchObject({ state: "updated", typesAdded: 1 });
    // The archived row's address is free again, so the new one takes it without a clash.
    const live = (await types(org.id)).filter((r) => r.name === "Free inspection");
    expect(live.length).toBe(2);
  });

  it("leaves a workspace that already has a calendar alone: active, manual, or drafted from a Blueprint", async () => {
    for (const make of [
      "insert into crm_calendars (org_id, name, slug, status, origin) values ($1, 'Main', 'main', 'active', 'manual')",
      "insert into crm_calendars (org_id, name, slug, status, origin) values ($1, 'From a Blueprint', 'bp', 'draft', 'blueprint')",
    ]) {
      const { org, ctx } = await workspace();
      await run((db) => db.query(make, [org.id]));
      const outcome = await run((db) => proposeSchedulingDrafts(db, ctx, answers()));
      expect(outcome.state).toBe("skipped");
      expect(outcome.reason).toMatch(/already have a calendar/i);
      expect(await calendars(org.id)).toHaveLength(1);
      expect(await types(org.id)).toHaveLength(0);
    }
  });

  it("treats a drafted calendar that a person activated as the client's own", async () => {
    const { org, ctx } = await workspace();
    await run((db) => proposeSchedulingDrafts(db, ctx, answers()));
    await run((db) => db.query("update crm_calendars set status = 'active', verified_at = now() where org_id = $1", [org.id]));
    const out = await run((db) => proposeSchedulingDrafts(db, ctx, answers({ "d.appt_types": [{ name: "Brand new", minutes: "30", mode: "phone" }] })));
    expect(out.state).toBe("skipped");
    expect(await types(org.id)).toHaveLength(2);
  });

  it("starts again when the only calendar was archived", async () => {
    const { org, ctx } = await workspace();
    await run((db) => db.query("insert into crm_calendars (org_id, name, slug, status, origin, archived_at) values ($1, 'Old', 'appointments', 'active', 'manual', now())", [org.id]));
    const out = await run((db) => proposeSchedulingDrafts(db, ctx, answers()));
    expect(out.state).toBe("created");
    const live = (await calendars(org.id)).filter((c) => c.archived_at === null);
    expect(live.map((c) => [c.name, c.slug])).toEqual([["Appointments", "appointments"]]);
  });

  it("drafts nothing when the CRM calendars live in GoHighLevel, or while the provider is being switched", async () => {
    const ghl = await workspace();
    await run((db) => db.query("insert into crm_workspaces (org_id, mode) values ($1, 'ghl') on conflict (org_id) do update set mode = 'ghl'", [ghl.org.id]));
    const a = await run((db) => proposeSchedulingDrafts(db, ghl.ctx, answers()));
    expect(a).toMatchObject({ state: "skipped" });
    expect(a.reason).toMatch(/GoHighLevel/);
    expect(await calendars(ghl.org.id)).toHaveLength(0);

    const switching = await workspace();
    await run((db) => db.query("insert into crm_workspaces (org_id, mode, switching) values ($1, 'native', true) on conflict (org_id) do update set switching = true", [switching.org.id]));
    const b = await run((db) => proposeSchedulingDrafts(db, switching.ctx, answers()));
    expect(b.state).toBe("skipped");
    expect(b.reason).toMatch(/switch/i);
    expect(await calendars(switching.org.id)).toHaveLength(0);
  });

  it("drafts nothing when the owner does not book appointments", async () => {
    const { org, ctx } = await workspace();
    const out = await run((db) => proposeSchedulingDrafts(db, ctx, answers({ "b.appointments": false })));
    expect(out).toMatchObject({ state: "skipped", typesAdded: 0 });
    expect(out.reason).toMatch(/don't book appointments/);
    expect(await calendars(org.id)).toHaveLength(0);
  });

  it("keeps two workspaces apart: a draft is made in the workspace asked for, never the other", async () => {
    const one = await workspace("Alpha Co");
    const two = await workspace("Beta Co");
    await run((db) => proposeSchedulingDrafts(db, one.ctx, answers()));
    expect(await calendars(two.org.id)).toEqual([]);
    expect(await types(two.org.id)).toEqual([]);
    await run((db) => proposeSchedulingDrafts(db, two.ctx, answers({ "d.appt_types": [{ name: "Beta visit", minutes: "30", mode: "phone" }] })));
    expect((await types(one.org.id)).map((r) => r.name)).toEqual(["Free inspection", "Phone quote"]);
    expect((await types(two.org.id)).map((r) => r.name)).toEqual(["Beta visit"]);
    // The same slug is fine in two workspaces.
    expect((await calendars(one.org.id))[0].slug).toBe((await calendars(two.org.id))[0].slug);
  });

  it("reports what it left out and still drafts the rest", async () => {
    const { org, ctx } = await workspace();
    const out = await run((db) => proposeSchedulingDrafts(db, ctx, answers({ "d.appt_types": [{ name: "Quick look", minutes: "2", mode: "phone" }, { name: "Site visit", minutes: "60", mode: "in_person" }] })));
    expect(out.state).toBe("created");
    expect(out.skipped).toEqual([{ name: "Quick look", why: expect.stringMatching(/5 minutes/) }]);
    expect((await types(org.id)).map((r) => r.name)).toEqual(["Site visit"]);
  });
});

describe("drafting during a submission", () => {
  it("a real submission drafts the calendar and says so in its result", async () => {
    const { org, result } = await submitRealOnboardingWithBooking("Roof Co");
    expect(result.scheduling).toMatchObject({ state: "created", typesAdded: 1 });
    const [cal] = await calendars(org.id);
    expect(cal).toMatchObject({ status: "draft", origin: "onboarding", name: "Appointments" });
  });

  it("a problem while drafting never loses the submission: the questionnaire is submitted and the result says the draft was skipped", async () => {
    // A trigger that makes every appointment-type insert fail stands in for any problem with the draft itself.
    await run((db) => db.query(`create function zz_fail_types() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$`));
    await run((db) => db.query("create trigger zz_fail_types before insert on crm_appointment_types for each row execute function zz_fail_types()"));
    try {
      const { org, result } = await submitRealOnboardingWithBooking("Broken Co");
      expect(result.scheduling).toMatchObject({ state: "skipped" });
      expect(result.scheduling.reason).toMatch(/could not be drafted/i);
      expect(await calendars(org.id)).toEqual([]);
      const submitted = await run((db) => db.query<{ status: string }>("select status from onboarding_responses where org_id = $1", [org.id]));
      expect(submitted.rows[0].status).toBe("submitted");
    } finally {
      await run((db) => db.query("drop trigger zz_fail_types on crm_appointment_types"));
      await run((db) => db.query("drop function zz_fail_types()"));
    }
  });
});

/** The questionnaire of tests/support/billing.ts submitRealOnboarding, with one booking type added, submitted for real. */
async function submitRealOnboardingWithBooking(name: string) {
  const { saveOnboardingStep, submitOnboarding } = await import("@/server/onboarding/service");
  const { ctxFor } = await import("./support/fixtures");
  const org = await createOrg({ name });
  await clearSetupPayment(org.id);
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  const c = ctxFor(owner, org, "owner");
  const given: Record<string, unknown> = {
    "a.business_name": name, "a.industry": "home_services", "a.business_model": "local", "a.description": "We repair residential roofs after storm damage.",
    "a.timezone": "America/Chicago", "a.contact_email": owner.email, "a.territories": "Austin, Texas", "a.target_customers": "Austin homeowners",
    "b.goals": ["more_leads", "more_appointments"], "b.services": "Roof repair and inspection", "b.ideal_customer": "Austin homeowners", "b.appointments": true, "b.website_need": "have",
    "d.appt_types": [{ name: "Free inspection", minutes: "30", mode: "in_person" }], "d.appt_notice": "2h", "d.pricing_policy": "never", "f.review": true,
  };
  const saved = await saveOnboardingStep(c, { answers: Object.fromEntries(Object.entries(given).map(([k, value]) => [k, { value }])), currentQuestionId: "f.review" });
  if (Object.keys(saved.rejected).length) throw new Error(`rejected: ${JSON.stringify(saved.rejected)}`);
  const result = await submitOnboarding(c);
  return { org, owner, result };
}
