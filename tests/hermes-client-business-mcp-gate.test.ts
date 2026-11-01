// The call-time gate of the client tier: whether a tool may answer RIGHT NOW, decided on every call from the workspace's own records. The tool list of an employee's profile is fixed by its
// role; this is what keeps a switched-off ability, a CRM that lives in another system, a missing calendar or an inbox that is not on from answering with an empty list that reads as "nothing
// there". Every read is a peek: asking a workspace that has no CRM or calendar yet creates nothing. Synthetic workspaces; the tools run through the real handler.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { ROLE_ABILITIES } from "@/lib/employee-tool-policy";
import { withSystem, type Queryable } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import type { AgentToolName } from "@/server/crm/agent-tools/catalog";
import { defaultSettings } from "@/server/workforce/compiler";
import { clientToolGate } from "@/server/workforce/hermes-client-business-mcp-gate";
import { createOrg } from "./support/fixtures";
import {
  callBody, clientSideEffects, endClientTurns, postClient, provisionedClient, refused, setClientTier, startClientTurn, temporarily, toolJson, toolText, withoutAudit, type ClientTenant,
} from "./support/client-business-mcp";

let a: ClientTenant;
let b: ClientTenant;
/** A workspace that has never opened its CRM or set up a calendar. */
let c: ClientTenant;

/** Starts a fresh turn for the person and makes one call as the employee. A new turn each time, so a configuration changed since is the one the turn is bound to. */
async function ask(t: ClientTenant, role: AgentRoleKey, tool: string, args: Record<string, unknown> = {}) {
  await startClientTurn(t, role, t.owner.id);
  return postClient(t.credentials[role], callBody(tool, args));
}

/** The honest "not available" answer: an ordinary result (not an error) that says so in words and carries none of the records the tool would have returned. */
function expectUnavailable(rpc: Awaited<ReturnType<typeof ask>>, detail: RegExp, label: string) {
  expect(rpc.status, label).toBe(200);
  const body = toolJson(rpc);
  expect(body, label).toMatchObject({ ok: true, status: "unavailable", result: { available: false } });
  // The gate puts its reason in both places; a tool's own refusal (a draft calendar) only in the result.
  expect(String((body?.result as { detail?: string } | undefined)?.detail), label).toMatch(detail);
  expect(toolText(rpc), label).not.toMatch(/"contacts":|"deals":|"slots":|"conversation":/);
}

/** The owner's Allowed actions: a new applied configuration that switches these abilities off (an empty list switches everything back on). Done before a turn starts, because a turn is bound to the active configuration. */
async function switchOff(t: ClientTenant, role: AgentRoleKey, disabledTools: readonly string[]) {
  await withSystem(async (db) => {
    const v = await db.query<{ id: string }>(
      `insert into agent_config_versions (org_id, agent_instance_id, version, settings, summary, compiled_instructions, policy_version, source, status)
       values ($1, $2, (select coalesce(max(version), 0) + 1 from agent_config_versions where agent_instance_id = $2), $3, 's', '# config', 'p', 'onboarding', 'applied') returning id`,
      [t.org.id, t.agents[role], JSON.stringify({ ...defaultSettings(role), disabledTools })],
    );
    await db.query("update agent_instances set active_config_version_id = $2 where id = $1", [t.agents[role], v.rows[0].id]);
  });
}

const count = async (table: string, orgId: string) => Number((await withSystem((db) => db.query<{ n: number }>(`select count(*)::int as n from ${table} where org_id = $1`, [orgId]))).rows[0].n);

beforeAll(async () => {
  a = await provisionedClient({ name: "Chicago Roofing", timezone: "America/Chicago", tag: "Chicagoan", phone: "+13125550101" });
  b = await provisionedClient({ name: "Manila Dental", timezone: "Asia/Manila", tag: "Manilan", phone: "+639171234501", entitled: AGENT_ROLE_KEYS.filter((role) => role !== "sales_assistant") });
  c = await provisionedClient({ name: "Austin Bakery", timezone: "America/Chicago", tag: "Austinian", phone: "+15125550101", crm: false });
}, 240_000);

