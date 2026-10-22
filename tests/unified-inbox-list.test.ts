import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/server/env";
import { withSystem, withUser } from "@/server/db";
import { assignConversation, takeOverConversation } from "@/server/messaging/handoff";
import { decodeCursor, inboxViewCounts, listConversationsPage } from "@/server/messaging/inbox-list";
import { listConversations, markConversationRead, retryFailedMessage, sendHumanReply, setConversationState } from "@/server/messaging/inbox";
import { dispatchMessage } from "@/server/messaging/send";
import { inboxSync, loadInboxThread, SYNC_MAX_CHANGES } from "@/server/messaging/inbox-sync";
import { describeChannel, getChannelHealth } from "@/server/messaging/channel-health";
import { addContactNoteFromConversation, createDealFromConversation, createTaskFromConversation, getInboxCrmContext, listConversationAiEmployees, setLeadStatusFromConversation } from "@/server/messaging/inbox-context";
import { INBOX_VIEWS } from "@/lib/inbox";
import { roleHasPermission } from "@/lib/permissions";
import { inbound, messagingOrg, recordingProvider, type MessagingOrg } from "./support/messaging";

let m: MessagingOrg;
const ids = (items: Array<{ id: string }>) => items.map((i) => i.id);

beforeAll(async () => {
  resetEnvCache();
  m = await messagingOrg({ name: "Inbox Views Co" });
});
afterAll(() => {
  delete process.env.GHL_WRITES_ENABLED;
  resetEnvCache();
});

const setTimes = (id: string, over: { lastInbound?: string | null; lastOutbound?: string | null; lastMessage?: string; unread?: number }) =>
  withSystem((db) =>
    db.query(
      `update conversations set last_inbound_at = coalesce($2::timestamptz, last_inbound_at), last_outbound_at = $3::timestamptz,
         last_message_at = coalesce($4::timestamptz, last_message_at), unread_count = coalesce($5, unread_count) where id = $1`,
      [id, over.lastInbound ?? null, over.lastOutbound ?? null, over.lastMessage ?? null, over.unread ?? null],
    ),
  );
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const view = async (ctx: ReturnType<MessagingOrg["ctx"]>, v: (typeof INBOX_VIEWS)[number], extra = {}) => ids((await listConversationsPage(ctx, { view: v, ...extra })).items);

