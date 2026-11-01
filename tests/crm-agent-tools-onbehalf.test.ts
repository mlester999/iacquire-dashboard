// The shared tool engine when a call is made for a person (the client business tier sets onBehalfOfUserId; the internal tier and the token API never do).
// Synthetic workspaces only: nothing here calls Hermes, a calendar provider or a messaging provider, and nothing is sent.
// With the person left out every call is what it always was. With the person set, the call is also bounded by that person's own role and overrides, their own row
// visibility in the inbox (the database's row-level security decides), and the audit names them.
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AGENT_TOOL_SCOPES } from "@/server/crm/agent-tools/catalog";
import { issueAgentToolToken } from "@/server/crm/agent-tools/tokens";
import { callAgentTool, describeAgentTools } from "@/server/crm/agent-tools/service";
import { createContact } from "@/server/crm/contacts";
import { createOpportunity } from "@/server/crm/opportunities";
import { listPipelines } from "@/server/crm/pipelines";
import { agentId as roleAgent } from "./support/fixtures";
import { crmOrg, type CrmOrg } from "./support/crm";

const ALL = [...AGENT_TOOL_SCOPES];
const OTHER_TENANTS_CONVERSATION_MESSAGE = "Conversation not found, or it isn't one this AI employee handles.";

let a: CrmOrg;
let b: CrmOrg;
let agent: string;
/** The CRM Manager holds the reports scope; the Sales Assistant, who handles the conversations, does not. */
let reporter: string;
let contactId: string;

const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[]) => (await withSystem((db) => db.query<T>(sql, params))).rows[0];
const count = async (sql: string, params: unknown[]) => Number((await one<{ n: string }>(`select count(*)::text as n from (${sql}) x`, params)).n);

async function ready(org: CrmOrg, role: string, mode = "autonomous") {
  const id = await roleAgent(org.org.id, role);
  await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, enabled = true, mode = $2 where id = $1", [id, mode]));
  return id;
}

/** A one-minute-style tool token for a run, as the business bridge issues it (one run, the scopes the role allows). */
async function tokenFor(org: CrmOrg, agentInstanceId: string, scopes: string[] = ALL) {
  const run = await one<{ id: string }>("insert into agent_runs (org_id, agent_instance_id, purpose, idempotency_key, status) values ($1, $2, 'crm_tool', $3, 'running') returning id", [org.org.id, agentInstanceId, `test:${crypto.randomUUID()}`]);
  return withSystem((db) => issueAgentToolToken(db, { orgId: org.org.id, agentInstanceId, runId: run.id, scopes, ttlMinutes: 5 }));
}

type Extra = { forceApprovalWrites?: boolean; callId?: string };
const callFor = async (org: CrmOrg, agentInstanceId: string, who: string | null | undefined, tool: string, args: unknown = {}, extra: Extra = {}) => {
  const t = await tokenFor(org, agentInstanceId);
  return callAgentTool({ token: t.token, tool, readArgs: async () => args, onBehalfOfUserId: who, ...extra });
};

async function conversation(org: CrmOrg, contact: string, opts: { assignedTo?: string | null; at?: string; body?: string } = {}) {
  const conv = await one<{ id: string }>(
    "insert into conversations (org_id, contact_id, channel, thread_key, ai_agent_id, owner_kind, assigned_user_id, last_message_at) values ($1, $2, 'sms', $3, $4, 'ai', $5, coalesce($6::timestamptz, now())) returning id",
    [org.org.id, contact, crypto.randomUUID(), agent, opts.assignedTo ?? null, opts.at ?? null],
  );
  await withSystem((db) => db.query("insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status) values ($1, $2, 'inbound', 'contact', $3, 'received')", [org.org.id, conv.id, opts.body ?? "Is Saturday free?"]));
  return conv.id;
}

const openConversations = async () => count("select 1 from conversations where org_id = $1 and status = 'open'", [a.org.id]);

