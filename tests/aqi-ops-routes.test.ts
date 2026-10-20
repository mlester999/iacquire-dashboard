import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/server/auth/service";

const session = vi.hoisted(() => ({ user: null as null | SessionUser, origin: true, ran: [] as string[] }));

vi.mock("@/server/auth/session", async (original) => {
  const actual = await original<typeof import("@/server/auth/session")>();
  const { AppError } = await import("@/server/errors");
  const need = () => {
    if (!session.user) throw new AppError("unauthenticated", "Your session has ended. Please sign in again.");
    return session.user;
  };
  return {
    ...actual,
    requireUserOrThrow: async () => need(),
    requireFreshUserOrThrow: async () => need(),
    assertSameOrigin: async () => {
      if (!session.origin) throw new AppError("forbidden", "Cross-site requests are not allowed.");
    },
  };
});

vi.mock("@/server/aqi/access", async () => ({
  resolveAqiViewer: async () => {
    const user = session.user!;
    return { user, org: null, permissions: [], can: () => false, agencyRole: user.platformRole === "none" ? null : user.platformRole };
  },
  requireAqiAdmin: () => undefined,
}));

vi.mock("@/server/aqi/ops/turn", () => ({
  runOpsTurn: async function* () {
    session.ran.push("operations");
    yield { type: "done", message: { id: "m", role: "assistant", content: "OPS", status: "complete" } };
  },
}));
vi.mock("@/server/aqi/service", async (original) => {
  const actual = await original<typeof import("@/server/aqi/service")>();
  return {
    ...actual,
    runAqiTurn: async function* () {
      session.ran.push("assistant");
      yield { type: "done", message: { id: "m", role: "assistant", content: "ASSISTANT", status: "complete" } };
    },
  };
});

import { GET as overviewGET } from "@/app/api/aqi/ops/overview/route";
import { GET as scopeGET, POST as scopePOST } from "@/app/api/aqi/ops/scope/route";
import { POST as refreshPOST } from "@/app/api/aqi/ops/refresh/route";
import { GET as actionGET, POST as actionPOST } from "@/app/api/aqi/ops/actions/[id]/route";
import { GET as conversationsGET } from "@/app/api/aqi/ops/conversations/route";
import { GET as conversationGET, DELETE as conversationDELETE } from "@/app/api/aqi/ops/conversations/[id]/route";
import { GET as briefingsGET, PUT as briefingsPUT, POST as briefingsPOST } from "@/app/api/aqi/ops/briefings/route";
import { POST as chatPOST } from "@/app/api/aqi/chat/route";
import { addMember, agencyUser, createOrg, createUser } from "./support/fixtures";

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify(body) });
const id = "5b3b2a4e-1111-4222-8333-444455556666";
const params = { params: Promise.resolve({ id }) };

const calls: Array<[string, () => Promise<Response>]> = [
  ["GET overview", () => overviewGET()],
  ["GET scope search", () => scopeGET(new Request("http://localhost/api/aqi/ops/scope?q=ab"))],
  ["POST scope resolve", () => scopePOST(new Request("http://localhost/api/aqi/ops/scope", json({ scope: { type: "platform" } })))],
  ["POST refresh", () => refreshPOST(new Request("http://localhost/api/aqi/ops/refresh", json({ toolId: "platform.health", args: {} })))],
  ["GET action", () => actionGET(new Request("http://localhost/x"), params)],
  ["POST action confirm", () => actionPOST(new Request("http://localhost/x", json({ op: "confirm" })), params)],
  ["GET conversations", () => conversationsGET(new Request("http://localhost/api/aqi/ops/conversations"))],
  ["GET conversation", () => conversationGET(new Request("http://localhost/x"), params)],
  ["DELETE conversation", () => conversationDELETE(new Request("http://localhost/x", { method: "DELETE" }), params)],
  ["GET briefings", () => briefingsGET(new Request("http://localhost/api/aqi/ops/briefings"))],
  ["PUT briefings", () => briefingsPUT(new Request("http://localhost/api/aqi/ops/briefings", { ...json({}), method: "PUT" }))],
  ["POST briefings", () => briefingsPOST()],
];