describe("the views of the conversation list", () => {
  it("puts each conversation where its definition says, and counts exactly what the view lists", async () => {
    const org = await messagingOrg({ name: "Definitions Co" });
    const fresh = await inbound(org.org.id, { name: "Fresh Unread" });
    const answered = await inbound(org.org.id, { name: "We Replied Last" });
    await setTimes(answered.conversationId, { lastInbound: ago(120), lastOutbound: ago(60), unread: 0 });
    const resolved = await inbound(org.org.id, { name: "Resolved One" });
    await setConversationState(org.ctx("manager"), resolved.conversationId, { status: "closed", outcome: "answered" });
    const archived = await inbound(org.org.id, { name: "Archived One" });
    await setConversationState(org.ctx("manager"), archived.conversationId, { status: "closed", archived: true });
    const mine = await inbound(org.org.id, { name: "Mine Now" });
    await takeOverConversation(org.ctx("manager"), mine.conversationId);
    const person = await inbound(org.org.id, { name: "Needs A Person", body: "Can I speak to a real person please?" });
    await withSystem((db) => db.query("update conversations set owner_kind = 'unassigned', ai_agent_id = null where id = $1", [fresh.conversationId]));

    const mgr = org.ctx("manager");
    expect(await view(mgr, "all")).toEqual(expect.arrayContaining([fresh, answered, resolved, mine, person].map((c) => c.conversationId)));
    expect(await view(mgr, "all")).not.toContain(archived.conversationId);
    expect(await view(mgr, "unread")).toEqual(expect.arrayContaining([fresh.conversationId, person.conversationId]));
    expect(await view(mgr, "unread")).not.toContain(answered.conversationId);
    expect(await view(mgr, "mine")).toEqual([mine.conversationId]);
    expect(await view(mgr, "unassigned")).toEqual([fresh.conversationId]);
    expect(await view(mgr, "waiting")).toEqual([answered.conversationId]);
    expect(await view(mgr, "resolved")).toEqual([resolved.conversationId]);
    expect(await view(mgr, "archived")).toEqual([archived.conversationId]);
    expect(await view(mgr, "open")).not.toContain(resolved.conversationId);
    expect(await view(mgr, "ai")).toEqual(expect.arrayContaining([answered.conversationId]));
    expect(await view(mgr, "ai")).not.toContain(mine.conversationId);
    expect(await view(mgr, "attention")).toEqual([person.conversationId]);

    const counts = await inboxViewCounts(mgr);
    for (const v of INBOX_VIEWS) expect(counts[v], v).toBe((await view(mgr, v)).length);
  });

  it("says why something needs attention, from facts, and stops saying it once it is dealt with", async () => {
    const org = await messagingOrg({ name: "Attention Co" });
    const a = await inbound(org.org.id, { name: "Urgent One" });
    await setConversationState(org.ctx("manager"), a.conversationId, { priority: "urgent" });
    const b = await inbound(org.org.id, { name: "Waiting Too Long" });
    await setTimes(b.conversationId, { lastInbound: ago(90), unread: 1 });
    const c = await inbound(org.org.id, { name: "Not Yet" });
    await setTimes(c.conversationId, { lastInbound: ago(5), unread: 1 });
    const d = await inbound(org.org.id, { name: "Send Failed" });
    const sent = await sendHumanReply(org.ctx("manager"), d.conversationId, "On our way");
    const rec = recordingProvider(() => ({ ok: false, retryable: false, error: "The provider rejected the message." }));
    await dispatchMessage(sent.messageId, { provider: rec.provider });

    const page = (await listConversationsPage(org.ctx("manager"), { view: "attention" })).items;
    const reasons = Object.fromEntries(page.map((i) => [i.contactName, i.attention]));
    expect(reasons).toMatchObject({ "Urgent One": ["urgent"], "Waiting Too Long": ["awaiting_reply"], "Send Failed": ["send_failed"] });
    expect(page.map((i) => i.contactName)).not.toContain("Not Yet");

    // Sending the failed message again clears that reason; resolving removes the conversation from attention altogether.
    await retryFailedMessage(org.ctx("manager"), sent.messageId);
    expect(await view(org.ctx("manager"), "attention")).not.toContain(d.conversationId);
    await setConversationState(org.ctx("manager"), a.conversationId, { status: "closed" });
    expect(await view(org.ctx("manager"), "attention")).not.toContain(a.conversationId);
  });

  it("shows a person only what they may see, in the list and in the counts", async () => {
    const org = await messagingOrg({ name: "Restricted Co" });
    const mine = await inbound(org.org.id, { name: "Assigned To Support" });
    const theirs = await inbound(org.org.id, { name: "Not For Support" });
    await assignConversation(org.ctx("manager"), mine.conversationId, org.people.support.id);
    expect(await view(org.ctx("support"), "all")).toEqual([mine.conversationId]);
    expect(await view(org.ctx("support"), "mine")).toEqual([mine.conversationId]);
    expect((await inboxViewCounts(org.ctx("support"))).all).toBe(1);
    expect((await inboxViewCounts(org.ctx("manager"))).all).toBe(2);
    expect(await view(org.ctx("sales"), "all")).toEqual([]);
    const other = await messagingOrg({ name: "Not Your Workspace Co" });
    const foreign = await inbound(other.org.id, { name: "Somebody Else" });
    expect(await view(org.ctx("manager"), "all")).not.toContain(foreign.conversationId);
    expect(await view(other.ctx("manager"), "all")).toEqual([foreign.conversationId]);
    // Another workspace's person cannot open it by id either.
    expect(await listConversationsPage(org.ctx("manager"), {}, foreign.conversationId)).toMatchObject({ items: [] });
    void theirs;
  });
});

