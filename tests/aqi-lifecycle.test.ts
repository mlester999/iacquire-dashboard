import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { generateAqiConversationTitle } from "@/server/aqi/titles";
import { invalidateLlmConfig } from "@/server/llm/client";
import { saveCredential } from "@/server/security/credentials";
import {
  createAqiConversation,
  getAqiConversation,
  getAqiWelcome,
  renameAqiConversation,
  searchAqiConversations,
} from "@/server/aqi/service";
import { discardAqiTemporaryConversation, saveAqiConversation } from "@/server/aqi/lifecycle";
import type { AqiViewer } from "@/server/aqi/access";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";

async function fixtures() {
  const org = await createOrg({ name: "AQi Title Client" });
  const owner = await createUser({ name: "AQi Title Owner" });
  const other = await createUser({ name: "AQi Title Other" });
  await addMember(org.id, owner.id, "owner");
  await addMember(org.id, other.id, "member");
  const ownerCtx = ctxFor(owner, org, "owner");
  const otherCtx = ctxFor(other, org, "member");
  const viewer: AqiViewer = {
    user: ownerCtx.user,
    org: { orgId: ownerCtx.org.orgId, name: ownerCtx.org.name, kind: ownerCtx.org.kind, role: ownerCtx.org.role },
    permissions: ownerCtx.permissions,
    can: ownerCtx.can,
    agencyRole: null,
  };
  const otherViewer: AqiViewer = {
    user: otherCtx.user,
    org: { orgId: otherCtx.org.orgId, name: otherCtx.org.name, kind: otherCtx.org.kind, role: otherCtx.org.role },
    permissions: otherCtx.permissions,
    can: otherCtx.can,
    agencyRole: null,
  };
  return { org, owner, other, viewer, otherViewer };
}

async function addTurn(viewer: AqiViewer, conversationId: string, content: string, offsetSeconds = 0) {
  await withUser(viewer.user.id, async (db) => {
    await db.query(
      `insert into aqi_messages (conversation_id, org_id, user_id, role, content, status, created_at)
       values ($1, $2, $3, 'user', $4, 'complete', now() + make_interval(secs => $5))`,
      [conversationId, viewer.org?.orgId ?? null, viewer.user.id, content, offsetSeconds],
    );
    await db.query(
      `insert into aqi_messages (conversation_id, org_id, user_id, role, content, status, created_at)
       values ($1, $2, $3, 'assistant', 'Answer', 'complete', now() + make_interval(secs => $4))`,
      [conversationId, viewer.org?.orgId ?? null, viewer.user.id, offsetSeconds + 1],
    );
  });
}

async function titleRow(conversationId: string) {
  const { rows } = await withSystem((db) =>
    db.query<{ title: string; title_source: string }>("select title, title_source from aqi_conversations where id = $1", [conversationId]),
  );
  return rows[0] ?? null;
}

async function setLastActivity(conversationId: string, iso: string) {
  await withSystem((db) => db.query("update aqi_conversations set last_message_at = $2::timestamptz where id = $1", [conversationId, iso]));
}