let assigned: string;
let unassigned: string;
let otherTenant: string;

beforeAll(async () => {
  a = await crmOrg({ name: "On Behalf Co" });
  b = await crmOrg({ name: "On Behalf Neighbour" });
  agent = await ready(a, "sales_assistant");
  reporter = await ready(a, "crm_manager");
  const c = await createContact(a.actor("owner"), { firstName: "Visible", lastName: "Person", phone: "+639171234500" });
  contactId = c.id;
  assigned = await conversation(a, contactId, { assignedTo: a.people.viewer.id, at: "2026-10-26T05:00:00Z", body: "Assigned to the viewer" });
  unassigned = await conversation(a, contactId, { at: "2026-10-26T06:00:00Z", body: "Nobody's in particular" });
  const bAgent = await ready(b, "sales_assistant");
  const bc = await createContact(b.actor("owner"), { firstName: "Other", lastName: "Tenant", phone: "+639171234599" });
  const bConv = await one<{ id: string }>("insert into conversations (org_id, contact_id, channel, thread_key, ai_agent_id, owner_kind) values ($1, $2, 'sms', $3, $4, 'ai') returning id", [b.org.id, bc.id, crypto.randomUUID(), bAgent]);
  otherTenant = bConv.id;
});

describe("with no person named, calls are exactly what they were", () => {
  it("reads any conversation the employee handles, shows the conversation count, and leaves no acting user in the audit", async () => {
    const read = await callFor(a, agent, undefined, "get_conversation_history", { conversationId: unassigned });
    expect(read.ok && read.result.messages).toEqual([expect.objectContaining({ text: "Nobody's in particular" })]);
    const report = await callFor(a, reporter, null, "crm_summary_report", {});
    expect(report.ok && report.result.conversations).toEqual({ open: expect.any(Number) });
    expect(report.ok && "conversationsNote" in report.result).toBe(false);
    const rows = await withSystem((db) => db.query<{ metadata: Record<string, unknown> }>("select metadata from audit_logs where org_id = $1 and action in ('crm.agent_tool.get_conversation_history', 'crm.agent_tool.crm_summary_report')", [a.org.id]));
    expect(rows.rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows.rows) expect("actingUserId" in row.metadata, JSON.stringify(row.metadata)).toBe(false);
  });

  it("finds the newest conversation with a contact, as before", async () => {
    const read = await callFor(a, agent, undefined, "get_conversation_history", { contactId });
    expect(read.ok && (read.result.conversation as { id: string }).id).toBe(unassigned);
  });
});