beforeEach(async () => {
  await withSystem((db) => db.query("delete from rate_limit_buckets"));
  setClientTier(true);
});

afterEach(async () => {
  for (const t of [a, b, c]) for (const role of AGENT_ROLE_KEYS) await endClientTurns(t, role);
  vi.unstubAllEnvs();
  resetEnvCache();
});

afterAll(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("the gate itself, one decision at a time", () => {
  const gate = (t: ClientTenant, role: AgentRoleKey, tool: AgentToolName, over: { orgId?: string } = {}) =>
    withSystem((db) => clientToolGate(db, { orgId: over.orgId ?? t.org.id, agentId: t.agents[role], roleKey: role, tool }));

  it("lets a role's own read through while everything is in place", async () => {
    expect(await gate(a, "crm_manager", "find_contacts")).toEqual({ ok: true });
    expect(await gate(a, "appointment_setter", "check_availability")).toEqual({ ok: true });
    expect(await gate(a, "appointment_setter", "get_conversation_history")).toEqual({ ok: true });
  });

  it("closes for a role the plan does not include, a workspace that is not active, an unconfirmed setup payment and a switched-off workspace", async () => {
    await temporarily("update agent_instances set enabled = false where id = $1", "update agent_instances set enabled = true where id = $1", [a.agents.crm_manager], async () => {
      expect(await gate(a, "crm_manager", "find_contacts")).toMatchObject({ ok: false, reason: "role_not_enabled" });
    });
    await temporarily("update organizations set status = 'suspended' where id = $1", "update organizations set status = 'active' where id = $1", [a.org.id], async () => {
      expect(await gate(a, "crm_manager", "find_contacts")).toMatchObject({ ok: false, reason: "workspace_not_active" });
    });
    await temporarily(
      "update billing_accounts set setup_payment_status = 'not_invoiced', waiver_reason = null, waived_at = null where org_id = $1",
      "update billing_accounts set setup_payment_status = 'waived', waiver_reason = 'Test fixture: setup payment cleared', waived_at = now() where org_id = $1", [a.org.id],
      async () => { expect(await gate(a, "crm_manager", "find_contacts")).toMatchObject({ ok: false, reason: "setup_payment_not_confirmed" }); },
    );
    await temporarily("update org_features set enabled = false where org_id = $1 and feature = 'client_business_tools'", "update org_features set enabled = true where org_id = $1 and feature = 'client_business_tools'", [a.org.id], async () => {
      expect(await gate(a, "crm_manager", "find_contacts")).toMatchObject({ ok: false, reason: "workspace_switch_off" });
    });
    expect(await gate(a, "crm_manager", "find_contacts")).toEqual({ ok: true });
  });

  it("closes, and reads nothing, when what the employee may do cannot be read (a failed read is never taken as 'everything is on')", async () => {
    const unreadable = (db: Queryable): Queryable => ({
      query: <R,>(sql: string, params?: unknown[]) => (sql.includes("disabledTools") ? Promise.reject(new Error("the read failed")) : db.query<R>(sql, params)),
    });
    for (const tool of ["find_contacts", "check_availability", "get_conversation_history"] as const) {
      const decision = await withSystem((db) => clientToolGate(unreadable(db), { orgId: a.org.id, agentId: a.agents.appointment_setter, roleKey: "appointment_setter", tool }));
      expect(decision, tool).toMatchObject({ ok: false, reason: "abilities_unreadable" });
    }
    // The same call with a working read is let through, so the refusal above is about the failed read and nothing else.
    expect(await gate(a, "appointment_setter", "find_contacts")).toEqual({ ok: true });
  });

  it("never finds another workspace's employee: an employee id under another workspace's id is simply not part of the plan", async () => {
    expect(await gate(a, "crm_manager", "find_contacts", { orgId: b.org.id })).toMatchObject({ ok: false, reason: "role_not_enabled" });
    expect(await gate(b, "crm_manager", "find_contacts", { orgId: a.org.id })).toMatchObject({ ok: false, reason: "role_not_enabled" });
  });

  it("never lets a tool that changes something through, whatever else is true", async () => {
    for (const tool of ["update_contact", "apply_tag", "remove_tag", "create_task", "create_opportunity", "move_opportunity_stage", "request_appointment", "prepare_message", "request_send_approval"] as const) {
      expect(await gate(a, "crm_manager", tool), tool).toMatchObject({ ok: false, reason: "tool_not_available" });
    }
  });
});

describe("the employee's own Allowed actions", () => {
  it("makes every tool unavailable when every action of the role is switched off, and says which switch", async () => {
    await switchOff(a, "crm_manager", ROLE_ABILITIES.crm_manager);
    try {
      const asks: Array<[string, Record<string, unknown>]> = [["find_contacts", { query: "Chicagoan" }], ["get_contact", { contactId: a.contact.id }], ["crm_summary_report", {}], ["list_opportunities", {}]];
      const before = await clientSideEffects();
      for (const [tool, args] of asks) expectUnavailable(await ask(a, "crm_manager", tool, args), /Allowed actions/, tool);
      // A refusal creates no token or approval; it is only logged.
      expect({ ...withoutAudit(await clientSideEffects()), agent_runs: 0 }).toEqual({ ...withoutAudit(before), agent_runs: 0 });
      // The snapshot says the same in its own way: the area is switched off, not empty.
      expect(toolText(await ask(a, "crm_manager", "get_role_workspace_context"))).toContain("switched_off");
    } finally {
      await switchOff(a, "crm_manager", []);
    }
    expect(toolJson(await ask(a, "crm_manager", "find_contacts", { query: "Chicagoan" }))).toMatchObject({ ok: true, status: "done" });
  });

  it("still answers while one of a role's actions is on, and only one workspace's switch counts", async () => {
    await switchOff(a, "appointment_setter", ["calendar.read_availability", "appointments.read"]);
    try {
      expect(toolJson(await ask(a, "appointment_setter", "find_contacts", { query: "Chicagoan" }))).toMatchObject({ ok: true, status: "done" });
      // The same role of the other workspace is untouched.
      expect(toolJson(await ask(b, "appointment_setter", "find_contacts", { query: "Manilan" }))).toMatchObject({ ok: true, status: "done" });
    } finally {
      await switchOff(a, "appointment_setter", []);
    }
  });
});

describe("a CRM that lives in another system is 'unavailable', never an empty list", () => {
  it("answers unavailable for contacts, deals, reports and calendar in a GoHighLevel workspace, and the records come back once it is native again", async () => {
    await temporarily("update crm_workspaces set mode = 'ghl' where org_id = $1", "update crm_workspaces set mode = 'native' where org_id = $1", [a.org.id], async () => {
      expectUnavailable(await ask(a, "appointment_setter", "find_contacts", { query: "Chicagoan" }), /another system/, "find_contacts");
      expectUnavailable(await ask(a, "appointment_setter", "get_contact", { contactId: a.contact.id }), /another system/, "get_contact");
      expectUnavailable(await ask(a, "appointment_setter", "check_availability"), /another system/, "check_availability");
      expectUnavailable(await ask(a, "crm_manager", "crm_summary_report"), /another system/, "crm_summary_report");
      expectUnavailable(await ask(a, "crm_manager", "list_opportunities"), /another system/, "list_opportunities");
    });
    expect(toolText(await ask(a, "appointment_setter", "find_contacts", { query: "Chicagoan" }))).toContain("Chicagoan Prospect");
  });

  it("follows each capability's own owner in a hybrid workspace: appointments elsewhere makes only the calendar unavailable", async () => {
    await withSystem(async (db) => {
      await db.query("update crm_workspaces set mode = 'hybrid' where org_id = $1", [a.org.id]);
      await db.query("insert into crm_capability_providers (org_id, capability, provider) values ($1, 'appointments', 'ghl') on conflict (org_id, capability) do update set provider = 'ghl'", [a.org.id]);
    });
    try {
      expectUnavailable(await ask(a, "appointment_setter", "check_availability"), /another system/, "calendar");
      expect(toolText(await ask(a, "appointment_setter", "find_contacts", { query: "Chicagoan" }))).toContain("Chicagoan Prospect");
    } finally {
      await withSystem(async (db) => {
        await db.query("delete from crm_capability_providers where org_id = $1 and capability = 'appointments'", [a.org.id]);
        await db.query("update crm_workspaces set mode = 'native' where org_id = $1", [a.org.id]);
      });
    }
  });
});

describe("a workspace that has never set anything up is asked without being set up by the question", () => {
  it("answers unavailable for the CRM tools and the calendar, and creates no CRM record and no calendar", async () => {
    const before = { workspaces: await count("crm_workspaces", c.org.id), calendars: await count("crm_calendars", c.org.id), global: await clientSideEffects() };
    expect(before.workspaces).toBe(0);
    for (const [role, tool, args] of [
      ["appointment_setter", "find_contacts", { query: "x" }], ["appointment_setter", "check_availability", {}], ["crm_manager", "crm_summary_report", {}], ["crm_manager", "list_opportunities", {}],
    ] as const) {
      expectUnavailable(await ask(c, role, tool, { ...args }), /not set up yet|nothing to read|No booking calendar/, `${role} ${tool}`);
    }
    expect(await count("crm_workspaces", c.org.id)).toBe(0);
    expect(await count("crm_calendars", c.org.id)).toBe(0);
    expect(withoutAudit(await clientSideEffects())).toEqual({ ...withoutAudit(before.global), agent_runs: expect.any(Number) });
  });

  it("says no calendar is set up when the workspace has a CRM but every calendar is archived, and creates nothing", async () => {
    const calendars = await count("crm_calendars", a.org.id);
    const workspaces = await count("crm_workspaces", a.org.id);
    await temporarily("update crm_calendars set archived_at = now() where org_id = $1", "update crm_calendars set archived_at = null where org_id = $1", [a.org.id], async () => {
      expectUnavailable(await ask(a, "appointment_setter", "check_availability"), /No booking calendar is set up/, "archived");
    });
    expect(await count("crm_calendars", a.org.id)).toBe(calendars);
    expect(await count("crm_workspaces", a.org.id)).toBe(workspaces);
  });

  it("reports a calendar that is still a draft as not bookable yet, and offers no time", async () => {
    // A draft is never the default calendar (the table refuses it), so the calendar is made a draft the way the onboarding leaves one.
    await temporarily("update crm_calendars set status = 'draft', is_default = false where org_id = $1", "update crm_calendars set status = 'active', is_default = true where org_id = $1", [a.org.id], async () => {
      expectUnavailable(await ask(a, "appointment_setter", "check_availability"), /draft/i, "draft");
    });
  });
});

describe("conversations need the new inbox to be on", () => {
  it("answers unavailable for the conversation history while the workspace's inbox is not switched on, and reads it when it is", async () => {
    await withSystem((db) => db.query("update inbox_rollout set enabled = false where org_id = $1", [a.org.id]));
    try {
      expectUnavailable(await ask(a, "appointment_setter", "get_conversation_history", { conversationId: a.conversationId }), /inbox/i, "inbox off");
      // The contact tools do not depend on it.
      expect(toolJson(await ask(a, "appointment_setter", "find_contacts", { query: "Chicagoan" }))).toMatchObject({ status: "done" });
    } finally {
      await withSystem((db) => db.query("update inbox_rollout set enabled = true where org_id = $1", [a.org.id]));
    }
    expect(toolText(await ask(a, "appointment_setter", "get_conversation_history", { conversationId: a.conversationId }))).toContain(a.messageText);
  });

  it("answers unavailable, never 'no conversation found', when the conversations are kept in another system, even with the inbox switched on", async () => {
    // The inbox is on for this workspace (the fixture), and the contact the history is asked about has a conversation in the native table: a workspace that keeps its conversations
    // elsewhere must still not be answered from that table.
    expect(await withSystem((db) => db.query("select 1 from inbox_rollout where org_id = $1 and enabled", [a.org.id]))).toMatchObject({ rows: [{ "?column?": 1 }] });
    await temporarily("update crm_workspaces set mode = 'ghl' where org_id = $1", "update crm_workspaces set mode = 'native' where org_id = $1", [a.org.id], async () => {
      expectUnavailable(await ask(a, "appointment_setter", "get_conversation_history", { conversationId: a.conversationId }), /another system/, "ghl");
    });
    // Hybrid: only the conversations capability's own owner decides.
    await withSystem(async (db) => {
      await db.query("update crm_workspaces set mode = 'hybrid' where org_id = $1", [a.org.id]);
      await db.query("insert into crm_capability_providers (org_id, capability, provider) values ($1, 'conversations', 'ghl') on conflict (org_id, capability) do update set provider = 'ghl'", [a.org.id]);
    });
    try {
      expectUnavailable(await ask(a, "appointment_setter", "get_conversation_history", { conversationId: a.conversationId }), /another system/, "hybrid, conversations elsewhere");
    } finally {
      await withSystem(async (db) => {
        await db.query("delete from crm_capability_providers where org_id = $1 and capability = 'conversations'", [a.org.id]);
        await db.query("update crm_workspaces set mode = 'native' where org_id = $1", [a.org.id]);
      });
    }
    expect(toolText(await ask(a, "appointment_setter", "get_conversation_history", { conversationId: a.conversationId }))).toContain(a.messageText);
  });
});

describe("each workspace is answered in its own time zone", () => {
  const hourIn = (iso: string, timeZone: string) => Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(new Date(iso)));

  it("offers Chicago's times in Chicago hours and Manila's in Manila hours, inside each calendar's weekday 9 to 5", async () => {
    const results = {} as Record<string, { timeZone: string; slots: Array<{ start: string }> }>;
    for (const t of [a, b]) {
      const rpc = await ask(t, "appointment_setter", "check_availability", { days: 3, limit: 30 });
      const body = toolJson(rpc) as { status: string; result: { available: boolean; timeZone: string; slots: Array<{ start: string }> } };
      expect(body.status, t.tag).toBe("done");
      expect(body.result.available, t.tag).toBe(true);
      expect(body.result.timeZone, t.tag).toBe(t.timezone);
      results[t.tag] = body.result;
      for (const slot of body.result.slots) {
        const hour = hourIn(slot.start, t.timezone);
        expect(hour, `${t.tag} ${slot.start}`).toBeGreaterThanOrEqual(9);
        expect(hour, `${t.tag} ${slot.start}`).toBeLessThan(17);
      }
    }
    // The same instants are different wall-clock times in the two zones, so one workspace's answer is not the other's.
    expect(results.Chicagoan.slots[0].start).not.toBe(results.Manilan.slots[0].start);
  });
});

