// The launch ledger: one audit row for each real change of a client's launch state and none for a repeat, owners told once per moment that is theirs, a long wait told to the agency (and
// only then worded as "alerted"), and every one of it kept inside the client it belongs to. Test database only; nothing is sent, booked or contacted.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { notifyAgency } from "@/server/notifications";
import { recordAudit } from "@/server/audit";
import { describeAction } from "@/lib/activity";
import { getDashboard } from "@/server/queries/dashboard";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import { deriveLaunchReadiness, fingerprintOf } from "@/lib/launch-readiness";
import { createConfigVersion, currentSettings } from "@/server/workforce/service";
import { waiveSetupFee } from "@/server/billing/manual";
import { pickUpSetupEvidence } from "@/server/setup/evidence-pickup";
import { sweepLaunchVerification, sweepLaunchVerificationAfter } from "@/server/setup/launch-sweep";
import { getLaunchReadiness, launchStallMinutes, loadLaunchFacts, loadLaunchFactsForOrg } from "@/server/setup/launch-readiness";
import { runLaunchIntent } from "@/server/setup/launch-intents";
import { LAUNCH_LEDGER_ACTION, readLaunchCurrent, recordLaunchSnapshot, settleLaunchSnapshots, type LaunchLedgerRow } from "@/server/setup/launch-ledger";
import { agentId, createOrg, ctxFor } from "./support/fixtures";
import { agencyPeople } from "./support/crm";
import { clearSetupPayment, onboardedClient, submitRealOnboarding } from "./support/billing";
import { draftClient, itemOf, readyClient, settled } from "./support/launch";

const SYSTEM = { kind: "system" } as const;

interface LedgerAuditRow { id: string; actor_kind: string; actor_user_id: string | null; created_at: Date; metadata: LaunchLedgerRow }
const ledgerRows = async (orgId: string) => (await withSystem((db) => db.query<LedgerAuditRow>(
  "select id, actor_kind, actor_user_id, created_at, metadata from audit_logs where org_id = $1 and action = $2 order by id",
  [orgId, LAUNCH_LEDGER_ACTION],
))).rows;
interface NoticeRow { user_id: string; kind: string; dedupe_key: string | null; org_id: string | null }
const notices = async (orgId: string, kinds: string[]) => (await withSystem((db) => db.query<NoticeRow>(
  "select user_id, kind, dedupe_key, org_id from notifications where org_id = $1 and kind = any($2::text[]) order by created_at, id",
  [orgId, kinds],
))).rows;
const OWNER_KINDS = ["setup_action_required", "setup_ready", "setup_issue"];
const noticesTo = (orgId: string, userId: string, kind: string) => notices(orgId, [kind]).then((rows) => rows.filter((n) => n.user_id === userId));