describe("a conversation the person cannot see is 'not found', the same as another workspace's", () => {
  it("answers a viewer for the conversation assigned to them and refuses the one that is not theirs, with the other workspace's wording", async () => {
    const viewer = a.people.viewer.id;
    const mine = await callFor(a, agent, viewer, "get_conversation_history", { conversationId: assigned });
    expect(mine.ok && mine.result.messages).toEqual([expect.objectContaining({ text: "Assigned to the viewer" })]);

    const hidden = await callFor(a, agent, viewer, "get_conversation_history", { conversationId: unassigned });
    const foreign = await callFor(a, agent, viewer, "get_conversation_history", { conversationId: otherTenant });
    expect(hidden).toMatchObject({ ok: false, httpStatus: 404, code: "not_found", error: OTHER_TENANTS_CONVERSATION_MESSAGE });
    expect(foreign).toEqual(hidden);
    expect(JSON.stringify(hidden)).not.toContain("Nobody's in particular");
  });

  it("lets a person who sees every conversation read both", async () => {
    for (const id of [assigned, unassigned]) {
      const read = await callFor(a, agent, a.people.owner.id, "get_conversation_history", { conversationId: id });
      expect(read.ok, id).toBe(true);
    }
  });

  it("picks, for a contact, the newest conversation this person can see, and says there is none rather than showing another", async () => {
    const viewer = await callFor(a, agent, a.people.viewer.id, "get_conversation_history", { contactId });
    expect(viewer.ok && (viewer.result.conversation as { id: string }).id).toBe(assigned);
    const owner = await callFor(a, agent, a.people.owner.id, "get_conversation_history", { contactId });
    expect(owner.ok && (owner.result.conversation as { id: string }).id).toBe(unassigned);

    // Another viewer holds none of them: nothing is read and nothing says a conversation exists.
    const other = await callFor(a, agent, a.people.support.id, "get_conversation_history", { contactId });
    const unrelated = await callFor(a, agent, a.people.viewer.id, "get_conversation_history", { contactId: (await createContact(a.actor("owner"), { firstName: "No", lastName: "Chats", phone: "+639171234501" })).id });
    expect(other).toMatchObject({ ok: true, result: { conversation: null, messages: [] } });
    expect(unrelated).toMatchObject({ ok: true, result: { conversation: null, messages: [] } });
    expect(JSON.stringify(other)).not.toContain("Nobody's in particular");
  });

  it("does not let a person of another workspace read this workspace's conversations, whatever the id", async () => {
    const outsider = b.people.owner.id;
    expect(await callFor(a, agent, outsider, "get_conversation_history", { conversationId: assigned })).toMatchObject({ ok: false, httpStatus: 403 });
  });
});

describe("conversation counts follow the person's inbox access", () => {
  it("withholds the open-conversation count (and says so) from someone who cannot see every conversation, and gives it to someone who can", async () => {
    const viewer = await callFor(a, reporter, a.people.viewer.id, "crm_summary_report", {});
    expect(viewer.ok && viewer.result.conversations).toBeNull();
    expect(viewer.ok && viewer.result.conversationsNote).toMatch(/not shown/);
    // The rest of the report is untouched.
    expect(viewer).toMatchObject({ ok: true, result: { contacts: { total: expect.any(Number) }, deals: { open: expect.any(Number) } } });

    const owner = await callFor(a, reporter, a.people.owner.id, "crm_summary_report", {});
    expect(owner.ok && owner.result.conversations).toEqual({ open: await openConversations() });
    expect(owner.ok && "conversationsNote" in owner.result).toBe(false);
  });

  it("gives it to a person who is granted inbox.view_all on top of their role", async () => {
    const support = a.people.support.id;
    const before = await callFor(a, reporter, support, "crm_summary_report", {});
    expect(before.ok && before.result.conversations).toBeNull();
    await withSystem((db) => db.query("insert into member_permission_overrides (org_id, user_id, permission, effect, reason) values ($1, $2, 'inbox.view_all', 'grant', 'test')", [a.org.id, support]));
    const after = await callFor(a, reporter, support, "crm_summary_report", {});
    expect(after.ok && after.result.conversations).toEqual({ open: await openConversations() });
    await withSystem((db) => db.query("delete from member_permission_overrides where org_id = $1 and user_id = $2", [a.org.id, support]));
  });
});

