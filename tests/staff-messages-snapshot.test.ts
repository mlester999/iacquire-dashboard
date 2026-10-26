import { beforeEach, describe, expect, it } from "vitest";
import { addMembers, createChannel, createDirect, createGroup, joinChannel, listConversations, setArchived, setPreferences, updateConversation, RENAME_CONFLICT_MESSAGE } from "@/server/staff-messages/conversations";
import { deleteMessage, EDIT_CONFLICT_MESSAGE, editMessage, sendMessage } from "@/server/staff-messages/messages";
import { markRead } from "@/server/staff-messages/read";
import { inboxStatus } from "@/server/staff-messages/inbox";
import { buildSnapshot, unreadTotal } from "@/server/staff-messages/snapshot";
import { staffNavState } from "@/server/staff-messages/nav";
import { loadPageData } from "@/server/staff-messages/page-data";
import { isUnchanged, type SnapshotPayload } from "@/lib/staff-messages/snapshot";
import type { SnapshotQuery } from "@/lib/staff-messages/live";
import { badgeTotal } from "@/lib/staff-messages/unread";
import { PAGE_SIZE } from "@/lib/staff-messages/limits";
import { resetRateLimits } from "./support/support-world";
import { channelName, clearOverride, disable, enable, freshId, override, setMessages, setRole, staffPerson, staffWorld, type Person, type World } from "./support/staff-messages";

// The snapshot an open Messages page asks for, the state of the navigation entry, and the first render of the pages: built from the person's own access, on embedded
// Postgres. Nothing here is a browser; the page's behaviour is in the screens test.

let w: World;
beforeEach(async () => {
  await resetRateLimits();
  w = await staffWorld();
});

const q = (over: Partial<SnapshotQuery> = {}): SnapshotQuery => ({ since: null, conversationId: null, threadRootId: null, beforeSeq: null, aroundSeq: null, badgeOnly: false, ...over });
const refused = async (p: Promise<unknown>) => p.then(() => null, (e: Error & { code?: string }) => ({ code: e.code, message: e.message }));
const send = (who: Person, conversationId: string, body: string, over: Record<string, unknown> = {}) => sendMessage(who, { conversationId, clientMessageId: freshId(), body, ...over });
const group = async (owner: Person, ...others: Person[]) => (await createGroup(owner, { name: `g-${freshId().slice(0, 6)}`, memberIds: others.map((o) => o.id) })).id;
const full = async (who: Person, query: Partial<SnapshotQuery> = {}) => {
  const out = await buildSnapshot(who, q(query));
  if (isUnchanged(out)) throw new Error("expected a full answer");
  return out;
};