describe("a paused employee or workspace answers no tool", () => {
  it("refuses the tools while the employee is paused or iAcquire has paused automation, and the snapshot stays available as in chat", async () => {
    const mode = (await withSystem((db) => db.query<{ mode: string }>("select mode from agent_instances where id = $1", [a.agents.crm_manager]))).rows[0].mode;
    await temporarily("update agent_instances set mode = 'paused' where id = $1", `update agent_instances set mode = '${mode}' where id = $1`, [a.agents.crm_manager], async () => {
      const tool = await ask(a, "crm_manager", "crm_summary_report");
      expect(refused(tool)).toBe(true);
      expect(toolText(tool)).toMatch(/paused/i);
      expect(refused(await postClient(a.credentials.crm_manager, callBody("get_role_workspace_context")))).toBe(false);
    });
    const agency = await createOrg({ name: "Agency Of The Gate Test", kind: "agency" });
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active, set_at) values ($1, 'agency', true, now()) on conflict (org_id, scope) do update set active = true", [agency.id]));
    try {
      const tool = await ask(a, "crm_manager", "crm_summary_report");
      expect(refused(tool)).toBe(true);
      expect(toolText(tool)).toMatch(/paused/i);
    } finally {
      await withSystem((db) => db.query("update automation_pauses set active = false where org_id = $1 and scope = 'agency'", [agency.id]));
    }
    expect(refused(await ask(a, "crm_manager", "crm_summary_report"))).toBe(false);
  });
});