describe("the person's own permissions bound every tool", () => {
  it("refuses a person whose per-person override removed what the tool needs, before anything is read, while the same call without a person still works", async () => {
    const person = a.people.sales.id;
    expect(await callFor(a, agent, person, "find_contacts", { query: "Visible" })).toMatchObject({ ok: true });
    await withSystem((db) => db.query("insert into member_permission_overrides (org_id, user_id, permission, effect, reason) values ($1, $2, 'contacts.view', 'revoke', 'test')", [a.org.id, person]));
    const toolRowsBefore = await count("select 1 from tool_executions where org_id = $1 and status = 'completed'", [a.org.id]);
    const denied = await callFor(a, agent, person, "find_contacts", { query: "Visible" });
    expect(denied).toMatchObject({ ok: false, httpStatus: 403, code: "forbidden", error: "Your iAcquire role does not have access to this business information." });
    expect(JSON.stringify(denied)).not.toContain("Visible");
    expect(await count("select 1 from tool_executions where org_id = $1 and status = 'completed'", [a.org.id])).toBe(toolRowsBefore);
    expect(await callFor(a, agent, undefined, "find_contacts", { query: "Visible" })).toMatchObject({ ok: true });
    await withSystem((db) => db.query("delete from member_permission_overrides where org_id = $1 and user_id = $2", [a.org.id, person]));
  });

  it("refuses an id that is not a person's, a person who left, and a person of another workspace, all the same way (never the unrestricted path)", async () => {
    const stranger = await one<{ id: string }>("insert into users (email, full_name, email_verified_at) values ($1, 'No Membership', now()) returning id", [`stranger-${crypto.randomUUID().slice(0, 8)}@example.test`]);
    for (const who of ["not-a-user-id", "", stranger.id, b.people.owner.id]) {
      const denied = await callFor(a, agent, who, "find_contacts", { query: "Visible" });
      expect(denied, JSON.stringify(who)).toMatchObject({ ok: false, httpStatus: 403, code: "forbidden" });
    }
  });

  it("records the refusal in the audit with the person it was for left out of any record text", async () => {
    const row = await one<{ metadata: Record<string, unknown>; result: string }>(
      "select metadata, result from audit_logs where org_id = $1 and action = 'crm.agent_tool.find_contacts' and result = 'denied' and metadata->>'detail' = 'Not allowed for the person asking' order by id desc limit 1",
      [a.org.id],
    );
    expect(row.result).toBe("denied");
    expect(JSON.stringify(row.metadata)).not.toContain("Visible");
  });

  it("stops a person without the edit permission from even proposing a change: no approval request exists", async () => {
    const before = await count("select 1 from approval_requests where org_id = $1", [a.org.id]);
    const denied = await callFor(a, agent, a.people.viewer.id, "update_contact", { contactId, changes: { city: "Chicago" } }, { forceApprovalWrites: true });
    expect(denied).toMatchObject({ ok: false, httpStatus: 403 });
    expect(await count("select 1 from approval_requests where org_id = $1", [a.org.id])).toBe(before);
  });

  it("records the person as the requester of an approval a forced write becomes, and nobody when no person is named", async () => {
    const named = await callFor(a, agent, a.people.owner.id, "update_contact", { contactId, changes: { city: "Chicago" } }, { forceApprovalWrites: true });
    expect(named).toMatchObject({ ok: true, status: "pending_approval" });
    expect(await one("select requested_by from approval_requests where id = $1", [named.ok ? named.approvalId : ""])).toEqual({ requested_by: a.people.owner.id });
    const unnamed = await callFor(a, agent, undefined, "update_contact", { contactId, changes: { city: "Springfield" } }, { forceApprovalWrites: true });
    expect(unnamed).toMatchObject({ ok: true, status: "pending_approval" });
    expect(await one("select requested_by from approval_requests where id = $1", [unnamed.ok ? unnamed.approvalId : ""])).toEqual({ requested_by: null });
    // The contact itself is untouched by either: both are only requests.
    expect(await one("select city from contacts where id = $1", [contactId])).toEqual({ city: null });
  });
});

