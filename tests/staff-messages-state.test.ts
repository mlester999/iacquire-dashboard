import { describe, expect, it } from "vitest";
import type { ConversationView } from "@/server/staff-messages/conversations";
import type { MessageView } from "@/server/staff-messages/messages";
import type { SnapshotPayload } from "@/lib/staff-messages/snapshot";
import { isUnchanged } from "@/lib/staff-messages/snapshot";
import {
  applyOlder, applySnapshot, bumpRail, initialState, upsertMessage, withDeletedMessage, withEditedMessage, withReactions, withReadMark, withRead, withSentMessage, type PageState,
} from "@/lib/staff-messages/state";
import { addPending, canRetry, failureText, markFailed, markSending, pendingFor, removePending } from "@/lib/staff-messages/pending";
import { enterSends, type PendingMessage } from "@/lib/staff-messages/composer";
import { isNearBottom, NEAR_BOTTOM_PX, readTarget, scrollPlan } from "@/lib/staff-messages/scroll";
import { MESSAGES_NAV_POLICY, navBadge, navLabel, showMessagesNav } from "@/lib/staff-messages/nav";
import {
  eventText, filterPeople, headerSubtitle, messageAllowances, parseDeepLink, ROLE_LABEL, searchHitHref, searchHitTitle, type PersonOption, type RailEntry,
} from "@/lib/staff-messages/view";
import { accessLostFor, frameReason } from "@/lib/staff-messages/live";
import { parseRetentionInput, RETENTION_DAYS_MAX, RETENTION_DAYS_MIN } from "@/lib/staff-messages/limits";

