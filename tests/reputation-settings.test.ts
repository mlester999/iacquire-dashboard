// The reputation settings (what counts as low feedback, how long the team has to acknowledge it, the optional assists) and the permissions around them: who can read them, who
// can change them, that two people cannot overwrite each other, that one workspace never sees or changes another's, and that the database agrees with the permission matrix.
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { agencyActor, startSupportSession } from "@/server/crm/actor";
import { getReputationSettings, loadSettings, saveReputationSettings, thresholdsOf } from "@/server/reputation/settings";
import { AGENCY_TEAM_MANAGED_PERMISSIONS, AGENCY_TEAM_PROTECTED_PERMISSIONS, PERMISSION_MATRIX } from "@/lib/permissions";
import { agencyPeople } from "./support/crm";
import { all, count, one, reputationShop, type ReputationShop } from "./support/reputation";

const expectError = async (p: Promise<unknown>, code: string, message?: RegExp) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  if (message) expect((err as AppError).message).toMatch(message);
};

let a: ReputationShop;
let b: ReputationShop;
beforeAll(async () => {
  a = await reputationShop("Settings Shop");
  b = await reputationShop("Other Settings Shop");
});

describe("reading the settings", () => {
  it("gives the standard settings to a workspace that never saved any, to everyone who can see contacts", async () => {
    for (const who of [a.owner, a.manager, a.sales, a.support, a.viewer]) {
      expect(await getReputationSettings(who)).toMatchObject({ escalateAtOrBelow: 2, acknowledgeWithinHours: 24, slaRemindersEnabled: true, outcomeNudgesEnabled: false, aiRepliesEnabled: false, version: 0, isDefault: true });
    }
    expect(await count("select count(*)::text as n from reputation_settings where org_id = $1", [a.m.org.id])).toBe(0);
    expect(thresholdsOf(await getReputationSettings(a.owner))).toEqual({ escalateAtOrBelow: 2, npsDetractorMax: 6 });
  });
});

