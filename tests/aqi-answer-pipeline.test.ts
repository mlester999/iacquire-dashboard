import { beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";
import type { AqiViewer } from "@/server/aqi/access";

// The model is replaced; everything after it (prompt construction, normalisation, persistence,
// history) is the real server code running on the real migrations.
const llm = vi.hoisted(() => ({ chunks: [] as string[], systems: [] as string[] }));
vi.mock("@/server/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/llm/client")>();
  return {
    ...actual,
    resolveLlmConfigDetailed: async () => ({
      config: { baseUrl: "https://llm.test/v1", format: "openai", model: "deepseek-chat", apiKey: "test-key", source: "environment" },
      reason: "ready",
      connectionStatus: "connected",
      provider: "deepseek",
      model: "deepseek-chat",
      host: "llm.test",
    }),
    llmStream: async function* (_config: unknown, input: { system: string }) {
      llm.systems.push(input.system);
      for (const text of llm.chunks) yield { type: "delta" as const, text };
      yield { type: "usage" as const, inputTokens: 10, outputTokens: 10 };
    },
  };
});

const { getAqiConversation, getAqiWelcome, runAqiTurn } = await import("@/server/aqi/service");

async function viewerFor(role: "owner" | "member") {
  const org = await createOrg({ name: `Answer pipeline ${Math.random().toString(16).slice(2)}` });
  const user = await createUser({ name: `Pipeline ${role}` });
  await addMember(org.id, user.id, role);
  const ctx = ctxFor(user, { ...org, slug: "x" }, role);
  const viewer: AqiViewer = {
    user: ctx.user,
    org: { orgId: org.id, name: org.name, kind: "client", role },
    permissions: ctx.permissions,
    can: ctx.can,
    agencyRole: null,
  };
  return { org, viewer };
}

async function ask(viewer: AqiViewer, message: string, chunks: string[]) {
  llm.chunks = chunks;
  const events: Array<Record<string, unknown>> = [];
  for await (const event of runAqiTurn(viewer, { message, pathname: "/overview" }, new AbortController().signal)) events.push(event as unknown as Record<string, unknown>);
  const meta = events.find((event) => event.type === "meta") as { conversationId: string; messageId: string };
  const done = events.find((event) => event.type === "done") as { message: { content: string } } | undefined;
  return { events, meta, done };
}

const MALFORMED = [
  "You can add people under [Team] (Settings → Team), ",
  "connect services in [Integrations](Settings → Integrations) ",
  "and find your employees in [AI Employees](AI Employees). ",
  "See [Admin](/admin/aqi) and [x](javascript:alert(1)).",
];

beforeEach(() => {
  llm.systems.length = 0;
});

describe("AQi answer pipeline", () => {
  it("turns malformed page references into verified links before saving", async () => {
    const { viewer } = await viewerFor("owner");
    const { done, meta } = await ask(viewer, "Where do I manage integrations?", MALFORMED);
    const expected = "You can add people under [Team](/settings/team), connect services in [Integrations](/settings/integrations) and find your employees in [AI Employees](/employees). See Admin and x.";
    expect(done?.message.content).toBe(expected);
    const stored = await withSystem(async (db) => (await db.query<{ content: string }>("select content from aqi_messages where id = $1", [meta.messageId])).rows[0].content);
    expect(stored).toBe(expected);
    expect(stored).not.toMatch(/\]\((?!\/)/);
  });

  it("gives the model the authorized pages and the link format for substantive questions only", async () => {
    const { viewer } = await viewerFor("owner");
    await ask(viewer, "Explain how the CRM works in detail", ["The CRM keeps contacts."]);
    const prompt = llm.systems.at(-1)!;
    expect(prompt).toContain("Authorized navigation");
    expect(prompt).toContain("`/settings/team`");
    expect(prompt).toContain("`/crm/contacts`");
    expect(prompt).toContain("never write a raw route");
    expect(prompt).toContain("no breadcrumbs such as Settings → Team");
    expect(prompt).not.toContain("`/admin/aqi`");

    await ask(viewer, "hey", ["Hey! How can I help you today?"]);
    const greeting = llm.systems.at(-1)!;
    expect(greeting).not.toContain("Authorized navigation");
    expect(greeting).not.toContain("`/settings/team`");
  });

  it("keeps a greeting short and plain, with no sources and no links", async () => {
    const { viewer } = await viewerFor("owner");
    const { done, meta } = await ask(viewer, "hey", ["Hey! How can I help you today?"]);
    expect(done?.message.content).toBe("Hey! How can I help you today?");
    const context = await withSystem(async (db) => (await db.query<{ sources: unknown[] }>("select context->'sources' as sources from aqi_messages where id = $1", [meta.messageId])).rows[0].sources);
    expect(context).toEqual([]);
  });

  it("does not link a page the person cannot open", async () => {
    const { viewer } = await viewerFor("member");
    const { done } = await ask(viewer, "Where do I manage integrations?", ["Open [Integrations](Settings → Integrations) and then [Team] to continue."]);
    // A member cannot open Integrations, so it is plain words; nothing is left as raw syntax.
    expect(done?.message.content).toContain("Open Integrations and then");
    expect(done?.message.content).not.toContain("/settings/integrations");
    expect(done?.message.content).not.toContain("(Settings");
    expect(done?.message.content).not.toMatch(/\[(?:Integrations|Team)\](?!\()/);
  });

  it("shows older malformed messages readably without changing what is stored", async () => {
    const { viewer, org } = await viewerFor("owner");
    const { meta } = await ask(viewer, "What can I do?", ["Fine."]);
    const raw = "Manage people under [Team] (Settings → Team) and tools in [Integrations](Settings → Integrations).";
    await withSystem((db) => db.query("update aqi_messages set content = $2 where id = $1", [meta.messageId, raw]));
    const history = await getAqiConversation(viewer, meta.conversationId);
    const shown = history.messages.find((message) => message.id === meta.messageId)!.content;
    expect(shown).toBe("Manage people under [Team](/settings/team) and tools in [Integrations](/settings/integrations).");
    const stored = await withSystem(async (db) => (await db.query<{ content: string }>("select content from aqi_messages where id = $1", [meta.messageId])).rows[0].content);
    expect(stored).toBe(raw);
    void org;
  });

  it("sends the browser the same list of pages it may link to", async () => {
    const { viewer } = await viewerFor("owner");
    const welcome = await getAqiWelcome(viewer, "/overview");
    expect(welcome.navigation).toEqual(expect.arrayContaining([{ path: "/settings/team", label: "Team" }, { path: "/crm/contacts", label: "Contacts" }]));
    expect(welcome.navigation.map((route) => route.path)).toEqual(welcome.allowedPaths);
    expect(welcome.navigation.some((route) => route.path.startsWith("/admin"))).toBe(false);
  });
});
