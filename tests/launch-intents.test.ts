// The guided launch steps and the employees' final read-only check, against a real (test) database. "100% Ready to Launch" is reached only through finished checks on the client's own
// records, a check goes stale when its employee's configuration changes, and nothing here books, sends or writes a business record. Test database only; no Hermes writes.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import { createConfigVersion, currentSettings } from "@/server/workforce/service";
import { getLaunchReadiness, loadLaunchFacts } from "@/server/setup/launch-readiness";
import { runLaunchIntent, startLaunchVerification } from "@/server/setup/launch-intents";
import { LAUNCH_INTENTS } from "@/lib/launch-readiness";
import { LAUNCH_LEDGER_ACTION } from "@/server/setup/launch-ledger";
import { sweepLaunchVerification } from "@/server/setup/launch-sweep";
import { agentId, ctxFor } from "./support/fixtures";
import { approveHours, checkJobs, count, draftClient, itemOf, markSubmitted, readyClient, settled } from "./support/launch";
import { submitRealOnboarding } from "./support/billing";

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

    const analyst = await agentId(c.org.id, "performance_analyst");
    const current = (await withSystem((db) => currentSettings(db, analyst, c.org.id))).settings;
    await withSystem((db) => createConfigVersion(db, { orgId: c.org.id, agentId: analyst, settings: { ...current, personality: "Plain and exact." }, source: "client_edit", userId: c.people.owner.id, apply: true }));
    // makeRuntimeReady's recorded health belongs to the old version; the new version is applied and the employee is still ready for work.
    const stale = (await getLaunchReadiness(c.ctx))!;
    expect(stale.state).toBe("action_required");
    expect(itemOf(stale, "verification.performance_analyst")).toMatchObject({ state: "action_required", detail: expect.stringContaining("configuration changed"), action: { intent: "run_checks" } });
    expect(stale.blocking.map((i) => i.key)).toEqual(["verification.performance_analyst"]);

    const rerun = await startLaunchVerification(c.ctx);
    expect(rerun.started).toEqual(["performance_analyst"]);
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

  it("says a check held for iAcquire's review is waiting for that review, and a check that is running is running", async () => {
    const c = await readyClient({ name: "Held Check Clinic", timezone: "Asia/Manila" });
    await startLaunchVerification(c.ctx);
    await settled(c.org.id, 6);
    const crm = await agentId(c.org.id, "crm_manager");
    const setStatus = (status: string) => withSystem((db) => db.query("update ai_work_jobs set status = $3 where org_id = $1 and agent_instance_id = $2 and input ->> 'launchVerification' = 'true'", [c.org.id, crm, status]));

    await setStatus("waiting_for_approval");
    const held = await startLaunchVerification(c.ctx);
    expect(held.started).toEqual([]);
    // The same words the panel uses: nothing is running, it waits for a person.
    expect(held.skipped).toEqual([{ role: "crm_manager", reason: expect.stringContaining("waiting for iAcquire's review") }]);
    expect(held.message).not.toContain("already running");
    expect(itemOf((await getLaunchReadiness(c.ctx))!, "verification.crm_manager").detail).toContain("waiting for iAcquire's review");

    await setStatus("running");
    const running = await startLaunchVerification(c.ctx);
    expect(running.skipped).toEqual([{ role: "crm_manager", reason: expect.stringContaining("already running") }]);
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

describe("each step that ran leaves the launch ledger a row, and a refused one leaves nothing", () => {
  const rows = async (orgId: string) => (await withSystem((db) => db.query<{ actor_kind: string; actor_user_id: string | null; metadata: { to: string; changed: Array<{ key: string; state: string }> } }>(
    "select actor_kind, actor_user_id, metadata from audit_logs where org_id = $1 and action = $2 order by id", [orgId, LAUNCH_LEDGER_ACTION]))).rows;

  it("records the state the step left, as the person who pressed it, and not for a step that changed nothing or was refused", async () => {
    const c = await readyClient({ name: "Ledger Steps Roofing", timezone: "Asia/Manila" });
    const base = (await rows(c.org.id)).length;
    // The final checks are started by the person: the state moves (the checks are running, or already passing), and that is one row naming them.
    const started = await runLaunchIntent(c.ctx, "run_checks");
    expect(started.ok).toBe(true);
    const after = (await rows(c.org.id)).slice(base);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ actor_kind: "user", actor_user_id: c.people.owner.id });
    expect(after[0].metadata.changed.some((i) => i.key.startsWith("verification."))).toBe(true);
    await settled(c.org.id, 6);
    // Once every check has passed, the next press records that (once), and pressing again while nothing changed adds nothing.
    await runLaunchIntent(c.ctx, "run_checks");
    expect((await rows(c.org.id)).at(-1)!.metadata.to).toBe("ready_to_launch");
    const settledCount = (await rows(c.org.id)).length;
    await runLaunchIntent(c.ctx, "run_checks");
    expect((await rows(c.org.id)).length).toBe(settledCount);
    // A step the person may not run is refused before anything is read, so the ledger hears nothing of it.
    await expect(runLaunchIntent(ctxFor(c.people.sales, c.org, "sales_rep"), "assign_host")).rejects.toThrow(/role doesn.t allow this/i);
    expect((await rows(c.org.id)).length).toBe(settledCount);
  }, 180_000);
});