describe("changing the settings", () => {
  it("lets the client's owner and manager change them, and nobody else", async () => {
    const s = await reputationShop("Who Shop");
    for (const who of [s.sales, s.support, s.viewer]) await expectError(saveReputationSettings(who, { escalateAtOrBelow: 3 }, 0), "forbidden", /owners and managers/);
    const first = await saveReputationSettings(s.manager, { escalateAtOrBelow: 3, acknowledgeWithinHours: 8 }, 0);
    expect(first).toMatchObject({ escalateAtOrBelow: 3, acknowledgeWithinHours: 8, version: 1, isDefault: false });
    const second = await saveReputationSettings(s.owner, { outcomeNudgesEnabled: true }, 1);
    expect(second).toMatchObject({ escalateAtOrBelow: 3, acknowledgeWithinHours: 8, outcomeNudgesEnabled: true, version: 2 });
    expect(await one("select updated_by, version from reputation_settings where org_id = $1", [s.m.org.id])).toEqual({ updated_by: s.m.people.owner.id, version: 2 });
    const audits = await all<{ metadata: Record<string, unknown>; actor_user_id: string }>("select metadata, actor_user_id from audit_logs where org_id = $1 and action = 'reputation.settings_saved' order by id", [s.m.org.id]);
    expect(audits.map((x) => x.actor_user_id)).toEqual([s.m.people.manager.id, s.m.people.owner.id]);
    expect(audits[1].metadata).toMatchObject({ escalateAtOrBelow: 3, acknowledgeWithinHours: 8, outcomeNudgesEnabled: true });
  });

  it("turns away an iAcquire support session, even a writing one: these settings are the client's own", async () => {
    const s = await reputationShop("Support Settings Shop");
    const { superAdmin } = await agencyPeople();
    await startSupportSession(superAdmin, s.m.org.id, { mode: "write", reason: "Checking the review settings" });
    const agency = await agencyActor(superAdmin, s.m.org.id);
    expect((await getReputationSettings(agency)).isDefault).toBe(true);
    await expectError(saveReputationSettings(agency, { escalateAtOrBelow: 3 }, 0), "forbidden", /client's own workspace/);
    expect(await count("select count(*)::text as n from reputation_settings where org_id = $1", [s.m.org.id])).toBe(0);
  });

  it("refuses values outside the ranges and fields it does not list, with a plain reason, and changes nothing", async () => {
    const s = await reputationShop("Range Shop");
    await expectError(saveReputationSettings(s.owner, { escalateAtOrBelow: 4 }, 0), "invalid_input", /can't be higher than 3/);
    await expectError(saveReputationSettings(s.owner, { escalateAtOrBelow: 0 }, 0), "invalid_input", /can't be lower than 1/);
    await expectError(saveReputationSettings(s.owner, { acknowledgeWithinHours: 169 }, 0), "invalid_input", /can't be higher than 168/);
    await expectError(saveReputationSettings(s.owner, { acknowledgeWithinHours: 1.5 }, 0), "invalid_input", /whole number/);
    await expectError(saveReputationSettings(s.owner, { npsDetractorMax: 9 }, 0), "invalid_input");
    await expectError(saveReputationSettings(s.owner, { replyStyleNote: "x".repeat(601) }, 0), "invalid_input", /600 characters/);
    await expectError(saveReputationSettings(s.owner, { version: 99 }, 0), "invalid_input");
    await expectError(saveReputationSettings(s.owner, { org_id: b.m.org.id }, 0), "invalid_input");
    await expectError(saveReputationSettings(s.owner, "nope", 0), "invalid_input");
    await expectError(saveReputationSettings(s.owner, {}, -1), "invalid_input");
    expect(await count("select count(*)::text as n from reputation_settings where org_id = $1", [s.m.org.id])).toBe(0);
  });

  it("stores a tidy style note, clears it with null, and keeps an unchanged save from changing anything but the version", async () => {
    const s = await reputationShop("Note Shop");
    expect((await saveReputationSettings(s.owner, { replyStyleNote: "  Warm,\n short and plain.  " }, 0)).replyStyleNote).toBe("Warm, short and plain.");
    expect((await saveReputationSettings(s.owner, { replyStyleNote: null }, 1)).replyStyleNote).toBeNull();
    const same = await saveReputationSettings(s.owner, {}, 2);
    expect(same).toMatchObject({ escalateAtOrBelow: 2, aiRepliesEnabled: false, version: 3 });
  });

  it("never lets two people overwrite each other: a save made on stale settings is refused and the newer values survive", async () => {
    const s = await reputationShop("Race Settings Shop");
    await saveReputationSettings(s.owner, { escalateAtOrBelow: 1 }, 0);
    await expectError(saveReputationSettings(s.manager, { escalateAtOrBelow: 3 }, 0), "conflict", /Someone else changed these settings/);
    expect((await loadSettingsFor(s)).escalateAtOrBelow).toBe(1);
    // Two saves that start from the same version together: exactly one wins.
    const results = await Promise.allSettled([saveReputationSettings(s.owner, { acknowledgeWithinHours: 2 }, 1), saveReputationSettings(s.manager, { acknowledgeWithinHours: 72 }, 1)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await loadSettingsFor(s)).version).toBe(2);
  });

  it("keeps each workspace's settings to itself", async () => {
    const s = await reputationShop("Isolated Settings Shop");
    await saveReputationSettings(s.owner, { escalateAtOrBelow: 3 }, 0);
    expect((await getReputationSettings(b.owner)).isDefault).toBe(true);
    // Another workspace's owner cannot reach it through the database either: row-level security shows them none of it.
    const seen = await withUser(b.m.people.owner.id, (db) => db.query("select org_id from reputation_settings"));
    expect(seen.rows.map((r) => (r as { org_id: string }).org_id)).not.toContain(s.m.org.id);
    const mine = await withUser(s.m.people.owner.id, (db) => db.query("select org_id, escalate_at_or_below from reputation_settings where org_id = $1", [s.m.org.id]));
    expect(mine.rows).toEqual([{ org_id: s.m.org.id, escalate_at_or_below: 3 }]);
    // Reading is all the application role can do with the table: every change goes through the checked service.
    await expect(withUser(s.m.people.owner.id, (db) => db.query("update reputation_settings set escalate_at_or_below = 1 where org_id = $1", [s.m.org.id]))).rejects.toThrow();
    await expect(withUser(s.m.people.owner.id, (db) => db.query("insert into reputation_settings (org_id) values ($1)", [b.m.org.id]))).rejects.toThrow();
    expect((await loadSettingsFor(s)).escalateAtOrBelow).toBe(3);
  });
});

async function loadSettingsFor(s: ReputationShop) {
  return withSystem((db) => loadSettings(db, s.m.org.id));
}

describe("the permissions", () => {
  const NEW = ["reviews.view", "reviews.respond", "reviews.reply_publish"] as const;

  it("gives the matrix the roles the design names: everyone who reads contacts views, writers draft, only the client's owner and manager approve and post, and the agency never does", () => {
    expect([...PERMISSION_MATRIX["reviews.view"]].sort()).toEqual(["admin", "agency_manager", "agency_staff", "appointment_setter", "member", "owner", "sales_rep", "support", "viewer"].sort());
    expect([...PERMISSION_MATRIX["reviews.respond"]].sort()).toEqual(["admin", "agency_manager", "agency_super_admin", "member", "owner", "sales_rep", "support"].sort());
    expect([...PERMISSION_MATRIX["reviews.reply_publish"]].sort()).toEqual(["admin", "owner"]);
    for (const role of PERMISSION_MATRIX["reviews.reply_publish"]) expect(role.startsWith("agency")).toBe(false);
    // Everyone who may view reviews can view contacts, so a person never sees feedback on a customer they cannot open.
    for (const role of PERMISSION_MATRIX["reviews.view"]) expect(PERMISSION_MATRIX["contacts.view"], role).toContain(role);
  });

  it("is the same in the database, role for role", async () => {
    for (const permission of NEW) {
      const inDb = (await all<{ role: string }>("select role from role_permissions where permission = $1", [permission])).map((r) => r.role).sort();
      expect(inDb, permission).toEqual([...PERMISSION_MATRIX[permission]].sort());
    }
  });

  it("is listed with the agency team's protected permissions (a Super Admin cannot hand them out one by one)", () => {
    for (const permission of NEW) {
      expect(AGENCY_TEAM_PROTECTED_PERMISSIONS as readonly string[], permission).toContain(permission);
      expect(AGENCY_TEAM_MANAGED_PERMISSIONS as readonly string[], permission).not.toContain(permission);
    }
  });
});
