// The launch watch: the clock-driven half of the launch ledger. It must notice a wait that went on too long (once, and only for the client it belongs to), a step back from 100%, and a
// calendar that broke on the provider's side without anybody editing anything; it must start the one read-only check an employee is due, skip every workspace that is not a paying,
// active client, and send nothing to a customer. Test database only; nothing is sent, booked or contacted.
import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { launchNoticesOn } from "./support/launch-notifications";
import { withSystem } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { createAppointmentType, createCalendar, setHostAvailability } from "@/server/calendars/setup";
import { activateCalendar } from "@/server/calendars/activation";
import { LAUNCH_LEDGER_ACTION, readLaunchCurrent } from "@/server/setup/launch-ledger";
import { runLaunchWatch } from "@/server/setup/launch-watch";
import { createOrg } from "./support/fixtures";
import { agencyPeople, crmOrg } from "./support/crm";
import { clearSetupPayment, onboardedClient } from "./support/billing";
import { checkJobs, draftClient, readyClient, settled, WEEKDAYS } from "./support/launch";

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000);

const ledgerRows = async (orgId: string) => (await withSystem((db) => db.query<{ id: string; metadata: { to: string; from: string | null } }>(
  "select id, metadata from audit_logs where org_id = $1 and action = $2 order by id", [orgId, LAUNCH_LEDGER_ACTION],
))).rows;
/** Looks again, a few times, until the watch has recorded the client as ready: a finished check is read back from the records a moment after its job closes. */
async function untilReady(orgId: string) {
  for (let i = 0; i < 12; i += 1) {
    await runLaunchWatch();
    if ((await readLaunchCurrent([orgId])).get(orgId)?.state === "ready_to_launch") return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}
/** The agency notices about a long wait for one workspace, by the key the ledger gives them. */
const stallNotices = async (orgId: string) => (await withSystem((db) => db.query<{ user_id: string; dedupe_key: string; org_id: string }>(
  "select user_id, dedupe_key, org_id from notifications where org_id = $1 and dedupe_key like 'launch-stalled:%' order by id", [orgId],
))).rows;
const ownerNotices = async (orgId: string, kind: string) => (await withSystem((db) => db.query<{ user_id: string }>("select user_id from notifications where org_id = $1 and kind = $2", [orgId, kind]))).rows;

// These tests are about the notices the watch sends (and the one it deliberately does not), so the deployment switch for launch notices is on (it is off by default; see tests/launch-notifications.test.ts).
beforeAll(launchNoticesOn);

describe("a wait that went on too long is told to iAcquire once", () => {
  it("sends one agency notice per stalled item, none on the next pass, and never to or about another client", async () => {
    await agencyPeople();
    const a = await draftClient("Watch Stalled Roofing", "America/Chicago");
    const b = await draftClient("Watch Young Dental", "Asia/Manila");
    const later = hoursFromNow(3);
    // B's wait began ten minutes before the clock the watch is given; A's began three hours before it.
    await withSystem(async (db) => {
      await db.query("update organizations set onboarding_completed_at = $2 where id = $1", [b.org.id, new Date(later.getTime() - 10 * 60_000)]);
      await db.query("update billing_accounts set waived_at = $2 where org_id = $1", [b.org.id, new Date(later.getTime() - 10 * 60_000)]);
    });

    const first = await runLaunchWatch({ now: later });
    expect(first.examined).toBe(2);
    expect(first.failed).toBe(0);
    const told = await stallNotices(a.org.id);
    expect(told.length).toBeGreaterThan(0);
    expect(told.every((n) => n.org_id === a.org.id && n.dedupe_key.startsWith(`launch-stalled:${a.org.id}:`))).toBe(true);
    // Only agency accounts are told, and nobody in the client's own workspace.
    const people = await withSystem((db) => db.query<{ platform_role: string }>("select platform_role from users where id = any($1::uuid[])", [[...new Set(told.map((n) => n.user_id))]]));
    expect(people.rows.length).toBeGreaterThan(0);
    expect(people.rows.every((u) => u.platform_role.startsWith("agency_"))).toBe(true);
    // The other client's wait is young: no notice for it, and nothing about A anywhere in B's notices.
    expect(await stallNotices(b.org.id)).toHaveLength(0);
    expect((await withSystem((db) => db.query("select 1 from notifications where org_id = $1 and (dedupe_key like $2 or body like $2)", [b.org.id, `%${a.org.id}%`]))).rows).toHaveLength(0);
    expect(await ledgerRows(a.org.id)).toHaveLength(1);

    // A second pass at the same moment: the same notices, no new row.
    const second = await runLaunchWatch({ now: later });
    expect(second.examined).toBe(2);
    expect(second.recorded).toBe(0);
    expect((await stallNotices(a.org.id)).map((n) => n.dedupe_key)).toEqual(told.map((n) => n.dedupe_key));
    expect(await stallNotices(b.org.id)).toHaveLength(0);
    expect(await ledgerRows(a.org.id)).toHaveLength(1);
  }, 180_000);

  it("says nothing about a client that is waiting only a little, however many times it looks", async () => {
    const c = await draftClient("Watch Quiet Roofing", "America/Chicago");
    for (let i = 0; i < 2; i += 1) await runLaunchWatch();
    expect(await stallNotices(c.org.id)).toHaveLength(0);
    // It still remembered the state (one row), because the first pass is a real change.
    expect(await ledgerRows(c.org.id)).toHaveLength(1);
  }, 120_000);
});

describe("a client that was live before the watch existed", () => {
  it("gets a silent first row: the ledger starts there and the owners are told only about what changes afterwards", async () => {
    const c = await draftClient("Watch Legacy Roofing", "America/Chicago");
    expect(await ledgerRows(c.org.id)).toHaveLength(0);

    await runLaunchWatch();
    const [first] = await ledgerRows(c.org.id);
    expect(first.metadata).toMatchObject({ from: null, to: "action_required" });
    // The state needs the owner, which a real transition would tell them; the baseline does not.
    expect(await ownerNotices(c.org.id, "setup_action_required")).toHaveLength(0);
    expect(await ownerNotices(c.org.id, "setup_ready")).toHaveLength(0);

    // What happens from there is told as usual: stepping back from a seeded 100% row notifies once.
    await recordAudit({
      orgId: c.org.id, actorKind: "system", action: LAUNCH_LEDGER_ACTION, targetType: "organization", targetId: c.org.id, result: "success",
      metadata: { from: "action_required", to: "ready_to_launch", percent: 100, passed: 5, total: 5, fingerprint: "seeded-ready-state", needsYou: 0, needsIacquire: 0, topBlocker: null, changed: [], items: {} },
    });
    await runLaunchWatch();
    expect(await ownerNotices(c.org.id, "setup_issue")).toHaveLength(1);
  }, 180_000);
});

describe("who the watch looks at", () => {
  it("skips a sample workspace, a suspended one, one that has not paid, one that has not submitted and the agency's own, and records nothing for them", async () => {
    const eligible = await draftClient("Watch Eligible Dental", "Asia/Manila");
    const demo = await draftClient("Watch Sample Roofing", "UTC");
    await withSystem((db) => db.query("update organizations set is_demo = true where id = $1", [demo.org.id]));
    const suspended = await draftClient("Watch Suspended Roofing", "UTC");
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [suspended.org.id]));
    const unpaid = await onboardedClient({ name: "Watch Unpaid Dental" });
    // A refunded fee keeps its paid date but is no longer cleared; a cleared status with no date on it is still cleared. The one payment gate decides, not the dates.
    const refunded = await draftClient("Watch Refunded Dental", "Asia/Manila");
    await withSystem((db) => db.query("update billing_accounts set setup_payment_status = 'refunded' where org_id = $1", [refunded.org.id]));
    const noDate = await draftClient("Watch Undated Waiver Dental", "Asia/Manila");
    await withSystem((db) => db.query("update billing_accounts set waived_at = null where org_id = $1", [noDate.org.id]));
    const unsubmitted = await createOrg({ name: "Watch Unsubmitted Co" });
    await clearSetupPayment(unsubmitted.id);
    const agency = await createOrg({ name: "Watch Agency", kind: "agency" });
    await clearSetupPayment(agency.id);

    const result = await runLaunchWatch({ now: hoursFromNow(3) });
    // Exactly the clients that qualify: the two of the first test, the quiet one of the second, the legacy one, this test's eligible one and the undated waiver (this file's database
    // holds no others), and none of the rest.
    expect(result.examined).toBe(6);
    expect(await ledgerRows(eligible.org.id)).toHaveLength(1);
    expect(await ledgerRows(noDate.org.id)).toHaveLength(1);
    for (const orgId of [demo.org.id, suspended.org.id, unpaid.org.id, unsubmitted.id, agency.id, refunded.org.id]) {
      expect(await ledgerRows(orgId), orgId).toHaveLength(0);
      expect(await stallNotices(orgId), orgId).toHaveLength(0);
    }
  }, 240_000);

  it("stops at its client limit and reaches every client over several passes, because the order rotates with the clock", async () => {
    const clients = [await draftClient("Rotate One Roofing", "UTC"), await draftClient("Rotate Two Dental", "UTC"), await draftClient("Rotate Three Dental", "UTC")];
    const ids = clients.map((c) => c.org.id);
    const reached = async () => (await readLaunchCurrent(ids)).size;
    const start = Date.now();
    let passes = 0;
    while ((await reached()) < ids.length && passes < 60) {
      const r = await runLaunchWatch({ maxClients: 1, now: new Date(start + passes * 10 * 60_000) });
      expect(r.examined).toBe(1);
      expect(r.cutOff).toBe(true);
      passes += 1;
    }
    expect(await reached()).toBe(ids.length);
    // A pass with no time left examines nobody and says it was cut off.
    const none = await runLaunchWatch({ budgetMs: -1 });
    expect(none).toMatchObject({ examined: 0, cutOff: true });
  }, 300_000);
});

