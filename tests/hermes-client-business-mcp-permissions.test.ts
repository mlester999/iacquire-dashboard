// The people boundary of the client tier: every read is made for the person whose Chat turn it is, so it can never show them more than their own role and per-person overrides allow.
// The employee's scope is only half the rule; the person's own permissions, and the inbox's own row visibility, are the other half. Synthetic workspace; the tools run through the real handler.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import {
  auditRows, callBody, clientSideEffects, endClientTurns, postClient, provisionedClient, refused, setClientTier, startClientTurn, toolJson, toolText, withoutAudit, type ClientTenant,
} from "./support/client-business-mcp";

let a: ClientTenant;

type Who = keyof ClientTenant["crm"]["people"];

/** A fresh turn started by this person, then one call as the employee. */
async function askAs(who: Who, role: AgentRoleKey, tool: string, args: Record<string, unknown> = {}) {
  await startClientTurn(a, role, a.crm.people[who].id);
  return postClient(a.credentials[role], callBody(tool, args));
}

const override = (who: Who, permission: string) => withSystem((db) => db.query(
  "insert into member_permission_overrides (org_id, user_id, permission, effect) values ($1, $2, $3, 'revoke') on conflict (org_id, user_id, permission) do update set effect = 'revoke'", [a.org.id, a.crm.people[who].id, permission],
));
const clearOverrides = () => withSystem((db) => db.query("delete from member_permission_overrides where org_id = $1", [a.org.id]));

beforeAll(async () => {
  a = await provisionedClient({ name: "Chicago Roofing", timezone: "America/Chicago", tag: "Chicagoan", phone: "+13125550101" });
}, 180_000);

beforeEach(async () => {
  await withSystem((db) => db.query("delete from rate_limit_buckets"));
  setClientTier(true);
});

afterEach(async () => {
  await clearOverrides();
  await withSystem((db) => db.query("update conversations set assigned_user_id = null where org_id = $1", [a.org.id]));
  for (const role of AGENT_ROLE_KEYS) await endClientTurns(a, role);
  vi.unstubAllEnvs();
  resetEnvCache();
});

