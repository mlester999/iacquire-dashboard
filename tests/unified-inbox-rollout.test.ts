import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { OrgContext } from "@/server/tenancy/context";
import type { SessionUser } from "@/server/auth/service";

// The per-workspace rollout of the new inbox: off by default, switched on by a Super Admin one workspace at a time, enforced on the server, and
// never able to interrupt customer messaging. Covers the four states the rollout has to get right: enabled, disabled, unauthorized and cross-tenant.

const state = vi.hoisted(() => ({ ctx: null as null | OrgContext, user: null as null | SessionUser }));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/tenancy/context", async (original) => {
  const actual = await original<typeof import("@/server/tenancy/context")>();
  const { AppError } = await import("@/server/errors");
  const need = (permission?: string) => {
    if (!state.ctx) throw new AppError("unauthenticated", "Sign in to continue.");
    if (permission && !state.ctx.can(permission as never)) throw new AppError("forbidden", "Your role doesn't allow this action. Ask a workspace owner for access.");
    return state.ctx;
  };
  // The same rule as the real guard: any agency member for "staff", only a Super Admin for "super_admin".
  const agency = (level: "staff" | "super_admin" = "staff") => {
    if (!state.user) throw new AppError("unauthenticated", "Sign in to continue.");
    const ok = level === "super_admin" ? state.user.platformRole === "agency_super_admin" : state.user.platformRole !== "none";
    if (!ok) throw new AppError("forbidden", "Agency access is required.");
    return state.user;
  };
  return { ...actual, requireOrgContextOrThrow: async (p?: string) => need(p), requireOrgContext: async (p?: string) => need(p), requireAgencyOrThrow: async (l?: "staff" | "super_admin") => agency(l) };
});
vi.mock("@/server/auth/session", async (original) => {
  const actual = await original<typeof import("@/server/auth/session")>();
  return { ...actual, assertSameOrigin: async () => undefined };
});

