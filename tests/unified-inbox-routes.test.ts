import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgContext } from "@/server/tenancy/context";

// The inbox's HTTP routes against a real (embedded) database. Only the session is stand-in: the route decides from the person's role and
// workspace, so a signed-out caller, a role without the permission, a foreign origin and a conversation of another workspace are all refused here.

const state = vi.hoisted(() => ({ ctx: null as null | OrgContext, origin: true }));

vi.mock("@/server/tenancy/context", async (original) => {
  const actual = await original<typeof import("@/server/tenancy/context")>();
  const { AppError } = await import("@/server/errors");
  return {
    ...actual,
    requireOrgContextOrThrow: async (permission?: string) => {
      if (!state.ctx) throw new AppError("unauthenticated", "Sign in to continue.");
      if (permission && !state.ctx.can(permission as never)) throw new AppError("forbidden", "Your role doesn't allow this action. Ask a workspace owner for access.");
      return state.ctx;
    },
  };
});
vi.mock("@/server/auth/session", async (original) => {
  const actual = await original<typeof import("@/server/auth/session")>();
  const { AppError } = await import("@/server/errors");
  return {
    ...actual,
    assertSameOrigin: async () => {
      if (!state.origin) throw new AppError("forbidden", "Cross-site requests are not allowed.");
    },
  };
});

import { resetEnvCache } from "@/server/env";
import { assignConversation } from "@/server/messaging/handoff";
import { pollAllowed } from "@/server/messaging/inbox-http";
import { GET as syncGET } from "@/app/api/inbox/sync/route";
import { GET as listGET } from "@/app/api/inbox/conversations/route";
import { GET as threadGET } from "@/app/api/inbox/conversations/[id]/route";
import { GET as contextGET } from "@/app/api/inbox/conversations/[id]/context/route";
import { POST as assistPOST } from "@/app/api/inbox/conversations/[id]/assist/route";
import { GET as escalationsGET } from "@/app/api/inbox/escalations/route";
import { inbound, messagingOrg, type MessagingOrg } from "./support/messaging";

let a: MessagingOrg;
let b: MessagingOrg;
beforeAll(async () => {
  resetEnvCache();
  a = await messagingOrg({ name: "Routes Co A" });
  b = await messagingOrg({ name: "Routes Co B" });
});
beforeEach(() => {
  state.ctx = null;
  state.origin = true;
});

const url = (path: string) => `http://localhost/api/inbox/${path}`;
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown) => new Request(url("x"), { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify(body) });
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
const ID = "5b3b2a4e-1111-4222-8333-444455556666";

const reads: Array<[string, () => Promise<Response>]> = [
  ["sync", () => syncGET(new Request(url("sync")))],
  ["list", () => listGET(new Request(url("conversations")))],
  ["thread", () => threadGET(new Request(url(`conversations/${ID}`)), params(ID))],
  ["context", () => contextGET(new Request(url(`conversations/${ID}/context`)), params(ID))],
  ["escalations", () => escalationsGET()],
];

describe("who may call the inbox routes", () => {
  it("answers a signed-out caller with 401 and says nothing else", async () => {
    for (const [name, call] of reads) {
      const res = await call();
      expect(res.status, name).toBe(401);
      expect(await json(res), name).toMatchObject({ code: "unauthenticated" });
    }
    expect((await assistPOST(post({ kind: "insights" }), params(ID))).status).toBe(401);
  });

  it("never lets a response be cached by anything shared", async () => {
    state.ctx = a.ctx("manager");
    for (const [name, call] of reads.filter(([n]) => n === "sync" || n === "list" || n === "escalations")) {
      const res = await call();
      expect(res.status, name).toBe(200);
      expect(res.headers.get("cache-control"), name).toBe("private, no-store");
      expect(res.headers.get("vary"), name).toContain("Cookie");
    }
  });

  it("refuses AI help to a role that can't reply, to a foreign origin, to a bad id and to a request that names nothing", async () => {
    const c = await inbound(a.org.id);
    state.ctx = a.ctx("viewer");
    expect((await assistPOST(post({ kind: "insights" }), params(c.conversationId))).status).toBe(403);
    state.ctx = a.ctx("manager");
    state.origin = false;
    expect((await assistPOST(post({ kind: "insights" }), params(c.conversationId))).status).toBe(403);
    state.origin = true;
    expect((await assistPOST(post({ kind: "insights" }), params("not-an-id"))).status).toBe(404);
    const res = await assistPOST(post({ kind: "send" }), params(c.conversationId));
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ code: "invalid_input" });
    expect((await assistPOST(new Request(url("x"), { method: "POST", body: "not json" }), params(c.conversationId))).status).toBe(400);
  });
});