let admin: SessionUser;
let manager: SessionUser;
let client: SessionUser;

beforeAll(async () => {
  admin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
  manager = agencyUser(await createUser({ platformRole: "agency_manager" }), "agency_manager");
  const org = await createOrg({ name: "Route Client" });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  client = { ...agencyUser(owner, "agency_staff"), platformRole: "none" };
});
beforeEach(() => { session.user = null; session.origin = true; session.ran = []; });

describe("AQi Operations endpoints enforce the role on the server", () => {
  it("rejects signed-out callers with 401 and never reaches a handler body", async () => {
    for (const [name, call] of calls) expect((await call()).status, name).toBe(401);
  });

  it("rejects client users and agency managers with 403 on every endpoint", async () => {
    for (const user of [client, manager]) {
      session.user = user;
      for (const [name, call] of calls) {
        const res = await call();
        expect(res.status, `${name} as ${user.platformRole}`).toBe(403);
        expect((await res.json()).error).toMatch(/Super Admins only/);
      }
    }
  });

  it("serves a Super Admin, and rejects mutating calls that fail the same-origin check", async () => {
    session.user = admin;
    const overview = await overviewGET();
    expect(overview.status).toBe(200);
    const body = await overview.json();
    expect(body.tiles.map((t: { key: string }) => t.key)).toEqual(["health", "incidents", "jobs", "employees", "approvals", "support", "onboarding", "integrations"]);
    expect(JSON.stringify(body)).not.toMatch(/\d+\s?%/);
    expect(body.notConfigured.map((n: { label: string }) => n.label).join(" ")).toMatch(/Request error rate/);
    expect((await scopeGET(new Request("http://localhost/api/aqi/ops/scope?q=ab"))).status).toBe(200);

    session.origin = false;
    for (const [name, call] of calls.filter(([n]) => /^(POST|PUT|DELETE)/.test(n))) expect((await call()).status, name).toBe(403);
  });

  it("validates the arguments of a Super Admin request", async () => {
    session.user = admin;
    expect((await refreshPOST(new Request("http://localhost/x", json({ toolId: "incident.acknowledge", args: {} })))).status).toBe(404); // writes cannot be refreshed
    expect((await refreshPOST(new Request("http://localhost/x", json({ toolId: "platform.health", args: { sql: "select 1" } })))).status).toBe(200);
    expect((await actionPOST(new Request("http://localhost/x", json({ op: "confirm" })), { params: Promise.resolve({ id: "not-a-uuid" }) })).status).toBe(404);
    expect((await actionPOST(new Request("http://localhost/x", json({ op: "approve-everything" })), params)).status).toBe(400);
    expect((await scopePOST(new Request("http://localhost/x", json({ scope: { type: "tenant", id: "nope" } })))).status).toBe(400);
  });
});

describe("the chat endpoint picks the runtime from the server-resolved role", () => {
  const chat = async () => {
    const res = await chatPOST(new Request("http://localhost/api/aqi/chat", json({ message: "hello", scope: { type: "platform" } })));
    return { status: res.status, text: await res.text() };
  };

  it("sends a Super Admin to the Operations runtime and everyone else to the Client assistant", async () => {
    session.user = admin;
    expect((await chat()).text).toContain("OPS");
    expect(session.ran).toEqual(["operations"]);

    for (const user of [client, manager]) {
      session.ran = [];
      session.user = user;
      expect((await chat()).text).toContain("ASSISTANT");
      expect(session.ran).toEqual(["assistant"]);
    }
  });

  it("ignores a browser-supplied scope for people who are not Super Admins", async () => {
    session.user = client;
    const res = await chatPOST(new Request("http://localhost/api/aqi/chat", json({ message: "hello", scope: { type: "tenant", id: id } })));
    expect(await res.text()).toContain("ASSISTANT");
    expect(session.ran).toEqual(["assistant"]);
  });
});