describe("the ledger writes one row per real change", () => {
  it("records the first state in the shape other code reads, adds nothing for an unchanged re-read, and records the next real change with what changed", async () => {
    const c = await draftClient("Ledger Dental", "Asia/Manila");
    expect(await ledgerRows(c.org.id)).toHaveLength(0);

    const first = await recordLaunchSnapshot(c.org.id, SYSTEM);
    expect(first).toMatchObject({ recorded: true, state: "action_required" });
    const [row] = await ledgerRows(c.org.id);
    expect(row.actor_kind).toBe("system");
    expect(row.metadata).toMatchObject({ from: null, to: "action_required", fingerprint: first!.fingerprint, percent: first!.percent });
    expect(row.metadata.fingerprint).toMatch(/^[0-9a-f]{14}$/);
    expect(row.metadata.total).toBeGreaterThan(row.metadata.passed);
    expect(row.metadata.needsYou).toBeGreaterThan(0);
    expect(row.metadata.topBlocker).toMatchObject({ key: expect.any(String), label: expect.any(String), owner: expect.stringMatching(/^(you|iacquire|system)$/) });
    expect(row.metadata.changed).toEqual(expect.arrayContaining([{ key: "calendar.host", state: "action_required", owner: "you" }]));
    expect(row.metadata.items["calendar.host"]).toBe("action_required/you");
    // The row says what the judge says now: the same fingerprint an independent read gives.
    const now = deriveLaunchReadiness((await loadLaunchFactsForOrg(c.org.id))!, new Date(), launchStallMinutes());
    expect(fingerprintOf(now)).toBe(row.metadata.fingerprint);

    // Nothing changed, nothing written: not even for a state that was read again and again.
    expect(await recordLaunchSnapshot(c.org.id, SYSTEM)).toMatchObject({ recorded: false, fingerprint: first!.fingerprint });
    expect(await ledgerRows(c.org.id)).toHaveLength(1);

    // A real change (the client chooses themselves as the host) records one more row, from the state before, naming the line that moved and who did it.
    const ran = await runLaunchIntent(c.ctx, "assign_host");
    expect(ran.ok).toBe(true);
    const rows = await ledgerRows(c.org.id);
    expect(rows).toHaveLength(2);
    expect(rows[1].metadata.from).toBe("action_required");
    expect(rows[1].metadata.fingerprint).not.toBe(rows[0].metadata.fingerprint);
    expect(rows[1].metadata.changed).toEqual(expect.arrayContaining([{ key: "calendar.host", state: "done", owner: "you" }]));
    expect(rows[1].metadata.changed.every((i) => rows[0].metadata.items[i.key] !== `${i.state}/${i.owner}`)).toBe(true);
    expect(rows[1]).toMatchObject({ actor_kind: "user", actor_user_id: c.people.owner.id });
    expect(await recordLaunchSnapshot(c.org.id, SYSTEM)).toMatchObject({ recorded: false });
    expect(await ledgerRows(c.org.id)).toHaveLength(2);
  }, 180_000);

  it("never writes when the panel is read: reading the facts and the readiness any number of times adds no row and no notice", async () => {
    const c = await draftClient("Read Only Roofing", "America/Chicago");
    await recordLaunchSnapshot(c.org.id, SYSTEM);
    const before = { rows: (await ledgerRows(c.org.id)).length, notices: (await notices(c.org.id, OWNER_KINDS)).length };
    for (let i = 0; i < 3; i += 1) {
      await getLaunchReadiness(c.ctx);
      await loadLaunchFacts(c.ctx);
      await loadLaunchFactsForOrg(c.org.id);
    }
    expect({ rows: (await ledgerRows(c.org.id)).length, notices: (await notices(c.org.id, OWNER_KINDS)).length }).toEqual(before);
  }, 120_000);

  it("writes nothing for a refused step, and records a client that has not started only once there is something to remember", async () => {
    const c = await draftClient("Refused Step Dental", "Asia/Manila");
    await recordLaunchSnapshot(c.org.id, SYSTEM);
    // A viewer may not set up calendars: the step is refused before it changes anything, and the ledger is left alone.
    await expect(runLaunchIntent(ctxFor(c.people.viewer, c.org, "viewer"), "assign_host")).rejects.toMatchObject({ code: "forbidden" });
    expect(await ledgerRows(c.org.id)).toHaveLength(1);
    // A workspace that has not submitted its questionnaire has no state to remember yet.
    const fresh = await createOrg({ name: "Not Started Co" });
    expect(await recordLaunchSnapshot(fresh.id, SYSTEM)).toMatchObject({ recorded: false, state: "not_started" });
    expect(await ledgerRows(fresh.id)).toHaveLength(0);
  }, 120_000);

  it("compares with the newest row by its sequence number, not by its text, when one client's rows straddle a digit boundary", async () => {
    const c = await draftClient("Digit Boundary Dental", "Asia/Manila");
    const top = async () => Number((await withSystem((db) => db.query<{ n: string }>("select coalesce(max(id), 0)::text as n from audit_logs"))).rows[0].n);
    // Put the audit sequence just under the next power of ten, so the client's first row has one digit fewer than its second: sorted as text, "999" would be newer than "1003".
    const boundary = 10 ** String((await top()) + 40).length;
    await withSystem((db) => db.query("select setval(pg_get_serial_sequence('audit_logs', 'id'), $1)", [boundary - 20]));
    await recordLaunchSnapshot(c.org.id, SYSTEM);
    while ((await top()) < boundary + 2) {
      await recordAudit({ orgId: c.org.id, actorKind: "system", action: "test.digit_boundary_filler", targetType: "organization", targetId: c.org.id, result: "success" });
    }
    expect((await runLaunchIntent(c.ctx, "assign_host")).ok).toBe(true);
    const rows = await ledgerRows(c.org.id);
    expect(rows).toHaveLength(2);
    expect(Number(rows[0].id)).toBeLessThan(boundary);
    expect(Number(rows[1].id)).toBeGreaterThanOrEqual(boundary);
    expect(rows[1].metadata.from).toBe("action_required");
    // The state is unchanged since the second row: nothing is written.
    expect(await recordLaunchSnapshot(c.org.id, SYSTEM)).toMatchObject({ recorded: false });
    expect(await ledgerRows(c.org.id)).toHaveLength(2);
    expect(await notices(c.org.id, ["setup_action_required"])).toHaveLength(1);
    // A later real change is still recorded, from the second row's state. Compared by text, the first row would look like the newest one: the writer would think another call had written
    // meanwhile, stand down, and the change would be lost.
    await withSystem((db) => db.query("delete from crm_appointment_types where org_id = $1", [c.org.id]));
    expect(await recordLaunchSnapshot(c.org.id, SYSTEM)).toMatchObject({ recorded: true });
    const after = await ledgerRows(c.org.id);
    expect(after).toHaveLength(3);
    expect(after[2].metadata.fingerprint).not.toBe(after[1].metadata.fingerprint);
    expect(after[2].metadata.from).toBe(after[1].metadata.to);
  }, 180_000);

  it("makes one row when it is called several times at once", async () => {
    const c = await draftClient("Concurrent Roofing", "Europe/London");
    const results = await Promise.all([recordLaunchSnapshot(c.org.id, SYSTEM), recordLaunchSnapshot(c.org.id, SYSTEM), recordLaunchSnapshot(c.org.id, { kind: "user", userId: c.people.owner.id })]);
    expect(results.filter((r) => r?.recorded)).toHaveLength(1);
    expect(await ledgerRows(c.org.id)).toHaveLength(1);
    expect(new Set(results.map((r) => r!.fingerprint)).size).toBe(1);
  }, 120_000);
});

