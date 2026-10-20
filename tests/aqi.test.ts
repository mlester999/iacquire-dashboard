import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { saveCredential } from "@/server/security/credentials";
import { invalidateLlmConfig, resolveLlmConfig, resolveLlmConfigDetailed } from "@/server/llm/client";
import { effectiveAqiModel } from "@/server/aqi/service";
import { agencyUser, addMember, createOrg, createUser, ctxFor } from "./support/fixtures";
import type { AqiViewer } from "@/server/aqi/access";
import {
  createAqiConversation,
  deleteAqiConversation,
  getAqiBootstrap,
  getAqiConversation,
  getPublishedAqiConfig,
  listAqiConversations,
  previewAqiRetrieval,
  publishAqiConfig,
  renameAqiConversation,
  retrieveAqiKnowledge,
  runAqiTurn,
  validateAqiCitations,
  saveAqiDraftConfig,
} from "@/server/aqi/service";
import { DEFAULT_AQI_CONFIG } from "@/server/aqi/service";

let org: Awaited<ReturnType<typeof createOrg>>;
let owner: { id: string; email: string };
let other: { id: string; email: string };
let viewer: AqiViewer;
let otherViewer: AqiViewer;

beforeAll(async () => {
  org = await createOrg({ name: "AQi Test Client" });
  owner = await createUser({ name: "AQi Owner" });
  other = await createUser({ name: "AQi Other" });
  await addMember(org.id, owner.id, "owner");
  await addMember(org.id, other.id, "member");
  const ownerCtx = ctxFor(owner, org, "owner");
  const otherCtx = ctxFor(other, org, "member");
  viewer = {
    user: ownerCtx.user,
    org: { orgId: ownerCtx.org.orgId, name: ownerCtx.org.name, kind: ownerCtx.org.kind, role: ownerCtx.org.role },
    permissions: ownerCtx.permissions,
    can: ownerCtx.can,
    agencyRole: null,
  };
  otherViewer = {
    user: otherCtx.user,
    org: { orgId: otherCtx.org.orgId, name: otherCtx.org.name, kind: otherCtx.org.kind, role: otherCtx.org.role },
    permissions: otherCtx.permissions,
    can: otherCtx.can,
    agencyRole: null,
  };
});

afterAll(async () => {
  // The shared test database keeps its rows; each test uses unique organizations/users.
});

