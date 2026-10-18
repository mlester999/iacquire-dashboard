import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
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
    const bootstrap = await getAqiBootstrap(viewer, "/workforce");
    expect(bootstrap.page?.label).toBe("AI Workforce");
    expect(bootstrap.suggestions.map((item) => item.question)).toContain("How do I change an employee's instructions?");
    expect(bootstrap.allowedPaths).toContain("/workforce");
    expect(bootstrap.allowedPaths).not.toContain("/admin/aqi");
    expect(bootstrap.config.identity).toBe("AQi");
  });

  it("retrieves approved knowledge for the workspace role and page", async () => {
    const result = await retrieveAqiKnowledge(viewer, "How do I change an employee's instructions?", "/workforce");
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.entries.some((entry) => entry.title === "Employee instructions and knowledge")).toBe(true);
    expect(result.entries.every((entry) => entry.roles.length === 0 || entry.roles.includes("owner"))).toBe(true);
  });

  it("does not answer without a real provider and records the failure honestly", async () => {
    const events = [];
    for await (const event of runAqiTurn(viewer, { message: "How do approvals work?", pathname: "/approvals" }, new AbortController().signal)) events.push(event);
    expect(events[0]).toMatchObject({ type: "meta" });
    expect(events.some((event) => event.type === "error" && event.code === "provider_unavailable")).toBe(true);
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
    expect(result.content).toBe("Use [K1] but not .");
    expect(result.warning).toMatch(/did not match/);
  });

  it("lets a Super Admin preview retrieval without an answer", async () => {
    const admin = await createUser({ platformRole: "agency_super_admin" });
    const preview = await previewAqiRetrieval(agencyUser(admin, "agency_super_admin"), "employee instructions", "/workforce");
    expect(preview.entries.some((entry) => entry.title === "Employee instructions and knowledge")).toBe(true);
    await expect(previewAqiRetrieval(viewer.user, "employee instructions", "/workforce")).rejects.toThrow(/Super Admin/i);
  });
});

describe("AQi conversation privacy", () => {
  it("creates, lists, renames, reads and deletes only the signed-in person's conversation", async () => {
    const created = await createAqiConversation(viewer, "/workforce");
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
