// The guided launch steps and the employees' final read-only check, against a real (test) database. "100% Ready to Launch" is reached only through finished checks on the client's own
// records, a check goes stale when its employee's configuration changes, and nothing here books, sends or writes a business record. Test database only; no Hermes writes.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import type { LaunchReadiness } from "@/lib/launch-readiness";
import { getWorkspace } from "@/server/crm/workspace";
import { listPipelines } from "@/server/crm/pipelines";
import { createAppointmentType, createCalendar, setHostAvailability } from "@/server/calendars/setup";
import { createConfigVersion } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { getLaunchReadiness, loadLaunchFacts } from "@/server/setup/launch-readiness";
import { runLaunchIntent, startLaunchVerification } from "@/server/setup/launch-intents";
import { agentId, ctxFor } from "./support/fixtures";
import { crmOrg } from "./support/crm";
import { clearSetupPayment } from "./support/billing";
import { makeRuntimeReady } from "./support/runtime-ready";
import { insertPublishedBlueprint, smallContent } from "./support/blueprints";

const itemOf = (r: LaunchReadiness, key: string) => r.steps.flatMap((s) => s.items).find((i) => i.key === key)!;
const WEEKDAYS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));

/** A client whose setup is finished in every way but the final checks: submitted, paid, CRM and calendar in place, six employees ready for authorized work. */
async function readyClient(opts: { name: string; timezone: string; noticeMinutes?: number }) {
  const c = await crmOrg({ name: opts.name, timezone: opts.timezone });
  const owner = c.people.owner;
  await withSystem(async (db) => {
    await db.query("update organizations set onboarding_completed_at = now(), industry = 'home_services' where id = $1", [c.org.id]);
    await db.query("insert into company_profiles (org_id, description) values ($1, 'We repair roofs after storms.') on conflict (org_id) do update set description = excluded.description", [c.org.id]);
    await db.query("insert into onboarding_answers (org_id, question_id, value) values ($1, 'b.appointments', 'true'::jsonb), ($1, 'a.timezone', to_jsonb($2::text))", [c.org.id, opts.timezone]);
    await db.query("insert into company_knowledge (org_id, section, content) values ($1, 'business_description', 'We repair residential roofs after storm damage.')", [c.org.id]);
    await db.query("insert into lead_targeting_profiles (org_id, criteria) values ($1, $2)", [c.org.id, JSON.stringify({ industries: ["Homeowners"], countries: ["US"] })]);
  });
  await clearSetupPayment(c.org.id);
  const actor = c.actor("owner");
  await getWorkspace(actor);
  await listPipelines(actor, { ensureDefault: true });
  const bp = await insertPublishedBlueprint(smallContent());
  await withSystem((db) => db.query(
    `insert into crm_blueprint_applications (org_id, blueprint_id, version_id, version, blueprint_name, mode, strategy, status, plan_digest, idempotency_key)
     values ($1, $2, $3, 1, 'Test blueprint', 'initial', 'add_missing', 'applied', $4, $5)`,
    [c.org.id, bp.blueprintId, bp.versionId, "a".repeat(64), `launch-test-${c.org.id}`],
  ));
  await setHostAvailability(actor, owner.id, { timezone: opts.timezone, rules: WEEKDAYS });
  const calendar = await createCalendar(actor, { name: "Consultations", members: [{ userId: owner.id }], isDefault: true });
  await createAppointmentType(actor, calendar.id, { name: "Free consultation", durationMinutes: 30, minNoticeMinutes: opts.noticeMinutes ?? 60, maxDaysAhead: 30 });
  for (const role of AGENT_ROLE_KEYS) await makeRuntimeReady(await agentId(c.org.id, role), c.org.id, owner.id);
  return { ...c, calendarId: calendar.id, ctx: ctxFor(owner, c.org, "owner") };
}