describe("the ledger stays inside the client it belongs to", () => {
  it("records each client on its own, lists only the clients asked for, and refuses the agency's workspace, a sample workspace and a workspace that does not exist", async () => {
    const a = await draftClient("Tenant A Dental", "Asia/Manila");
    const b = await draftClient("Tenant B Roofing", "America/Chicago");
    await recordLaunchSnapshot(a.org.id, SYSTEM);
    expect(await ledgerRows(b.org.id)).toHaveLength(0);
    expect((await readLaunchCurrent([a.org.id, b.org.id])).has(b.org.id)).toBe(false);
    await recordLaunchSnapshot(b.org.id, SYSTEM);
    const both = await readLaunchCurrent([a.org.id, b.org.id]);
    expect([...both.keys()].sort()).toEqual([a.org.id, b.org.id].sort());
    expect(both.get(a.org.id)).toMatchObject({ orgId: a.org.id, state: "action_required", topBlocker: expect.objectContaining({ key: expect.any(String) }) });
    // Asking for one client says nothing about another.
    expect([...(await readLaunchCurrent([a.org.id])).keys()]).toEqual([a.org.id]);
    expect((await readLaunchCurrent([])).size).toBe(0);
    // Each client's owner hears about their own workspace only.
    const aNotices = await notices(a.org.id, OWNER_KINDS);
    expect(aNotices.length).toBeGreaterThan(0);
    expect(aNotices.every((n) => n.user_id === a.people.owner.id && n.org_id === a.org.id)).toBe(true);
    expect((await notices(b.org.id, OWNER_KINDS)).every((n) => n.user_id === b.people.owner.id)).toBe(true);

    const agency = await createOrg({ name: "The Agency", kind: "agency" });
    expect(await recordLaunchSnapshot(agency.id, SYSTEM)).toBeNull();
    const demo = await draftClient("Sample Demo Co", "UTC");
    await withSystem((db) => db.query("update organizations set is_demo = true where id = $1", [demo.org.id]));
    expect(await recordLaunchSnapshot(demo.org.id, SYSTEM)).toBeNull();
    expect(await recordLaunchSnapshot("00000000-0000-4000-8000-000000000000", SYSTEM)).toBeNull();
    expect(await ledgerRows(agency.id)).toHaveLength(0);
    expect(await ledgerRows(demo.org.id)).toHaveLength(0);
  }, 180_000);
});

