// Launch notices are new, so a client that was already using the product must never receive one it did not expect. They are OFF unless somebody switches them on: the deployment switch
// (LAUNCH_NOTIFICATIONS_ENABLED, off by default) or a workspace's own setting (the launch_notifications feature), and the workspace's own setting wins either way. Only the notices are
// held back: the record in the audit trail is written regardless. Synthetic workspaces; nothing is sent, booked or contacted.
import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { env, resetEnvCache } from "@/server/env";
import { createAppointmentType, createCalendar, setHostAvailability } from "@/server/calendars/setup";
import { activateCalendar } from "@/server/calendars/activation";
import { LAUNCH_LEDGER_ACTION, recordLaunchSnapshot } from "@/server/setup/launch-ledger";
import { LAUNCH_NOTIFICATIONS_FEATURE, launchNotificationsOn } from "@/server/setup/launch-notifications";
import { crmOrg, type CrmOrg } from "./support/crm";
import { draftClient } from "./support/launch";

const SYSTEM = { kind: "system" } as const;
const OWNER_KINDS = ["setup_action_required", "setup_ready", "setup_issue"];

const deployment = (on: boolean) => {
  vi.stubEnv("LAUNCH_NOTIFICATIONS_ENABLED", on ? "true" : "false");
  resetEnvCache();
};
const workspace = (orgId: string, enabled: boolean) =>
  withSystem((db) => db.query("insert into org_features (org_id, feature, enabled) values ($1, $2, $3) on conflict (org_id, feature) do update set enabled = $3", [orgId, LAUNCH_NOTIFICATIONS_FEATURE, enabled]));
const ledgerRows = async (orgId: string) => (await withSystem((db) => db.query("select 1 from audit_logs where org_id = $1 and action = $2", [orgId, LAUNCH_LEDGER_ACTION]))).rows.length;
const ownerNotices = async (orgId: string) => (await withSystem((db) => db.query("select 1 from notifications where org_id = $1 and kind = any($2::text[])", [orgId, OWNER_KINDS]))).rows.length;
const driftNotices = async (orgId: string) => (await withSystem((db) => db.query("select 1 from notifications where org_id = $1 and dedupe_key like 'calendar-drift:%'", [orgId]))).rows.length;
const audits = async (orgId: string, action: string) => (await withSystem((db) => db.query("select 1 from audit_logs where org_id = $1 and action = $2", [orgId, action]))).rows.length;

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("launch notices are off unless somebody switches them on", () => {
  it("are off in the schema's default and for every workspace that has no setting of its own", async () => {
    vi.unstubAllEnvs();
    resetEnvCache();
    expect(env().LAUNCH_NOTIFICATIONS_ENABLED).toBe(false);
    const c = await draftClient("Default Off Dental", "Asia/Manila");
    expect(await withSystem((db) => launchNotificationsOn(c.org.id, db))).toBe(false);
  }, 120_000);

  it("with the default, the ledger still records the change and nobody is told", async () => {
    deployment(false);
    const c = await draftClient("Quiet Ledger Roofing", "America/Chicago");
    expect(await recordLaunchSnapshot(c.org.id, SYSTEM)).toMatchObject({ recorded: true, state: "action_required" });
    expect(await ledgerRows(c.org.id)).toBe(1);
    expect(await ownerNotices(c.org.id)).toBe(0);
  }, 120_000);

  it("with the deployment switch on, the owner is told once", async () => {
    deployment(true);
    const c = await draftClient("Told Ledger Roofing", "America/Chicago");
    await recordLaunchSnapshot(c.org.id, SYSTEM);
    expect(await ownerNotices(c.org.id)).toBe(1);
    await recordLaunchSnapshot(c.org.id, SYSTEM);
    expect(await ownerNotices(c.org.id)).toBe(1);
  }, 120_000);

  it("a workspace's own setting wins: on with the deployment off tells that workspace and no other, off with the deployment on tells nobody", async () => {
    deployment(false);
    const chosen = await draftClient("Chosen Dental", "Asia/Manila");
    const other = await draftClient("Other Dental", "Asia/Manila");
    await workspace(chosen.org.id, true);
    await recordLaunchSnapshot(chosen.org.id, SYSTEM);
    await recordLaunchSnapshot(other.org.id, SYSTEM);
    expect(await ownerNotices(chosen.org.id)).toBe(1);
    expect(await ownerNotices(other.org.id)).toBe(0);
    expect(await ledgerRows(other.org.id)).toBe(1);

    deployment(true);
    const muted = await draftClient("Muted Dental", "Asia/Manila");
    await workspace(muted.org.id, false);
    await recordLaunchSnapshot(muted.org.id, SYSTEM);
    expect(await ownerNotices(muted.org.id)).toBe(0);
    expect(await ledgerRows(muted.org.id)).toBe(1);
  }, 180_000);
});

const WEEKDAYS_9_TO_5 = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));
const ZONE = "America/Chicago";

async function verifiedCalendar(c: CrmOrg) {
  const owner = c.actor("owner");
  await setHostAvailability(owner, c.people.owner.id, { timezone: ZONE, rules: WEEKDAYS_9_TO_5 });
  const cal = await createCalendar(owner, { name: `Visits ${crypto.randomBytes(2).toString("hex")}`, assignment: "single", members: [{ userId: c.people.owner.id }] });
  await createAppointmentType(owner, cal.id, { name: "Site visit", durationMinutes: 60, minNoticeMinutes: 60, maxDaysAhead: 30 });
  await withSystem((db) => db.query("update crm_calendars set status = 'draft', public = false, is_default = false where id = $1", [cal.id]));
  expect((await activateCalendar(owner, cal.id)).activated).toBe(true);
  return cal.id;
}

describe("a calendar that stops passing its checks", () => {
  it("is recorded and audited either way, and its owners and admins are told only where launch notices are on", async () => {
    deployment(false);
    const quiet = await crmOrg({ timezone: ZONE });
    await verifiedCalendar(quiet);
    await setHostAvailability(quiet.actor("owner"), quiet.people.owner.id, { timezone: ZONE, rules: [] });
    expect(await audits(quiet.org.id, "crm.calendar_verification_drifted")).toBe(1);
    expect(await driftNotices(quiet.org.id)).toBe(0);

    const told = await crmOrg({ timezone: ZONE });
    await workspace(told.org.id, true);
    await verifiedCalendar(told);
    await setHostAvailability(told.actor("owner"), told.people.owner.id, { timezone: ZONE, rules: [] });
    expect(await audits(told.org.id, "crm.calendar_verification_drifted")).toBe(1);
    expect(await driftNotices(told.org.id)).toBeGreaterThan(0);
  }, 180_000);
});