describe("a full snapshot", () => {
  it("carries the rail, the conversation, its newest messages and the unread total, and nothing from conversations the person is not in", async () => {
    const mine = await group(w.staff, w.staff2);
    const theirs = await group(w.staff2, w.staff3);
    await send(w.staff2, mine, "Hello from Staff 2");
    await send(w.staff3, theirs, "Private to the others");
    const out = await full(w.staff, { conversationId: mine });
    expect(out.rail?.map((r) => r.id)).toEqual([mine]);
    expect(out.unread).toBe(1);
    expect(out.conversation?.conversation.id).toBe(mine);
    expect(out.conversation?.can.post).toBe(true);
    expect(out.page?.messages.map((m) => m.body)).toEqual(["Hello from Staff 2"]);
    expect(out.page).toMatchObject({ hasMore: false, lastSeq: 1, lastReadSeq: 0 });
    expect(JSON.stringify(out)).not.toContain("Private to the others");
    expect(out.thread).toBeUndefined();
  });

  it("answers a rail-only request without a conversation", async () => {
    await group(w.staff, w.staff2);
    const out = await full(w.staff);
    expect(out.rail).toHaveLength(1);
    expect(out.conversation).toBeUndefined();
    expect(out.page).toBeUndefined();
  });

  it("says a conversation the person is not in is not there, in the same words for a made-up id", async () => {
    const dm = (await createDirect(w.staff2, w.staff3.id)).id;
    await send(w.staff2, dm, "Not for you");
    for (const who of [w.staff, w.manager, w.superAdmin]) {
      const out = await full(who, { conversationId: dm });
      expect(out.conversation, who.name).toBeNull();
      expect(out.page).toBeUndefined();
      expect(JSON.stringify(out)).not.toContain("Not for you");
    }
    const made = await full(w.staff, { conversationId: freshId() });
    expect(made.conversation).toBeNull();
    expect(await full(w.staff, { conversationId: dm })).toMatchObject({ conversation: null });
  });

  it("previews an open channel the person has not joined without its messages, and shows them once they join", async () => {
    const name = channelName();
    const channel = (await createChannel(w.manager, { name, visibility: "staff" })).id;
    await send(w.manager, channel, "Welcome to the channel");
    const before = await full(w.staff, { conversationId: channel });
    expect(before.conversation).toMatchObject({ conversation: { memberRole: null }, members: null, can: { join: true, post: false } });
    expect(before.page).toBeUndefined();
    expect(JSON.stringify(before)).not.toContain("Welcome to the channel");
    await joinChannel(w.staff, channel);
    const after = await full(w.staff, { conversationId: channel });
    expect(after.page?.messages.map((m) => m.body)).toEqual(["Welcome to the channel"]);
  });

  it("does not preview a private channel to someone who is not in it", async () => {
    const channel = (await createChannel(w.manager, { name: channelName(), visibility: "private", memberIds: [w.staff2.id] })).id;
    expect((await full(w.staff, { conversationId: channel })).conversation).toBeNull();
  });

  it("opens the newest page, or the page ending a little after a message when asked to read around it", async () => {
    const id = await group(w.staff, w.staff2);
    for (let i = 1; i <= PAGE_SIZE + 30; i++) await send(w.staff2, id, `m${i}`);
    const newest = await full(w.staff, { conversationId: id });
    expect(newest.page?.messages).toHaveLength(PAGE_SIZE);
    expect(newest.page?.messages.at(-1)?.body).toBe(`m${PAGE_SIZE + 30}`);
    expect(newest.page?.hasMore).toBe(true);
    const around = await full(w.staff, { conversationId: id, aroundSeq: 20 });
    expect(around.page?.messages.some((m) => m.seq === 20)).toBe(true);
    expect(around.page?.messages.at(-1)?.seq).toBe(45);
    expect(around.page?.messages.some((m) => m.seq === 80)).toBe(false);
  }, 60_000);

  it("asks for an older page on its own, without the rail", async () => {
    const id = await group(w.staff, w.staff2);
    for (let i = 1; i <= 8; i++) await send(w.staff2, id, `m${i}`);
    const out = await full(w.staff, { conversationId: id, beforeSeq: 4 });
    expect(out.older?.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(out.rail).toBeUndefined();
    expect(out.page).toBeUndefined();
  });

  it("includes the open thread, root first, and says null for an id that is not a thread of this conversation", async () => {
    const id = await group(w.staff, w.staff2);
    const root = (await send(w.staff, id, "Root")).message;
    await send(w.staff2, id, "Reply", { threadRootId: root.id });
    const other = await group(w.staff, w.staff2);
    const elsewhere = (await send(w.staff, other, "Another root")).message;
    const out = await full(w.staff, { conversationId: id, threadRootId: root.id });
    expect(out.thread?.messages.map((m) => m.body)).toEqual(["Root", "Reply"]);
    expect(out.page?.messages.map((m) => m.body)).toEqual(["Root"]);
    expect((await full(w.staff, { conversationId: id, threadRootId: freshId() })).thread).toBeNull();
    expect((await full(w.staff, { conversationId: id, threadRootId: elsewhere.id })).thread).toBeNull();
    // A reply is not itself a thread.
    const reply = out.thread?.messages[1];
    expect((await full(w.staff, { conversationId: id, threadRootId: reply?.id })).thread).toBeNull();
  });
});

describe("asking again", () => {
  it("answers 'unchanged' while nothing happened and a full answer after anything does", async () => {
    const id = await group(w.staff, w.staff2);
    const first = await full(w.staff, { conversationId: id });
    const same = await buildSnapshot(w.staff, q({ conversationId: id, since: first.revision }));
    expect(same).toEqual({ unchanged: true, revision: first.revision });
    await send(w.staff2, id, "News");
    const next = await buildSnapshot(w.staff, q({ conversationId: id, since: first.revision }));
    expect(isUnchanged(next)).toBe(false);
    expect((next as SnapshotPayload).revision).toBeGreaterThan(first.revision);
    expect((next as SnapshotPayload).page?.messages.map((m) => m.body)).toEqual(["News"]);
    // A revision from the future (a forged one) is not 'unchanged': the person gets the real answer.
    expect(isUnchanged(await buildSnapshot(w.staff, q({ conversationId: id, since: first.revision + 1000 })))).toBe(false);
  });

  it("changes the revision for a read, a reaction-free edit, a delete, a rename and a mute, so every open page hears about it", async () => {
    const id = await group(w.staff, w.staff2);
    const m = (await send(w.staff, id, "Text")).message;
    const seen: number[] = [(await full(w.staff2)).revision];
    const bump = async (action: () => Promise<unknown>) => {
      await action();
      const now = (await full(w.staff2)).revision;
      expect(now, "after a change").toBeGreaterThan(seen.at(-1) as number);
      seen.push(now);
    };
    await bump(() => editMessage(w.staff, { messageId: m.id, body: "Text edited" }));
    await bump(() => markRead(w.staff2, id, 1));
    await bump(() => updateConversation(w.staff, id, { name: "Renamed" }));
    await bump(() => setPreferences(w.staff2, id, { muted: true }));
    await bump(() => deleteMessage(w.staff, m.id));
  });

  it("returns only the unread total for a badge-only request, equal to what the rail adds up to", async () => {
    const a = await group(w.staff, w.staff2);
    const b = await group(w.staff, w.staff3);
    await send(w.staff2, a, "one");
    await send(w.staff2, a, "two");
    await send(w.staff3, b, "three");
    await setPreferences(w.staff, b, { muted: true });
    const out = await full(w.staff, { badgeOnly: true });
    expect(out).toEqual({ revision: expect.any(Number), unread: 2 });
    expect(await unreadTotal(w.staff.id)).toBe(2);
    expect(badgeTotal(await listConversations(w.staff))).toBe(2);
    expect((await full(w.staff)).unread).toBe(2);
    await markRead(w.staff, a, 2);
    expect(await unreadTotal(w.staff.id)).toBe(0);
  });

  it("does not count a muted conversation or an archived one toward the badge, and counts replies like any message", async () => {
    const id = await group(w.staff, w.staff2);
    const root = (await send(w.staff2, id, "Root")).message;
    await send(w.staff2, id, "Reply", { threadRootId: root.id });
    expect(await unreadTotal(w.staff.id)).toBe(2);
    await setPreferences(w.staff, id, { muted: true });
    expect(await unreadTotal(w.staff.id)).toBe(0);
    await setPreferences(w.staff, id, { muted: false });
    expect(await unreadTotal(w.staff.id)).toBe(2);
    await setArchived(w.staff, id, true);
    expect(await unreadTotal(w.staff.id)).toBe(0);
    expect(badgeTotal(await listConversations(w.staff))).toBe(0);
  });
});

describe("a person whose standing changed", () => {
  const stopped = async (who: Person, code: string) => {
    expect(await refused(buildSnapshot(who, q()))).toMatchObject({ code });
    expect(await refused(buildSnapshot(who, q({ badgeOnly: true })))).toMatchObject({ code });
    expect(await refused(buildSnapshot(who, q({ conversationId: freshId() })))).toMatchObject({ code });
  };

  it("is refused at once when disabled, demoted to a client, denied the permission, or when the module is switched off, with the reason", async () => {
    const stale = await staffPerson("agency_staff");
    await disable(stale.id);
    await stopped(stale, "forbidden");
    const demoted = await staffPerson("agency_manager");
    await setRole(demoted.id, "none");
    await stopped(demoted, "forbidden");
    const denied = await staffPerson("agency_staff");
    await override(denied.id, "agency.messages.use", "deny");
    await stopped(denied, "forbidden");
    const changed = await staffPerson("agency_staff");
    await setRole(changed.id, "agency_manager");
    // Their session still says agency_staff.
    await stopped({ ...changed, platformRole: "agency_staff" }, "forbidden");
    await setMessages(false);
    await stopped(w.staff, "not_enabled");
    expect(await inboxStatus(w.staff)).toEqual({ access: "changed", reason: "not_enabled" });
    await setMessages(true);
    await clearOverride(denied.id, "agency.messages.use");
    expect(await buildSnapshot(denied, q({ badgeOnly: true }))).toMatchObject({ unread: 0 });
    await enable(stale.id);
  });

  it("is refused for an id that is not a person at all", async () => {
    expect(await refused(buildSnapshot({ id: "not-an-id", platformRole: "agency_staff" }, q()))).toMatchObject({ code: "forbidden" });
  });
});

describe("the entry in the navigation", () => {
  it("is on, with the unread total, for someone who may use Messages", async () => {
    const id = await group(w.staff, w.staff2);
    await send(w.staff2, id, "Ping");
    expect(await staffNavState(w.staff)).toEqual({ state: "on", unread: 1 });
    expect(await staffNavState(w.staff2)).toEqual({ state: "on", unread: 0 });
  });

  it("is off while the module is switched off, even for a Super Admin (who still gets the entry from the shell), and denied for someone who may not use it or who is not agency staff", async () => {
    await setMessages(false);
    expect(await staffNavState(w.superAdmin)).toEqual({ state: "off", unread: 0 });
    expect(await staffNavState(w.staff)).toEqual({ state: "off", unread: 0 });
    await setMessages(true);
    const denied = await staffPerson("agency_staff");
    await override(denied.id, "agency.messages.use", "deny");
    expect(await staffNavState(denied)).toEqual({ state: "denied", unread: 0 });
    const client = await staffPerson("none");
    expect(await staffNavState(client)).toEqual({ state: "denied", unread: 0 });
    expect(await staffNavState({ id: "nope", platformRole: "agency_staff" })).toEqual({ state: "denied", unread: 0 });
  });
});

describe("the first render of a page", () => {
  const user = (p: Person) => ({ id: p.id, platformRole: p.platformRole, timezone: "Asia/Manila" });

  it("is ready with the person's name, what they may do and the first snapshot", async () => {
    const id = await group(w.manager, w.staff);
    await send(w.manager, id, "Welcome");
    const out = await loadPageData(user(w.staff), { conversationId: id, aroundSeq: null, threadId: null });
    expect(out.kind).toBe("ready");
    if (out.kind !== "ready") return;
    expect(out.me).toEqual({ id: w.staff.id, name: w.staff.name, role: "agency_staff", canChannels: false, canModerate: false, timeZone: "Asia/Manila" });
    expect(out.initial.page?.messages.map((m) => m.body)).toEqual(["Welcome"]);
    const mgr = await loadPageData(user(w.manager), { conversationId: null, aroundSeq: null, threadId: null });
    expect(mgr).toMatchObject({ kind: "ready", me: { canChannels: true, canModerate: false } });
    const sup = await loadPageData(user(w.superAdmin), { conversationId: null, aroundSeq: null, threadId: null });
    expect(sup).toMatchObject({ kind: "ready", me: { canChannels: true, canModerate: true } });
  });

  it("says why there is nothing to show, honestly: switched off, not allowed, or no agency workspace", async () => {
    await setMessages(false);
    expect(await loadPageData(user(w.staff), { conversationId: null, aroundSeq: null, threadId: null })).toEqual({ kind: "unavailable", reason: "off" });
    await setMessages(true);
    const denied = await staffPerson("agency_staff");
    await override(denied.id, "agency.messages.use", "deny");
    expect(await loadPageData(user(denied), { conversationId: null, aroundSeq: null, threadId: null })).toEqual({ kind: "unavailable", reason: "denied" });
    const client = await staffPerson("none");
    expect(await loadPageData(user(client), { conversationId: null, aroundSeq: null, threadId: null })).toEqual({ kind: "unavailable", reason: "denied" });
  });
});

describe("two people changing the same thing", () => {
  it("refuses an edit made from a stale copy, and says so, instead of overwriting the later edit", async () => {
    const id = await group(w.staff, w.staff2);
    const m = (await send(w.staff, id, "Version one")).message;
    expect(m.editedAt).toBeNull();
    const second = await editMessage(w.staff, { messageId: m.id, body: "Version two", expectedEditedAt: null });
    expect(second.editedAt).not.toBeNull();
    const stale = await refused(editMessage(w.staff, { messageId: m.id, body: "Version three from a stale tab", expectedEditedAt: null }));
    expect(stale).toEqual({ code: "conflict", message: EDIT_CONFLICT_MESSAGE });
    const fresh = await editMessage(w.staff, { messageId: m.id, body: "Version three", expectedEditedAt: second.editedAt });
    expect(fresh.body).toBe("Version three");
    // Without a stamp the old behaviour stands, and a stamp that is not a date is refused.
    expect((await editMessage(w.staff, { messageId: m.id, body: "Version four" })).body).toBe("Version four");
    expect((await refused(editMessage(w.staff, { messageId: m.id, body: "x", expectedEditedAt: "yesterday-ish" })))?.code).toBe("invalid_input");
    expect((await refused(editMessage(w.staff, { messageId: m.id, body: "x", expectedEditedAt: 5 })))?.code).toBe("invalid_input");
  });

  it("refuses a rename from a stale form and accepts one from the current values", async () => {
    const channel = (await createChannel(w.manager, { name: channelName(), topic: "Old topic", visibility: "staff" })).id;
    const [row] = (await listConversations(w.manager)).filter((c) => c.id === channel);
    expect(row.topic).toBe("Old topic");
    await updateConversation(w.manager, channel, { topic: "New topic", expectedTopic: "Old topic" });
    const stale = await refused(updateConversation(w.manager, channel, { topic: "Third topic", expectedTopic: "Old topic" }));
    expect(stale).toEqual({ code: "conflict", message: RENAME_CONFLICT_MESSAGE });
    await updateConversation(w.manager, channel, { topic: "Third topic", expectedTopic: "New topic" });
    expect((await listConversations(w.manager)).find((c) => c.id === channel)?.topic).toBe("Third topic");
    // Changing only the name does not care what the topic was.
    const named = channelName("renamed");
    await updateConversation(w.manager, channel, { name: named, expectedName: (await listConversations(w.manager)).find((c) => c.id === channel)?.name });
    expect((await listConversations(w.manager)).find((c) => c.id === channel)?.name).toBe(named);
    await addMembers(w.manager, channel, [w.staff.id]);
  });
});
