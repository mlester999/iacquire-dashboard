import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AGENT_ROLES, AGENT_ROLE_KEYS } from "@/lib/agents";
import { workforceChatRefusal } from "@/lib/workforce-chat-guardrail";
import { defaultSettings } from "@/server/workforce/compiler";
import { createConfigVersion, currentSettings, ensureAgentInstances } from "@/server/workforce/service";
import { addMember, agentId, createOrg, createUser } from "./support/fixtures";

// An AI Employee's ROLE is universal (six of them); its DISPLAY NAME belongs to one company. The agency's Operations Manager is called Zeng; another company's may be Alex, a third's Nova.
// Nothing about a name may leak between companies, become a default for a role, or change what the employee is (its id, role, profile, permissions). These tests hold that line on the real
// configuration flow (the same one the Configure screen uses) and on the words the product says in chat.

async function company(name: string, kind: "agency" | "client" = "client") {
  const org = await createOrg({ name: `${name} ${crypto.randomUUID().slice(0, 6)}`, kind });
  const owner = await createUser(kind === "agency" ? { platformRole: "agency_super_admin" } : {});
  await addMember(org.id, owner.id, "owner");
  return { org, owner };
}

async function nameOf(orgId: string, role: string) {
  const { rows } = await withSystem((db) => db.query<{ display_name: string }>("select display_name from agent_instances where org_id = $1 and role_key = $2", [orgId, role]));
  return rows[0].display_name;
}

async function names(orgId: string) {
  const { rows } = await withSystem((db) => db.query<{ role_key: string; display_name: string }>("select role_key, display_name from agent_instances where org_id = $1 order by role_key", [orgId]));
  return Object.fromEntries(rows.map((r) => [r.role_key, r.display_name]));
}

async function operationalIdentity(orgId: string) {
  const { rows } = await withSystem((db) =>
    db.query("select id, org_id, role_key, enabled, status, mode, hermes_base_url, hermes_profile from agent_instances where org_id = $1 order by role_key", [orgId]),
  );
  return rows;
}

async function rename(c: Awaited<ReturnType<typeof company>>, role: "operations_manager" | "lead_hunter" | "sales_assistant", displayName: string, source: "client_edit" | "agency" = "client_edit") {
  const agent = await agentId(c.org.id, role);
  await withSystem((db) =>
    createConfigVersion(db, {
      orgId: c.org.id,
      agentId: agent,
      settings: { ...defaultSettings(role), displayName },
      source,
      actorKind: source === "agency" ? "agency" : "user",
      userId: c.owner.id,
      apply: true,
    }),
  );
}

describe("AI Employee display names belong to one company", () => {
  it("shows the role label until a company chooses a name, and never a name from another company", async () => {
    const fresh = await company("Fresh Co");
    expect(await names(fresh.org.id)).toEqual(Object.fromEntries(AGENT_ROLES.map((r) => [r.key, r.shortName])));
    // The universal role metadata carries no personal name at all.
    for (const role of AGENT_ROLES) {
      expect(Object.keys(role), role.key).not.toContain("alias");
      expect(JSON.stringify(role), role.key).not.toMatch(/Zeng|Alex|Nova/);
    }
    for (const key of AGENT_ROLE_KEYS) expect(defaultSettings(key).displayName).toBe(AGENT_ROLES.find((r) => r.key === key)!.shortName);
  });

  it("keeps the agency's Zeng, a client's Alex and another client's Nova each in its own company", async () => {
    const agency = await company("Agency", "agency");
    const a = await company("Client A");
    const b = await company("Client B");
    await rename(agency, "operations_manager", "Zeng", "agency");
    await rename(a, "operations_manager", "Alex");
    await rename(b, "operations_manager", "Nova");

    expect(await nameOf(agency.org.id, "operations_manager")).toBe("Zeng");
    expect(await nameOf(a.org.id, "operations_manager")).toBe("Alex");
    expect(await nameOf(b.org.id, "operations_manager")).toBe("Nova");
    // Each company reads its own configuration through the same service, and only its own.
    const aOps = await agentId(a.org.id, "operations_manager");
    const bOps = await agentId(b.org.id, "operations_manager");
    expect((await withSystem((db) => currentSettings(db, aOps, a.org.id))).settings.displayName).toBe("Alex");
    expect((await withSystem((db) => currentSettings(db, bOps, b.org.id))).settings.displayName).toBe("Nova");
    // A name never reaches a company that did not choose it.
    for (const org of [a.org.id, b.org.id]) expect(Object.values(await names(org)).join(" ")).not.toContain("Zeng");
    expect(Object.values(await names(a.org.id)).join(" ")).not.toContain("Nova");
    expect(Object.values(await names(b.org.id)).join(" ")).not.toContain("Alex");
    // A company cannot read or change another company's employee through its own organisation id.
    const foreign = await agentId(b.org.id, "operations_manager");
    await expect(withSystem((db) => currentSettings(db, foreign, a.org.id))).rejects.toBeTruthy();
  });

  it("renames one employee without touching the other five, the role, the profile, the permissions or the id", async () => {
    const c = await company("Rename Co");
    const before = await operationalIdentity(c.org.id);
    const namesBefore = await names(c.org.id);
    await rename(c, "lead_hunter", "Maya");
    const after = await operationalIdentity(c.org.id);
    const namesAfter = await names(c.org.id);
    expect(namesAfter.lead_hunter).toBe("Maya");
    for (const role of AGENT_ROLE_KEYS.filter((r) => r !== "lead_hunter")) expect(namesAfter[role], role).toBe(namesBefore[role]);
    // What the employee IS (its stable id, role, runtime profile, switches) is the same row before and after.
    expect(after).toEqual(before);
    expect(new Set(Object.values(namesAfter)).size).toBe(6);
  });

  it("keeps a chosen name through reloads and through provisioning retries", async () => {
    const c = await company("Persist Co");
    await rename(c, "sales_assistant", "Riley");
    await withSystem((db) => ensureAgentInstances(c.org.id, db));
    await withSystem((db) => ensureAgentInstances(c.org.id, db));
    expect(await nameOf(c.org.id, "sales_assistant")).toBe("Riley");
    const agent = await agentId(c.org.id, "sales_assistant");
    expect((await withSystem((db) => currentSettings(db, agent, c.org.id))).settings.displayName).toBe("Riley");
  });
});

describe("what the product says in chat never names an employee the company did not name", () => {
  it("uses the company's own name for its Operations Manager, or the role label, and never Zeng by default", () => {
    const ask = "Assign this task to the Lead Hunter";
    const alex = workforceChatRefusal("operations_manager", ask, "Alex");
    const nova = workforceChatRefusal("operations_manager", ask, "Nova");
    const none = workforceChatRefusal("operations_manager", ask);
    expect(alex?.reason).toBe("unsupported_internal_write");
    expect(alex?.message.startsWith("Alex ")).toBe(true);
    expect(nova?.message.startsWith("Nova ")).toBe(true);
    expect(none?.message.startsWith("The Operations Manager ")).toBe(true);
    for (const r of [alex, nova, none]) expect(r?.message).not.toContain("Zeng");
  });
});