describe("paging, sorting and searching", () => {
  it("walks the whole list page by page without repeating or skipping, even while it changes", async () => {
    const org = await messagingOrg({ name: "Paging Co" });
    const made: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const c = await inbound(org.org.id, { name: `Person ${i}` });
      await setTimes(c.conversationId, { lastMessage: ago(100 - i * 10) });
      made.push(c.conversationId);
    }
    for (const sort of ["recent", "priority", "waiting_longest"] as const) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await listConversationsPage(org.ctx("manager"), { sort, limit: 3, cursor });
        seen.push(...ids(page.items));
        cursor = page.nextCursor;
        pages += 1;
        if (pages === 1) {
          // A conversation arriving between pages is simply not in the walk already behind the cursor.
          const late = await inbound(org.org.id, { name: `Late ${sort}` });
          made.push(late.conversationId);
        }
      } while (cursor);
      expect(new Set(seen).size, sort).toBe(seen.length);
      expect(seen).toEqual(expect.arrayContaining(made.slice(0, 7)));
      expect(pages, sort).toBeGreaterThanOrEqual(3);
    }
    const recent = ids((await listConversationsPage(org.ctx("manager"), { sort: "recent", limit: 100 })).items);
    const stamps = (await withSystem((db) => db.query<{ id: string; t: Date }>("select id, last_message_at as t from conversations where org_id = $1", [org.org.id]))).rows;
    const byTime = [...stamps].sort((a, b) => new Date(b.t).getTime() - new Date(a.t).getTime()).map((r) => r.id);
    expect(recent).toEqual(byTime);
  });

  it("ignores a cursor that was tampered with, and caps the page size", async () => {
    expect(decodeCursor("not-a-cursor")).toBeNull();
    expect(decodeCursor(Buffer.from(JSON.stringify([1, "x'; drop table conversations; --", "00000000-0000-0000-0000-000000000000"])).toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from(JSON.stringify([1, "2026-10-22 00:00:00+00", "not-a-uuid"])).toString("base64url"))).toBeNull();
    const page = await listConversationsPage(m.ctx("manager"), { limit: 100000, cursor: "garbage" });
    expect(page.items.length).toBeLessThanOrEqual(100);
  });

  it("finds a conversation by name, number, email, subject or what the customer wrote, and treats wildcards literally", async () => {
    const org = await messagingOrg({ name: "Search Co" });
    const a = await inbound(org.org.id, { name: "Zelda Fitzgerald", body: "Do you install heat pumps in Quezon City?" });
    const b = await inbound(org.org.id, { name: "Plain Person", body: "Is the 100% discount real?" });
    const mgr = org.ctx("manager");
    expect(ids((await listConversationsPage(mgr, { q: "zelda" })).items)).toEqual([a.conversationId]);
    expect(ids((await listConversationsPage(mgr, { q: a.address.slice(-6) })).items)).toEqual([a.conversationId]);
    expect(ids((await listConversationsPage(mgr, { q: "heat pumps" })).items)).toEqual([a.conversationId]);
    expect(ids((await listConversationsPage(mgr, { q: "100%" })).items)).toEqual([b.conversationId]);
    expect(ids((await listConversationsPage(mgr, { q: "%" })).items)).toEqual([b.conversationId]);
    expect(ids((await listConversationsPage(mgr, { q: "_" })).items)).toEqual([]);
    expect(ids((await listConversationsPage(mgr, { q: "no such thing anywhere" })).items)).toEqual([]);
  });

  it("does not search the team's private notes, and does not search what a person is not allowed to open", async () => {
    const org = await messagingOrg({ name: "Private Search Co" });
    const c = await inbound(org.org.id, { name: "Quiet Customer", body: "Hello there" });
    await withSystem((db) => db.query("insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status) values ($1, $2, 'internal', 'human', 'secretnote budget is tiny', 'note')", [org.org.id, c.conversationId]));
    expect(ids((await listConversationsPage(org.ctx("manager"), { q: "secretnote" })).items)).toEqual([]);
    expect(ids((await listConversationsPage(org.ctx("support"), { q: "Hello there" })).items)).toEqual([]);
  });

  it("keeps the old list function working for callers that predate views", async () => {
    const org = await messagingOrg({ name: "Legacy Callers Co" });
    const c = await inbound(org.org.id);
    const list = await listConversations(org.ctx("manager"), { owner: "ai", unreadOnly: true });
    expect(ids(list)).toEqual([c.conversationId]);
    expect(list[0]).toMatchObject({ aiPaused: false, waitingOnCustomer: false, archivedAt: null, attention: [] });
  });
});