describe("every step the panel can offer is handled by the server, and refused for a member without the permission", () => {
  it("refuses each step that changes the workspace for a viewer, before anything is read, and names a client workspace for anything else", async () => {
    const c = await readyClient({ name: "Every Step Roofing", timezone: "Asia/Manila" });
    await withSystem((db) => db.query("insert into onboarding_answers (org_id, question_id, value) values ($1, 'd.team', $2::jsonb)", [c.org.id, JSON.stringify([{ name: "Ana Cruz", email: "ana-steps@client.example", role: "support" }])]));
    const viewer = ctxFor(c.people.viewer, c.org, "viewer");
    const writing = LAUNCH_INTENTS.filter((intent) => intent !== "run_checks");
    expect(writing).toHaveLength(LAUNCH_INTENTS.length - 1);
    for (const intent of writing) await expect(runLaunchIntent(viewer, intent), intent).rejects.toMatchObject({ code: "forbidden" });
    // Nothing was written by any of them: no invitation, no pipeline, no region, no application, no host.
    const n = async (sql: string) => Number((await withSystem((db) => db.query<{ n: string }>(sql, [c.org.id]))).rows[0].n);
    expect(await n("select count(*) as n from invitations where org_id = $1")).toBe(0);
    expect(await n("select count(*) as n from audit_logs where org_id = $1 and action in ('onboarding.region_defaults_applied', 'onboarding.pipeline_stages_applied', 'team.invited', 'crm.auto_setup_applied', 'setup.launch_host_chosen')")).toBe(0);

    // The same steps are refused outside a client workspace, whoever presses them.
    const asAgency = { ...c.ctx, org: { ...c.ctx.org, kind: "agency" as const } };
    for (const intent of LAUNCH_INTENTS) await expect(runLaunchIntent(asAgency, intent), intent).rejects.toMatchObject({ code: "forbidden" });
    expect(await n("select count(*) as n from invitations where org_id = $1")).toBe(0);
  }, 180_000);
});