describe("the boundary between workspaces and between people", () => {
  it("answers a conversation of another workspace exactly like one that does not exist", async () => {
    const mine = await inbound(a.org.id);
    state.ctx = b.ctx("owner");
    for (const call of [
      () => threadGET(new Request(url("x")), params(mine.conversationId)),
      () => contextGET(new Request(url("x")), params(mine.conversationId)),
      () => threadGET(new Request(url("x")), params(ID)),
      () => contextGET(new Request(url("x")), params(ID)),
    ]) {
      const res = await call();
      expect(res.status).toBe(404);
      expect(await json(res)).toMatchObject({ error: "Conversation not found." });
    }
    // And its owner reads it fine.
    state.ctx = a.ctx("owner");
    const ok = await threadGET(new Request(url("x")), params(mine.conversationId));
    expect(ok.status).toBe(200);
    expect(JSON.stringify(await json(ok))).toContain(mine.conversationId);
  });

  it("keeps another workspace's conversations out of the list and the sync", async () => {
    const theirs = await inbound(b.org.id, { name: "Only Visible To B" });
    state.ctx = a.ctx("owner");
    const list = await json(await listGET(new Request(url("conversations?limit=100"))));
    expect(JSON.stringify(list)).not.toContain(theirs.conversationId);
    const sync = await json(await syncGET(new Request(url("sync"))));
    expect(JSON.stringify(sync)).not.toContain(theirs.conversationId);
    state.ctx = b.ctx("owner");
    expect(JSON.stringify(await json(await listGET(new Request(url("conversations?limit=100")))))).toContain(theirs.conversationId);
  });

  it("shows a support person only the conversations assigned to them, in the list, the sync and the thread", async () => {
    const hidden = await inbound(a.org.id, { name: "Not For Support" });
    const given = await inbound(a.org.id, { name: "For Support" });
    await assignConversation(a.ctx("manager"), given.conversationId, a.people.support.id);
    state.ctx = a.ctx("support");
    const list = JSON.stringify(await json(await listGET(new Request(url("conversations?limit=100")))));
    expect(list).toContain(given.conversationId);
    expect(list).not.toContain(hidden.conversationId);
    const sync = JSON.stringify(await json(await syncGET(new Request(url("sync")))));
    expect(sync).not.toContain(hidden.conversationId);
    expect((await threadGET(new Request(url("x")), params(hidden.conversationId))).status).toBe(404);
    expect((await contextGET(new Request(url("x")), params(hidden.conversationId))).status).toBe(404);
    expect((await threadGET(new Request(url("x")), params(given.conversationId))).status).toBe(200);
  });

  it("ignores a view, sort or channel it doesn't know instead of passing it on", async () => {
    state.ctx = a.ctx("owner");
    const res = await listGET(new Request(url("conversations?view=drop_table&sort=%3B--&channel=fax&cursor=%00&limit=-5")));
    expect([200, 400]).toContain(res.status);
    if (res.status === 200) expect(Array.isArray((await json(res)).items)).toBe(true);
  });
});

describe("the polling allowance", () => {
  it("lets a normal tab through, stops a runaway one with a retry time, and starts again after the window", () => {
    const key = `test:${Math.random()}`;
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i += 1) expect(pollAllowed(key, 3, 60_000, t0 + i).ok).toBe(true);
    const denied = pollAllowed(key, 3, 60_000, t0 + 10);
    expect(denied).toMatchObject({ ok: false });
    expect((denied as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
    expect((denied as { retryAfterSeconds: number }).retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(pollAllowed(key, 3, 60_000, t0 + 60_001).ok).toBe(true);
    // One person's allowance is not another's.
    expect(pollAllowed(`${key}:other`, 3, 60_000, t0 + 10).ok).toBe(true);
  });
});