describe("keeping tabs and teammates in step", () => {
  it("tells a client what changed since its last look, and only what that person may see", async () => {
    const org = await messagingOrg({ name: "Sync Co" });
    const first = await inbound(org.org.id, { name: "First" });
    const start = await inboxSync(org.ctx("manager"), null);
    expect(start).toMatchObject({ full: true, changes: [] });
    const since = new Date(new Date(start.serverTime).getTime() - 1000).toISOString();
    expect(await inboxSync(org.ctx("manager"), start.serverTime)).toMatchObject({ full: false, changes: [] });
    await new Promise((r) => setTimeout(r, 20));
    const second = await inbound(org.org.id, { name: "Second" });
    await markConversationRead(org.ctx("manager"), first.conversationId);
    const changed = await inboxSync(org.ctx("manager"), since, { counts: true });
    expect(changed.full).toBe(false);
    expect(ids(changed.changes.map((c) => ({ id: c.id })))).toEqual(expect.arrayContaining([second.conversationId, first.conversationId]));
    expect(changed.counts?.all).toBe(2);
    // Revisions only go up, so a client can ignore a late or repeated answer.
    const again = await inboxSync(org.ctx("manager"), since);
    for (const c of again.changes) expect(c.revision).toBeGreaterThanOrEqual(changed.changes.find((x) => x.id === c.id)!.revision);
    // A teammate with access to neither conversation learns nothing, not even that something happened.
    expect((await inboxSync(org.ctx("support"), since)).changes).toEqual([]);
  });

  it("notices a delivery status moving, not only new messages", async () => {
    const org = await messagingOrg({ name: "Delivery Sync Co" });
    const c = await inbound(org.org.id);
    const sent = await sendHumanReply(org.ctx("manager"), c.conversationId, "On our way");
    const before = await inboxSync(org.ctx("manager"), null);
    await new Promise((r) => setTimeout(r, 20));
    const rec = recordingProvider();
    await dispatchMessage(sent.messageId, { provider: rec.provider });
    const out = await inboxSync(org.ctx("manager"), new Date(new Date(before.serverTime).getTime() - 500).toISOString());
    expect(ids(out.changes)).toContain(c.conversationId);
    const thread = await loadInboxThread(org.ctx("manager"), c.conversationId);
    expect(thread?.messages.some((x) => x.id === sent.messageId && x.status === "sent")).toBe(true);
  });

  it("asks for a full refresh when the client's last look is too old, in the future, or unreadable", async () => {
    const day = 25 * 3600_000;
    for (const since of [new Date(Date.now() - day).toISOString(), new Date(Date.now() + 3600_000).toISOString(), "yesterday", ""]) {
      expect(await inboxSync(m.ctx("manager"), since), since).toMatchObject({ full: true, changes: [] });
    }
    expect(SYNC_MAX_CHANGES).toBeGreaterThan(0);
  });

  it("answers the thread view only for conversations the person can open", async () => {
    const org = await messagingOrg({ name: "Thread Access Co" });
    const c = await inbound(org.org.id);
    expect((await loadInboxThread(org.ctx("manager"), c.conversationId))?.conversation.id).toBe(c.conversationId);
    expect(await loadInboxThread(org.ctx("support"), c.conversationId)).toBeNull();
    expect(await loadInboxThread(org.ctx("viewer"), c.conversationId)).toBeNull();
    const other = await messagingOrg({ name: "Thread Elsewhere Co" });
    expect(await loadInboxThread(other.ctx("owner"), c.conversationId)).toBeNull();
    expect(await loadInboxThread(org.ctx("manager"), "not-a-uuid")).toBeNull();
  });
});