// The rules that decide what an open Messages page shows and does, without a browser: how an answer from the server joins what the page holds, how a message being sent is
// tracked, where the scroll goes, when the person has read what is on screen, what the navigation shows and what the buttons on a message offer. Pure.

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONV = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ROOT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const msg = (seq: number, over: Partial<MessageView> = {}): MessageView => ({
  id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`, conversationId: CONV, seq, threadRootId: null, authorId: OTHER, author: { name: "Maya", former: false }, body: `message ${seq}`, mentions: [],
  createdAt: new Date(Date.UTC(2026, 9, 24, 9, seq)).toISOString(), editedAt: null, deleted: false, replyCount: 0, reactions: [], attachments: [], mine: false, ...over,
});

const rail = (over: Partial<RailEntry> = {}): RailEntry => ({
  id: CONV, kind: "channel", visibility: "staff", name: "general", topic: null, archived: false, lastSeq: 5, lastReadSeq: 2, unread: 3, muted: false, notify: "mentions", lastMessageAt: null, memberCount: 3, peer: null, ...over,
});

const view = (over: Partial<ConversationView["conversation"]> = {}): ConversationView => ({
  conversation: { id: CONV, kind: "channel", visibility: "staff", archived: false, name: "general", topic: null, directKey: null, createdBy: null, lastSeq: 5, lastReadSeq: 2, muted: false, notify: "mentions", lastMessageAt: null, memberRole: "member", ...over } as ConversationView["conversation"],
  members: [], memberCount: 3, peer: null,
  can: { post: true, join: false, leave: true, manageMembers: false, rename: false, archive: false },
  events: [],
});

const payload = (over: Partial<SnapshotPayload> = {}): SnapshotPayload => ({
  revision: 10, unread: 3, rail: [rail()], conversation: view(), page: { messages: [msg(1), msg(2), msg(3)], hasMore: true, lastSeq: 3, lastReadSeq: 1 }, ...over,
});

describe("what the page holds", () => {
  it("starts from the first answer, with a conversation that is not there kept apart from none open", () => {
    const s = initialState(payload());
    expect(s).toMatchObject({ revision: 10, hasMore: true, lastSeq: 3, lastReadSeq: 1, thread: undefined });
    expect(s.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(initialState({ revision: 1 }).conversation).toBeUndefined();
    expect(initialState({ revision: 1, conversation: null }).conversation).toBeNull();
    expect(initialState(payload({ thread: null })).thread).toBeNull();
  });

  it("drops an answer that was overtaken by a newer one", () => {
    const now = initialState(payload({ revision: 10 }));
    const late = applySnapshot(now, payload({ revision: 9, page: { messages: [msg(1, { body: "OLD" })], hasMore: false, lastSeq: 1, lastReadSeq: 0 } }));
    expect(late).toBe(now);
  });

  it("lets the newest page replace the tail it covers and keeps older messages already loaded", () => {
    const base = applyOlder(initialState(payload({ page: { messages: [msg(5), msg(6)], hasMore: true, lastSeq: 6, lastReadSeq: 6 } })), { messages: [msg(3), msg(4)], hasMore: false, lastSeq: 6, lastReadSeq: 6 });
    expect(base.messages.map((m) => m.seq)).toEqual([3, 4, 5, 6]);
    expect(base.hasMore).toBe(false);
    const next = applySnapshot(base, payload({ revision: 11, page: { messages: [msg(5, { body: "edited" }), msg(6), msg(7)], hasMore: true, lastSeq: 7, lastReadSeq: 6 } }));
    expect(next.messages.map((m) => m.seq)).toEqual([3, 4, 5, 6, 7]);
    expect(next.messages.find((m) => m.seq === 5)?.body).toBe("edited");
    // The older messages were loaded earlier, and that answer (nothing above them) still stands.
    expect(next.hasMore).toBe(false);
    expect(next.lastSeq).toBe(7);
  });

  it("takes the page's own word that more lie above when the oldest message on screen came from it", () => {
    const base = initialState(payload({ page: { messages: [msg(5), msg(6)], hasMore: false, lastSeq: 6, lastReadSeq: 6 } }));
    const next = applySnapshot(base, payload({ revision: 11, page: { messages: [msg(2), msg(3), msg(4), msg(5), msg(6)], hasMore: true, lastSeq: 6, lastReadSeq: 6 } }));
    expect(next.messages.map((m) => m.seq)).toEqual([2, 3, 4, 5, 6]);
    expect(next.hasMore).toBe(true);
  });

  it("replaces the whole list when the window moves back to the newest messages", () => {
    const base = initialState(payload({ page: { messages: [msg(40), msg(41)], hasMore: true, lastSeq: 41, lastReadSeq: 41 } }));
    const next = applySnapshot(base, payload({ revision: 12, page: { messages: [msg(90), msg(91)], hasMore: true, lastSeq: 91, lastReadSeq: 91 } }), "replace");
    expect(next.messages.map((m) => m.seq)).toEqual([90, 91]);
  });

  it("clears the messages and the thread when the conversation is no longer there for the person", () => {
    const base = initialState(payload({ thread: { messages: [msg(1)], hasMore: false, lastSeq: 3, lastReadSeq: 3 } }));
    const next = applySnapshot(base, { revision: 11, rail: [], conversation: null });
    expect(next).toMatchObject({ conversation: null, messages: [], hasMore: false, thread: undefined, rail: [] });
  });

  it("keeps the rail and the conversation when an answer carries neither", () => {
    const base = initialState(payload());
    const next = applySnapshot(base, { revision: 11, unread: 0 });
    expect(next.rail).toBe(base.rail);
    expect(next.conversation).toBe(base.conversation);
    expect(next.revision).toBe(11);
  });

  it("recognises the answer that says nothing changed", () => {
    expect(isUnchanged({ unchanged: true, revision: 4 })).toBe(true);
    expect(isUnchanged(payload())).toBe(false);
  });
});

describe("upserting and showing what the person just did", () => {
  it("inserts a message by its number and replaces one with the same id", () => {
    const list = [msg(1), msg(3)];
    expect(upsertMessage(list, msg(2)).map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(upsertMessage(list, msg(4)).map((m) => m.seq)).toEqual([1, 3, 4]);
    const swapped = upsertMessage(list, msg(3, { body: "changed" }));
    expect(swapped).toHaveLength(2);
    expect(swapped[1].body).toBe("changed");
    expect(list[1].body).toBe("message 3");
  });

  it("shows a message the person sent, counts it as read, moves the conversation to the top, and does not double it when the next answer repeats it", () => {
    const base = initialState(payload({ rail: [rail({ id: "other-1" }), rail()] }));
    const sent = msg(6, { authorId: ME, mine: true });
    const next = withSentMessage(base, sent);
    expect(next.messages.at(-1)?.seq).toBe(6);
    expect(next.lastSeq).toBe(6);
    expect(next.lastReadSeq).toBe(6);
    expect(next.rail[0]).toMatchObject({ id: CONV, lastSeq: 6, lastReadSeq: 6, unread: 0 });
    const again = applySnapshot(next, payload({ revision: 11, page: { messages: [msg(1), msg(2), msg(3), msg(6, { authorId: ME, mine: true })], hasMore: true, lastSeq: 6, lastReadSeq: 6 } }));
    expect(again.messages.filter((m) => m.seq === 6)).toHaveLength(1);
  });

  it("puts a reply in the open thread and counts it on the message that started it, once", () => {
    const root = msg(2, { id: ROOT, replyCount: 1 });
    const base: PageState = { ...initialState(payload({ page: { messages: [msg(1), root], hasMore: false, lastSeq: 3, lastReadSeq: 3 } })), thread: [root, msg(3, { threadRootId: ROOT })] };
    const reply = msg(4, { threadRootId: ROOT, authorId: ME, mine: true });
    const next = withSentMessage(base, reply);
    expect(next.thread?.map((m) => m.seq)).toEqual([2, 3, 4]);
    expect(next.messages.find((m) => m.id === ROOT)?.replyCount).toBe(2);
    // The reply never joins the main view.
    expect(next.messages.some((m) => m.seq === 4)).toBe(false);
    // The same reply arriving again (a retry's answer) is not counted twice.
    expect(withSentMessage(next, reply).messages.find((m) => m.id === ROOT)?.replyCount).toBe(2);
  });

  it("changes a message in the main view and in the thread, deletes the way the server stores it, and swaps reactions", () => {
    const m = msg(2, { id: ROOT, body: "before", reactions: [{ reaction: "heart", count: 1, mine: false }], replyCount: 3, attachments: [{ id: "f", filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 5 }] });
    const base: PageState = { ...initialState(payload({ page: { messages: [m], hasMore: false, lastSeq: 2, lastReadSeq: 2 } })), thread: [m] };
    const edited = withEditedMessage(base, { ...m, body: "after", editedAt: "2026-10-24T10:00:00.000Z", replyCount: 0 });
    expect(edited.messages[0]).toMatchObject({ body: "after", editedAt: "2026-10-24T10:00:00.000Z", replyCount: 3 });
    expect(edited.thread?.[0].body).toBe("after");
    const gone = withDeletedMessage(base, ROOT);
    expect(gone.messages[0]).toMatchObject({ deleted: true, body: "", reactions: [], attachments: [], mentions: [] });
    expect(gone.thread?.[0].deleted).toBe(true);
    const liked = withReactions(base, ROOT, [{ reaction: "tada", count: 2, mine: true }]);
    expect(liked.messages[0].reactions).toEqual([{ reaction: "tada", count: 2, mine: true }]);
  });

  it("moves a conversation's read mark forward only, never past the newest, and updates the rail with it", () => {
    const base = initialState(payload());
    const next = withReadMark(base, CONV, 99);
    expect(next.lastReadSeq).toBe(3);
    expect(next.rail[0]).toMatchObject({ lastReadSeq: 5, unread: 0 });
    expect(withReadMark(next, CONV, 1).lastReadSeq).toBe(3);
    expect(withRead([rail({ lastReadSeq: 4, unread: 1 })], CONV, 2)[0]).toMatchObject({ lastReadSeq: 4, unread: 1 });
    expect(bumpRail([rail()], "missing", { seq: 9, createdAt: "x" })).toEqual([rail()]);
  });
});

describe("messages being sent", () => {
  const pend = (clientId: string, over: Partial<PendingMessage> = {}): PendingMessage => ({
    clientId, conversationId: CONV, body: "hi", threadRootId: null, attachments: [], status: "sending", error: null, errorCode: null, createdAt: "2026-10-24T10:00:00.000Z", ...over,
  });

  it("keeps each message once, with its id, through sending, failing, retrying and arriving", () => {
    let list = addPending([], pend("c1"));
    list = addPending(list, pend("c1", { body: "changed" }));
    expect(list).toHaveLength(1);
    expect(list[0].body).toBe("hi");
    list = markFailed(list, "c1", null);
    expect(list[0]).toMatchObject({ status: "failed", error: null, errorCode: null });
    list = markSending(list, "c1");
    expect(list[0]).toMatchObject({ status: "sending", error: null });
    list = markFailed(list, "c1", "You can't write in this conversation.", "forbidden");
    expect(list[0]).toMatchObject({ status: "failed", errorCode: "forbidden" });
    expect(removePending(list, "c1")).toEqual([]);
  });

  it("separates the main view's messages from each thread's", () => {
    const list = [pend("a"), pend("b", { threadRootId: ROOT }), pend("c", { conversationId: "elsewhere" })];
    expect(pendingFor(list, CONV, null).map((p) => p.clientId)).toEqual(["a"]);
    expect(pendingFor(list, CONV, ROOT).map((p) => p.clientId)).toEqual(["b"]);
  });

  it("offers a retry only where waiting could help, in plain words", () => {
    for (const code of [null, undefined, "network", "rate_limited", "internal", "unavailable"]) expect(canRetry(code), String(code)).toBe(true);
    for (const code of ["forbidden", "not_found", "not_enabled", "unauthenticated", "invalid_input", "conflict"]) expect(canRetry(code), code).toBe(false);
    expect(failureText(null, null)).toMatch(/connection/i);
    expect(failureText("Write something before you send.", "invalid_input")).toBe("Write something before you send.");
    expect(failureText("The server is busy.", "unavailable")).toBe("Not sent. The server is busy.");
    expect(failureText(null, "rate_limited")).toMatch(/wait/i);
  });
});

describe("the Enter key", () => {
  const key = (over: Partial<Parameters<typeof enterSends>[0]> = {}) => ({ key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, ...over });
  it("sends with a mouse and keyboard, starts a line on a touch screen, and leaves a composing input method alone", () => {
    expect(enterSends(key(), true)).toBe(true);
    expect(enterSends(key({ shiftKey: true }), true)).toBe(false);
    expect(enterSends(key(), false)).toBe(false);
    expect(enterSends(key({ ctrlKey: true }), false)).toBe(true);
    expect(enterSends(key({ metaKey: true }), false)).toBe(true);
    expect(enterSends(key({ isComposing: true }), true)).toBe(false);
    expect(enterSends(key({ key: "a" }), true)).toBe(false);
  });
});

describe("scrolling and reading", () => {
  const change = (over: Partial<Parameters<typeof scrollPlan>[0]> = {}) => ({ initial: false, wasAtBottom: false, appendedNewest: false, prependedOlder: false, ownMessage: false, ...over });

  it("goes to the bottom at first, follows a person who is at the bottom, always follows their own message, and never pulls a reader away", () => {
    expect(scrollPlan(change({ initial: true }))).toBe("bottom");
    expect(scrollPlan(change({ appendedNewest: true, wasAtBottom: true }))).toBe("bottom");
    expect(scrollPlan(change({ appendedNewest: true, wasAtBottom: false }))).toBe("stay");
    expect(scrollPlan(change({ appendedNewest: true, wasAtBottom: false, ownMessage: true }))).toBe("bottom");
    expect(scrollPlan(change())).toBe("stay");
  });

  it("keeps the place when older messages are added above, even for a person at the bottom", () => {
    expect(scrollPlan(change({ prependedOlder: true }))).toBe("keep-position");
    expect(scrollPlan(change({ prependedOlder: true, wasAtBottom: true }))).toBe("keep-position");
    // Both at once (a refresh that brought new messages while older ones loaded): the end wins for a person who was reading it.
    expect(scrollPlan(change({ prependedOlder: true, appendedNewest: true, wasAtBottom: true }))).toBe("bottom");
  });

  it("counts a person as at the bottom within a little slack", () => {
    expect(isNearBottom(1000, 600, 400)).toBe(true);
    expect(isNearBottom(1000, 600 - NEAR_BOTTOM_PX, 400)).toBe(true);
    expect(isNearBottom(1000, 600 - NEAR_BOTTOM_PX - 1, 400)).toBe(false);
  });

  it("marks a conversation read only when the person is looking at the newest messages in a visible tab, and says it once", () => {
    const facts = { visible: true, atBottom: true, showingNewest: true, lastSeq: 9, lastReadSeq: 4, sentSeq: 0 };
    expect(readTarget(facts)).toBe(9);
    expect(readTarget({ ...facts, visible: false })).toBeNull();
    expect(readTarget({ ...facts, atBottom: false })).toBeNull();
    expect(readTarget({ ...facts, showingNewest: false })).toBeNull();
    expect(readTarget({ ...facts, sentSeq: 9 })).toBeNull();
    expect(readTarget({ ...facts, lastReadSeq: 9 })).toBeNull();
    expect(readTarget({ ...facts, sentSeq: 7 })).toBe(9);
  });
});

describe("the entry in the navigation", () => {
  it("is shown to someone who may use Messages while it is on, and to a Super Admin always", () => {
    expect(MESSAGES_NAV_POLICY).toEqual({ permission: "agency.messages.use" });
    for (const role of ["agency_staff", "agency_manager", "agency_super_admin"]) expect(showMessagesNav("on", role), role).toBe(true);
    for (const role of ["agency_staff", "agency_manager"]) {
      expect(showMessagesNav("off", role), role).toBe(false);
      expect(showMessagesNav("denied", role), role).toBe(false);
      expect(showMessagesNav(undefined, role), role).toBe(false);
    }
    expect(showMessagesNav("off", "agency_super_admin")).toBe(true);
    expect(showMessagesNav("denied", "agency_super_admin")).toBe(true);
  });

  it("shows a badge only for a person with access and something unread, never more than 99+", () => {
    expect(navBadge("on", 0)).toBeNull();
    expect(navBadge("on", 3)).toBe("3");
    expect(navBadge("on", 99)).toBe("99");
    expect(navBadge("on", 100)).toBe("99+");
    expect(navBadge("off", 5)).toBeNull();
    expect(navBadge("denied", 5)).toBeNull();
    expect(navBadge(undefined, 5)).toBeNull();
  });

  it("reads the unread count aloud", () => {
    expect(navLabel(0)).toBe("Messages");
    expect(navLabel(1)).toBe("Messages, 1 unread");
    expect(navLabel(7)).toBe("Messages, 7 unread");
    expect(navLabel(250)).toBe("Messages, more than 99 unread");
  });
});

describe("the buttons on a message", () => {
  const c = (over: Partial<Parameters<typeof messageAllowances>[0]> = {}) => ({ kind: "group" as const, visibility: "private" as const, archived: false, memberRole: "member" as const, ...over });
  const caps = { channels: false, moderate: false };

  it("offers a member their own message to edit and delete, and a colleague's message to react to and reply to only", () => {
    expect(messageAllowances(c(), caps, ME, { authorId: ME, deleted: false })).toEqual({ canReact: true, canReply: true, canEdit: true, canDelete: true });
    expect(messageAllowances(c(), caps, ME, { authorId: OTHER, deleted: false })).toEqual({ canReact: true, canReply: true, canEdit: false, canDelete: false });
  });

  it("offers nothing on a deleted message, and nothing to write in an archived conversation", () => {
    expect(messageAllowances(c(), caps, ME, { authorId: ME, deleted: true })).toEqual({ canReact: false, canReply: false, canEdit: false, canDelete: false });
    expect(messageAllowances(c({ archived: true }), caps, ME, { authorId: ME, deleted: false })).toEqual({ canReact: false, canReply: false, canEdit: false, canDelete: false });
  });

  it("offers a moderator the delete of a colleague's message in a channel they belong to, and in no other kind of conversation", () => {
    const channel = c({ kind: "channel", visibility: "staff" });
    expect(messageAllowances(channel, { channels: false, moderate: true }, ME, { authorId: OTHER, deleted: false }).canDelete).toBe(true);
    expect(messageAllowances(channel, { channels: true, moderate: false }, ME, { authorId: OTHER, deleted: false }).canDelete).toBe(false);
    expect(messageAllowances(c(), { channels: false, moderate: true }, ME, { authorId: OTHER, deleted: false }).canDelete).toBe(false);
  });

  it("offers nothing to someone who is not in the conversation", () => {
    expect(messageAllowances(c({ kind: "channel", visibility: "staff", memberRole: null }), { channels: true, moderate: true }, ME, { authorId: OTHER, deleted: false })).toEqual({ canReact: false, canReply: false, canEdit: false, canDelete: false });
  });
});

describe("people, events and search hits", () => {
  const people: PersonOption[] = [
    { id: ME, name: "Avery Admin", role: "agency_super_admin", self: true },
    { id: OTHER, name: "Maya Santos", role: "agency_manager", self: false },
    { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", name: "Ana Maya", role: "agency_staff", self: false },
    { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", name: "Zed", role: "agency_staff", self: false },
  ];

  it("lists everyone but the person asking in name order, matches by name with the best match first, and leaves out people already in", () => {
    expect(filterPeople(people, "").map((p) => p.name)).toEqual(["Ana Maya", "Maya Santos", "Zed"]);
    expect(filterPeople(people, "maya").map((p) => p.name)).toEqual(["Maya Santos", "Ana Maya"]);
    expect(filterPeople(people, "  ZED ").map((p) => p.name)).toEqual(["Zed"]);
    expect(filterPeople(people, "avery")).toEqual([]);
    expect(filterPeople(people, "avery", { includeSelf: true }).map((p) => p.name)).toEqual(["Avery Admin"]);
    expect(filterPeople(people, "", { exclude: new Set([OTHER]) }).map((p) => p.name)).toEqual(["Ana Maya", "Zed"]);
    expect(filterPeople(people, "x".repeat(20_000))).toEqual([]);
    expect(Object.keys(ROLE_LABEL)).toEqual(["agency_staff", "agency_manager", "agency_super_admin"]);
  });

  it("writes a line about each change to a conversation", () => {
    expect(eventText("created", "Maya", null)).toBe("Maya started this conversation");
    expect(eventText("member_added", "Maya", "Sam")).toBe("Maya added Sam");
    expect(eventText("member_added", "Sam", "Sam")).toBe("Sam joined");
    expect(eventText("member_added", "Sam", null)).toBe("Sam joined");
    expect(eventText("member_removed", "Maya", "Sam")).toBe("Maya removed Sam");
    expect(eventText("member_removed", "Maya", null)).toBe("Maya removed someone");
    expect(eventText("member_left", "Sam", null)).toBe("Sam left");
    expect(eventText("renamed", "Maya", null)).toBe("Maya renamed it");
    expect(eventText("topic_changed", "Maya", null)).toBe("Maya changed the topic");
    expect(eventText("archived", "Maya", null)).toBe("Maya archived it");
    expect(eventText("unarchived", "Maya", null)).toBe("Maya brought it back");
  });

  it("writes the line under a conversation's name from facts, not guesses", () => {
    expect(headerSubtitle({ kind: "direct", topic: null, memberCount: 2, archived: false })).toBe("");
    expect(headerSubtitle({ kind: "group", topic: null, memberCount: 1, archived: false })).toBe("1 person");
    expect(headerSubtitle({ kind: "channel", topic: "Launch planning", memberCount: 12, archived: false })).toBe("12 people · Launch planning");
    expect(headerSubtitle({ kind: "channel", topic: null, memberCount: 3, archived: true })).toBe("Archived · 3 people");
  });

  it("opens a search hit at its message, and a reply at its thread, from ids and numbers only", () => {
    expect(searchHitHref({ conversationId: CONV, seq: 41, threadRootId: null })).toBe(`/admin/messages/${CONV}?at=41`);
    expect(searchHitHref({ conversationId: CONV, seq: 41, threadRootId: ROOT })).toBe(`/admin/messages/${CONV}?at=41&thread=${ROOT}`);
    expect(searchHitTitle({ conversationKind: "channel", conversationName: "general" })).toBe("#general");
    expect(searchHitTitle({ conversationKind: "direct", conversationName: "Maya" })).toBe("Maya");
  });

  it("reads the deep link strictly and ignores anything else", () => {
    expect(parseDeepLink({ at: "41", thread: ROOT })).toEqual({ aroundSeq: 41, threadId: ROOT });
    expect(parseDeepLink({ at: ["7", "8"], thread: undefined })).toEqual({ aroundSeq: 7, threadId: null });
    expect(parseDeepLink({ at: "0" })).toEqual({ aroundSeq: null, threadId: null });
    for (const at of ["-1", "1.5", "abc", "1e3", "9".repeat(30), ""]) expect(parseDeepLink({ at }).aroundSeq, at).toBeNull();
    for (const thread of ["nope", "../../x", `${ROOT}x`, "<script>"]) expect(parseDeepLink({ thread }).threadId, thread).toBeNull();
    expect(parseDeepLink({ thread: ROOT.toUpperCase() }).threadId).toBe(ROOT);
  });
});

describe("refusals and the settings field", () => {
  it("tells a signed-out session from a module switched off from a person who may no longer use it", () => {
    expect(accessLostFor(401, null)).toBe("signed_out");
    expect(accessLostFor(403, "not_enabled")).toBe("not_enabled");
    expect(accessLostFor(403, "forbidden")).toBe("forbidden");
    expect(accessLostFor(403, undefined)).toBe("forbidden");
    for (const status of [200, 400, 404, 429, 500, 503]) expect(accessLostFor(status, "forbidden"), String(status)).toBeNull();
  });

  it("reads the reason out of a stream frame, defaulting to the stricter one", () => {
    expect(frameReason('{"reason":"not_enabled"}')).toBe("not_enabled");
    expect(frameReason('{"reason":"forbidden"}')).toBe("forbidden");
    for (const bad of ["", "nope", "null", "[]", '{"reason":5}', '{"reason":"other"}']) expect(frameReason(bad), bad).toBe("forbidden");
  });

  it("reads the retention days: empty is none, a whole number in range is a number, anything else is refused", () => {
    expect(parseRetentionInput("")).toBeNull();
    expect(parseRetentionInput("   ")).toBeNull();
    expect(parseRetentionInput(String(RETENTION_DAYS_MIN))).toBe(RETENTION_DAYS_MIN);
    expect(parseRetentionInput(` ${RETENTION_DAYS_MAX} `)).toBe(RETENTION_DAYS_MAX);
    for (const bad of [String(RETENTION_DAYS_MIN - 1), String(RETENTION_DAYS_MAX + 1), "0", "-30", "90.5", "abc", "1e3", "999999", "30 days"]) expect(parseRetentionInput(bad), bad).toBe("invalid");
  });
});