describe("owners are told once for each moment that is theirs", () => {
  it("sends one 'needs you' notice to the owner only, and no second one when the state changes again", async () => {
    const c = await draftClient("Notice Dental", "Asia/Manila");
    await recordLaunchSnapshot(c.org.id, SYSTEM);
    expect(await noticesTo(c.org.id, c.people.owner.id, "setup_action_required")).toHaveLength(1);
    // A manager, a viewer and the rest of the team are not told: the owner is the one who answers for the setup.
    expect((await notices(c.org.id, OWNER_KINDS)).every((n) => n.user_id === c.people.owner.id)).toBe(true);
    await runLaunchIntent(c.ctx, "assign_host");
    expect(await ledgerRows(c.org.id)).toHaveLength(2);
    await recordLaunchSnapshot(c.org.id, SYSTEM);
    expect((await notices(c.org.id, OWNER_KINDS))).toHaveLength(1);
  }, 120_000);

  it("records a regression from ready, tells the owner once, records the way back, and lists the current state with when it began", async () => {
    const c = await readyClient({ name: "Regression Roofing", timezone: "Asia/Manila" });
    // The fixture's own Blueprint apply and calendar activation are events that already left rows; everything below is counted from here.
    await recordLaunchSnapshot(c.org.id, SYSTEM);
    const base = (await ledgerRows(c.org.id)).length;
    expect((await ledgerRows(c.org.id)).at(-1)!.metadata.to).toBe("action_required");

    await sweepLaunchVerification(c.org.id);
    await settled(c.org.id, 6);
    expect(await recordLaunchSnapshot(c.org.id, SYSTEM)).toMatchObject({ recorded: true, state: "ready_to_launch", percent: 100 });
    expect(await recordLaunchSnapshot(c.org.id, SYSTEM)).toMatchObject({ recorded: false });
    let rows = (await ledgerRows(c.org.id)).slice(base);
    expect(rows.map((r) => r.metadata.to)).toEqual(["ready_to_launch"]);
    expect(rows[0].metadata).toMatchObject({ from: "action_required", percent: 100, needsYou: 0, needsIacquire: 0, topBlocker: null });
    expect(await noticesTo(c.org.id, c.people.owner.id, "setup_ready")).toHaveLength(1);
    expect(await noticesTo(c.org.id, c.people.owner.id, "setup_issue")).toHaveLength(0);
    let current = (await readLaunchCurrent([c.org.id])).get(c.org.id)!;
    expect(current).toMatchObject({ state: "ready_to_launch", percent: 100 });
    expect(current.since).toBe(rows[0].created_at.toISOString());

    // The analyst's configuration changes: its last check no longer describes it, so the client is not ready any more, and that step back is recorded.
    const analyst = await agentId(c.org.id, "performance_analyst");
    const analystSettings = (await withSystem((db) => currentSettings(db, analyst, c.org.id))).settings;
    await withSystem((db) => createConfigVersion(db, { orgId: c.org.id, agentId: analyst, settings: { ...analystSettings, personality: "Plain and exact." }, source: "client_edit", userId: c.people.owner.id, apply: true }));
    expect(await recordLaunchSnapshot(c.org.id, SYSTEM)).toMatchObject({ recorded: true, state: "action_required" });
    rows = (await ledgerRows(c.org.id)).slice(base);
    expect(rows[1].metadata).toMatchObject({ from: "ready_to_launch", to: "action_required" });
    expect(rows[1].metadata.changed.map((i) => i.key)).toEqual(["verification.performance_analyst"]);
    expect(await noticesTo(c.org.id, c.people.owner.id, "setup_issue")).toHaveLength(1);
    // A regression is one notice, and it is not a second "needs you" notice on top.
    expect(await noticesTo(c.org.id, c.people.owner.id, "setup_action_required")).toHaveLength(1);
    expect(await recordLaunchSnapshot(c.org.id, SYSTEM)).toMatchObject({ recorded: false });
    expect(await noticesTo(c.org.id, c.people.owner.id, "setup_issue")).toHaveLength(1);
    current = (await readLaunchCurrent([c.org.id])).get(c.org.id)!;
    expect(current).toMatchObject({ state: "action_required", needsYou: 1, topBlocker: { key: "verification.performance_analyst", owner: "you" } });
    expect(current.since).toBe(rows[1].created_at.toISOString());

    // The check runs again and the client is ready again: a new row, and a new notice for this new arrival (the first one is not repeated).
    await sweepLaunchVerification(c.org.id);
    await settled(c.org.id, 7);
    expect(await recordLaunchSnapshot(c.org.id, SYSTEM)).toMatchObject({ recorded: true, state: "ready_to_launch" });
    expect(await noticesTo(c.org.id, c.people.owner.id, "setup_ready")).toHaveLength(2);
    expect(await noticesTo(c.org.id, c.people.owner.id, "setup_issue")).toHaveLength(1);
    expect((await ledgerRows(c.org.id)).slice(base).map((r) => r.metadata.to)).toEqual(["ready_to_launch", "action_required", "ready_to_launch"]);
  }, 300_000);
});