describe("what the inbox says about each channel", () => {
  const row = (over: Record<string, unknown> = {}) => ({ channel: "sms" as const, provider: "twilio", enabled: true, sender_verified_at: new Date(), registration_status: "approved", detail: null, capability_tested_at: new Date(), ...over });

  it("claims a channel is connected only when it is verified, switched on and allowed to send", () => {
    expect(describeChannel(undefined, { sent24h: 0, failed24h: 0 }, true).state).toBe("not_connected");
    expect(describeChannel(row({ sender_verified_at: null }), { sent24h: 0, failed24h: 0 }, true).state).toBe("not_connected");
    expect(describeChannel(row({ enabled: false }), { sent24h: 0, failed24h: 0 }, true).state).toBe("paused");
    expect(describeChannel(row(), { sent24h: 0, failed24h: 0 }, false)).toMatchObject({ state: "needs_attention", detail: expect.stringMatching(/switched off in this environment/) });
    expect(describeChannel(row(), { sent24h: 10, failed24h: 6 }, true).state).toBe("needs_attention");
    expect(describeChannel(row(), { sent24h: 10, failed24h: 5 }, true).state).toBe("connected");
    expect(describeChannel(row(), { sent24h: 2, failed24h: 2 }, true).state).toBe("connected");
    expect(describeChannel(row(), { sent24h: 0, failed24h: 0 }, true).state).toBe("connected");
  });

  it("reports the workspace's real channels, with what actually arrived, and is honest about the two that are not message channels", async () => {
    delete process.env.GHL_WRITES_ENABLED;
    resetEnvCache();
    const org = await messagingOrg({ name: "Health Co" });
    await inbound(org.org.id);
    const off = await getChannelHealth(org.ctx("manager"));
    expect(off.find((c) => c.key === "sms")).toMatchObject({ state: "needs_attention", inbound7d: 1, provider: "GoHighLevel" });
    process.env.GHL_WRITES_ENABLED = "true";
    resetEnvCache();
    const on = await getChannelHealth(org.ctx("manager"));
    expect(on.find((c) => c.key === "sms")).toMatchObject({ state: "connected", inbound7d: 1 });
    expect(on.find((c) => c.key === "email")).toMatchObject({ state: "connected", inbound7d: 0, lastInboundAt: null });
    expect(on.find((c) => c.key === "web_chat")?.state).toBe("not_available");
    expect(on.find((c) => c.key === "phone")?.state).toBe("not_available");
    await withSystem((db) => db.query("update messaging_channels set enabled = false where org_id = $1 and channel = 'whatsapp'", [org.org.id]));
    expect((await getChannelHealth(org.ctx("manager"))).find((c) => c.key === "whatsapp")?.state).toBe("paused");
    const blank = await messagingOrg({ name: "No Setup Co" });
    await withSystem((db) => db.query("delete from messaging_channels where org_id = $1", [blank.org.id]));
    expect((await getChannelHealth(blank.ctx("manager"))).filter((c) => ["sms", "whatsapp", "email"].includes(c.key)).map((c) => c.state)).toEqual(["not_connected", "not_connected", "not_connected"]);
    await expect(getChannelHealth(org.ctx("viewer"))).resolves.toBeDefined();
  });
});