describe("a step back from 100% is noticed without anybody editing anything the watch can see", () => {
  /** What a client that reached 100% left in the ledger: the row the watch compares the client's state with. */
  const reachedReady = (orgId: string) => recordAudit({
    orgId, actorKind: "system", action: LAUNCH_LEDGER_ACTION, targetType: "organization", targetId: orgId, result: "success",
    metadata: { from: null, to: "ready_to_launch", percent: 100, passed: 5, total: 5, fingerprint: "seeded-ready-state", needsYou: 0, needsIacquire: 0, topBlocker: null, changed: [], items: {} },
  });

  it("records the step back, counts it, tells the owner once, and a repeat adds nothing", async () => {
    const c = await draftClient("Watch Regression Dental", "Asia/Manila");
    const bystander = await draftClient("Watch Bystander Dental", "Asia/Manila");
    await reachedReady(c.org.id);
    expect((await readLaunchCurrent([c.org.id])).get(c.org.id)?.state).toBe("ready_to_launch");

    // The client is at 100% by the ledger and is not by its records (it has no host, no hours): a client at 100% is still looked at, and the step back is recorded and told once.
    const back = await runLaunchWatch();
    expect(back.regressions).toBe(1);
    expect((await ledgerRows(c.org.id)).at(-1)?.metadata).toMatchObject({ from: "ready_to_launch", to: "action_required" });
    expect((await readLaunchCurrent([c.org.id])).get(c.org.id)?.state).toBe("action_required");
    expect(await ownerNotices(c.org.id, "setup_issue")).toHaveLength(1);
    // Nobody else was told: the other client was never at 100%.
    expect(await ownerNotices(bystander.org.id, "setup_issue")).toHaveLength(0);

    const again = await runLaunchWatch();
    expect(again.regressions).toBe(0);
    expect(await ownerNotices(c.org.id, "setup_issue")).toHaveLength(1);
    expect(await ledgerRows(c.org.id)).toHaveLength(2);
  }, 180_000);

  it("starts the one final check each ready employee is due, once, and records the client as ready when they pass", async () => {
    const c = await readyClient({ name: "Watch Sweep Roofing", timezone: "Asia/Manila" });
    const first = await runLaunchWatch();
    expect(first.checksQueued).toBe(6);
    await settled(c.org.id, 6);
    const second = await runLaunchWatch();
    expect(second.checksQueued).toBe(0);
    expect(await checkJobs(c.org.id)).toBe(6);
    // With every check passed the watch itself records the client as ready, with nobody pressing anything.
    expect(await untilReady(c.org.id)).toBe(true);
    expect((await readLaunchCurrent([c.org.id])).get(c.org.id)).toMatchObject({ state: "ready_to_launch", percent: 100 });
    expect(await ownerNotices(c.org.id, "setup_ready")).toHaveLength(1);
  }, 300_000);
});

