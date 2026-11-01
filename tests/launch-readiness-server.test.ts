// The launch-readiness facts, read from a real (test) database: a client's own records decide every line of the answer, a drafted calendar is not a calendar that takes bookings, and
// another client's work never moves this client's state. Test database only; no Hermes writes, nothing sent, nobody booked.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import type { LaunchReadiness } from "@/lib/launch-readiness";
import { getLaunchReadiness, loadLaunchFacts } from "@/server/setup/launch-readiness";
import { activateCalendar, applyCalendarHoursTemplate, verifyCalendar } from "@/server/calendars/activation";
import { updateCalendar } from "@/server/calendars/setup";
import { ctxFor } from "./support/fixtures";
import { crmOrg } from "./support/crm";
import { clearSetupPayment, submitRealOnboarding } from "./support/billing";
import { makeRuntimeReady } from "./support/runtime-ready";

const itemOf = (r: LaunchReadiness, key: string) => r.steps.flatMap((s) => s.items).find((i) => i.key === key)!;
const stepOf = (r: LaunchReadiness, key: string) => r.steps.find((s) => s.key === key)!;

/** A client workspace that has submitted its questionnaire and paid, with a DRAFT booking calendar of the kind onboarding makes: no host, suggested weekdays 9 to 5. */
async function clientWithDraftCalendar(opts: { name: string; timezone: string; template?: boolean }) {
  const c = await crmOrg({ name: opts.name, timezone: opts.timezone });
  await withSystem((db) => db.query("update organizations set onboarding_completed_at = now() where id = $1", [c.org.id]));
  await clearSetupPayment(c.org.id);
  // The client's own answers, as the questionnaire stores them: they book appointments, in this time zone.
  await withSystem(async (db) => {
    await db.query("insert into onboarding_answers (org_id, question_id, value) values ($1, 'b.appointments', 'true'::jsonb), ($1, 'a.timezone', to_jsonb($2::text))", [c.org.id, opts.timezone]);
  });
  const hours = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));
  const calendarId = (await withSystem((db) => db.query<{ id: string }>(
    `insert into crm_calendars (org_id, name, slug, status, origin, timezone, hours_template, is_default, public)
     values ($1, 'Consultations', 'consultations', 'draft', 'onboarding', $2, $3::jsonb, false, false) returning id`,
    [c.org.id, opts.timezone, JSON.stringify(opts.template === false ? [] : hours)],
  ))).rows[0].id;
  // The type is made by an owner who can manage calendars; it belongs to the draft calendar, which has no host yet.
  await withSystem((db) => db.query(
    `insert into crm_appointment_types (org_id, calendar_id, name, slug, duration_minutes, min_notice_minutes, location_kind) values ($1, $2, 'Free consultation', 'free-consultation', 30, 60, 'phone')`,
    [c.org.id, calendarId],
  ));
  return { ...c, calendarId, ownerCtx: ctxFor(c.people.owner, c.org, "owner") };
}

