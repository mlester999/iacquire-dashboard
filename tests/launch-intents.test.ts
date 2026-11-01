// The guided launch steps and the employees' final read-only check, against a real (test) database. "100% Ready to Launch" is reached only through finished checks on the client's own
// records, a check goes stale when its employee's configuration changes, and nothing here books, sends or writes a business record. Test database only; no Hermes writes.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import { createConfigVersion } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { getLaunchReadiness, loadLaunchFacts } from "@/server/setup/launch-readiness";
import { runLaunchIntent, startLaunchVerification } from "@/server/setup/launch-intents";
import { agentId, ctxFor } from "./support/fixtures";
import { approveHours, checkJobs, count, draftClient, itemOf, readyClient, settled } from "./support/launch";

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
    // Its connection check failed, so it is a failure for iAcquire to look at, not something "being verified".
    expect(itemOf(r, "employees.sales_assistant")).toMatchObject({ state: "action_required", owner: "iacquire" });
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

    expect(await approveHours(c.ctx)).toMatchObject({ ok: true, message: expect.stringContaining("Weekly hours saved") });
    expect((await approveHours(c.ctx)).message).toContain("nothing was changed");

    const done = await runLaunchIntent(c.ctx, "activate_calendar");
    expect(done).toMatchObject({ ok: true, message: expect.stringContaining("booking page is still off") });
    const calendar = (await loadLaunchFacts(c.ctx))!.appointments.calendar!;
    expect(calendar).toMatchObject({ status: "active", bookingPageOn: false });
    expect((await runLaunchIntent(c.ctx, "activate_calendar")).message).toContain("already active");
  }, 120_000);

  it("says so when a host works in another time zone and cannot be given the suggested hours, instead of claiming every host already has hours", async () => {
    const c = await draftClient("Zone Dental", "Asia/Manila");
    await runLaunchIntent(c.ctx, "assign_host");
    // The host already works in London and has no weekly hours: the suggested hours are written in Manila, so giving them to this host would put them hours off.
    await withSystem((db) => db.query("insert into crm_host_settings (org_id, user_id, timezone, accepting) values ($1, $2, 'Europe/London', true)", [c.org.id, c.people.owner.id]));
    const res = await approveHours(c.ctx);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/different time zone/);
    expect(res.message).toMatch(/Availability/);
    expect(res.message).not.toMatch(/already has weekly hours/);
    expect(await count(c.org.id, "crm_availability_rules")).toBe(0);
    // Pressing it again says the same thing, and the calendar still cannot activate on hours that were never written.
    expect((await approveHours(c.ctx)).ok).toBe(false);
    const activation = await runLaunchIntent(c.ctx, "activate_calendar");
    expect(activation.ok).toBe(false);
    expect(activation.message).toMatch(/no weekly hours/);
  }, 120_000);

  it("will not activate while the client's own answer says their Google Calendar must block times and none is connected, and does so only for that client", async () => {
    const c = await draftClient("Busy Google Dental", "Asia/Manila");
    const other = await draftClient("Busy Other Dental", "Asia/Manila");
    for (const x of [c, other]) {
      await runLaunchIntent(x.ctx, "assign_host");
      await approveHours(x.ctx);
    }
    await withSystem((db) => db.query("insert into crm_setup_guides (org_id, answers) values ($1, $2::jsonb)", [c.org.id, JSON.stringify({ appointments: true, calendarSource: "google" })]));
    const refused = await runLaunchIntent(c.ctx, "activate_calendar");
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/events in your Google Calendar must block times, but no host has connected one yet/);
    expect((await loadLaunchFacts(c.ctx))!.appointments.calendar!.status).toBe("draft");
    // The same facts through the panel's own read: the calendar's connections check fails with the same words.
    expect((await loadLaunchFacts(c.ctx))!.appointments.calendar!.checks).toEqual(expect.arrayContaining([expect.objectContaining({ key: "connections", ok: false, detail: expect.stringMatching(/must block times/) })]));
    // Another client with no such answer is not held back.
    expect(await runLaunchIntent(other.ctx, "activate_calendar")).toMatchObject({ ok: true });
    // A connected Google calendar that is being read for busy times is what the answer asks for.
    await withSystem((db) => db.query(
      "insert into crm_calendar_connections (org_id, user_id, provider, account_label, status, check_conflicts, write_events, last_success_at) values ($1, $2, 'google', 'owner@example.test', 'connected', true, false, $3)",
      [c.org.id, c.people.owner.id, new Date(Date.now() - 5 * 60_000)],
    ));
    expect(await runLaunchIntent(c.ctx, "activate_calendar")).toMatchObject({ ok: true });
    expect((await loadLaunchFacts(c.ctx))!.appointments.calendar!.status).toBe("active");
  }, 120_000);

  it("holds no one to an outside calendar when the client said they take no appointments or use only the iAcquire calendar", async () => {
    for (const answers of [{ appointments: false, calendarSource: "google" }, { appointments: true, calendarSource: "iacquire" }]) {
      const c = await draftClient(`No Busy ${answers.calendarSource} ${answers.appointments}`, "Asia/Manila");
      await withSystem((db) => db.query("insert into crm_setup_guides (org_id, answers) values ($1, $2::jsonb)", [c.org.id, JSON.stringify(answers)]));
      await runLaunchIntent(c.ctx, "assign_host");
      await approveHours(c.ctx);
      expect(await runLaunchIntent(c.ctx, "activate_calendar"), JSON.stringify(answers)).toMatchObject({ ok: true });
    }
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
    await approveHours(a.ctx);
    await runLaunchIntent(a.ctx, "activate_calendar");
    expect((await loadLaunchFacts(a.ctx))!.appointments.calendar!.status).toBe("active");
    expect((await loadLaunchFacts(b.ctx))!.appointments.calendar).toMatchObject({ status: "draft", hosts: 0 });
    expect(await count(b.org.id, "crm_calendar_members")).toBe(0);
    expect(await checkJobs(b.org.id)).toBe(0);
  }, 120_000);
});