describe("AQi automatic conversation titles", () => {
  it("names the first meaningful topic with the deterministic fallback and never regenerates", async () => {
    const { viewer } = await fixtures();
    const conversation = await createAqiConversation(viewer, "/crm");
    expect(conversation.title).toBe("New conversation");
    await addTurn(viewer, conversation.id, "How do I connect DeepSeek to AQi?");

    const first = await generateAqiConversationTitle(viewer, conversation.id);
    expect(first).toEqual({ title: "Connecting DeepSeek to AQi", generated: true });
    expect(await titleRow(conversation.id)).toMatchObject({ title: "Connecting DeepSeek to AQi", title_source: "auto" });

    await addTurn(viewer, conversation.id, "And where do I find the API key?", 5);
    const second = await generateAqiConversationTitle(viewer, conversation.id);
    expect(second).toEqual({ title: "Connecting DeepSeek to AQi", generated: false });
  });

  it("keeps the placeholder for a greeting-only conversation", async () => {
    const { viewer } = await fixtures();
    const conversation = await createAqiConversation(viewer, "/overview");
    await addTurn(viewer, conversation.id, "hey");

    const result = await generateAqiConversationTitle(viewer, conversation.id);
    expect(result).toEqual({ title: "New conversation", generated: false });
    expect(await titleRow(conversation.id)).toMatchObject({ title: "New conversation", title_source: "default" });
  });

  it("names the topic once a follow-up message makes it clear", async () => {
    const { viewer } = await fixtures();
    const conversation = await createAqiConversation(viewer, "/overview");
    await addTurn(viewer, conversation.id, "hey");
    expect((await generateAqiConversationTitle(viewer, conversation.id))?.generated).toBe(false);

    await addTurn(viewer, conversation.id, "How can I create an automation?", 3);
    const result = await generateAqiConversationTitle(viewer, conversation.id);
    expect(result).toEqual({ title: "Creating an Automation", generated: true });
  });

  it("never overwrites a manual rename, even when generation was already requested", async () => {
    const { viewer } = await fixtures();
    const conversation = await createAqiConversation(viewer, "/workforce");
    await addTurn(viewer, conversation.id, "How can I manage my AI employees?");

    const pending = generateAqiConversationTitle(viewer, conversation.id);
    await renameAqiConversation(viewer, conversation.id, "My workforce notes");
    await pending;

    expect(await titleRow(conversation.id)).toMatchObject({ title: "My workforce notes", title_source: "manual" });
    const after = await generateAqiConversationTitle(viewer, conversation.id);
    expect(after).toEqual({ title: "My workforce notes", generated: false });
  });

  it("never recreates a conversation deleted while generation is in flight", async () => {
    const { viewer } = await fixtures();
    const conversation = await createAqiConversation(viewer, "/crm");
    await addTurn(viewer, conversation.id, "My automation isn't running.");
    const pending = generateAqiConversationTitle(viewer, conversation.id);
    // A chat can be deleted while naming is in flight only while it is still temporary; the discard
    // action exercises that same race without first saving it.
    await discardAqiTemporaryConversation(viewer, conversation.id);
    const result = await pending;

    // Generation may finish after the row is gone; it must never create or rename a conversation.
    expect(result?.generated ?? false).toBe(false);
    const { rows } = await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from aqi_conversations where id = $1", [conversation.id]));
    expect(rows[0].n).toBe(0);
  });

  it("does not touch another person's conversation", async () => {
    const { viewer, otherViewer } = await fixtures();
    const conversation = await createAqiConversation(viewer, "/crm");
    await addTurn(viewer, conversation.id, "How do I add a contact?");
    expect(await generateAqiConversationTitle(otherViewer, conversation.id)).toBeNull();
    expect(await titleRow(conversation.id)).toMatchObject({ title: "New conversation", title_source: "default" });
  });
});

describe("AQi conversation history search", () => {
  it("searches automatic and manual titles within the owner's scope and paginates", async () => {
    const { viewer, otherViewer } = await fixtures();
    const automation = await createAqiConversation(viewer, "/crm");
    await addTurn(viewer, automation.id, "How can I create an automation?");
    await generateAqiConversationTitle(viewer, automation.id);
    await saveAqiConversation(viewer, automation.id);

    const renamed = await createAqiConversation(viewer, "/crm");
    await renameAqiConversation(viewer, renamed.id, "Billing question for March");
    await saveAqiConversation(viewer, renamed.id);

    const third = await createAqiConversation(viewer, "/crm");
    await addTurn(viewer, third.id, "How do I invite a team member?");
    await saveAqiConversation(viewer, third.id);
    await setLastActivity(automation.id, "2026-01-03T00:00:00Z");
    await setLastActivity(renamed.id, "2026-01-02T00:00:00Z");
    await setLastActivity(third.id, "2026-01-01T00:00:00Z");

    const automationMatches = await searchAqiConversations(viewer, { query: "automation" });
    expect(automationMatches.conversations.map((item) => item.title)).toContain("Creating an Automation");
    expect(automationMatches.conversations).toHaveLength(1);

    const manualMatches = await searchAqiConversations(viewer, { query: "billing question" });
    expect(manualMatches.conversations.map((item) => item.id)).toEqual([renamed.id]);

    const page = await searchAqiConversations(viewer, { limit: 2 });
    expect(page.conversations).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    const next = await searchAqiConversations(viewer, { limit: 2, before: page.conversations.at(-1)!.lastMessageAt });
    expect(next.conversations.some((item) => item.id === third.id)).toBe(true);

    const otherSearch = await searchAqiConversations(otherViewer, { query: "automation" });
    expect(otherSearch.conversations).toHaveLength(0);
  });
});