describe("the audit names the person", () => {
  it("carries actingUserId on success and on a refusal, and only when a person was named", async () => {
    const viewer = a.people.viewer.id;
    await callFor(a, agent, viewer, "get_conversation_history", { conversationId: assigned });
    await callFor(a, agent, viewer, "get_conversation_history", { conversationId: unassigned });
    const rows = await withSystem((db) => db.query<{ result: string; metadata: Record<string, unknown> }>(
      "select result, metadata from audit_logs where org_id = $1 and action = 'crm.agent_tool.get_conversation_history' and metadata->>'actingUserId' = $2 order by id",
      [a.org.id, viewer],
    ));
    expect(rows.rows.map((r) => r.result)).toEqual(expect.arrayContaining(["success", "denied"]));
    // Names and message text never go in the audit.
    expect(JSON.stringify(rows.rows)).not.toMatch(/Assigned to the viewer|Nobody's in particular/);
    const unset = await count("select 1 from audit_logs where org_id = $1 and action = 'crm.agent_tool.get_conversation_history' and not (metadata ? 'actingUserId')", [a.org.id]);
    expect(unset).toBeGreaterThan(0);
  });
});

describe("get_contact carries no conversation facts, with or without a person", () => {
  it("returns the same contact sections whether or not a person is named (any conversation fact added later has to go through the visibility rule)", async () => {
    const plain = await callFor(a, agent, undefined, "get_contact", { contactId });
    const named = await callFor(a, agent, a.people.viewer.id, "get_contact", { contactId });
    for (const reply of [plain, named]) {
      expect(reply.ok).toBe(true);
      const result = reply.ok ? (JSON.parse(JSON.stringify(reply.result)) as Record<string, unknown>) : {};
      expect(Object.keys(result).sort()).toEqual(["contact", "openDeals", "openTasks", "upcomingAppointments"]);
      expect(JSON.stringify(result)).not.toMatch(/conversation|Nobody's in particular|Assigned to the viewer/i);
    }
  });
});

describe("get_contact sections follow the person's own permissions", () => {
  it("leaves out the deals and the appointments a person may not open, while they still see the contact; the same call without a person is unchanged", async () => {
    const person = a.people.manager.id;
    const pipelineId = (await listPipelines(a.actor("owner"), { ensureDefault: true }))[0].id;
    await createOpportunity(a.actor("owner"), { name: "Secret roof deal", contactId, pipelineId, value: 9000, currency: "USD" });
    const sections = async (who: string | undefined) => {
      const reply = await callFor(a, agent, who, "get_contact", { contactId });
      expect(reply.ok).toBe(true);
      const result = reply.ok ? (JSON.parse(JSON.stringify(reply.result)) as Record<string, unknown>) : {};
      return { keys: Object.keys(result).sort(), text: JSON.stringify(result) };
    };
    const full = await sections(person);
    expect(full.keys).toEqual(["contact", "openDeals", "openTasks", "upcomingAppointments"]);
    expect(full.text).toContain("Secret roof deal");
    for (const permission of ["sales.view", "appointments.view"]) {
      await withSystem((db) => db.query("insert into member_permission_overrides (org_id, user_id, permission, effect, reason) values ($1, $2, $3, 'revoke', 'test')", [a.org.id, person, permission]));
    }
    try {
      const limited = await sections(person);
      expect(limited.keys).toEqual(["contact", "openTasks"]);
      expect(limited.text).not.toContain("Secret roof deal");
      const unchanged = await sections(undefined);
      expect(unchanged.keys).toEqual(["contact", "openDeals", "openTasks", "upcomingAppointments"]);
      expect(unchanged.text).toContain("Secret roof deal");
    } finally {
      await withSystem((db) => db.query("delete from member_permission_overrides where org_id = $1 and user_id = $2", [a.org.id, person]));
    }
  });
});

describe("a tool offered only to the client business tier", () => {
  it("is refused without a person, never listed by the token catalog, and offered with one", async () => {
    const plain = await callFor(a, agent, undefined, "list_opportunities", {});
    expect(plain).toMatchObject({ ok: false, httpStatus: 403, code: "forbidden" });
    const t = await tokenFor(a, agent);
    const catalog = await describeAgentTools(t.token);
    expect(catalog.ok && "tools" in catalog && catalog.tools.map((x) => x.name)).not.toContain("list_opportunities");
    const named = await callFor(a, agent, a.people.owner.id, "list_opportunities", {});
    expect(named).toMatchObject({ ok: true, status: "done" });
  });
});
