import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { OrgContext } from "@/server/tenancy/context";

// The inbox kill switch (INBOX_DISABLED): off takes the /inbox page, /api/inbox/*, the inbox's server actions and the inbox's notices away and answers
// "temporarily unavailable"; unset or false (the default) changes nothing. Receiving and storing messages is never touched.

const state = vi.hoisted(() => ({ ctx: null as null | OrgContext, authCalls: 0, originCalls: 0 }));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/tenancy/context", async (original) => {
  const actual = await original<typeof import("@/server/tenancy/context")>();
  const { AppError } = await import("@/server/errors");
  const need = (permission?: string) => {
    state.authCalls += 1;
    if (!state.ctx) throw new AppError("unauthenticated", "Sign in to continue.");
    if (permission && !state.ctx.can(permission as never)) throw new AppError("forbidden", "Your role doesn't allow this action. Ask a workspace owner for access.");
    return state.ctx;
  };
  return { ...actual, requireOrgContextOrThrow: async (permission?: string) => need(permission), requireOrgContext: async (permission?: string) => need(permission) };
});
vi.mock("@/server/auth/session", async (original) => {
  const actual = await original<typeof import("@/server/auth/session")>();
  return { ...actual, assertSameOrigin: async () => { state.originCalls += 1; } };
});

import { env, resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { AppError, toPublicError } from "@/server/errors";
import { INBOX_UNAVAILABLE_MESSAGE } from "@/lib/inbox";
import { assertInboxEnabled, inboxEnabled } from "@/server/messaging/inbox-switch";
import { scanInboxAttention } from "@/server/messaging/attention";
import { GET as syncGET } from "@/app/api/inbox/sync/route";
import { GET as listGET } from "@/app/api/inbox/conversations/route";
import { GET as threadGET } from "@/app/api/inbox/conversations/[id]/route";
import { GET as contextGET } from "@/app/api/inbox/conversations/[id]/context/route";
import { POST as assistPOST } from "@/app/api/inbox/conversations/[id]/assist/route";
import { GET as escalationsGET } from "@/app/api/inbox/escalations/route";
import InboxPage from "@/app/(portal)/inbox/page";
import * as inboxActions from "@/app/actions/inbox";
import { InboxWorkspace } from "@/components/inbox/inbox-workspace";
import { inbound, messagingOrg, type MessagingOrg } from "./support/messaging";

const setSwitch = (value: string | undefined) => {
  if (value === undefined) delete process.env.INBOX_DISABLED;
  else process.env.INBOX_DISABLED = value;
  resetEnvCache();
};

let m: MessagingOrg;
beforeAll(async () => {
  setSwitch(undefined);
  m = await messagingOrg({ name: "Switch Co" });
});
beforeEach(() => {
  state.ctx = null;
  state.authCalls = 0;
  state.originCalls = 0;
});
afterEach(() => setSwitch(undefined));

const url = (path: string) => `http://localhost/api/inbox/${path}`;
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown) => new Request(url("x"), { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify(body) });
const ID = "5b3b2a4e-1111-4222-8333-444455556666";
const routes: Array<[string, () => Promise<Response>]> = [
  ["sync", () => syncGET(new Request(url("sync")))],
  ["list", () => listGET(new Request(url("conversations")))],
  ["thread", () => threadGET(new Request(url(`conversations/${ID}`)), params(ID))],
  ["context", () => contextGET(new Request(url(`conversations/${ID}/context`)), params(ID))],
  ["assist", () => assistPOST(post({ kind: "insights" }), params(ID))],
  ["escalations", () => escalationsGET()],
];