describe("AQi welcome suggestions respect permissions", () => {
  it("hides capability questions the person cannot use and exposes page context only when authorized", async () => {
    const { viewer, org } = await fixtures();
    const restricted: AqiViewer = {
      ...viewer,
      permissions: ["workspace.view"],
      can: (permission) => permission === "workspace.view",
    };
    const welcome = await getAqiWelcome(restricted, "/workforce");
    expect(welcome.page).toBeNull();
    expect(welcome.suggestions.map((item) => item.question)).not.toContain("How do I manage my AI employees?");
    expect(welcome.suggestions.map((item) => item.question)).not.toContain("Where can I find my integrations?");
    expect(welcome.suggestions.map((item) => item.question)).not.toContain("How do I contact support?");
    expect(welcome.suggestions.length).toBeGreaterThan(0);

    const ownerWelcome = await getAqiWelcome(viewer, "/workforce");
    expect(ownerWelcome.page?.label).toBe("AI Workforce");
    expect(ownerWelcome.suggestions.map((item) => item.question)).toContain("How do I change an employee's instructions?");
    expect(ownerWelcome.suggestions.length).toBeLessThanOrEqual(4);
    expect(org.id).toBeTruthy();
  });

  it("does not leak a page label for an unauthorized route", async () => {
    const { viewer } = await fixtures();
    const client: AqiViewer = { ...viewer, can: (permission) => permission !== "agency.security.manage" };
    const welcome = await getAqiWelcome(client, "/admin/health");
    expect(welcome.page).toBeNull();
    expect(welcome.allowedPaths).not.toContain("/admin/health");
    expect(JSON.stringify(welcome)).not.toContain("apiKey");
  });

  it("keeps a readable conversation after the welcome loads", async () => {
    const { viewer } = await fixtures();
    const conversation = await createAqiConversation(viewer, "/crm");
    const loaded = await getAqiConversation(viewer, conversation.id);
    expect(loaded.conversation.title).toBe("New conversation");
  });
});

describe("AQi model-generated titles", () => {
  let server: http.Server;
  let baseUrl: string;
  let credentialId: string | null = null;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
        req.resume();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Tracing DeepSeek Wiring" } }], usage: { prompt_tokens: 20, completion_tokens: 4 } }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await withSystem(async (db) => {
      await db.query("delete from integration_connections where org_id is null and provider = 'llm' and label = 'AQi title test'");
      if (credentialId) await db.query("delete from integration_credentials where id = $1", [credentialId]);
      await db.query("delete from credential_references where provider = 'llm' and org_id is null");
    });
    invalidateLlmConfig();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it("uses the configured provider model and persists a sanitized title", async () => {
    const { viewer } = await fixtures();
    const admin = await createUser({ platformRole: "agency_super_admin" });
    credentialId = await withSystem(async (db) => {
      const credential = await saveCredential(db, { orgId: null, provider: "llm", label: "AQi title test", secret: "sk-test-title-0123456789abcdef", actorId: admin.id });
      await db.query(
        `insert into integration_connections (org_id, provider, label, environment, config, credential_id, status, created_by)
         values (null, 'llm', 'AQi title test', 'production', $1, $2, 'connected', $3)`,
        [JSON.stringify({ baseUrl, model: "qa-title-model", apiFormat: "openai", llmPreset: "deepseek" }), credential.id, admin.id],
      );
      return credential.id;
    });
    invalidateLlmConfig();

    const conversation = await createAqiConversation(viewer, "/crm");
    await addTurn(viewer, conversation.id, "How do I connect DeepSeek to AQi?");
    const result = await generateAqiConversationTitle(viewer, conversation.id);
    expect(result).toEqual({ title: "Tracing DeepSeek Wiring", generated: true });
    expect(await titleRow(conversation.id)).toMatchObject({ title: "Tracing DeepSeek Wiring", title_source: "auto" });
  });
});