describe("a wait that went on too long is told to iAcquire, and only then said to be alerted", () => {
  it("flips old profile jobs to iAcquire's, alerts the agency once per wait, words it truthfully, and never crosses to another client", async () => {
    const { superAdmin } = await agencyPeople();
    const a = await submitRealOnboarding({ name: "Stalled Roofing", clearPayment: true });
    const b = await submitRealOnboarding({ name: "Young Roofing", clearPayment: true });
    const jobCount = async (orgId: string) => Number((await withSystem((db) => db.query<{ n: string }>("select count(*) as n from agent_provisioning_jobs where org_id = $1 and status in ('requested', 'in_progress')", [orgId]))).rows[0].n);
    expect(await jobCount(a.org.id)).toBeGreaterThan(0);

    // Young: still in progress, nothing is needed, and nobody is called a staller.
    const young = (await getLaunchReadiness(a.ctx))!;
    expect(itemOf(young, "employees.lead_hunter")).toMatchObject({ state: "in_progress", owner: "system" });
    expect(itemOf(young, "employees.lead_hunter").stalled).toBeUndefined();

    // Two hours later by the clock the judge is given (the test clock: the rows were written a moment ago): the same facts say "taking longer than expected" for iAcquire.
    const facts = (await loadLaunchFactsForOrg(a.org.id))!;
    const later = new Date(Date.now() + 2 * 3_600_000);
    const stalledLater = deriveLaunchReadiness(facts, later, launchStallMinutes());
    // Every employee whose profile job is still open is stalled; the one whose configuration is held for iAcquire's review waits on that review instead (it is already iAcquire's).
    const open = AGENT_ROLE_KEYS.filter((role) => facts.employees.find((e) => e.role === role)?.heldForReview !== true);
    expect(open.length).toBeGreaterThanOrEqual(5);
    expect(open.every((role) => itemOf(stalledLater, `employees.${role}`).stalled === true)).toBe(true);
    expect(AGENT_ROLE_KEYS.filter((role) => !open.includes(role)).every((role) => itemOf(stalledLater, `employees.${role}`).state === "awaiting_review")).toBe(true);
    // The industry CRM wait begins at the later of the questionnaire's submission and the fee clearing, read from the workspace's own rows.
    const waiting = (await withSystem((db) => db.query<{ since: Date }>(
      "select greatest(o.onboarding_completed_at, b.paid_at, b.waived_at) as since from organizations o join billing_accounts b on b.org_id = o.id where o.id = $1", [a.org.id],
    ))).rows[0].since;
    expect(facts.crm.waitingSince).toBe(waiting.toISOString());
    expect(itemOf(stalledLater, "crm.blueprint")).toMatchObject({ state: "action_required", owner: "iacquire", stalled: true });

    // Make the profile jobs of client A actually old. Client B's stay young.
    await withSystem((db) => db.query("update agent_provisioning_jobs set created_at = now() - interval '2 hours' where org_id = $1", [a.org.id]));
    const stalled = (await getLaunchReadiness(a.ctx))!;
    expect(itemOf(stalled, "employees.lead_hunter")).toMatchObject({ state: "action_required", owner: "iacquire", stalled: true });
    expect(itemOf(stalled, "employees.lead_hunter").detail).toContain("waiting on iAcquire");
    // No alert exists yet, so none is claimed.
    expect(itemOf(stalled, "employees.lead_hunter").detail).not.toContain("has been alerted");
    expect(stalled.state).toBe("action_required");

    // The ledger tells the agency (the people whose scope includes this client), once per wait.
    const staleKey = (orgId: string) => withSystem((db) => db.query<{ user_id: string; dedupe_key: string; org_id: string }>(
      "select user_id, dedupe_key, org_id from notifications where kind = 'setup_issue' and dedupe_key like 'launch-stalled:%' and org_id = $1", [orgId],
    )).then((r) => r.rows);
    expect(await recordLaunchSnapshot(a.org.id, SYSTEM)).toMatchObject({ recorded: true, state: "action_required" });
    const alerts = await staleKey(a.org.id);
    expect(alerts.length).toBeGreaterThanOrEqual(open.length);
    expect(alerts.every((n) => n.org_id === a.org.id && n.dedupe_key.startsWith(`launch-stalled:${a.org.id}:employees.`))).toBe(true);
    // Only agency accounts are told (this client's own people never are), and the Super Admin is one of them.
    const told = await withSystem((db) => db.query<{ id: string; platform_role: string }>("select id, platform_role from users where id = any($1::uuid[])", [[...new Set(alerts.map((n) => n.user_id))]]));
    expect(told.rows.every((u) => u.platform_role.startsWith("agency_"))).toBe(true);
    expect(told.rows.map((u) => u.id)).toContain(superAdmin.id);
    const sent = alerts.length;
    await recordLaunchSnapshot(a.org.id, SYSTEM);
    await recordLaunchSnapshot(a.org.id, SYSTEM);
    expect((await staleKey(a.org.id)).length).toBe(sent);
    expect((await ledgerRows(a.org.id)).at(-1)!.metadata.needsIacquire).toBeGreaterThanOrEqual(open.length);

    // Now an alert really exists, so the panel may say so.
    const alerted = (await getLaunchReadiness(a.ctx))!;
    expect(itemOf(alerted, "employees.lead_hunter").detail).toContain("iAcquire has been alerted.");

    // Client B's wait is young: nothing for B, no alert about A reaches B, and B's panel never claims one.
    expect(await recordLaunchSnapshot(b.org.id, SYSTEM)).toMatchObject({ recorded: true });
    expect(await staleKey(b.org.id)).toHaveLength(0);
    const bNow = (await getLaunchReadiness(b.ctx))!;
    expect(AGENT_ROLE_KEYS.every((role) => itemOf(bNow, `employees.${role}`).stalled === undefined && !itemOf(bNow, `employees.${role}`).detail.includes("has been alerted"))).toBe(true);
    expect(await withSystem((db) => db.query("select 1 from notifications where org_id = $1 and dedupe_key like $2", [b.org.id, `%${a.org.id}%`]))).toMatchObject({ rows: [] });
  }, 300_000);
});