describe("a calendar that breaks on the provider's side is noticed by the pass", () => {
  it("records the break once when a connection goes into an error state and the recovery when it clears, and touches no other workspace", async () => {
    const c = await crmOrg({ timezone: "America/Chicago" });
    const other = await crmOrg({ timezone: "America/Chicago" });
    for (const w of [c, other]) {
      await withSystem((db) => db.query("update organizations set onboarding_completed_at = now() where id = $1", [w.org.id]));
      await clearSetupPayment(w.org.id);
    }
    const connection = async (w: typeof c) => (await withSystem((db) => db.query<{ id: string }>(
      "insert into crm_calendar_connections (org_id, user_id, provider, account_label, status, write_events, external_calendar_id) values ($1, $2, 'google', $3, 'connected', true, 'primary') returning id",
      [w.org.id, w.people.owner.id, `owner-${crypto.randomBytes(3).toString("hex")}@example.test`],
    ))).rows[0].id;
    const verified = async (w: typeof c) => {
      await setHostAvailability(w.actor("owner"), w.people.owner.id, { timezone: "America/Chicago", rules: WEEKDAYS });
      const cal = await createCalendar(w.actor("owner"), { name: "Visits", members: [{ userId: w.people.owner.id }] });
      await createAppointmentType(w.actor("owner"), cal.id, { name: "Video call", durationMinutes: 30, minNoticeMinutes: 60, maxDaysAhead: 30, locationKind: "video", meetingProvider: "google_meet" });
      await withSystem((db) => db.query("update crm_calendars set status = 'draft', public = false, is_default = false where id = $1", [cal.id]));
      const done = await activateCalendar(w.actor("owner"), cal.id);
      expect(done.activated).toBe(true);
      return cal.id;
    };
    const connectionId = await connection(c);
    await connection(other);
    const calendarId = await verified(c);
    const otherCalendar = await verified(other);
    const drift = async (id: string) => (await withSystem((db) => db.query<{ verification: { drift?: { failing: string[]; reason: string } } }>("select verification from crm_calendars where id = $1", [id]))).rows[0].verification.drift;
    const audits = async (orgId: string, action: string) => (await withSystem((db) => db.query("select 1 from audit_logs where org_id = $1 and action = $2", [orgId, action]))).rows.length;
    const notices = async (orgId: string) => (await withSystem((db) => db.query("select 1 from notifications where org_id = $1 and dedupe_key like 'calendar-drift:%'", [orgId]))).rows.length;

    // Healthy: the pass checks the calendar and finds nothing to say.
    expect((await runLaunchWatch()).calendarChanges).toBe(0);
    expect(await drift(calendarId)).toBeUndefined();

    // The provider side breaks: the connection's status becomes 'error' with no write path involved (markNeedsReauth is not what ran).
    await withSystem((db) => db.query("update crm_calendar_connections set status = 'error' where id = $1", [connectionId]));
    expect(await drift(calendarId)).toBeUndefined();
    const broken = await runLaunchWatch();
    expect(broken.calendarChanges).toBe(1);
    expect(await drift(calendarId)).toMatchObject({ failing: ["connections"], reason: "watch" });
    expect(await audits(c.org.id, "crm.calendar_verification_drifted")).toBe(1);
    expect(await notices(c.org.id)).toBeGreaterThan(0);
    const noticesAfterBreak = await notices(c.org.id);
    // Another pass says nothing more, and the other workspace is untouched.
    expect((await runLaunchWatch()).calendarChanges).toBe(0);
    expect(await audits(c.org.id, "crm.calendar_verification_drifted")).toBe(1);
    expect(await notices(c.org.id)).toBe(noticesAfterBreak);
    expect(await drift(otherCalendar)).toBeUndefined();
    expect(await audits(other.org.id, "crm.calendar_verification_drifted")).toBe(0);
    // The break is not a change to the calendar: it is still active, and the pass changed nobody's bookings or settings.
    expect((await withSystem((db) => db.query<{ status: string }>("select status from crm_calendars where id = $1", [calendarId]))).rows[0].status).toBe("active");

    // The connection works again: the next pass records the recovery once.
    await withSystem((db) => db.query("update crm_calendar_connections set status = 'connected' where id = $1", [connectionId]));
    expect((await runLaunchWatch()).calendarChanges).toBe(1);
    expect(await drift(calendarId)).toBeUndefined();
    expect(await audits(c.org.id, "crm.calendar_verification_recovered")).toBe(1);
  }, 300_000);
});

describe("with nothing to look at", () => {
  it("does nothing, and fails nothing, when there is no client to look at", async () => {
    await withSystem((db) => db.query("update organizations set status = 'suspended' where kind = 'client'"));
    expect(await runLaunchWatch()).toEqual({ examined: 0, checksQueued: 0, recorded: 0, regressions: 0, calendarChanges: 0, failed: 0, cutOff: false });
  });
});