describe("the flag", () => {
  it("is on by default, and off only for an explicit true or 1", () => {
    setSwitch(undefined);
    expect(inboxEnabled()).toBe(true);
    for (const v of ["false", "0", ""]) {
      setSwitch(v);
      expect(inboxEnabled(), `INBOX_DISABLED=${v}`).toBe(true);
    }
    for (const v of ["true", "1"]) {
      setSwitch(v);
      expect(inboxEnabled(), `INBOX_DISABLED=${v}`).toBe(false);
    }
  });

  it("refuses a value it does not understand instead of guessing, so a typo is loud and never silently leaves the inbox on", () => {
    setSwitch("yes");
    expect(() => env()).toThrow(/INBOX_DISABLED/);
  });

  it("throws a 503 'unavailable' error with a retry time only while off", () => {
    setSwitch(undefined);
    expect(() => assertInboxEnabled()).not.toThrow();
    setSwitch("true");
    let caught: unknown;
    try {
      assertInboxEnabled();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(toPublicError(caught)).toEqual({ code: "unavailable", message: INBOX_UNAVAILABLE_MESSAGE, status: 503, retryAfterSeconds: 60 });
  });
});

describe("/api/inbox/* while switched off", () => {
  it("answers every route with 503, a retry time and the plain message, before any sign-in or database work, and never caches it", async () => {
    setSwitch("true");
    for (const [name, call] of routes) {
      const res = await call();
      expect(res.status, name).toBe(503);
      expect(res.headers.get("retry-after"), name).toBe("60");
      expect(res.headers.get("cache-control"), name).toBe("private, no-store");
      expect(await res.json(), name).toEqual({ error: INBOX_UNAVAILABLE_MESSAGE, code: "unavailable", retryAfterSeconds: 60 });
    }
    expect(state.authCalls).toBe(0);
    expect(state.originCalls).toBe(0);
  });

  it("answers the same to someone who is signed in with every permission", async () => {
    setSwitch("true");
    state.ctx = m.ctx("owner");
    for (const [name, call] of routes) expect((await call()).status, name).toBe(503);
    expect(state.authCalls).toBe(0);
  });

  it("changes nothing when it is on: the same routes still answer as before", async () => {
    setSwitch(undefined);
    expect((await syncGET(new Request(url("sync")))).status).toBe(401);
    state.ctx = m.ctx("manager");
    for (const [name, call] of routes.filter(([n]) => n === "sync" || n === "list" || n === "escalations")) expect((await call()).status, name).toBe(200);
    expect((await threadGET(new Request(url("x")), params(ID))).status).toBe(404);
  });
});

describe("the /inbox page while switched off", () => {
  const render = async () => renderToStaticMarkup((await InboxPage({ searchParams: Promise.resolve({}) })) as never);

  it("shows the unavailable notice, still after the sign-in check, and reads no inbox data", async () => {
    setSwitch("true");
    state.ctx = m.ctx("owner");
    // A conversation exists and is open in a link; none of it is read.
    const c = await inbound(m.org.id, { name: "Hidden Hana" });
    const el = (await InboxPage({ searchParams: Promise.resolve({ conversation: c.conversationId }) })) as { type: unknown };
    expect(el.type).not.toBe(InboxWorkspace);
    const html = renderToStaticMarkup(el as never);
    expect(html).toContain(INBOX_UNAVAILABLE_MESSAGE.replace(/'/g, "&#x27;"));
    expect(html).toContain("<h1");
    expect(html).toContain("Messages from your customers are still being received and kept");
    expect(html).toContain('href="/overview"');
    expect(html).not.toContain("Hidden Hana");
    expect(html).not.toContain("Search customers or messages");
    expect(state.authCalls).toBe(1);
  });

  it("still sends a signed-out visitor to sign in (the check runs first), and shows the inbox as usual when it is on", async () => {
    setSwitch("true");
    await expect(render()).rejects.toThrow(/Sign in/);
    setSwitch(undefined);
    state.ctx = m.ctx("manager");
    const el = (await InboxPage({ searchParams: Promise.resolve({}) })) as { type: unknown };
    expect(el.type).toBe(InboxWorkspace);
  });
});

describe("the inbox's server actions while switched off", () => {
  // The settings that share the actions file (messaging settings, channel switches, availability, notification preferences, escalation authorization)
  // are not the inbox screen and keep working. Every other action is the inbox's and must refuse.
  const SETTINGS = new Set(["updateMessagingSettingsAction", "setChannelEnabledAction", "setAvailabilityAction", "setNotificationPreferencesAction", "setOwnerPriorityModeAction", "setEscalationAuthorizationAction"]);
  const all = Object.entries(inboxActions).filter(([n, f]) => n.endsWith("Action") && typeof f === "function") as Array<[string, (...a: unknown[]) => Promise<{ ok: boolean; code?: string; error?: string }>]>;
  const call = (f: (...a: unknown[]) => Promise<{ ok: boolean; code?: string; error?: string }>) => f("x", "x", "x", "x", "x");

  it("covers every action in the file (a new one has to be classified here)", () => {
    expect(all.length).toBeGreaterThanOrEqual(33);
    for (const s of SETTINGS) expect(all.map(([n]) => n)).toContain(s);
  });

  it("refuses every inbox action with the plain message, touching neither the session nor the database", async () => {
    setSwitch("true");
    const before = (await withSystem((db) => db.query<{ n: string }>("select count(*)::text as n from conversation_messages"))).rows[0].n;
    for (const [name, fn] of all.filter(([n]) => !SETTINGS.has(n))) {
      expect(await call(fn), name).toEqual({ ok: false, error: INBOX_UNAVAILABLE_MESSAGE, code: "unavailable" });
    }
    expect(state.authCalls).toBe(0);
    expect((await withSystem((db) => db.query<{ n: string }>("select count(*)::text as n from conversation_messages"))).rows[0].n).toBe(before);
  });

  it("leaves the settings actions alone: they go on to their own checks as usual", async () => {
    setSwitch("true");
    for (const [name, fn] of all.filter(([n]) => SETTINGS.has(n))) {
      const out = await call(fn);
      expect(out.code, name).not.toBe("unavailable");
      expect(out.code, name).toBe("unauthenticated");
    }
    expect(state.authCalls).toBeGreaterThan(0);
  });

  it("works as before when it is on", async () => {
    setSwitch(undefined);
    state.ctx = m.ctx("manager");
    const c = await inbound(m.org.id, { name: "Read Rina" });
    expect(await inboxActions.markReadAction(c.conversationId)).toEqual({ ok: true });
    state.ctx = null;
    expect((await inboxActions.markReadAction(c.conversationId)).ok).toBe(false);
  });
});

describe("the inbox's notices and the messaging core while switched off", () => {
  const notices = async (orgId: string, kind: string) =>
    Number((await withSystem((db) => db.query<{ n: string }>("select count(*)::text as n from notifications where org_id = $1 and kind = $2", [orgId, kind]))).rows[0].n);

  it("raises no 'customer is waiting' notice, and raises it again once the inbox is back on", async () => {
    const org = await messagingOrg({ name: "Quiet Notices Co" });
    const c = await inbound(org.org.id);
    await withSystem((db) => db.query("update conversations set unread_count = 1, last_outbound_at = null, last_inbound_at = now() - interval '45 minutes' where id = $1", [c.conversationId]));
    setSwitch("true");
    expect(await scanInboxAttention()).toMatchObject({ notified: 0 });
    expect(await notices(org.org.id, "conversation_awaiting_reply")).toBe(0);
    setSwitch(undefined);
    expect((await scanInboxAttention()).notified).toBeGreaterThan(0);
    expect(await notices(org.org.id, "conversation_awaiting_reply")).toBeGreaterThan(0);
  });

  it("still receives and keeps the customer's message, with no new-inquiry notice pointing at a screen nobody can open", async () => {
    const org = await messagingOrg({ name: "Ingest Still Works Co" });
    await withSystem((db) => db.query("update agent_instances set enabled = false where org_id = $1 and role_key = 'sales_assistant'", [org.org.id]));
    setSwitch("true");
    const off = await inbound(org.org.id, { name: "While Off", body: "Is anyone there?" });
    expect(off.status).toBe("created");
    expect((await withSystem((db) => db.query("select 1 from conversation_messages where id = $1 and body = 'Is anyone there?'", [off.messageId]))).rows).toHaveLength(1);
    expect(await notices(org.org.id, "conversation_new_inquiry")).toBe(0);
    setSwitch(undefined);
    await inbound(org.org.id, { name: "While On" });
    expect(await notices(org.org.id, "conversation_new_inquiry")).toBeGreaterThan(0);
  });
});