import { env, resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { INBOX_NOT_ENABLED_MESSAGE, INBOX_UNAVAILABLE_MESSAGE } from "@/lib/inbox";
import { disableAllWorkspaces, inboxEnabledFor, inboxModeFor, listRollout, rolloutImpact, setWorkspaceRollout, setWorkspaceRolloutBulk, workspaceInboxOn } from "@/server/messaging/inbox-rollout";
import { announceIdleConversations, scanInboxAttention } from "@/server/messaging/attention";
import { createEscalation } from "@/server/messaging/handoff";
import { dispatchDue, dispatchMessage, queueOutbound } from "@/server/messaging/send";
import { memberActor } from "@/server/crm/actor";
import { createTag } from "@/server/crm/tags";
import { crmEventDispatch } from "@/server/crm/dispatch";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import { createWorkflow, publishWorkflow, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import { validateDefinition, type WorkflowDefinition, type WorkflowStep } from "@/lib/crm/workflow/spec";
import { GET as syncGET } from "@/app/api/inbox/sync/route";
import { GET as listGET } from "@/app/api/inbox/conversations/route";
import { GET as threadGET } from "@/app/api/inbox/conversations/[id]/route";
import { GET as contextGET } from "@/app/api/inbox/conversations/[id]/context/route";
import { POST as assistPOST } from "@/app/api/inbox/conversations/[id]/assist/route";
import { GET as escalationsGET } from "@/app/api/inbox/escalations/route";
import InboxPage from "@/app/(portal)/inbox/page";
import { LegacyInbox } from "@/app/(portal)/inbox/legacy-inbox";
import { LegacyInboxWorkspace } from "@/components/inbox/legacy-inbox-workspace";
import { InboxWorkspace } from "@/components/inbox/inbox-workspace";
import * as inboxActions from "@/app/actions/inbox";
import * as rolloutActions from "@/app/(admin)/admin/inbox-rollout/actions";
import { agencyUser, createOrg, createUser } from "./support/fixtures";
import { inbound, messageRow, messagingOrg, recordingProvider, type MessagingOrg } from "./support/messaging";

beforeAll(() => {
  delete process.env.INBOX_DISABLED;
  resetEnvCache();
});
beforeEach(() => {
  state.ctx = null;
  state.user = null;
});
afterEach(() => {
  delete process.env.INBOX_DISABLED;
  resetEnvCache();
});

const url = (p: string) => `http://localhost/api/inbox/${p}`;
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown) => new Request(url("x"), { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify(body) });
const ID = "5b3b2a4e-1111-4222-8333-444455556666";
const count = async (sql: string, p: unknown[] = []) => Number((await withSystem((db) => db.query<{ n: string }>(sql, p))).rows[0].n);

/** An agency member, as the session would hold them. */
async function agency(role: "agency_staff" | "agency_manager" | "agency_super_admin") {
  return agencyUser(await createUser({ platformRole: role, name: "Sasha Super" }), role);
}
async function superAdmin() {
  return agency("agency_super_admin");
}
const on = (org: MessagingOrg, by: SessionUser, note?: string) => setWorkspaceRollout(by, { orgId: org.org.id, enabled: true, note });
const off = (org: MessagingOrg, by: SessionUser, note?: string) => setWorkspaceRollout(by, { orgId: org.org.id, enabled: false, note });
const auditRows = async (orgId: string, action?: string) =>
  (await withSystem((db) => db.query<{ action: string; actor_user_id: string | null; actor_kind: string; target_id: string; metadata: Record<string, unknown>; result: string }>(
    "select action, actor_user_id, actor_kind, target_id, metadata, result from audit_logs where org_id = $1 and action like 'inbox.rollout_%' and ($2::text is null or action = $2) order by created_at, id", [orgId, action ?? null],
  ))).rows;

/** The routes the new inbox alone uses, each called as the currently signed-in person. */
const routes: Array<[string, () => Promise<Response>]> = [
  ["sync", () => syncGET(new Request(url("sync")))],
  ["list", () => listGET(new Request(url("conversations")))],
  ["thread", () => threadGET(new Request(url(`conversations/${ID}`)), params(ID))],
  ["context", () => contextGET(new Request(url(`conversations/${ID}/context`)), params(ID))],
  ["assist", () => assistPOST(post({ kind: "insights" }), params(ID))],
  ["escalations", () => escalationsGET()],
];

describe("a workspace that was never switched on", () => {
  let m: MessagingOrg;
  beforeAll(async () => {
    m = await messagingOrg({ name: "Not Yet Co", inboxRollout: false });
  });

  it("has no rollout row, which means off", async () => {
    expect(await count("select count(*)::text as n from inbox_rollout where org_id = $1", [m.org.id])).toBe(0);
    expect(await workspaceInboxOn(m.org.id)).toBe(false);
    expect(await inboxEnabledFor(m.org.id)).toBe(false);
    expect(await inboxModeFor(m.org.id)).toBe("legacy");
  });

  it("answers every new-inbox route with 403 'not_enabled' and the plain message, for every role, and reads nothing", async () => {
    for (const who of ["owner", "manager", "sales", "support", "viewer"] as const) {
      state.ctx = m.ctx(who);
      for (const [name, call] of routes) {
        const res = await call();
        expect(res.status, `${who} ${name}`).toBe(403);
        expect(res.headers.get("cache-control"), `${who} ${name}`).toBe("private, no-store");
        const body = await res.json();
        // A person whose role can't use a route is told so first (that check comes before the rollout's); everyone else is told the inbox isn't on.
        if (who === "viewer" && name === "assist") expect(body.code).toBe("forbidden");
        else expect(body, `${who} ${name}`).toMatchObject({ code: "not_enabled", error: INBOX_NOT_ENABLED_MESSAGE });
      }
    }
  });

  it("still asks a signed-out visitor to sign in first, so a rollout state is never revealed to someone who is not signed in", async () => {
    for (const [name, call] of routes) expect((await call()).status, name).toBe(401);
  });

  it("shows the previous inbox screen, which loads from today's services, instead of the new one", async () => {
    state.ctx = m.ctx("manager");
    const c = await inbound(m.org.id, { name: "Legacy Larry" });
    const el = (await InboxPage({ searchParams: Promise.resolve({ conversation: c.conversationId }) })) as { type: unknown; props: { ctx: OrgContext } };
    expect(el.type).toBe(LegacyInbox);
    expect(el.type).not.toBe(InboxWorkspace);
    expect(((await LegacyInbox(el.props as never)) as { type: unknown }).type).toBe(LegacyInboxWorkspace);
  });

  it("refuses the new-only actions with 'not_enabled', changing nothing, and leaves every action the previous screen uses working", async () => {
    state.ctx = m.ctx("owner");
    const c = await inbound(m.org.id, { name: "Shared Sally" });
    const before = await count("select count(*)::text as n from conversation_events where org_id = $1", [m.org.id]);
    for (const out of [
      await inboxActions.pauseAiAction(c.conversationId),
      await inboxActions.markUnreadAction(c.conversationId),
      await inboxActions.setLeadStatusAction(c.conversationId, "qualified"),
      await inboxActions.createTaskFromConversationAction(c.conversationId, { title: "Call back" }),
      await inboxActions.bulkConversationsAction([c.conversationId], { kind: "archive" }),
      await inboxActions.setConversationStateAction(c.conversationId, { archived: true }),
      await inboxActions.setConversationStateAction(c.conversationId, { outcome: "answered" }),
    ]) {
      expect(out).toEqual({ ok: false, error: INBOX_NOT_ENABLED_MESSAGE, code: "not_enabled" });
    }
    expect(await count("select count(*)::text as n from conversation_events where org_id = $1", [m.org.id])).toBe(before);
    expect((await withSystem((db) => db.query<{ archived_at: Date | null; ai_paused_at: Date | null }>("select archived_at, ai_paused_at from conversations where id = $1", [c.conversationId]))).rows[0]).toEqual({ archived_at: null, ai_paused_at: null });

    // What the previous screen does: read, take over, note, resolve with a plain status change.
    expect(await inboxActions.markReadAction(c.conversationId)).toEqual({ ok: true });
    expect((await inboxActions.takeOverAction(c.conversationId)).ok).toBe(true);
    expect((await inboxActions.addNoteAction(c.conversationId, "Spoke to the customer.")).ok).toBe(true);
    expect((await inboxActions.setConversationStateAction(c.conversationId, { status: "closed" })).ok).toBe(true);
    expect((await withSystem((db) => db.query<{ owner_kind: string; status: string }>("select owner_kind, status from conversations where id = $1", [c.conversationId]))).rows[0]).toEqual({ owner_kind: "human", status: "closed" });
  });

  it("keeps receiving and storing the customer's messages, and AI replies and settings still work, with no new-inbox notice", async () => {
    const before = await count("select count(*)::text as n from notifications where org_id = $1 and kind in ('conversation_new_inquiry', 'conversation_awaiting_reply', 'conversation_assigned')", [m.org.id]);
    const first = await inbound(m.org.id, { name: "Plain Pam", body: "Do you have a slot on Friday?" });
    expect(first.status).toBe("created");
    expect((await messageRow(first.messageId)).body).toBe("Do you have a slot on Friday?");
    // A repeat of the same provider message is still recognised, whatever the rollout says.
    expect((await inbound(m.org.id, { address: first.address, providerMessageId: (await messageRow(first.messageId)).provider_message_id as string })).status).not.toBe("created");
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and kind in ('conversation_new_inquiry', 'conversation_awaiting_reply', 'conversation_assigned')", [m.org.id])).toBe(before);
    // An AI employee's reply to that customer is queued and sent exactly as in a workspace with the new inbox.
    const q = await withSystem((db) => queueOutbound(db, { orgId: m.org.id, conversationId: first.conversationId, scope: "reply", actor: { kind: "ai", agentId: m.salesAgentId }, body: "Yes, Friday at 10 works." }));
    expect(q.status).toBe("queued");
    const { provider, calls } = recordingProvider();
    expect(await dispatchMessage(q.messageId, { provider })).toEqual({ status: "sent" });
    expect(calls).toHaveLength(1);
  });

  it("does not raise the new inbox's 'customer is waiting' notice or announce quiet conversations", async () => {
    const c = await inbound(m.org.id);
    await withSystem((db) => db.query("update conversations set unread_count = 1, last_outbound_at = null, last_inbound_at = now() - interval '45 minutes', last_message_at = now() - interval '45 minutes' where id = $1", [c.conversationId]));
    await scanInboxAttention();
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and kind = 'conversation_awaiting_reply'", [m.org.id])).toBe(0);
  });
});

describe("a workspace that is switched on", () => {
  it("answers the routes and shows the new inbox, and every new-only action works", async () => {
    const m = await messagingOrg({ name: "Switched On Co", inboxRollout: false });
    const admin = await superAdmin();
    await on(m, admin);
    expect(await inboxEnabledFor(m.org.id)).toBe(true);
    expect(await inboxModeFor(m.org.id)).toBe("new");
    state.ctx = m.ctx("manager");
    for (const name of ["sync", "list", "escalations"]) expect((await routes.find(([n]) => n === name)![1]()).status, name).toBe(200);
    expect((await threadGET(new Request(url("x")), params(ID))).status).toBe(404);
    const el = (await InboxPage({ searchParams: Promise.resolve({}) })) as { type: unknown };
    expect(el.type).toBe(InboxWorkspace);
    const c = await inbound(m.org.id);
    expect(await inboxActions.markUnreadAction(c.conversationId)).toEqual({ ok: true });
    expect((await inboxActions.pauseAiAction(c.conversationId)).ok).toBe(true);
  });

  it("is overridden by the global switch for every workspace at once, and comes back when the global switch is cleared", async () => {
    const m = await messagingOrg({ name: "Global Beats Local Co" });
    state.ctx = m.ctx("owner");
    expect((await syncGET(new Request(url("sync")))).status).toBe(200);
    process.env.INBOX_DISABLED = "true";
    resetEnvCache();
    expect(await inboxEnabledFor(m.org.id)).toBe(false);
    const res = await syncGET(new Request(url("sync")));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(INBOX_UNAVAILABLE_MESSAGE);
    // The rollout itself is untouched by the emergency switch.
    expect(await workspaceInboxOn(m.org.id)).toBe(true);
    delete process.env.INBOX_DISABLED;
    resetEnvCache();
    expect((await syncGET(new Request(url("sync")))).status).toBe(200);
  });
});

describe("workspaces are independent, and one cannot see another", () => {
  it("switching one workspace on or off changes nothing for the others", async () => {
    const a = await messagingOrg({ name: "Wave One A", inboxRollout: false });
    const b = await messagingOrg({ name: "Wave One B", inboxRollout: false });
    const c = await messagingOrg({ name: "Wave Two C", inboxRollout: false });
    const admin = await superAdmin();
    await on(a, admin);
    expect([await inboxEnabledFor(a.org.id), await inboxEnabledFor(b.org.id), await inboxEnabledFor(c.org.id)]).toEqual([true, false, false]);
    await on(c, admin);
    expect([await inboxEnabledFor(a.org.id), await inboxEnabledFor(b.org.id), await inboxEnabledFor(c.org.id)]).toEqual([true, false, true]);
    await off(a, admin);
    expect([await inboxEnabledFor(a.org.id), await inboxEnabledFor(b.org.id), await inboxEnabledFor(c.org.id)]).toEqual([false, false, true]);
    // The same through the routes: C works, A and B are refused.
    for (const [who, status] of [[a, 403], [b, 403], [c, 200]] as const) {
      state.ctx = who.ctx("owner");
      expect((await syncGET(new Request(url("sync")))).status, who.org.name).toBe(status);
    }
  });

  it("keeps the new inbox working for an enabled workspace while another stays disabled, including its notices and its scheduled scan", async () => {
    const enabled = await messagingOrg({ name: "Enabled Scan Co" });
    const disabled = await messagingOrg({ name: "Disabled Scan Co", inboxRollout: false });
    const waiting = async (org: MessagingOrg) => {
      const c = await inbound(org.org.id);
      await withSystem((db) => db.query("update conversations set unread_count = 1, last_outbound_at = null, last_inbound_at = now() - interval '45 minutes' where id = $1", [c.conversationId]));
    };
    await waiting(enabled);
    await waiting(disabled);
    expect((await scanInboxAttention()).notified).toBeGreaterThan(0);
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and kind = 'conversation_awaiting_reply'", [enabled.org.id])).toBeGreaterThan(0);
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and kind = 'conversation_awaiting_reply'", [disabled.org.id])).toBe(0);
    // A new inquiry nobody is handling raises its notice in the enabled workspace and not in the other.
    for (const org of [enabled, disabled]) await withSystem((db) => db.query("update agent_instances set enabled = false where org_id = $1 and role_key = 'sales_assistant'", [org.org.id]));
    await inbound(enabled.org.id, { name: "Fresh Fay" });
    await inbound(disabled.org.id, { name: "Fresh Finn" });
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and kind = 'conversation_new_inquiry'", [enabled.org.id])).toBeGreaterThan(0);
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and kind = 'conversation_new_inquiry'", [disabled.org.id])).toBe(0);
  });

  it("never lets one workspace's people reach another's conversations, enabled or not, and says nothing about whether it exists", async () => {
    const a = await messagingOrg({ name: "Tenant A" });
    const b = await messagingOrg({ name: "Tenant B", inboxRollout: false });
    const bConv = await inbound(b.org.id, { name: "B's Customer" });
    const aConv = await inbound(a.org.id, { name: "A's Customer" });
    // A is on, B is off. A's people ask for B's conversation: not found, not "not enabled" (that would say B exists), and no data.
    state.ctx = a.ctx("owner");
    for (const [name, res] of [
      ["thread", await threadGET(new Request(url("x")), params(bConv.conversationId))],
      ["context", await contextGET(new Request(url("x")), params(bConv.conversationId))],
    ] as const) {
      expect(res.status, name).toBe(404);
      expect(JSON.stringify(await res.json()), name).not.toContain("B's Customer");
    }
    const list = await (await listGET(new Request(url("conversations")))).json();
    expect(JSON.stringify(list)).not.toContain("B's Customer");
    expect(JSON.stringify(list)).toContain("A's Customer");
    // B's people ask for A's conversation: refused before anything is read, and nothing of A leaks.
    state.ctx = b.ctx("owner");
    const refused = await threadGET(new Request(url("x")), params(aConv.conversationId));
    expect(refused.status).toBe(403);
    expect(JSON.stringify(await refused.json())).not.toContain("A's Customer");
    // Once B is on too, A's conversation is still not found for B.
    await on(b, await superAdmin());
    expect((await threadGET(new Request(url("x")), params(aConv.conversationId))).status).toBe(404);
    expect((await threadGET(new Request(url("x")), params(bConv.conversationId))).status).toBe(200);
  });
});

describe("only a Super Admin can change the rollout", () => {
  it("refuses everyone else in the service, whatever the caller passed, and writes nothing", async () => {
    const m = await messagingOrg({ name: "Guarded Rollout Co", inboxRollout: false });
    const rows = () => count("select count(*)::text as n from inbox_rollout where org_id = $1", [m.org.id]);
    const members = [m.ctx("owner").user, m.ctx("manager").user, await agency("agency_staff"), await agency("agency_manager")];
    for (const who of members) {
      await expect(on(m, who), who.platformRole).rejects.toMatchObject({ code: "forbidden" });
      await expect(setWorkspaceRolloutBulk(who, { orgIds: [m.org.id], enabled: true }), who.platformRole).rejects.toMatchObject({ code: "forbidden" });
      await expect(disableAllWorkspaces(who), who.platformRole).rejects.toMatchObject({ code: "forbidden" });
      await expect(listRollout(who), who.platformRole).rejects.toMatchObject({ code: "forbidden" });
      await expect(rolloutImpact(who, m.org.id), who.platformRole).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(await rows()).toBe(0);
    expect(await auditRows(m.org.id)).toHaveLength(0);
    expect(await workspaceInboxOn(m.org.id)).toBe(false);
  });

  it("refuses the admin actions to a signed-out visitor, a workspace owner and agency staff, and lets a Super Admin through", async () => {
    const m = await messagingOrg({ name: "Action Guard Co", inboxRollout: false });
    const who: Array<[string, SessionUser | null, string]> = [
      ["signed out", null, "unauthenticated"],
      ["workspace owner", m.ctx("owner").user, "forbidden"],
      ["agency staff", await agency("agency_staff"), "forbidden"],
      ["agency manager", await agency("agency_manager"), "forbidden"],
    ];
    for (const [label, user, code] of who) {
      state.user = user;
      for (const out of [
        await rolloutActions.setWorkspaceRolloutAction(m.org.id, true),
        await rolloutActions.setWorkspaceRolloutBulkAction([m.org.id], true),
        await rolloutActions.disableAllWorkspacesAction(),
        await rolloutActions.rolloutImpactAction(m.org.id),
      ]) expect(out, label).toMatchObject({ ok: false, code });
    }
    expect(await workspaceInboxOn(m.org.id)).toBe(false);
    state.user = await superAdmin();
    expect(await rolloutActions.setWorkspaceRolloutAction(m.org.id, true, "Internal first")).toMatchObject({ ok: true, data: { orgId: m.org.id, enabled: true, changed: true } });
    expect(await workspaceInboxOn(m.org.id)).toBe(true);
    expect(await rolloutActions.setWorkspaceRolloutAction("not-a-workspace", true)).toMatchObject({ ok: false });
    expect(await rolloutActions.rolloutImpactAction(m.org.id)).toMatchObject({ ok: true });
  });

  it("checks the Super Admin level in every exported admin action, so a new one cannot skip it", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/app/(admin)/admin/inbox-rollout/actions.ts"), "utf8");
    const names = [...source.matchAll(/export async function (\w+)\(/g)].map((x) => x[1]);
    expect(names.length).toBeGreaterThanOrEqual(4);
    for (const n of names) {
      const start = source.indexOf(`export async function ${n}(`);
      const next = source.indexOf("\nexport async function ", start + 1);
      expect(source.slice(start, next === -1 ? undefined : next), n).toContain('requireAgencyOrThrow("super_admin")');
    }
    const page = fs.readFileSync(path.join(process.cwd(), "src/app/(admin)/admin/inbox-rollout/page.tsx"), "utf8");
    expect(page).toContain('requireAgency("super_admin")');
  });

  it("never touches the provider write switches: the service does not mention them, and a channel is exactly as it was after a rollout change", async () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/server/messaging/inbox-rollout.ts"), "utf8");
    expect(source).not.toMatch(/WRITES_ENABLED|messaging_channels\s+set|update\s+messaging_channels/i);
    const m = await messagingOrg({ name: "Provider Untouched Co", inboxRollout: false });
    const channels = () => withSystem((db) => db.query("select channel, provider, enabled, sender_identity, registration_status from messaging_channels where org_id = $1 order by channel", [m.org.id]));
    const writes = () => [env().GHL_WRITES_ENABLED, env().RESEND_WRITES_ENABLED, env().TWILIO_WRITES_ENABLED, env().META_WHATSAPP_WRITES_ENABLED];
    const before = { channels: (await channels()).rows, writes: writes() };
    const admin = await superAdmin();
    await on(m, admin);
    await off(m, admin);
    await on(m, admin);
    expect({ channels: (await channels()).rows, writes: writes() }).toEqual(before);
    expect(before.writes).toEqual([false, false, false, false]);
  });

  it("sends nothing to a provider while its write switch is off, even in a workspace that has the new inbox", async () => {
    const m = await messagingOrg({ name: "No Live Writes Co" });
    expect(await workspaceInboxOn(m.org.id)).toBe(true);
    const c = await inbound(m.org.id);
    const q = await withSystem((db) => queueOutbound(db, { orgId: m.org.id, conversationId: c.conversationId, scope: "reply", actor: { kind: "ai", agentId: m.salesAgentId }, body: "Held back." }));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await dispatchMessage(q.messageId);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
    expect((await messageRow(q.messageId)).status).not.toBe("sent");
  });
});

describe("changing the rollout is recorded", () => {
  it("writes who switched which workspace on or off, when, and why, and nothing when the state did not change", async () => {
    const m = await messagingOrg({ name: "Audited Co", inboxRollout: false });
    const admin = await superAdmin();
    expect(await on(m, admin, "  Internal first, week 1  ")).toEqual({ orgId: m.org.id, enabled: true, changed: true });
    expect(await on(m, admin, "again")).toEqual({ orgId: m.org.id, enabled: true, changed: false });
    const enabledRow = (await withSystem((db) => db.query<{ enabled: boolean; note: string | null; enabled_by: string | null; enabled_at: Date | null }>("select enabled, note, enabled_by, enabled_at from inbox_rollout where org_id = $1", [m.org.id]))).rows[0];
    expect(enabledRow).toMatchObject({ enabled: true, note: "Internal first, week 1", enabled_by: admin.id });
    expect(enabledRow.enabled_at).not.toBeNull();

    expect(await off(m, admin, "Pausing while we fix a bug")).toEqual({ orgId: m.org.id, enabled: false, changed: true });
    expect(await off(m, admin)).toMatchObject({ changed: false });
    const row = (await withSystem((db) => db.query<{ enabled: boolean; disabled_by: string | null; disabled_at: Date | null; note: string | null }>("select enabled, disabled_by, disabled_at, note from inbox_rollout where org_id = $1", [m.org.id]))).rows[0];
    expect(row).toMatchObject({ enabled: false, disabled_by: admin.id, note: "Pausing while we fix a bug" });

    const log = await auditRows(m.org.id);
    expect(log.map((r) => r.action)).toEqual(["inbox.rollout_enabled", "inbox.rollout_disabled"]);
    for (const r of log) expect(r).toMatchObject({ actor_user_id: admin.id, actor_kind: "agency", target_id: m.org.id, result: "success" });
    expect(log[0].metadata).toMatchObject({ via: "single", note: "Internal first, week 1" });
    expect(log[1].metadata).toMatchObject({ via: "single", note: "Pausing while we fix a bug", inFlight: { openConversations: 0, queuedAiReplies: 0, draftsAwaitingApproval: 0 } });
  });

  it("takes effect for this server at once (no wait for the cache), and an unknown workspace is not found", async () => {
    const m = await messagingOrg({ name: "Immediate Co", inboxRollout: false });
    const admin = await superAdmin();
    expect(await inboxEnabledFor(m.org.id)).toBe(false);
    await on(m, admin);
    expect(await inboxEnabledFor(m.org.id)).toBe(true);
    await off(m, admin);
    expect(await inboxEnabledFor(m.org.id)).toBe(false);
    await expect(setWorkspaceRollout(admin, { orgId: crypto.randomUUID(), enabled: true })).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps a note to 200 characters and an empty note as none", async () => {
    const m = await messagingOrg({ name: "Notes Co", inboxRollout: false });
    const admin = await superAdmin();
    await on(m, admin, "x".repeat(500));
    expect((await withSystem((db) => db.query<{ note: string }>("select note from inbox_rollout where org_id = $1", [m.org.id]))).rows[0].note).toHaveLength(200);
    const n = await messagingOrg({ name: "Blank Note Co", inboxRollout: false });
    await on(n, admin, "   ");
    expect((await withSystem((db) => db.query<{ note: string | null }>("select note from inbox_rollout where org_id = $1", [n.org.id]))).rows[0].note).toBeNull();
  });

  it("switches several workspaces on in one step, all or none, at most 25 at a time", async () => {
    const admin = await superAdmin();
    const a = await messagingOrg({ name: "Bulk A", inboxRollout: false });
    const b = await messagingOrg({ name: "Bulk B", inboxRollout: false });
    expect(await setWorkspaceRolloutBulk(admin, { orgIds: [a.org.id, b.org.id, a.org.id], enabled: true, note: "Wave 2" })).toEqual([
      { orgId: a.org.id, enabled: true, changed: true },
      { orgId: b.org.id, enabled: true, changed: true },
    ]);
    expect((await auditRows(a.org.id, "inbox.rollout_enabled"))[0].metadata).toMatchObject({ via: "bulk", note: "Wave 2" });
    // One bad id aborts the whole step: the good workspace is not switched on either, and nothing is written.
    const c = await messagingOrg({ name: "Bulk C", inboxRollout: false });
    await expect(setWorkspaceRolloutBulk(admin, { orgIds: [c.org.id, crypto.randomUUID()], enabled: true })).rejects.toMatchObject({ code: "not_found" });
    expect(await workspaceInboxOn(c.org.id)).toBe(false);
    expect(await auditRows(c.org.id)).toHaveLength(0);
    await expect(setWorkspaceRolloutBulk(admin, { orgIds: [], enabled: true })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(setWorkspaceRolloutBulk(admin, { orgIds: Array.from({ length: 26 }, () => crypto.randomUUID()), enabled: true })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("at most 25") });
  });

  it("lists every workspace with its state, the internal workspace first, for a Super Admin only", async () => {
    const admin = await superAdmin();
    const internal = await createOrg({ name: "Internal Agency Co", kind: "agency" });
    const client = await messagingOrg({ name: "Listed Client", inboxRollout: false });
    await on(client, admin);
    const rows = await listRollout(admin);
    expect(rows[0].kind).toBe("agency");
    expect(rows.map((r) => r.orgId)).toEqual(expect.arrayContaining([internal.id, client.org.id]));
    expect(rows.find((r) => r.orgId === internal.id)).toMatchObject({ enabled: false, enabledAt: null });
    expect(rows.find((r) => r.orgId === client.org.id)).toMatchObject({ enabled: true, enabledByName: "Sasha Super", liveChannels: 3 });
    // A workspace that is on is listed before the ones that are not (after the internal workspace).
    const clients = rows.filter((r) => r.kind === "client");
    expect(clients.findIndex((r) => r.orgId === client.org.id)).toBeLessThan(clients.findIndex((r) => !r.enabled));
  });
});

describe("switching a workspace off keeps what is in flight", () => {
  /** Everything a customer or a teammate is waiting on, read directly so a change shows up as a difference. */
  const inFlight = (orgId: string) =>
    withSystem(async (db) => ({
      messages: (await db.query("select id, direction, status, author_kind, body, blocked_reason, approval_id from conversation_messages where org_id = $1 order by id", [orgId])).rows,
      conversations: (await db.query("select id, status, owner_kind, owner_user_id, assigned_user_id, ai_paused_at, ownership_version, unread_count from conversations where org_id = $1 order by id", [orgId])).rows,
      escalations: (await db.query("select id, conversation_id, status from human_escalations where org_id = $1 order by id", [orgId])).rows,
      approvals: (await db.query("select id, status from approval_requests where org_id = $1 order by id", [orgId])).rows,
      notifications: (await db.query("select id, kind, read_at from notifications where org_id = $1 order by id", [orgId])).rows,
      channels: (await db.query("select channel, enabled from messaging_channels where org_id = $1 order by channel", [orgId])).rows,
    }));

  async function busyWorkspace() {
    const m = await messagingOrg({ name: `Busy ${Math.random().toString(36).slice(2, 7)} Co` });
    const queued = await inbound(m.org.id, { name: "Queued Quinn" });
    const q = await withSystem((db) => queueOutbound(db, { orgId: m.org.id, conversationId: queued.conversationId, scope: "reply", actor: { kind: "ai", agentId: m.salesAgentId }, body: "Happy to help with that." }));
    expect(q.status).toBe("queued");
    const paused = await inbound(m.org.id, { name: "Paused Pat" });
    await withSystem((db) => db.query("update conversations set ai_paused_at = now() where id = $1", [paused.conversationId]));
    const escalated = await inbound(m.org.id, { name: "Escalated Eve" });
    const esc = await withSystem((db) => createEscalation(db, { orgId: m.org.id, conversationId: escalated.conversationId, category: "complaint", summary: "Customer needs a person.", agentId: m.salesAgentId }));
    // A draft awaiting approval: the same employee, now needing approval.
    await withSystem((db) => db.query("update agent_instances set mode = 'approval_required' where id = $1", [m.salesAgentId]));
    const drafted = await inbound(m.org.id, { name: "Drafted Dee" });
    const d = await withSystem((db) => queueOutbound(db, { orgId: m.org.id, conversationId: drafted.conversationId, scope: "reply", actor: { kind: "ai", agentId: m.salesAgentId }, body: "Draft awaiting a person." }));
    expect(d.status).toBe("draft");
    await withSystem((db) => db.query("update agent_instances set mode = 'autonomous' where id = $1", [m.salesAgentId]));
    return { m, queued, q, paused, escalated, esc, drafted, d };
  }

  it("changes no queued reply, draft, escalation, pause, approval, notification or channel, and records what was in flight", async () => {
    const w = await busyWorkspace();
    const admin = await superAdmin();
    const impact = await rolloutImpact(admin, w.m.org.id);
    expect(impact).toMatchObject({ aiPaused: 1, openEscalations: 1, queuedAiReplies: 1, draftsAwaitingApproval: 1, liveChannels: 3 });
    expect(impact.openConversations).toBeGreaterThanOrEqual(4);
    const before = await inFlight(w.m.org.id);
    await off(w.m, admin, "Rollback drill");
    // Every row except the audit entry is exactly as it was.
    expect(await inFlight(w.m.org.id)).toEqual(before);
    expect((await auditRows(w.m.org.id, "inbox.rollout_disabled"))[0].metadata).toMatchObject({ via: "single", inFlight: { aiPaused: 1, openEscalations: 1, queuedAiReplies: 1, draftsAwaitingApproval: 1 } });
    await on(w.m, admin);
    expect(await inFlight(w.m.org.id)).toEqual(before);
  });

  it("still delivers the queued AI reply while the new inbox is off, and loses no inbound message", async () => {
    const w = await busyWorkspace();
    const admin = await superAdmin();
    await off(w.m, admin);
    const { provider, calls } = recordingProvider();
    const out = await dispatchDue({ provider });
    expect(out.attempted).toBeGreaterThanOrEqual(1);
    expect(calls.map((c) => c.body)).toContain("Happy to help with that.");
    expect((await messageRow(w.q.messageId)).status).toBe("sent");
    // The draft is still waiting for a person, not sent and not discarded.
    expect(calls.map((c) => c.body)).not.toContain("Draft awaiting a person.");
    expect((await messageRow(w.d.messageId)).status).toBe("draft");
    // A customer writing now is received, stored and recognised on repeat, with the new inbox off.
    const msg = await inbound(w.m.org.id, { address: w.queued.address, name: "Queued Quinn", body: "Thanks, one more question." });
    expect((await messageRow(msg.messageId)).body).toBe("Thanks, one more question.");
    expect(await count("select count(*)::text as n from conversation_messages where conversation_id = $1 and direction = 'inbound'", [w.queued.conversationId])).toBe(2);
  });

  it("leaves a person able to answer the escalation, take over and reply from the previous screen", async () => {
    const w = await busyWorkspace();
    await off(w.m, await superAdmin());
    state.ctx = w.m.ctx("owner");
    expect((await inboxActions.claimEscalationAction(w.esc.escalationId)).ok).toBe(true);
    expect((await inboxActions.resolveEscalationAction(w.esc.escalationId, "Called the customer and sorted it out.")).ok).toBe(true);
    expect((await inboxActions.takeOverAction(w.paused.conversationId)).ok).toBe(true);
    // Approving the draft goes through the ordinary send path. Live writes are off here, so it is held back with that reason and nothing leaves the server.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      expect((await inboxActions.approveDraftAction(w.d.messageId)).ok).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
    expect(await messageRow(w.d.messageId)).toMatchObject({ status: "blocked", blocked_reason: "provider_not_enabled" });
    expect((await withSystem((db) => db.query<{ status: string }>("select status from human_escalations where id = $1", [w.esc.escalationId]))).rows[0].status).not.toMatch(/open|awaiting|claimed/);
  });

  it("stops only the new inbox's own announcements, and brings them back when it is switched on again", async () => {
    const m = await messagingOrg({ name: "Back And Forth Co", inboxRollout: false });
    const admin = await superAdmin();
    const waiting = await inbound(m.org.id);
    await withSystem((db) => db.query("update conversations set unread_count = 1, last_outbound_at = null, last_inbound_at = now() - interval '45 minutes' where id = $1", [waiting.conversationId]));
    await scanInboxAttention();
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and kind = 'conversation_awaiting_reply'", [m.org.id])).toBe(0);
    await on(m, admin);
    await scanInboxAttention();
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and kind = 'conversation_awaiting_reply'", [m.org.id])).toBeGreaterThan(0);
  });

  it("rolls every workspace back in one step, records each, and a second rollback finds nothing to do", async () => {
    const admin = await superAdmin();
    await disableAllWorkspaces(admin);
    const a = await messagingOrg({ name: "Rollback A", inboxRollout: false });
    const b = await messagingOrg({ name: "Rollback B", inboxRollout: false });
    const c = await messagingOrg({ name: "Rollback C", inboxRollout: false });
    await setWorkspaceRolloutBulk(admin, { orgIds: [a.org.id, b.org.id], enabled: true });
    const out = await disableAllWorkspaces(admin, "Stage 7 rollback drill");
    expect(out.map((o) => o.orgId).sort()).toEqual([a.org.id, b.org.id].sort());
    expect(out.every((o) => o.changed && o.enabled === false)).toBe(true);
    expect(await Promise.all([a, b, c].map((x) => inboxEnabledFor(x.org.id)))).toEqual([false, false, false]);
    for (const x of [a, b]) {
      const log = await auditRows(x.org.id, "inbox.rollout_disabled");
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ actor_user_id: admin.id, metadata: expect.objectContaining({ via: "disable_all", note: "Stage 7 rollback drill" }) });
    }
    expect(await auditRows(c.org.id)).toHaveLength(0);
    expect(await disableAllWorkspaces(admin)).toEqual([]);
    // Each workspace is back on the previous screen at once.
    for (const x of [a, b]) {
      state.ctx = x.ctx("owner");
      expect((await InboxPage({ searchParams: Promise.resolve({}) }) as { type: unknown }).type).toBe(LegacyInbox);
    }
  });
});