describe("the ledger's own rows do not clutter the client's activity", () => {
  it("has plain labels for the launch ledger and the plan-change resume, and keeps the ledger out of the client's recent activity", async () => {
    expect(describeAction(LAUNCH_LEDGER_ACTION)).toBe("launch readiness changed");
    expect(describeAction("agent.plan_change_resumed")).not.toMatch(/agent plan change resumed/);
    expect(describeAction("agent.plan_change_resumed", "Lead Hunter")).toContain("Lead Hunter");
    const c = await draftClient("Activity Feed Dental", "Asia/Manila");
    await recordLaunchSnapshot(c.org.id, { kind: "user", userId: c.people.owner.id });
    expect(await ledgerRows(c.org.id)).toHaveLength(1);
    // The row exists, and the page that lists the client's recent actions leaves it out.
    expect((await getDashboard(c.ctx)).recent.map((r) => r.action)).not.toContain(LAUNCH_LEDGER_ACTION);
  }, 120_000);
});

describe("the industry CRM setup is waited for only once it can start", () => {
  const crmAlerts = (orgId: string) => withSystem((db) => db.query("select 1 from notifications where org_id = $1 and dedupe_key like $2", [orgId, `launch-stalled:${orgId}:crm.blueprint:%`])).then((r) => r.rows);

  it("calls no wait late, and tells the agency nothing, for a client who submitted but has not paid, or who paid but has not submitted", async () => {
    const unpaid = await onboardedClient({ name: "Unpaid Submitted Roofing" });
    const unsubmitted = await createOrg({ name: "Paid Not Submitted Dental" });
    await clearSetupPayment(unsubmitted.id);
    const later = new Date(Date.now() + 3 * 3_600_000);
    for (const orgId of [unpaid.org.id, unsubmitted.id]) {
      const facts = (await loadLaunchFactsForOrg(orgId))!;
      expect(facts.crm.blueprint).toBe("none");
      // Only one of the two things the automatic setup waits for has happened, so the wait has not begun.
      expect(facts.crm.waitingSince).toBeNull();
      const readiness = deriveLaunchReadiness(facts, later, launchStallMinutes());
      expect(itemOf(readiness, "crm.blueprint").stalled).toBeUndefined();
      await recordLaunchSnapshot(orgId, SYSTEM, { now: later });
      expect(await crmAlerts(orgId)).toHaveLength(0);
    }
  }, 180_000);

  it("a client who submitted and paid is still called late after an hour, and the agency is told once", async () => {
    const c = await onboardedClient({ name: "Paid Submitted Roofing" });
    await clearSetupPayment(c.org.id);
    const facts = (await loadLaunchFactsForOrg(c.org.id))!;
    expect(facts.crm.waitingSince).not.toBeNull();
    await recordLaunchSnapshot(c.org.id, SYSTEM, { now: new Date(Date.now() + 3 * 3_600_000) });
    expect((await crmAlerts(c.org.id)).length).toBeGreaterThan(0);
  }, 180_000);
});

