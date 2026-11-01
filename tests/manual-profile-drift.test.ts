// A client employee whose Hermes profile was connected by hand (the agency runbook) has no worker to synchronize it. Connecting records which approved configuration the runbook
// carried, so a later approved edit reads "synchronization pending" instead of leaving the employee Ready on a SOUL that predates the edit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { agentSettingsSchema } from "@/lib/agent-settings";
import { defaultSettings } from "@/server/workforce/compiler";
import { connectHermesProfile, createConfigVersion, runHealthCheck } from "@/server/workforce/service";
import { addMember, agentId, createOrg, createUser } from "./support/fixtures";
import { startMockHermes, type MockHermes } from "./support/mock-hermes";

const KEY = "d".repeat(40);
const PROFILES = ["c-manual-drift-one", "c-manual-drift-two", "agency-manual-drift"];
const q = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => (await withSystem((db) => db.query<T>(text, params))).rows;
const row = async (agent: string) => (await q<{ status: string; last_health_ok: boolean | null; active: string | null; recorded: string | null }>(
  "select status,last_health_ok,active_config_version_id as active,hermes_profile_config_version_id as recorded from agent_instances where id=$1", [agent]))[0];

let mock: MockHermes;
let admin: { id: string };

beforeAll(async () => {
  mock = await startMockHermes(Object.fromEntries(PROFILES.map((name) => [name, { key: KEY }])));
  admin = await createUser({ platformRole: "agency_super_admin" });
});
afterAll(() => mock.close());

async function editApproved(orgId: string, agent: string, userId: string) {
  const current = (await q<{ settings: unknown }>("select v.settings from agent_instances a join agent_config_versions v on v.id=a.active_config_version_id where a.id=$1", [agent]))[0];
  const settings = agentSettingsSchema.parse(current.settings);
  const version = await withSystem((db) => createConfigVersion(db, {
    orgId, agentId: agent, settings: { ...settings, tone: settings.tone === "professional" ? "friendly" : "professional" }, source: "client_edit", actorKind: "user", userId, apply: true,
  }));
  expect(version.status).toBe("applied");
  return version.versionId;
}

describe("a manually connected client profile", () => {
  it("is Ready for the version the runbook carried, then reads 'synchronization pending' after a newer approved edit", async () => {
    const org = await createOrg({ name: "Manual Drift Roofing" });
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    const agent = await agentId(org.id, "crm_manager");
    await withSystem((db) => createConfigVersion(db, { orgId: org.id, agentId: agent, settings: defaultSettings("crm_manager"), source: "onboarding", userId: owner.id, apply: true }));

    await connectHermesProfile({ agentId: agent, baseUrl: mock.url, profile: PROFILES[0], apiKey: KEY, agencyUserId: admin.id });
    const connected = await row(agent);
    // The version the agency attested is recorded, so there is something to compare a later approval against.
    expect(connected.recorded).not.toBeNull();
    expect(connected.recorded).toBe(connected.active);
    const first = await runHealthCheck(agent, { userId: admin.id, kind: "agency" });
    expect(first).toMatchObject({ ok: true, status: "online" });

    const newer = await editApproved(org.id, agent, owner.id);
    const pending = await row(agent);
    expect(pending).toMatchObject({ status: "provisioning", last_health_ok: null, active: newer });
    expect(pending.recorded).not.toBe(newer);
    // No worker job is created for a profile the worker did not build.
    expect(await q("select 1 from agent_provisioning_jobs where agent_instance_id=$1 and kind='sync'", [agent])).toEqual([]);

    const before = mock.requests.length;
    const stale = await runHealthCheck(agent, { userId: admin.id, kind: "agency" });
    expect(stale).toMatchObject({ ok: false, status: "setup_required" });
    expect(stale.detail).toMatch(/not been synchronized/i);
    // The check stops before it asks Hermes anything, so it cannot report Ready on the old SOUL.
    expect(mock.requests.length).toBe(before);
    expect((await row(agent)).status).toBe("setup_required");

    // Re-running the runbook and connecting again records the newer version, and the check passes.
    await connectHermesProfile({ agentId: agent, baseUrl: mock.url, profile: PROFILES[0], apiKey: KEY, agencyUserId: admin.id });
    expect((await row(agent)).recorded).toBe(newer);
    expect(await runHealthCheck(agent, { userId: admin.id, kind: "agency" })).toMatchObject({ ok: true, status: "online" });
  });

  it("is tracked per employee: another client's profile and its version are untouched", async () => {
    const a = await createOrg({ name: "Manual Drift A" });
    const b = await createOrg({ name: "Manual Drift B" });
    const ownerA = await createUser();
    const ownerB = await createUser();
    await addMember(a.id, ownerA.id, "owner");
    await addMember(b.id, ownerB.id, "owner");
    const agentA = await agentId(a.id, "crm_manager");
    const agentB = await agentId(b.id, "crm_manager");
    for (const [org, agent, owner] of [[a, agentA, ownerA], [b, agentB, ownerB]] as const) {
      await withSystem((db) => createConfigVersion(db, { orgId: org.id, agentId: agent, settings: defaultSettings("crm_manager"), source: "onboarding", userId: owner.id, apply: true }));
    }
    await connectHermesProfile({ agentId: agentA, baseUrl: mock.url, profile: PROFILES[1], apiKey: KEY, agencyUserId: admin.id });
    const recordedA = (await row(agentA)).recorded;
    expect(recordedA).not.toBeNull();
    // B has no profile yet: nothing is recorded for it, and editing A never reaches B.
    expect((await row(agentB)).recorded).toBeNull();
    await editApproved(a.id, agentA, ownerA.id);
    expect((await row(agentB)).recorded).toBeNull();
    expect((await row(agentA)).recorded).toBe(recordedA);
  });

  it("does not track an internal agency profile, which has its own review path", async () => {
    const agency = await createOrg({ name: "Manual Drift Agency", kind: "agency" });
    const agent = await agentId(agency.id, "crm_manager");
    await withSystem((db) => createConfigVersion(db, { orgId: agency.id, agentId: agent, settings: defaultSettings("crm_manager"), source: "agency", userId: admin.id, apply: true }));
    await connectHermesProfile({ agentId: agent, baseUrl: mock.url, profile: PROFILES[2], apiKey: KEY, agencyUserId: admin.id });
    expect((await row(agent)).recorded).toBeNull();
  });
});