describe("the launch facts are read from the workspace's own records", () => {
  it("says the questionnaire is submitted, and starts nothing, while the setup payment is not confirmed", async () => {
    const c = await submitRealOnboarding({ name: "Unpaid Roofing" });
    const r = (await getLaunchReadiness(c.ctx))!;
    expect(r.state).toBe("questionnaire_submitted");
    expect(r.label).toBe("Questionnaire submitted");
    // Nothing was queued, so nothing may read as in progress or done: the employees wait for the payment.
    const jobs = await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from agent_provisioning_jobs where org_id = $1", [c.org.id]));
    expect(jobs.rows[0].n).toBe(0);
    expect(AGENT_ROLE_KEYS.every((role) => itemOf(r, `employees.${role}`).state === "action_required" && itemOf(r, `employees.${role}`).detail.includes("setup payment"))).toBe(true);
    expect(r.percent).toBeLessThan(100);
  }, 120_000);

  it("after payment, a queued profile is in progress and never counted as ready: six employees are registered, none are done", async () => {
    const c = await submitRealOnboarding({ name: "Paid Roofing", clearPayment: true });
    const r = (await getLaunchReadiness(c.ctx))!;
    expect(["provisioning", "action_required"]).toContain(r.state);
    expect(r.state).not.toBe("ready_to_launch");
    for (const role of AGENT_ROLE_KEYS) {
      const item = itemOf(r, `employees.${role}`);
      expect(item.state, role).not.toBe("done");
      expect(item.required).toBe(true);
    }
    // The company profile the client typed is read back from the workspace, not assumed.
    expect(itemOf(r, "profile.company").state).toBe("done");
    expect(itemOf(r, "profile.timezone")).toMatchObject({ state: "done", detail: expect.stringContaining("America/Chicago") });
    expect(stepOf(r, "verification").state).not.toBe("done");
  }, 120_000);

  it("walks a drafted calendar to an active one through the real services, and a draft never counts as taking bookings", async () => {
    const c = await clientWithDraftCalendar({ name: "Walk Dental", timezone: "Asia/Manila" });
    const actor = c.actor("owner");
    let r = (await getLaunchReadiness(c.ownerCtx))!;
    expect(itemOf(r, "calendar.host")).toMatchObject({ state: "action_required", action: { intent: "assign_host" } });
    expect(itemOf(r, "calendar.hours").state).toBe("in_progress");
    expect(itemOf(r, "calendar.types").state).toBe("done");
    expect(itemOf(r, "calendar.active").state).toBe("in_progress");
    expect((await loadLaunchFacts(c.ownerCtx))!.appointments.calendar).toMatchObject({ status: "draft", hosts: 0, hasSuggestedHours: true, types: 1, checks: null, bookingPageOn: false });

    // The client picks a host (themselves). Hours still do not exist, and the suggested ones are offered, not applied.
    await updateCalendar(actor, c.calendarId, { members: [{ userId: c.people.owner.id }] });
    r = (await getLaunchReadiness(c.ownerCtx))!;
    expect(itemOf(r, "calendar.host").state).toBe("done");
    expect(itemOf(r, "calendar.hours")).toMatchObject({ state: "action_required", action: { intent: "apply_hours" } });
    expect(itemOf(r, "calendar.verified").state).toBe("in_progress");
    expect(itemOf(r, "calendar.active").state).toBe("in_progress");

    // Approving the suggested hours gives the host the weekly hours; the checks can then run, and activation is the client's click.
    expect((await applyCalendarHoursTemplate(actor, c.calendarId)).applied).toEqual([c.people.owner.id]);
    r = (await getLaunchReadiness(c.ownerCtx))!;
    expect(itemOf(r, "calendar.hours").state).toBe("done");
    expect(itemOf(r, "calendar.active")).toMatchObject({ state: "action_required", action: { intent: "activate_calendar" } });
    expect(stepOf(r, "calendar").state).toBe("action_required");

    const activation = await activateCalendar(actor, c.calendarId);
    expect(activation.activated).toBe(true);
    r = (await getLaunchReadiness(c.ownerCtx))!;
    expect(itemOf(r, "calendar.active").state).toBe("done");
    expect(itemOf(r, "calendar.verified")).toMatchObject({ state: "done" });
    // The public booking page was never turned on by any of this.
    expect(itemOf(r, "calendar.public")).toMatchObject({ required: false, detail: expect.stringContaining("off") });
    expect(stepOf(r, "calendar").state).toBe("done");
  }, 120_000);

  it("never invents hours: with no suggested hours the host must set their own", async () => {
    const c = await clientWithDraftCalendar({ name: "No Template Clinic", timezone: "Europe/London", template: false });
    await updateCalendar(c.actor("owner"), c.calendarId, { members: [{ userId: c.people.owner.id }] });
    const r = (await getLaunchReadiness(c.ownerCtx))!;
    expect(itemOf(r, "calendar.hours")).toMatchObject({ state: "action_required", action: { href: "/crm/availability" } });
    expect(itemOf(r, "calendar.hours").action?.intent).toBeUndefined();
    await expect(applyCalendarHoursTemplate(c.actor("owner"), c.calendarId)).rejects.toThrow(/no suggested hours/i);
    expect(((await verifyCalendar(c.actor("owner"), c.calendarId)).checks.find((k) => k.key === "hours"))?.ok).toBe(false);
  }, 120_000);

  it("marks the calendar not applicable when the client said they do not book appointments, and keeps the Appointment Setter out of the way", async () => {
    const c = await submitRealOnboarding({ name: "No Booking Plumbing", clearPayment: true });
    await withSystem((db) => db.query("update onboarding_answers set value = 'false'::jsonb where org_id = $1 and question_id = 'b.appointments'", [c.org.id]));
    const r = (await getLaunchReadiness(c.ctx))!;
    expect(stepOf(r, "calendar").state).toBe("not_applicable");
    expect(itemOf(r, "employees.appointment_setter").state).toBe("not_applicable");
    expect(itemOf(r, "verification.appointment_setter").state).toBe("not_applicable");
    expect(r.blocking.map((i) => i.key)).not.toContain("calendar.host");
  }, 120_000);

  it("keeps a client's state its own: another client's calendar, employees and checks never change it", async () => {
    const a = await clientWithDraftCalendar({ name: "Isolation A", timezone: "Asia/Manila" });
    const b = await clientWithDraftCalendar({ name: "Isolation B", timezone: "America/Denver" });
    await updateCalendar(b.actor("owner"), b.calendarId, { members: [{ userId: b.people.owner.id }] });
    await applyCalendarHoursTemplate(b.actor("owner"), b.calendarId);
    await activateCalendar(b.actor("owner"), b.calendarId);
    for (const role of AGENT_ROLE_KEYS) {
      const agent = (await withSystem((db) => db.query<{ id: string }>("select id from agent_instances where org_id = $1 and role_key = $2", [b.org.id, role]))).rows[0];
      await makeRuntimeReady(agent.id, b.org.id, b.people.owner.id);
    }
    const ra = (await getLaunchReadiness(a.ownerCtx))!;
    const rb = (await getLaunchReadiness(b.ownerCtx))!;
    expect(itemOf(ra, "calendar.host").state).toBe("action_required");
    expect(itemOf(rb, "calendar.host").state).toBe("done");
    expect(itemOf(rb, "calendar.active").state).toBe("done");
    for (const role of AGENT_ROLE_KEYS) expect((ra.steps.find((s) => s.key === "employees")!.items.find((i) => i.key === `employees.${role}`)!.state), role).not.toBe("done");
    // The facts name this workspace's time zone, not the other one's.
    expect((await loadLaunchFacts(a.ownerCtx))!.profile.timezone).toBe("Asia/Manila");
    expect((await loadLaunchFacts(b.ownerCtx))!.profile.timezone).toBe("America/Denver");
  }, 120_000);

  it("returns nothing for the agency's own workspace", async () => {
    const ctx = await withSystem(async (db) => (await db.query<{ id: string }>("select id from organizations where kind = 'agency' limit 1")).rows[0]);
    if (!ctx) return; // a test database without the agency workspace has nothing to refuse
    const user = await crmOrg({ name: "Not the agency" });
    const asAgency = ctxFor(user.people.owner, { id: ctx.id, name: "Agency", slug: "agency" }, "owner");
    expect(await loadLaunchFacts(asAgency)).toBeNull();
  }, 120_000);
});