describe("sync_employees: bringing the AI team up to what the client approved", () => {
  const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[]) => (await withSystem((db) => db.query<T>(sql, params))).rows;
  const versions = async (orgId: string) => Object.fromEntries((await q<{ role_key: string; n: number }>(
    "select a.role_key, count(v.id)::int as n from agent_instances a left join agent_config_versions v on v.agent_instance_id = a.id where a.org_id = $1 group by a.role_key", [orgId])).map((r) => [r.role_key, r.n]));
  const behindRoles = async (c: Awaited<ReturnType<typeof readyClient>>) => ((await loadLaunchFacts(c.ctx))!.employeesBehind ?? []).map((b) => b.role).sort();
  const staleBusiness = (orgId: string) => withSystem((db) => db.query("update company_profiles set services = 'Metal roofing and gutters' where org_id = $1", [orgId]));

  it("writes one new attributed version for each employee that is behind, reports what each one became, and a second press changes nothing", async () => {
    const c = await readyClient({ name: "Sync Employees Roofing", timezone: "America/Chicago" });
    await staleBusiness(c.org.id);
    expect(await behindRoles(c)).toEqual([...AGENT_ROLE_KEYS].sort());
    const before = await versions(c.org.id);

    const res = await runLaunchIntent(c.ctx, "sync_employees");
    const after = await versions(c.org.id);
    for (const role of AGENT_ROLE_KEYS) expect(after[role], role).toBe(before[role] + 1);
    // Each new version names the person who pressed, and says it came from the approved answers.
    const made = await q<{ role_key: string; source: string; status: string; created_by: string; version: number }>(
      `select distinct on (a.role_key) a.role_key, v.source, v.status, v.created_by, v.version from agent_config_versions v join agent_instances a on a.id = v.agent_instance_id
        where a.org_id = $1 order by a.role_key, v.version desc`, [c.org.id]);
    for (const m of made) expect(m.version, m.role_key).toBe(before[m.role_key] + 1);
    expect(made).toHaveLength(6);
    expect(made.every((m) => m.source === "onboarding" && m.created_by === c.people.owner.id)).toBe(true);
    expect(made.every((m) => m.status === "applied" || m.status === "pending_agency_review")).toBe(true);
    const applied = made.filter((m) => m.status === "applied").map((m) => m.role_key).sort();
    const held = made.filter((m) => m.status === "pending_agency_review").map((m) => m.role_key).sort();
    // A change that needs the reviewer waits for the reviewer and is said to: it is never reported as applied.
    expect(applied.length + held.length).toBe(6);
    expect(res.message).toContain("Updated");
    if (held.length) expect(res.message).toContain("needs iAcquire's review");
    expect(res.ok).toBe(applied.length > 0);
    // Nothing is behind any more: an employee is either running the new version or waiting for its review.
    expect(await behindRoles(c)).toEqual([]);
    const audit = await q<{ metadata: { updated: string[]; held: string[] } }>("select metadata from audit_logs where org_id = $1 and action = 'setup.launch_employees_synced'", [c.org.id]);
    expect(audit).toHaveLength(1);
    expect([...audit[0].metadata.updated].sort()).toEqual(applied);
    expect([...audit[0].metadata.held].sort()).toEqual(held);

    // Pressing it again finds nothing to do and writes nothing.
    expect(await runLaunchIntent(c.ctx, "sync_employees")).toEqual({ ok: true, message: "Your AI employees already match your approved setup. Nothing was changed." });
    expect(await versions(c.org.id)).toEqual(after);
    expect(await q("select 1 from audit_logs where org_id = $1 and action = 'setup.launch_employees_synced'", [c.org.id])).toHaveLength(1);
  }, 180_000);

  it("uses the single Growth Partner identity in onboarding sync results", async () => {
    const c = await submitRealOnboarding({
      name: "Partner Setup Sync Roofing",
      clearPayment: true,
      disableRoles: [...AGENT_ROLE_KEYS],
      withGrowthPartner: true,
    });
    const enabledRoles = await q<{ role_key: string }>("select role_key from agent_instances where org_id = $1 and enabled", [c.org.id]);
    expect(enabledRoles.map((r) => r.role_key)).toEqual(["growth_partner"]);
    const partner = await q<{ id: string; active_config_version_id: string | null }>(
      "select id, active_config_version_id from agent_instances where org_id = $1 and role_key = 'growth_partner' and enabled", [c.org.id],
    );
    expect(partner).toHaveLength(1);
    // Simulate an interrupted first configuration write: the setup action should repair the
    // single Partner from the already-approved questionnaire even though legacy sync rows omit it.
    await withSystem((db) => db.query("update agent_instances set active_config_version_id = null where id = $1 and org_id = $2", [partner[0].id, c.org.id]));
    const synced = await runLaunchIntent(c.ctx, "sync_employees");
    expect(synced.ok).toBe(true);
    expect(synced.message).toContain("Updated your AI Growth Partner to match your approved setup.");
    expect(synced.message).not.toMatch(/AI employees|Operations Manager|Lead Hunter|Sales Assistant|CRM Manager|Performance Analyst/);
    expect((await q<{ active_config_version_id: string | null }>("select active_config_version_id from agent_instances where id = $1", [partner[0].id]))[0].active_config_version_id).toBeTruthy();

    expect(await runLaunchIntent(c.ctx, "sync_employees")).toEqual({
      ok: true,
      message: "Your AI Growth Partner already matches your approved setup. Nothing was changed.",
    });
  }, 180_000);

  it("leaves what the client wrote in an employee's settings alone", async () => {
    const c = await readyClient({ name: "Sync Keeps Edits Roofing", timezone: "America/Chicago" });
    const analyst = await agentId(c.org.id, "performance_analyst");
    const own = "The client's own wording.";
    const current = (await withSystem((db) => currentSettings(db, analyst, c.org.id))).settings;
    await withSystem((db) => createConfigVersion(db, { orgId: c.org.id, agentId: analyst, settings: { ...current, personality: own }, source: "client_edit", userId: c.people.owner.id, apply: true }));
    await staleBusiness(c.org.id);
    await runLaunchIntent(c.ctx, "sync_employees");
    const kept = (await q<{ settings: { personality?: string } }>("select v.settings from agent_config_versions v join agent_instances a on a.active_config_version_id = v.id where a.id = $1", [analyst]))[0].settings;
    expect(kept.personality).toBe(own);
  }, 180_000);

  it("is refused before the questionnaire, before the payment, for a sample workspace, for unapproved edits and for people who may not manage the profile, and writes nothing", async () => {
    const early = await readyClient({ name: "Sync Early Roofing", timezone: "UTC" });
    await staleBusiness(early.org.id);
    await withSystem((db) => db.query("update organizations set onboarding_completed_at = null where id = $1", [early.org.id]));
    await expect(runLaunchIntent(early.ctx, "sync_employees")).rejects.toThrow(/Submit your company information/i);

    const unpaid = await readyClient({ name: "Sync Unpaid Roofing", timezone: "UTC" });
    await staleBusiness(unpaid.org.id);
    await withSystem((db) => db.query("update billing_accounts set setup_payment_status = 'invoiced', waiver_reason = null, waived_at = null where org_id = $1", [unpaid.org.id]));
    await expect(runLaunchIntent(unpaid.ctx, "sync_employees")).rejects.toThrow(/setup payment is not confirmed/i);

    const demo = await readyClient({ name: "Sync Sample Roofing", timezone: "UTC" });
    await staleBusiness(demo.org.id);
    demo.ctx.org.isDemo = true;
    await expect(runLaunchIntent(demo.ctx, "sync_employees")).rejects.toThrow(/sample workspace/i);

    const waiting = await readyClient({ name: "Sync Unapproved Roofing", timezone: "UTC" });
    await staleBusiness(waiting.org.id);
    await markSubmitted(waiting.org.id);
    await withSystem((db) => db.query("update onboarding_answers set updated_at = now() + interval '1 minute' where org_id = $1 and question_id = 'a.timezone'", [waiting.org.id]));
    await expect(runLaunchIntent(waiting.ctx, "sync_employees")).rejects.toThrow(/not approved/i);

    const people = await readyClient({ name: "Sync People Roofing", timezone: "UTC" });
    await staleBusiness(people.org.id);
    const roles = [["sales", "sales_rep"], ["support", "support"], ["viewer", "viewer"], ["setter", "appointment_setter"]] as const;
    for (const [who, role] of roles) await expect(runLaunchIntent(ctxFor(people.people[who], people.org, role), "sync_employees"), who).rejects.toThrow(/owner or admin/i);

    for (const c of [early, unpaid, demo, waiting, people]) {
      expect(await q("select 1 from audit_logs where org_id = $1 and action = 'setup.launch_employees_synced'", [c.org.id]), c.org.name).toHaveLength(0);
      expect(Object.values(await versions(c.org.id)).every((n) => n === 1), c.org.name).toBe(true);
    }
    // An admin may.
    expect((await runLaunchIntent(ctxFor(people.people.manager, people.org, "admin"), "sync_employees")).message).toContain("Updated");
  }, 300_000);

  it("keeps two clients apart: updating one writes nothing in the other, which stays behind until its own owner does it", async () => {
    const a = await readyClient({ name: "Sync Apart A", timezone: "Asia/Manila" });
    const b = await readyClient({ name: "Sync Apart B", timezone: "America/Denver" });
    await staleBusiness(a.org.id);
    await staleBusiness(b.org.id);
    const bBefore = await versions(b.org.id);
    await runLaunchIntent(a.ctx, "sync_employees");
    expect(await versions(b.org.id)).toEqual(bBefore);
    expect(await behindRoles(a)).toEqual([]);
    expect(await behindRoles(b)).toEqual([...AGENT_ROLE_KEYS].sort());
  }, 300_000);

  it("makes the changed employees' checks stale, so the way back to 100% is the update, then the checks", async () => {
    const c = await readyClient({ name: "Sync Back To Ready Roofing", timezone: "America/Chicago" });
    await sweepLaunchVerification(c.org.id);
    await settled(c.org.id, 6);
    expect((await getLaunchReadiness(c.ctx))!.state).toBe("ready_to_launch");
    await staleBusiness(c.org.id);
    const behind = (await getLaunchReadiness(c.ctx))!;
    expect(behind.state).toBe("action_required");
    expect(behind.blocking.map((i) => i.key)).toEqual(["employees.in_sync"]);
    await runLaunchIntent(c.ctx, "sync_employees");
    // The updated employees run a new configuration, so their checks are stale; an employee waiting for review is the reviewer's.
    const after = (await getLaunchReadiness(c.ctx))!;
    expect(after.percent).toBeLessThan(100);
    expect(after.blocking.map((i) => i.key)).not.toContain("employees.in_sync");
  }, 240_000);
});