describe("AQi context and knowledge", () => {
  it("adapts suggestions to the current page and only exposes authorized routes", async () => {
    const bootstrap = await getAqiBootstrap(viewer, "/employees");
    expect(bootstrap.page?.label).toBe("AI Employees");
    expect(bootstrap.suggestions.map((item) => item.question)).toContain("How do I change an employee's instructions?");
    expect(bootstrap.allowedPaths).toContain("/employees");
    expect(bootstrap.allowedPaths).not.toContain("/admin/aqi");
    expect(bootstrap.config.identity).toBe("AQi");
  });

  it("retrieves approved knowledge for the workspace role and page", async () => {
    const result = await retrieveAqiKnowledge(viewer, "How do I change an employee's instructions?", "/employees");
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.entries.some((entry) => entry.title === "Employee instructions and knowledge")).toBe(true);
    expect(result.entries.every((entry) => entry.roles.length === 0 || entry.roles.includes("owner"))).toBe(true);
  });

  it("does not answer without a real provider and records the failure honestly", async () => {
    const events = [];
    for await (const event of runAqiTurn(viewer, { message: "How do approvals work?", pathname: "/approvals" }, new AbortController().signal)) events.push(event);
    expect(events[0]).toMatchObject({ type: "meta" });
    expect(events.some((event) => event.type === "error" && event.code === "temporarily_unavailable")).toBe(true);
    const messageId = events.find((event) => event.type === "meta")?.messageId;
    expect(messageId).toBeTruthy();
    const row = await withSystem((db) => db.query<{ status: string; error_code: string | null; content: string }>("select status, error_code, content from aqi_messages where id = $1", [messageId]));
    expect(row.rows[0]).toMatchObject({ status: "failed", error_code: "provider_unavailable", content: "" });
    const meta = events.find((event) => event.type === "meta") as { conversationId: string } | undefined;
    const conversation = await getAqiConversation(viewer, meta!.conversationId);
    expect(conversation.messages.at(-1)?.sources?.length).toBeGreaterThan(0);
  });

  it("removes citations that do not map to retrieved sources", () => {
    const result = validateAqiCitations("Use [K1] but not [K3].", [{ id: "a", title: "A", category: "C" }]);
    expect(result.cited).toEqual([1]);
    expect(result.content).toBe("Use but not.");
    expect(result.warning).toMatch(/did not match/);
  });

  it("removes inline reference numbers while retaining the linked sources", () => {
    const result = validateAqiCitations("Grounded claim [K1][K2].", [
      { id: "1", title: "One", category: "Test" },
      { id: "2", title: "Two", category: "Test" },
    ]);
    expect(result.content).toBe("Grounded claim.");
    expect(result.cited).toEqual([1, 2]);
  });

  it("resolves a verified DeepSeek integration through the OpenAI-compatible adapter", async () => {
    const admin = await createUser({ platformRole: "agency_super_admin" });
    const secret = "sk-test-deepseek-0123456789abcdef";
    let credentialId: string | null = null;
    try {
      credentialId = await withSystem(async (db) => {
        const credential = await saveCredential(db, { orgId: null, provider: "llm", label: "DeepSeek acceptance", secret, actorId: admin.id });
        await db.query(
          `insert into integration_connections (org_id, provider, label, environment, config, credential_id, status, created_by)
           values (null, 'llm', 'DeepSeek acceptance', 'production', $1, $2, 'connected', $3)`,
          [JSON.stringify({ baseUrl: "https://api.deepseek.com", model: "deepseek-flash", apiFormat: "openai", llmPreset: "deepseek" }), credential.id, admin.id],
        );
        return credential.id;
      });
      invalidateLlmConfig();
      const resolution = await resolveLlmConfigDetailed();
      expect(resolution).toMatchObject({ reason: "ready", connectionStatus: "connected", provider: "deepseek", model: "deepseek-flash", host: "api.deepseek.com" });
      expect(resolution.config).toMatchObject({ baseUrl: "https://api.deepseek.com", model: "deepseek-flash", format: "openai", source: "portal" });
      const adminViewer: AqiViewer = { user: agencyUser(admin, "agency_super_admin"), org: null, permissions: [], can: () => true, agencyRole: "agency_super_admin" };
      const publicBootstrap = await getAqiBootstrap(adminViewer, "/overview");
      expect(JSON.stringify(publicBootstrap)).not.toContain(secret);
      expect(effectiveAqiModel({ ...DEFAULT_AQI_CONFIG, model: "deepseek-chat", modelOverride: false }, "deepseek-flash")).toBe("deepseek-flash");
      expect(effectiveAqiModel({ ...DEFAULT_AQI_CONFIG, model: "deepseek-chat", modelOverride: true }, "deepseek-flash")).toBe("deepseek-chat");
      await withSystem((db) => db.query("update integration_connections set status = 'credentials_saved' where org_id is null and provider = 'llm'"));
      const ineligible = await resolveLlmConfigDetailed();
      expect(ineligible).toMatchObject({ config: null, reason: "status_not_eligible", connectionStatus: "credentials_saved" });
      expect(await resolveLlmConfig()).toBeNull();
      await withSystem((db) => db.query("update integration_connections set status = 'connected' where org_id is null and provider = 'llm'"));
      expect((await resolveLlmConfig())?.model).toBe("deepseek-flash");
      await withSystem(async (db) => {
        if (credentialId) await db.query("update integration_credentials set revoked_at = now() where id = $1", [credentialId]);
      });
      const revoked = await resolveLlmConfigDetailed();
      expect(revoked).toMatchObject({ config: null, reason: "credential_unavailable", connectionStatus: "connected" });
    } finally {
      await withSystem(async (db) => {
        await db.query("delete from integration_connections where org_id is null and provider = 'llm'");
        if (credentialId) await db.query("delete from integration_credentials where id = $1", [credentialId]);
        await db.query("delete from credential_references where provider = 'llm' and org_id is null");
      });
      invalidateLlmConfig();
    }
  });

  it("keeps provider diagnostics out of the client bootstrap and exposes them to a Super Admin", async () => {
    const client = await getAqiBootstrap(viewer, "/overview");
    expect(client.health.available).toBe(false);
    expect(client.health.detail).not.toMatch(/provider|Super Admin|API key|credential/i);
    const admin = await createUser({ platformRole: "agency_super_admin" });
    const adminViewer: AqiViewer = { user: agencyUser(admin, "agency_super_admin"), org: null, permissions: [], can: () => true, agencyRole: "agency_super_admin" };
    const elevated = await getAqiBootstrap(adminViewer, "/overview");
    expect(elevated.health.diagnostic?.reason).toBeTruthy();
  });

  it("seeds grounded contact and team-invite answers for common how-to questions", async () => {
    const contact = await retrieveAqiKnowledge(viewer, "how do I add a contact?", "/crm");
    const invite = await retrieveAqiKnowledge(viewer, "how do I invite a team member?", "/settings/team");
    expect(contact.sources.map((source) => source.title)).toContain("Adding a CRM contact");
    expect(invite.sources.map((source) => source.title)).toContain("Inviting a team member");
  });

  it("lets a Super Admin preview retrieval without an answer", async () => {
    const admin = await createUser({ platformRole: "agency_super_admin" });
    const preview = await previewAqiRetrieval(agencyUser(admin, "agency_super_admin"), "employee instructions", "/employees");
    expect(preview.entries.some((entry) => entry.title === "Employee instructions and knowledge")).toBe(true);
    await expect(previewAqiRetrieval(viewer.user, "employee instructions", "/employees")).rejects.toThrow(/Super Admin/i);
  });
});