async function settled(orgId: string, expected: number) {
  for (let i = 0; i < 600; i += 1) {
    const { rows } = await withSystem((db) => db.query<{ status: string }>("select status from ai_work_jobs where org_id = $1 and input ->> 'launchVerification' = 'true'", [orgId]));
    if (rows.length >= expected && rows.every((r) => ["completed", "failed", "blocked", "cancelled"].includes(r.status))) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the launch checks did not settle");
}
const checkJobs = async (orgId: string) => Number((await withSystem((db) => db.query<{ n: string }>("select count(*) as n from ai_work_jobs where org_id = $1 and input ->> 'launchVerification' = 'true'", [orgId]))).rows[0].n);
const count = async (orgId: string, table: string) => Number((await withSystem((db) => db.query<{ n: string }>(`select count(*) as n from ${table} where org_id = $1`, [orgId]))).rows[0].n);

describe("the final checks decide 100% Ready to Launch", () => {
  it("is not ready before the checks run, ready only after six finished checks, and never writes or sends anything", async () => {
    const c = await readyClient({ name: "Final Checks Roofing", timezone: "Asia/Manila" });
    const before = await getLaunchReadiness(c.ctx);
    // Everything else is in place, yet the state is not 100%: no employee has proven anything on this workspace's records.
    expect(before!.state).toBe("action_required");
    expect(before!.blocking.map((i) => i.key).sort()).toEqual(AGENT_ROLE_KEYS.map((role) => `verification.${role}`).sort());
    expect(before!.percent).toBeLessThan(100);
    expect(itemOf(before!, "verification.crm_manager").action).toMatchObject({ intent: "run_checks" });

    const baseline = { contacts: await count(c.org.id, "contacts"), bookings: await count(c.org.id, "appointment_bookings"), refs: await count(c.org.id, "appointment_refs"), outbound: await count(c.org.id, "conversation_messages") };
    const started = await startLaunchVerification(c.ctx);
    expect(started).toMatchObject({ ok: true });
    expect(started.started!.sort()).toEqual([...AGENT_ROLE_KEYS].sort());
    // A double click while the checks run reuses them: still six jobs, one per employee.
    await startLaunchVerification(c.ctx);
    expect(await checkJobs(c.org.id)).toBe(6);

    await settled(c.org.id, 6);
    const after = (await getLaunchReadiness(c.ctx))!;
    expect(after.blocking).toEqual([]);
    expect(after).toMatchObject({ state: "ready_to_launch", label: "100% Ready to Launch", percent: 100 });
    expect(after.passed).toBe(after.total);

    // Read-only: no record was created, no appointment booked, no message sent.
    expect({ contacts: await count(c.org.id, "contacts"), bookings: await count(c.org.id, "appointment_bookings"), refs: await count(c.org.id, "appointment_refs"), outbound: await count(c.org.id, "conversation_messages") }).toEqual(baseline);
    // A passing check is left alone: asking again starts nothing.
    const again = await startLaunchVerification(c.ctx);
    expect(again.started).toEqual([]);
    expect(await checkJobs(c.org.id)).toBe(6);
    expect(again.message).toContain("already has a passing check");
  }, 180_000);

  it("makes a passed check stale when its employee's configuration changes, and re-checks only that employee", async () => {
    const c = await readyClient({ name: "Stale Checks Plumbing", timezone: "America/Chicago" });
    await startLaunchVerification(c.ctx);
    await settled(c.org.id, 6);
    expect((await getLaunchReadiness(c.ctx))!.state).toBe("ready_to_launch");

    const crm = await agentId(c.org.id, "crm_manager");
    await withSystem((db) => createConfigVersion(db, { orgId: c.org.id, agentId: crm, settings: { ...defaultSettings("crm_manager"), personality: "Careful and brief." }, source: "client_edit", userId: c.people.owner.id, apply: true }));
    // makeRuntimeReady's recorded health belongs to the old version; the new version is applied and the employee is still ready for work.
    const stale = (await getLaunchReadiness(c.ctx))!;
    expect(stale.state).toBe("action_required");
    expect(itemOf(stale, "verification.crm_manager")).toMatchObject({ state: "action_required", detail: expect.stringContaining("configuration changed"), action: { intent: "run_checks" } });
    expect(stale.blocking.map((i) => i.key)).toEqual(["verification.crm_manager"]);

    const rerun = await startLaunchVerification(c.ctx);
    expect(rerun.started).toEqual(["crm_manager"]);
    await settled(c.org.id, 7);
    expect((await getLaunchReadiness(c.ctx))!.state).toBe("ready_to_launch");
  }, 180_000);

  it("fails the Appointment Setter's check when no bookable time exists in the next seven days, and says so", async () => {
    // Ten days of notice: the 14-day activation check still finds a time, but the setter can offer nothing this week.
    const c = await readyClient({ name: "Far Notice Dental", timezone: "Europe/London", noticeMinutes: 10 * 24 * 60 });
    await startLaunchVerification(c.ctx);
    await settled(c.org.id, 6);
    const r = (await getLaunchReadiness(c.ctx))!;
    expect(r.state).toBe("action_required");
    expect(itemOf(r, "calendar.verified").state).toBe("done");
    expect(itemOf(r, "verification.appointment_setter")).toMatchObject({ state: "failed", action: { intent: "run_checks" } });
    expect(itemOf(r, "verification.appointment_setter").detail).toMatch(/seven days|notice/i);
    for (const role of AGENT_ROLE_KEYS.filter((k) => k !== "appointment_setter")) expect(itemOf(r, `verification.${role}`).state, role).toBe("done");
    // Running it again is allowed (a new job), and still fails honestly until the calendar changes.
    await startLaunchVerification(c.ctx);
    await settled(c.org.id, 7);
    expect(await checkJobs(c.org.id)).toBe(7);
  }, 180_000);

  it("does not start a check for an employee that is not ready, and says which and why", async () => {
    const c = await readyClient({ name: "Not Ready Clinic", timezone: "Asia/Manila" });
    const sales = await agentId(c.org.id, "sales_assistant");
    await withSystem((db) => db.query("update agent_instances set last_health_ok = false, status = 'offline' where id = $1", [sales]));
    const res = await startLaunchVerification(c.ctx);
    expect(res.started!.sort()).toEqual(AGENT_ROLE_KEYS.filter((k) => k !== "sales_assistant").sort());
    expect(res.skipped).toEqual([{ role: "sales_assistant", reason: expect.stringContaining("not ready for authorized work") }]);
    await settled(c.org.id, 5);
    const r = (await getLaunchReadiness(c.ctx))!;
    expect(r.state).not.toBe("ready_to_launch");
    expect(itemOf(r, "employees.sales_assistant").state).not.toBe("done");
    expect(itemOf(r, "verification.sales_assistant").state).toBe("in_progress");
  }, 180_000);

  it("refuses a member who cannot start AI work, before the questionnaire, and before the setup payment", async () => {
    const c = await readyClient({ name: "Permissions Roofing", timezone: "UTC" });
    const viewer = ctxFor(c.people.viewer, c.org, "viewer");
    const denied = await startLaunchVerification(viewer);
    expect(denied.started).toEqual([]);
    expect(denied.ok).toBe(false);
    expect(denied.skipped!.length).toBe(6);
    expect(await checkJobs(c.org.id)).toBe(0);

    await withSystem((db) => db.query("update billing_accounts set setup_payment_status = 'invoiced', waiver_reason = null, waived_at = null where org_id = $1", [c.org.id]));
    await expect(startLaunchVerification(c.ctx)).rejects.toThrow(/setup payment is not confirmed/i);
    await withSystem((db) => db.query("update organizations set onboarding_completed_at = null where id = $1", [c.org.id]));
    await expect(startLaunchVerification(c.ctx)).rejects.toThrow(/company information/i);
    expect(await checkJobs(c.org.id)).toBe(0);
  }, 180_000);
});

describe("the guided calendar steps", () => {
  async function draftClient(name: string, timezone: string) {
    const c = await crmOrg({ name, timezone });
    await withSystem(async (db) => {
      await db.query("update organizations set onboarding_completed_at = now() where id = $1", [c.org.id]);
      await db.query("insert into onboarding_answers (org_id, question_id, value) values ($1, 'b.appointments', 'true'::jsonb), ($1, 'a.timezone', to_jsonb($2::text))", [c.org.id, timezone]);
    });
    await clearSetupPayment(c.org.id);
    const calendarId = (await withSystem((db) => db.query<{ id: string }>(
      `insert into crm_calendars (org_id, name, slug, status, origin, timezone, hours_template) values ($1, 'Consultations', 'consultations', 'draft', 'onboarding', $2, $3::jsonb) returning id`,
      [c.org.id, timezone, JSON.stringify(WEEKDAYS)],
    ))).rows[0].id;
    await withSystem((db) => db.query("insert into crm_appointment_types (org_id, calendar_id, name, slug, duration_minutes, min_notice_minutes, location_kind) values ($1, $2, 'Free consultation', 'free-consultation', 30, 60, 'phone')", [c.org.id, calendarId]));
    return { ...c, calendarId, ctx: ctxFor(c.people.owner, c.org, "owner") };
  }

  it("takes a drafted calendar to active one click at a time: host, suggested hours, activation, and the booking page stays off", async () => {
    const c = await draftClient("Click Through Dental", "Asia/Manila");
    // Activation before there is a host or any hours says what is missing instead of failing silently.
    const early = await runLaunchIntent(c.ctx, "activate_calendar");
    expect(early.ok).toBe(false);
    expect(early.message.length).toBeGreaterThan(10);
    expect((await loadLaunchFacts(c.ctx))!.appointments.calendar!.status).toBe("draft");

    expect(await runLaunchIntent(c.ctx, "assign_host")).toMatchObject({ ok: true, message: expect.stringContaining("host") });
    expect((await runLaunchIntent(c.ctx, "assign_host")).message).toContain("already has a host");
    expect((await loadLaunchFacts(c.ctx))!.appointments.calendar).toMatchObject({ hosts: 1, hostsWithHours: 0 });

    expect(await runLaunchIntent(c.ctx, "apply_hours")).toMatchObject({ ok: true, message: expect.stringContaining("Weekly hours saved") });
    expect((await runLaunchIntent(c.ctx, "apply_hours")).message).toContain("nothing was changed");

    const done = await runLaunchIntent(c.ctx, "activate_calendar");
    expect(done).toMatchObject({ ok: true, message: expect.stringContaining("booking page is still off") });
    const calendar = (await loadLaunchFacts(c.ctx))!.appointments.calendar!;
    expect(calendar).toMatchObject({ status: "active", bookingPageOn: false });
    expect((await runLaunchIntent(c.ctx, "activate_calendar")).message).toContain("already active");
  }, 120_000);

  it("refuses a member who may not manage calendars, and never makes someone else the host", async () => {
    const c = await draftClient("Refusal Clinic", "UTC");
    const sales = ctxFor(c.people.sales, c.org, "sales_rep");
    await expect(runLaunchIntent(sales, "assign_host")).rejects.toThrow(/role doesn.t allow this/i);
    expect((await loadLaunchFacts(c.ctx))!.appointments.calendar!.hosts).toBe(0);
    await runLaunchIntent(c.ctx, "assign_host");
    const members = await withSystem((db) => db.query<{ user_id: string }>("select user_id from crm_calendar_members where calendar_id = $1", [c.calendarId]));
    expect(members.rows.map((r) => r.user_id)).toEqual([c.people.owner.id]);
  }, 120_000);

  it("keeps two clients apart: one client's clicks and checks never touch the other's calendar or jobs", async () => {
    const a = await draftClient("Apart A", "Asia/Manila");
    const b = await draftClient("Apart B", "America/Denver");
    await runLaunchIntent(a.ctx, "assign_host");
    await runLaunchIntent(a.ctx, "apply_hours");
    await runLaunchIntent(a.ctx, "activate_calendar");
    expect((await loadLaunchFacts(a.ctx))!.appointments.calendar!.status).toBe("active");
    expect((await loadLaunchFacts(b.ctx))!.appointments.calendar).toMatchObject({ status: "draft", hosts: 0 });
    expect(await count(b.org.id, "crm_calendar_members")).toBe(0);
    expect(await checkJobs(b.org.id)).toBe(0);
  }, 120_000);
});