describe("the customer's CRM record beside the conversation", () => {
  it("gathers the record for people who may see it and says plainly what the others may not", async () => {
    const org = await messagingOrg({ name: "Context Co" });
    const c = await inbound(org.org.id, { name: "Carla Reyes", body: "I'd like a quote please" });
    await assignConversation(org.ctx("manager"), c.conversationId, org.people.support.id);
    await assignConversation(org.ctx("manager"), c.conversationId, org.people.support.id);
    const task = await createTaskFromConversation(org.ctx("manager"), c.conversationId, { title: "Send Carla the quote", priority: "high" });
    const deal = await createDealFromConversation(org.ctx("manager"), c.conversationId, { value: 1200 });
    // Once per conversation: a second click returns the same deal.
    expect(await createDealFromConversation(org.ctx("manager"), c.conversationId, { value: 9999 })).toEqual(deal);
    await addContactNoteFromConversation(org.ctx("manager"), c.conversationId, "Prefers a morning call.");
    await setLeadStatusFromConversation(org.ctx("manager"), c.conversationId, "qualified");

    const full = await getInboxCrmContext(org.ctx("manager"), c.conversationId);
    expect(full.contact).toMatchObject({ name: "Carla Reyes", leadStatus: "qualified" });
    expect(full.tasks).toMatchObject({ state: "ok", items: [expect.objectContaining({ id: task.taskId, title: "Send Carla the quote", priority: "high" })] });
    expect(full.deals).toMatchObject({ state: "ok", items: [expect.objectContaining({ id: deal.opportunityId, value: 1200 })] });
    expect(full.notes).toMatchObject({ state: "ok", items: [expect.objectContaining({ body: "Prefers a morning call." })] });
    expect(full.appointments.state).toBe("ok");
    expect(full.links.contact).toBe(`/crm/contacts/${full.contact!.id}`);
    expect(full.ai.employees.length).toBeGreaterThan(0);

    for (const who of ["support", "sales"] as const) {
      if (who === "sales") continue; // not assigned: cannot open it at all
      const ctx = org.ctx(who);
      const limited = await getInboxCrmContext(ctx, c.conversationId);
      expect(limited.deals.state, `${who} deals`).toBe(roleHasPermission("support", "sales.view") ? "ok" : "no_access");
      expect(limited.calls.state, `${who} calls`).toBe(roleHasPermission("support", "calls.view") ? "ok" : "no_access");
    }
    await expect(getInboxCrmContext(org.ctx("sales"), c.conversationId)).rejects.toThrow(/not found/i);
    const other = await messagingOrg({ name: "Context Elsewhere Co" });
    await expect(getInboxCrmContext(other.ctx("owner"), c.conversationId)).rejects.toThrow(/not found/i);
  });

  it("writes through the CRM's own permission checks, and leaves a line on the conversation", async () => {
    const org = await messagingOrg({ name: "Quick Actions Co" });
    const c = await inbound(org.org.id);
    await assignConversation(org.ctx("manager"), c.conversationId, org.people.support.id);
    await createTaskFromConversation(org.ctx("support"), c.conversationId, { title: "Call back" }).catch(() => undefined);
    await createTaskFromConversation(org.ctx("manager"), c.conversationId, { title: "Call back tomorrow" });
    const kinds = (await withSystem((db) => db.query<{ kind: string }>("select kind from conversation_events where conversation_id = $1 order by id", [c.conversationId]))).rows.map((r) => r.kind);
    expect(kinds).toContain("task_linked");
    await expect(createTaskFromConversation(org.ctx("viewer"), c.conversationId, { title: "Nope" })).rejects.toThrow(/not found|Your role|can't/i);
    await expect(setLeadStatusFromConversation(org.ctx("manager"), c.conversationId, "invented")).rejects.toThrow(/Choose a lead status/);
    await expect(createTaskFromConversation(org.ctx("manager"), c.conversationId, { title: "" })).rejects.toThrow(/title/i);
    const task = (await withSystem((db) => db.query<{ description: string; contact_id: string }>("select description, contact_id from tasks where org_id = $1 and title = 'Call back tomorrow'", [org.org.id]))).rows[0];
    expect(task.description).toContain(`/inbox?conversation=${c.conversationId}`);
  });

  it("lists only customer-facing AI employees, with whether each could take a conversation right now", async () => {
    const list = await listConversationAiEmployees(m.ctx("manager"));
    expect(list.map((e) => e.roleKey).sort()).toEqual(["appointment_setter", "sales_assistant"]);
    expect(list.find((e) => e.roleKey === "sales_assistant")).toMatchObject({ ready: true, problem: null });
    expect(await listConversationAiEmployees(m.ctx("support"))).toEqual([]);
  });

  it("reads the thread's AI facts from the database, not from a model", async () => {
    const org = await messagingOrg({ name: "AI Facts Co" });
    const c = await inbound(org.org.id);
    const ctxData = await getInboxCrmContext(org.ctx("manager"), c.conversationId);
    expect(ctxData.ai).toMatchObject({ aiMessages: 0, draftsWaiting: 0, handoffs: 0 });
    expect(ctxData.ai.employees.map((e) => e.roleKey)).toEqual(["sales_assistant"]);
    void withUser;
  });
});