afterAll(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("a person without a permission the tool needs gets nothing, and no tool token is ever issued", () => {
  it("refuses the contact tools for a member whose view of contacts was withdrawn, while the owner and a colleague are still served", async () => {
    await override("support", "contacts.view");
    const before = await clientSideEffects();
    for (const [tool, args] of [["find_contacts", { query: "Chicagoan" }], ["get_contact", { contactId: a.contact.id }]] as const) {
      const rpc = await askAs("support", "appointment_setter", tool, { ...args });
      expect(refused(rpc), tool).toBe(true);
      expect(toolJson(rpc), tool).toMatchObject({ ok: false, code: "forbidden", httpStatus: 403 });
      expect(toolText(rpc), tool).not.toContain("Chicagoan Prospect");
    }
    // Nothing was issued, asked for or created: the refusal came before any token existed.
    const after = await clientSideEffects();
    expect(after.crm_agent_tokens).toBe(before.crm_agent_tokens);
    expect(after.approval_requests).toBe(before.approval_requests);
    expect({ ...withoutAudit(after), agent_runs: 0 }).toEqual({ ...withoutAudit(before), agent_runs: 0 });
    // The refusal is on record in this workspace, naming the person and the reason only.
    const rows = await auditRows("hermes.business_mcp.read", a.org.id);
    expect(rows.filter((row) => row.result === "denied" && row.metadata.reason === "person_permission" && row.actor_user_id === a.crm.people.support.id)).toHaveLength(2);
    // The same credential, for people who still hold the permission.
    expect(toolText(await askAs("owner", "appointment_setter", "find_contacts", { query: "Chicagoan" }))).toContain("Chicagoan Prospect");
    expect(toolText(await askAs("sales", "appointment_setter", "find_contacts", { query: "Chicagoan" }))).toContain("Chicagoan Prospect");
  });

  it("refuses the deals read for a member whose view of sales was withdrawn, and the calendar read for one whose view of appointments was", async () => {
    await override("sales", "sales.view");
    await override("support", "appointments.view");
    expect(toolJson(await askAs("sales", "crm_manager", "list_opportunities"))).toMatchObject({ ok: false, code: "forbidden" });
    expect(toolText(await askAs("sales", "crm_manager", "list_opportunities"))).not.toContain(a.dealName);
    expect(toolJson(await askAs("support", "appointment_setter", "check_availability"))).toMatchObject({ ok: false, code: "forbidden" });
    // Others are served.
    expect(toolText(await askAs("owner", "crm_manager", "list_opportunities"))).toContain(a.dealName);
    expect(toolJson(await askAs("owner", "appointment_setter", "check_availability"))).toMatchObject({ ok: true, status: "done" });
  });

  it("says in the snapshot that the area is not theirs to read, and shows none of its records", async () => {
    await override("support", "contacts.view");
    const rpc = await askAs("support", "crm_manager", "get_role_workspace_context");
    expect(refused(rpc)).toBe(false);
    expect(toolText(rpc)).toContain("no_permission");
    expect(toolText(rpc)).not.toContain("Chicagoan Prospect");
    const owner = await askAs("owner", "crm_manager", "get_role_workspace_context");
    expect(toolText(owner)).toContain("Chicagoan");
  });
});

describe("a conversation is read only by someone who could open it in the inbox", () => {
  it("answers 'not found' for a member who neither owns nor is assigned the conversation, the same as another workspace's, and the messages once it is theirs", async () => {
    const hidden = await askAs("support", "appointment_setter", "get_conversation_history", { conversationId: a.conversationId });
    expect(refused(hidden)).toBe(true);
    expect(toolJson(hidden)).toMatchObject({ ok: false, code: "not_found", httpStatus: 404 });
    expect(toolText(hidden)).not.toContain(a.messageText);
    // By contact, the member is told there is no conversation, not that one exists.
    const byContact = await askAs("support", "appointment_setter", "get_conversation_history", { contactId: a.contact.id });
    expect(toolJson(byContact)).toMatchObject({ ok: true, result: { conversation: null, messages: [] } });
    expect(toolText(byContact)).not.toContain(a.messageText);

    // The owner sees every conversation.
    expect(toolText(await askAs("owner", "appointment_setter", "get_conversation_history", { conversationId: a.conversationId }))).toContain(a.messageText);
    // Assigned to the member, it is theirs.
    await withSystem((db) => db.query("update conversations set assigned_user_id = $2 where id = $1", [a.conversationId, a.crm.people.support.id]));
    expect(toolText(await askAs("support", "appointment_setter", "get_conversation_history", { conversationId: a.conversationId }))).toContain(a.messageText);
  });

  it("withholds the conversation count from a member who may not see every conversation, and gives it to the owner", async () => {
    const member = toolJson(await askAs("support", "crm_manager", "crm_summary_report")) as { result: Record<string, unknown> };
    expect(member.result.conversations).toBeNull();
    expect(String(member.result.conversationsNote)).toMatch(/not shown/);
    const owner = toolJson(await askAs("owner", "crm_manager", "crm_summary_report")) as { result: Record<string, unknown> };
    expect(owner.result.conversations).toEqual({ open: expect.any(Number) });
    expect("conversationsNote" in owner.result).toBe(false);
  });
});

describe("a person who loses their place in the workspace mid-turn is refused at once", () => {
  it("refuses a removed member for the tool and the snapshot, and a member whose role was lowered below AI use", async () => {
    await startClientTurn(a, "appointment_setter", a.crm.people.support.id);
    expect(refused(await postClient(a.credentials.appointment_setter, callBody("find_contacts", { query: "Chicagoan" })))).toBe(false);
    await withSystem((db) => db.query("update organization_memberships set role = 'viewer' where org_id = $1 and user_id = $2", [a.org.id, a.crm.people.support.id]));
    try {
      for (const ask of [callBody("find_contacts", { query: "Chicagoan" }), callBody("get_role_workspace_context")]) {
        const rpc = await postClient(a.credentials.appointment_setter, ask);
        expect(refused(rpc)).toBe(true);
        expect(toolText(rpc)).not.toContain("Chicagoan Prospect");
      }
    } finally {
      await withSystem((db) => db.query("update organization_memberships set role = 'support' where org_id = $1 and user_id = $2", [a.org.id, a.crm.people.support.id]));
    }
    expect(refused(await postClient(a.credentials.appointment_setter, callBody("find_contacts", { query: "Chicagoan" })))).toBe(false);
    await withSystem((db) => db.query("update organization_memberships set status = 'revoked' where org_id = $1 and user_id = $2", [a.org.id, a.crm.people.support.id]));
    try {
      expect(refused(await postClient(a.credentials.appointment_setter, callBody("find_contacts", { query: "Chicagoan" })))).toBe(true);
    } finally {
      await withSystem((db) => db.query("update organization_memberships set status = 'active' where org_id = $1 and user_id = $2", [a.org.id, a.crm.people.support.id]));
    }
  });
});
