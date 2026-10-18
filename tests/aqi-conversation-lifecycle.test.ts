import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import {
  createAqiConversation,
  deleteAqiConversation,
  getAqiConversation,
  listAqiConversations,
} from "@/server/aqi/service";
import {
  discardAqiTemporaryConversation,
  purgeStaleAqiTemporaryConversations,
  saveAqiConversation,
} from "@/server/aqi/lifecycle";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";
import type { AqiViewer } from "@/server/aqi/access";

let org: Awaited<ReturnType<typeof createOrg>>;
let owner: { id: string; email: string };
let other: { id: string; email: string };
let viewer: AqiViewer;
let otherViewer: AqiViewer;

beforeAll(async () => {
  org = await createOrg({ name: "AQi Lifecycle" });
  owner = await createUser({ name: "AQi Lifecycle Owner" });
  other = await createUser({ name: "AQi Lifecycle Other" });
  await addMember(org.id, owner.id, "owner");
  await addMember(org.id, other.id, "member");
  const ownerCtx = ctxFor(owner, org, "owner");
  const otherCtx = ctxFor(other, org, "member");
  viewer = { user: ownerCtx.user, org: { orgId: ownerCtx.org.orgId, name: ownerCtx.org.name, kind: ownerCtx.org.kind, role: ownerCtx.org.role }, permissions: ownerCtx.permissions, can: ownerCtx.can, agencyRole: null };
  otherViewer = { user: otherCtx.user, org: { orgId: otherCtx.org.orgId, name: otherCtx.org.name, kind: otherCtx.org.kind, role: otherCtx.org.role }, permissions: otherCtx.permissions, can: otherCtx.can, agencyRole: null };
});

describe("AQi conversation lifecycle", () => {
  it("keeps a new chat out of history until it is explicitly saved", async () => {
    const conversation = await createAqiConversation(viewer, "/overview");
    expect((await listAqiConversations(viewer)).some((item) => item.id === conversation.id)).toBe(false);
    await saveAqiConversation(viewer, conversation.id);
    expect((await listAqiConversations(viewer)).some((item) => item.id === conversation.id)).toBe(true);
    // Saving is idempotent and keeps the original saved timestamp.
    const first = await saveAqiConversation(viewer, conversation.id);
    const second = await saveAqiConversation(viewer, conversation.id);
    expect(second.savedAt).toBe(first.savedAt);
    await deleteAqiConversation(viewer, conversation.id);
  });

  it("discards only temporary chats and deletes only saved chats", async () => {
    const temporary = await createAqiConversation(viewer, "/overview");
    await expect(deleteAqiConversation(viewer, temporary.id)).rejects.toThrow(/not found/i);
    await discardAqiTemporaryConversation(viewer, temporary.id);
    await expect(getAqiConversation(viewer, temporary.id)).rejects.toThrow(/not found/i);

    const saved = await createAqiConversation(viewer, "/overview");
    await saveAqiConversation(viewer, saved.id);
    await expect(discardAqiTemporaryConversation(viewer, saved.id)).rejects.toThrow(/not found/i);
    await deleteAqiConversation(viewer, saved.id);
    await expect(getAqiConversation(viewer, saved.id)).rejects.toThrow(/not found/i);
  });

  it("never lets another person save, discard or read the chat", async () => {
    const conversation = await createAqiConversation(viewer, "/overview");
    await expect(saveAqiConversation(otherViewer, conversation.id)).rejects.toThrow(/not found/i);
    await expect(discardAqiTemporaryConversation(otherViewer, conversation.id)).rejects.toThrow(/not found/i);
    await expect(deleteAqiConversation(otherViewer, conversation.id)).rejects.toThrow(/not found/i);
    await expect(getAqiConversation(otherViewer, conversation.id)).rejects.toThrow(/not found/i);
    await discardAqiTemporaryConversation(viewer, conversation.id);
  });

  it("cleans up stale temporary chats without touching saved history", async () => {
    const stale = await createAqiConversation(viewer, "/overview");
    const saved = await createAqiConversation(viewer, "/overview");
    await saveAqiConversation(viewer, saved.id);
    await withSystem((db) => db.query("update aqi_conversations set last_message_at = now() - interval '3 days' where id in ($1,$2)", [stale.id, saved.id]));
    const removed = await purgeStaleAqiTemporaryConversations(viewer, 24);
    expect(removed).toBeGreaterThanOrEqual(1);
    await expect(getAqiConversation(viewer, stale.id)).rejects.toThrow(/not found/i);
    expect((await getAqiConversation(viewer, saved.id)).conversation.id).toBe(saved.id);
    await deleteAqiConversation(viewer, saved.id);
  });
});
