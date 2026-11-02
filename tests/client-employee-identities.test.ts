// A client's six employees are six distinct identities, and the client's Zeng (the Operations Manager) is a separate employee from iAcquire's own Zeng: the same name, never the same
// employee. Each has its own row, its own runtime profile name, and no way to be mapped onto iAcquire's. An employee that already has a name keeps it. Test database only.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AGENCY_HERMES_PROFILE_IDS, AGENT_BY_KEY, AGENT_ROLE_KEYS, OPERATIONS_MANAGER_PERSONA, defaultEmployeeName } from "@/lib/agents";
import { defaultSettings } from "@/server/workforce/compiler";
import { ensureAgentInstances, isReservedProfile, suggestedProfileName } from "@/server/workforce/service";
import { agentId, createOrg } from "./support/fixtures";

const names = async (orgId: string) => Object.fromEntries((await withSystem((db) => db.query<{ role_key: string; display_name: string }>("select role_key, display_name from agent_instances where org_id = $1", [orgId]))).rows.map((r) => [r.role_key, r.display_name]));

describe("the name each employee starts with", () => {
  it("is Zeng for the Operations Manager and the role's own name for the other five", () => {
    expect(OPERATIONS_MANAGER_PERSONA).toBe("Zeng");
    expect(defaultEmployeeName("operations_manager")).toBe("Zeng");
    for (const role of AGENT_ROLE_KEYS.filter((r) => r !== "operations_manager")) expect(defaultEmployeeName(role)).toBe(AGENT_BY_KEY[role].shortName);
    // The configuration a new employee starts from says the same, so the prompt, the screen and the row agree.
    for (const role of AGENT_ROLE_KEYS) expect(defaultSettings(role).displayName).toBe(defaultEmployeeName(role));
  });

  it("is what a new client workspace gets, and an employee that already has a name keeps it", async () => {
    const org = await createOrg({ name: "Name Check Roofing" });
    const first = await names(org.id);
    expect(first.operations_manager).toBe("Zeng");
    for (const role of AGENT_ROLE_KEYS.filter((r) => r !== "operations_manager")) expect(first[role]).toBe(AGENT_BY_KEY[role].shortName);
    await withSystem((db) => db.query("update agent_instances set display_name = 'Max' where org_id = $1 and role_key = 'operations_manager'", [org.id]));
    await withSystem((db) => ensureAgentInstances(org.id, db));
    expect((await names(org.id)).operations_manager).toBe("Max");
  });
});

describe("a client's Zeng is not iAcquire's Zeng", () => {
  it("two clients each have a Zeng that is their own employee with their own runtime profile name", async () => {
    const a = await createOrg({ name: "Zeng Client Alpha" });
    const b = await createOrg({ name: "Zeng Client Beta" });
    const zengA = await agentId(a.id, "operations_manager");
    const zengB = await agentId(b.id, "operations_manager");
    expect((await names(a.id)).operations_manager).toBe("Zeng");
    expect((await names(b.id)).operations_manager).toBe("Zeng");
    expect(zengA).not.toBe(zengB);
    const profileA = suggestedProfileName(a.slug, "operations_manager");
    const profileB = suggestedProfileName(b.slug, "operations_manager");
    expect(profileA).not.toBe(profileB);
    for (const profile of [profileA, profileB]) {
      expect(profile).toMatch(/^c-/);
      expect(profile).not.toBe(AGENCY_HERMES_PROFILE_IDS.operations_manager);
      expect(isReservedProfile(profile)).toBe(false);
    }
    // Six distinct identities in each workspace: six rows, six profile names, none repeated.
    for (const org of [a, b]) {
      const profiles = AGENT_ROLE_KEYS.map((role) => suggestedProfileName(org.slug, role));
      expect(new Set(profiles).size).toBe(6);
      expect(profiles.every((p) => p.startsWith("c-") && p.length <= 63)).toBe(true);
      expect((await withSystem((db) => db.query("select 1 from agent_instances where org_id = $1", [org.id]))).rows).toHaveLength(6);
    }
  });

  it("cannot be mapped onto iAcquire's own profile: the database refuses it, whatever the name", async () => {
    const org = await createOrg({ name: "Zeng Mapping Client" });
    const zeng = await agentId(org.id, "operations_manager");
    await expect(withSystem((db) => db.query("update agent_instances set hermes_profile = $2 where id = $1", [zeng, AGENCY_HERMES_PROFILE_IDS.operations_manager]))).rejects.toThrow(/reserved_hermes_profile/);
    await expect(withSystem((db) => db.query("update agent_instances set hermes_profile = 'iacquire-zeng' where id = $1", [zeng]))).rejects.toThrow(/reserved_hermes_profile/);
    expect(isReservedProfile("iacquire-zeng")).toBe(true);
  });
});