describe("AQi conversation privacy", () => {
  it("cleans old inline source numbers and em dashes when loading saved answers", async () => {
    const conversation = await createAqiConversation(viewer, "/overview");
    const sources = Array.from({ length: 5 }, (_, index) => ({ id: String(index + 1), title: `Source ${index + 1}`, category: "Test" }));
    await withUser(owner.id, (db) => db.query(
      "insert into aqi_messages (conversation_id,org_id,user_id,role,content,status,context) values ($1,$2,$3,'assistant',$4,'complete',$5::jsonb)",
      [conversation.id, org.id, owner.id, "Open the workspace² — then add a contact⁵.", JSON.stringify({ sources })],
    ));

    const loaded = await getAqiConversation(viewer, conversation.id);
    expect(loaded.messages[0].content).toBe("Open the workspace, then add a contact.");
    expect(loaded.messages[0].sources).toHaveLength(5);
  });

  it("persists, changes and clears feedback on the correct assistant message", async () => {
    const conversation = await createAqiConversation(viewer, "/overview");
    const messageId = await withUser(owner.id, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        "insert into aqi_messages (conversation_id,org_id,user_id,role,content,status) values ($1,$2,$3,'assistant','Answer','complete') returning id",
        [conversation.id, org.id, owner.id],
      );
      return rows[0].id;
    });
    const { rateAqiMessage } = await import("@/server/aqi/service");
    await rateAqiMessage(viewer, messageId, 1);
    let row = await withSystem((db) => db.query<{ feedback_rating: number | null }>("select feedback_rating from aqi_messages where id=$1", [messageId]));
    expect(row.rows[0].feedback_rating).toBe(1);
    await rateAqiMessage(viewer, messageId, -1, "Incorrect information — missed the step");
    row = await withSystem((db) => db.query<{ feedback_rating: number | null; feedback_comment: string | null }>("select feedback_rating,feedback_comment from aqi_messages where id=$1", [messageId]));
    expect(row.rows[0]).toMatchObject({ feedback_rating: -1, feedback_comment: "Incorrect information — missed the step" });
    await rateAqiMessage(viewer, messageId, 0);
    row = await withSystem((db) => db.query<{ feedback_rating: number | null; feedback_comment: string | null }>("select feedback_rating,feedback_comment from aqi_messages where id=$1", [messageId]));
    expect(row.rows[0]).toMatchObject({ feedback_rating: null, feedback_comment: null });
  });

  it("creates, lists, renames, reads and deletes only the signed-in person's conversation", async () => {
    const created = await createAqiConversation(viewer, "/employees");
    expect((await listAqiConversations(viewer)).some((conversation) => conversation.id === created.id)).toBe(false);
    const { saveAqiConversation } = await import("@/server/aqi/lifecycle");
    await saveAqiConversation(viewer, created.id);
    expect((await listAqiConversations(viewer)).some((conversation) => conversation.id === created.id)).toBe(true);
    await renameAqiConversation(viewer, created.id, "My private AQi chat");
    const loaded = await getAqiConversation(viewer, created.id);
    expect(loaded.conversation.title).toBe("My private AQi chat");
    await expect(getAqiConversation(otherViewer, created.id)).rejects.toThrow(/not found/i);
    await deleteAqiConversation(viewer, created.id);
    await expect(getAqiConversation(viewer, created.id)).rejects.toThrow(/not found/i);
  });
});

describe("AQi configuration publishing", () => {
  it("refuses configuration writes from a non-Super-Admin", async () => {
    await expect(saveAqiDraftConfig(otherViewer.user, { ...DEFAULT_AQI_CONFIG, identity: "Not allowed" })).rejects.toThrow(/Super Admin/i);
  });

  it("creates a draft, publishes it and keeps prior versions", async () => {
    const admin = await createUser({ platformRole: "agency_super_admin" });
    const session = agencyUser(admin, "agency_super_admin");
    const draft = await saveAqiDraftConfig(session, { ...DEFAULT_AQI_CONFIG, identity: "AQi Test" }, "test draft");
    await publishAqiConfig(session, draft.id);
    const published = await getPublishedAqiConfig();
    expect(published.version).toBe(draft.version);
    expect(published.config.identity).toBe("AQi Test");
    const versions = await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from aqi_config_versions"));
    expect(versions.rows[0].n).toBeGreaterThanOrEqual(2);
  });
});