describe("the watchdog's notice is claimed as an alert only for the jobs it was about", () => {
  it("counts a queue notice for a request that had waited past the threshold, not for a running job or a younger request", async () => {
    await agencyPeople();
    const a = await submitRealOnboarding({ name: "Watchdog Claim Roofing", clearPayment: true });
    const minutes = launchStallMinutes().provisioning;
    // One role's job is running (claimed) and old; one is still queued and old; the rest are queued and young.
    const roles = AGENT_ROLE_KEYS;
    await withSystem(async (db) => {
      await db.query("update agent_provisioning_jobs set created_at = now() - interval '3 hours' where org_id = $1", [a.org.id]);
      await db.query(
        `update agent_provisioning_jobs set status = 'in_progress', created_at = now() - interval '45 minutes' where org_id = $1
           and agent_instance_id = (select id from agent_instances where org_id = $1 and role_key = $2)`, [a.org.id, roles[1]],
      );
      await db.query(
        `update agent_provisioning_jobs set created_at = now() - interval '5 minutes' where org_id = $1
           and agent_instance_id = (select id from agent_instances where org_id = $1 and role_key = $2)`, [a.org.id, roles[2]],
      );
      // The watchdog's notice, sent about 10 minutes ago (after the old queued jobs had waited past the threshold, before the running job had).
      await notifyAgency(db, a.org.id, { kind: "setup_issue", severity: "warning", title: "AI employee setup is stalled", body: "test", link: `/admin/clients/${a.org.id}`, dedupeKey: `provisioning-stalled:${a.org.id}:2026-10-26` });
      await db.query("update notifications set created_at = now() - interval '10 minutes' where org_id = $1 and dedupe_key like 'provisioning-stalled:%'", [a.org.id]);
    });
    const jobStatus = async (role: string) => (await withSystem((db) => db.query<{ status: string }>(
      "select j.status from agent_provisioning_jobs j join agent_instances a on a.id = j.agent_instance_id where j.org_id = $1 and a.role_key = $2 order by j.created_at desc limit 1", [a.org.id, role],
    ))).rows[0]?.status;
    expect(await jobStatus(roles[0])).toBe("requested");
    expect(await jobStatus(roles[1])).toBe("in_progress");
    expect(minutes).toBeGreaterThan(5);

    const facts = (await loadLaunchFactsForOrg(a.org.id))!;
    const alerted = (role: string) => facts.employees.find((e) => e.role === role)?.stallAlerted;
    // The queued job that was older than the threshold when the notice went out is covered by it.
    expect(alerted(roles[0])).toBe(true);
    // The running job (the watchdog only counts queued requests) and the young request (not yet past the threshold at that time) were not what the notice was about.
    expect(alerted(roles[1])).toBe(false);
    expect(alerted(roles[2])).toBe(false);
  }, 180_000);
});