describe("workflows follow the rollout", () => {
  const step = (key: string, kind: WorkflowStep["kind"], config: Record<string, unknown>): WorkflowStep => ({ key, kind, config, next: null }) as WorkflowStep;
  const settle = async () => {
    for (let i = 0; i < 40; i += 1) {
      const d = await crmEventDispatch();
      const r = await processWorkflowRuns();
      if (!d.claimed && !r.claimed && !r.scheduled) return;
    }
  };
  const resolveStep = step("act", "conversation_action", { action: "resolve" });
  const errors = (def: unknown, inboxEnabled: boolean) => validateDefinition(def, { inboxEnabled } as never).filter((i) => i.level === "error").map((i) => i.code);

  it("refuses the conversation triggers and the Update conversation step where the new inbox is off, and nowhere else", () => {
    for (const type of ["conversation.assigned", "conversation.resolved", "conversation.urgent", "conversation.handoff_requested"]) {
      const def = { trigger: { type }, steps: [step("note", "internal_note", { body: "Seen" })] };
      expect(errors(def, false), type).toContain("inbox_not_enabled");
      expect(errors(def, true), type).not.toContain("inbox_not_enabled");
    }
    const updates = { trigger: { type: "conversation.message_received" }, steps: [resolveStep] } as unknown as WorkflowDefinition;
    expect(errors(updates, false)).toContain("inbox_not_enabled");
    expect(errors(updates, true)).not.toContain("inbox_not_enabled");
    // A workflow that uses neither is no business of the rollout.
    const plain = { trigger: { type: "contact.created" }, steps: [step("note", "internal_note", { body: "Hi" })] };
    expect(errors(plain, false)).not.toContain("inbox_not_enabled");
  });

  it("will not publish such a workflow in a workspace that is off, and publishes it once the workspace is on", async () => {
    const m = await messagingOrg({ name: "Publish Gate Co", inboxRollout: false });
    const actor = memberActor(m.ctx("owner"));
    const def = { trigger: { type: "conversation.message_received" }, steps: [resolveStep] } as unknown as WorkflowDefinition;
    const { id } = await createWorkflow(actor, { name: "Resolve everything", definition: def });
    await expect(publishWorkflow(actor, id)).rejects.toThrow(/new inbox isn't switched on/);
    await on(m, await superAdmin());
    expect((await publishWorkflow(actor, id)).needsApproval).toBe(false);
  });

  it("lets a published workflow keep running when the inbox goes off, but its Update conversation step then changes nothing and says why", async () => {
    const m = await messagingOrg({ name: "Runtime Gate Co" });
    const admin = await superAdmin();
    const actor = memberActor(m.ctx("owner"));
    const { id } = await createWorkflow(actor, { name: "Resolve on message", definition: { trigger: { type: "conversation.message_received" }, steps: [resolveStep] } as unknown as WorkflowDefinition });
    await publishWorkflow(actor, id);
    await setWorkflowStatus(actor, id, "active");
    await off(m, admin);
    const c = await inbound(m.org.id);
    await settle();
    expect((await withSystem((db) => db.query<{ status: string }>("select status from conversations where id = $1", [c.conversationId]))).rows[0].status).toBe("open");
    const steps = (await withSystem((db) => db.query<{ status: string; result: Record<string, unknown> }>(
      "select s.status, s.result from crm_workflow_run_steps s join crm_workflow_runs r on r.id = s.run_id and r.org_id = s.org_id where r.workflow_id = $1 and s.kind = 'conversation_action'", [id],
    ))).rows;
    expect(steps).toHaveLength(1);
    expect(steps[0].result).toMatchObject({ outcome: "blocked", reason: "inbox_not_enabled" });
    // Switched on again, the same workflow resolves the next conversation.
    await on(m, admin);
    const next = await inbound(m.org.id);
    await settle();
    expect((await withSystem((db) => db.query<{ status: string }>("select status from conversations where id = $1", [next.conversationId]))).rows[0].status).toBe("closed");
  });

  it("announces quiet conversations only for workspaces that have the new inbox", async () => {
    const m = await messagingOrg({ name: "Idle Gate Co" });
    const admin = await superAdmin();
    const actor = memberActor(m.ctx("owner"));
    const tag = await createTag(actor, { name: "Went quiet", color: "#2563eb" });
    const { id } = await createWorkflow(actor, { name: "Quiet", definition: { trigger: { type: "conversation.idle", filters: { idleHours: [24] } }, steps: [step("tag", "add_tag", { tagIds: [tag.id] })] } as unknown as WorkflowDefinition });
    await publishWorkflow(actor, id);
    await setWorkflowStatus(actor, id, "active");
    const c = await inbound(m.org.id);
    await withSystem((db) => db.query("update conversations set last_message_at = now() - interval '25 hours' where id = $1", [c.conversationId]));
    await off(m, admin);
    expect(await withSystem((db) => announceIdleConversations(db))).toBe(0);
    await on(m, admin);
    expect(await withSystem((db) => announceIdleConversations(db))).toBe(1);
  });
});

describe("the rollout table", () => {
  it("is invisible to the application role: row-level security on, no privileges, so only trusted server code can read or write it", async () => {
    const rls = await withSystem((db) => db.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname = 'inbox_rollout' and relkind = 'r'"));
    expect(rls.rows[0].relrowsecurity).toBe(true);
    const grants = await withSystem((db) => db.query<{ grantee: string; privilege_type: string }>("select grantee, privilege_type from information_schema.role_table_grants where table_name = 'inbox_rollout' and grantee in ('iaq_app_user', 'anon', 'authenticated', 'PUBLIC')"));
    expect(grants.rows).toEqual([]);
  });

  it("follows its workspace when that is deleted, keeps the history if a Super Admin's account goes, and refuses a note over 200 characters", async () => {
    const m = await messagingOrg({ name: "Cascade Co" });
    expect(await count("select count(*)::text as n from inbox_rollout where org_id = $1", [m.org.id])).toBe(1);
    await expect(withSystem((db) => db.query("update inbox_rollout set note = $2 where org_id = $1", [m.org.id, "x".repeat(201)]))).rejects.toThrow(/note|check/i);
    const fks = await withSystem((db) => db.query<{ ref: string; del: string }>(
      "select confrelid::regclass::text as ref, confdeltype as del from pg_constraint where conrelid = 'inbox_rollout'::regclass and contype = 'f' order by 1",
    ));
    // The workspace's own row is removed with it ('c' cascade); a person's account going only clears the name ('n' set null).
    expect(fks.rows).toEqual([{ ref: "organizations", del: "c" }, { ref: "users", del: "n" }, { ref: "users", del: "n" }]);
  });
});