describe("the events that move a client's launch state each leave a row", () => {
  it("records after the setup fee clears, from inside the clearing transaction and only once it committed", async () => {
    const { superAdmin } = await agencyPeople();
    const c = await submitRealOnboarding({ name: "Paid Later Roofing" });
    expect(await ledgerRows(c.org.id)).toHaveLength(0);
    await waiveSetupFee(superAdmin, c.org.id, { reason: "Founding client, agreed in writing" });
    await settleLaunchSnapshots();
    const rows = await ledgerRows(c.org.id);
    expect(rows).toHaveLength(1);
    // It saw the committed clearing: the state is no longer "questionnaire submitted".
    expect(["provisioning", "action_required"]).toContain(rows[0].metadata.to);
    expect(rows[0].actor_kind).toBe("system");
  }, 180_000);

  it("records after the sweep and after evidence arrives, once for each event, and not when the caller records for itself", async () => {
    const c = await draftClient("Event Dental", "Asia/Manila");
    await sweepLaunchVerificationAfter(c.org.id, "a test event", { record: false });
    expect(await ledgerRows(c.org.id)).toHaveLength(0);
    await sweepLaunchVerificationAfter(c.org.id, "a test event");
    expect(await ledgerRows(c.org.id)).toHaveLength(1);

    const d = await draftClient("Pickup Roofing", "America/Chicago");
    // The pickup records exactly once: it asks the sweep not to, and records after both steps.
    await pickUpSetupEvidence(d.org.id, "a test event");
    expect(await ledgerRows(d.org.id)).toHaveLength(1);
    await pickUpSetupEvidence(d.org.id, "a test event");
    expect(await ledgerRows(d.org.id)).toHaveLength(1);
  }, 180_000);
});
