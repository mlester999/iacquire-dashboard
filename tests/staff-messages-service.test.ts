import { beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { addMembers, createChannel, createDirect, createGroup, joinChannel, listConversations, setArchived, setPreferences } from "@/server/staff-messages/conversations";
import { deleteMessage, editMessage, listMessages, sendMessage, setReaction } from "@/server/staff-messages/messages";
import { markRead } from "@/server/staff-messages/read";
import { searchMessages } from "@/server/staff-messages/search";
import { inboxRevision, inboxStatus } from "@/server/staff-messages/inbox";
import { listNotifications, unreadCount } from "@/server/notifications";
import { mentionToken } from "@/lib/staff-messages/mentions";
import { MAX_BODY_CHARS } from "@/lib/staff-messages/limits";
import { resetRateLimits } from "./support/support-world";
import { RATE_LIMITS } from "@/server/security/rate-limit";
import { channelName, clearOverride, count, disable, freshId, override, rows, seedRateHits, setMessages, staffPerson, staffWorld, type Person, type World } from "./support/staff-messages";

// Messages of staff Messages (migration 0096): sending with a retry key, numbers, threads, mentions, edits, deletes, reactions, the read cursor, search, notices and the
// per-person revision. Embedded Postgres; no provider, no network.

let w: World;
beforeEach(async () => {
  await resetRateLimits();
  w = await staffWorld();
});

const refused = async (p: Promise<unknown>) => p.then(() => null, (e: Error & { code?: string }) => ({ code: e.code, message: e.message }));
const send = (who: Person, conversationId: string, body: string, over: Record<string, unknown> = {}) => sendMessage(who, { conversationId, clientMessageId: freshId(), body, ...over });
const group = async (owner: Person, ...others: Person[]) => (await createGroup(owner, { name: `g-${freshId().slice(0, 6)}`, memberIds: others.map((o) => o.id) })).id;
const noticesFor = (userId: string, kind?: string) => rows<{ kind: string; title: string; body: string; dedupe_key: string | null }>(
  "select kind, title, body, dedupe_key from notifications where user_id = $1 and audience = 'staff' and ($2::text is null or kind = $2) order by created_at, id", [userId, kind ?? null]);

describe("sending", () => {
  it("numbers messages in order, one after another, and shows the sender as the author", async () => {
    const id = await group(w.staff, w.staff2);
    const a = await send(w.staff, id, "  First  ");
    const b = await send(w.staff2, id, "Second");
    const c = await send(w.staff, id, "Third");
    expect([a, b, c].map((r) => r.message.seq)).toEqual([1, 2, 3]);
    expect([a, b, c].every((r) => !r.duplicate)).toBe(true);
    expect(a.message).toMatchObject({ body: "First", authorId: w.staff.id, author: { name: w.staff.name, former: false }, mine: true, deleted: false, replyCount: 0, threadRootId: null });
    expect(b.message.mine).toBe(true);
    const [conv] = await rows<{ last_seq: string; last_message_at: Date | null }>("select last_seq::text, last_message_at from staff_conversations where id = $1", [id]);
    expect(conv.last_seq).toBe("3");
    expect(conv.last_message_at).not.toBeNull();
  });

  it("posts a retried send once: the same id from the same person returns the message that exists", async () => {
    const id = await group(w.staff, w.staff2);
    const clientMessageId = freshId();
    const first = await sendMessage(w.staff, { conversationId: id, clientMessageId, body: "Once only" });
    const again = await sendMessage(w.staff, { conversationId: id, clientMessageId, body: "Once only" });
    const lost = await sendMessage(w.staff, { conversationId: id, clientMessageId: clientMessageId.toUpperCase(), body: "Typed differently the second time" });
    expect(first.duplicate).toBe(false);
    expect(again).toMatchObject({ duplicate: true, message: { id: first.message.id, seq: 1 } });
    expect(lost).toMatchObject({ duplicate: true, message: { id: first.message.id, body: "Once only" } });
    expect(await count("select 1 from staff_messages where conversation_id = $1", [id])).toBe(1);
    // The same id from another person, or in another conversation, is a different message.
    const other = await sendMessage(w.staff2, { conversationId: id, clientMessageId, body: "Mine" });
    expect(other.duplicate).toBe(false);
    const elsewhere = await group(w.staff, w.staff2);
    expect((await sendMessage(w.staff, { conversationId: elsewhere, clientMessageId, body: "Elsewhere" })).duplicate).toBe(false);
  });

  it("gives ten sends at once ten consecutive numbers, and two copies of one send only one message", async () => {
    const id = await group(w.staff, w.staff2, w.staff3);
    const people = [w.staff, w.staff2, w.staff3];
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => send(people[i % 3], id, `Parallel ${i}`)));
    expect(results.map((r) => r.message.seq).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const key = freshId();
    const twins = await Promise.all([sendMessage(w.staff, { conversationId: id, clientMessageId: key, body: "Twin" }), sendMessage(w.staff, { conversationId: id, clientMessageId: key, body: "Twin" })]);
    expect(twins.filter((t) => !t.duplicate)).toHaveLength(1);
    expect(twins[0].message.id).toBe(twins[1].message.id);
    expect(await count("select 1 from staff_messages where conversation_id = $1", [id])).toBe(11);
    const seqs = await rows<{ s: string }>("select m.seq::text as s from staff_messages m where m.conversation_id = $1 order by m.seq", [id]);
    expect(seqs.map((x) => Number(x.s))).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
  });

  it("refuses an empty message, one over the limit, an id that is missing and text that is not text, and posts nothing", async () => {
    const id = await group(w.staff, w.staff2);
    expect((await refused(send(w.staff, id, "   \n ")))?.code).toBe("invalid_input");
    expect((await refused(send(w.staff, id, "x".repeat(MAX_BODY_CHARS + 1))))?.code).toBe("invalid_input");
    expect((await refused(sendMessage(w.staff, { conversationId: id, clientMessageId: "nope", body: "Hello" })))?.code).toBe("invalid_input");
    expect((await refused(sendMessage(w.staff, { conversationId: id, clientMessageId: freshId(), body: { not: "text" } })))?.code).toBe("invalid_input");
    expect(await send(w.staff, id, "x".repeat(MAX_BODY_CHARS))).toMatchObject({ duplicate: false });
    expect(await count("select 1 from staff_messages where conversation_id = $1", [id])).toBe(1);
  });

  it("is refused to a person who is not in the conversation, even the Super Admin, and reads as not found", async () => {
    const dm = (await createDirect(w.staff, w.staff2.id)).id;
    for (const outsider of [w.staff3, w.manager, w.superAdmin]) {
      expect((await refused(send(outsider, dm, "Let me in")))?.code).toBe("not_found");
    }
    expect((await refused(send(w.staff, freshId(), "Nowhere")))?.code).toBe("not_found");
    expect((await refused(send(w.staff, "not an id", "Nowhere")))?.code).toBe("not_found");
    expect(await count("select 1 from staff_messages where conversation_id = $1", [dm])).toBe(0);
  });

  it("is refused in an archived conversation until it is brought back", async () => {
    const id = await group(w.staff, w.staff2);
    await send(w.staff, id, "Before");
    await setArchived(w.staff, id, true);
    expect((await refused(send(w.staff2, id, "After")))?.code).toBe("conflict");
    await setArchived(w.staff, id, false);
    expect((await send(w.staff2, id, "Back")).message.seq).toBe(2);
  });

  it("is refused to a person denied Messages, a person who has left, and a disabled account, at once", async () => {
    const id = await group(w.staff, w.staff2, w.staff3);
    await send(w.staff2, id, "Hello");
    await override(w.staff2.id, "agency.messages.use", "deny");
    expect((await refused(send(w.staff2, id, "Still here?")))?.code).toBe("forbidden");
    await disable(w.staff3.id);
    expect((await refused(send(w.staff3, id, "Disabled")))?.code).toBe("forbidden");
    await withSystem((db) => db.query("update staff_conversation_members set left_at = now() where conversation_id = $1 and user_id = $2", [id, w.staff.id]));
    expect((await refused(send(w.staff, id, "Left")))?.code).toBe("not_found");
    expect(await count("select 1 from staff_messages where conversation_id = $1", [id])).toBe(1);
  });

  it("limits how fast one person can send, and says when to try again", async () => {
    const id = await group(w.staff, w.staff2);
    await seedRateHits(RATE_LIMITS.staffMessageSendByUser, w.staff.id, RATE_LIMITS.staffMessageSendByUser.limit - 2);
    await send(w.staff, id, "Ninety minus one");
    await send(w.staff, id, "Ninety");
    const stopped = await refused(send(w.staff, id, "Ninety one"));
    expect(stopped).toMatchObject({ code: "rate_limited" });
    expect(await count("select 1 from staff_messages where conversation_id = $1", [id])).toBe(2);
    // Someone else is not held back by it.
    expect((await send(w.staff2, id, "Not me")).duplicate).toBe(false);
  });
});

describe("threads", () => {
  it("attach a reply to the message that started the thread, and a reply to a reply joins the same thread", async () => {
    const id = await group(w.staff, w.staff2);
    const root = (await send(w.staff, id, "Question?")).message;
    const reply = (await send(w.staff2, id, "Answer", { threadRootId: root.id })).message;
    const second = (await send(w.staff, id, "Thanks", { threadRootId: reply.id })).message;
    expect(reply.threadRootId).toBe(root.id);
    expect(second.threadRootId).toBe(root.id);
    const main = await listMessages(w.staff, id);
    expect(main.messages.map((m) => [m.body, m.replyCount])).toEqual([["Question?", 2]]);
    const thread = await listMessages(w.staff2, id, { threadRootId: root.id });
    expect(thread.messages.map((m) => m.body)).toEqual(["Question?", "Answer", "Thanks"]);
  });

  it("refuse a reply to a message that is not in this conversation or does not exist", async () => {
    const a = await group(w.staff, w.staff2);
    const b = await group(w.staff, w.staff2);
    const elsewhere = (await send(w.staff, b, "Over there")).message;
    expect((await refused(send(w.staff, a, "Reply", { threadRootId: elsewhere.id })))?.code).toBe("invalid_input");
    expect((await refused(send(w.staff, a, "Reply", { threadRootId: freshId() })))?.code).toBe("invalid_input");
    expect((await refused(send(w.staff, a, "Reply", { threadRootId: "nope" })))?.code).toBe("invalid_input");
  });

  it("stand when their first message is deleted, and the deleted one is counted out of the replies only when it is a reply", async () => {
    const id = await group(w.staff, w.staff2);
    const root = (await send(w.staff, id, "Start")).message;
    const r1 = (await send(w.staff2, id, "One", { threadRootId: root.id })).message;
    await send(w.staff2, id, "Two", { threadRootId: root.id });
    await deleteMessage(w.staff2, r1.id);
    expect((await listMessages(w.staff, id)).messages[0].replyCount).toBe(1);
    await deleteMessage(w.staff, root.id);
    const thread = await listMessages(w.staff, id, { threadRootId: root.id });
    expect(thread.messages.map((m) => [m.deleted, m.body])).toEqual([[true, ""], [true, ""], [false, "Two"]]);
  });
});

describe("mentions", () => {
  it("name people in the conversation, and tell them once each, in words that carry no message text", async () => {
    const id = await group(w.staff, w.staff2, w.staff3);
    const text = `Can ${mentionToken(w.staff2.id)} look at the quarterly numbers with ${mentionToken(w.staff3.id)}? ${mentionToken(w.staff2.id)} first please.`;
    const sent = await send(w.staff, id, text);
    expect(sent.message.mentions).toEqual([w.staff2.id, w.staff3.id]);
    expect(sent.message.body).toBe(text);
    for (const who of [w.staff2, w.staff3]) {
      const n = await noticesFor(who.id, "staff_message_mention");
      expect(n).toHaveLength(1);
      expect(n[0]).toMatchObject({ title: "You were mentioned", dedupe_key: `staffmention:${sent.message.id}` });
      expect(JSON.stringify(n)).not.toContain("quarterly");
    }
    expect(await noticesFor(w.staff.id)).toEqual([]);
  });

  it("are refused for someone who is not in the conversation, for too many people, and for a made-up id", async () => {
    const id = await group(w.staff, w.staff2);
    expect((await refused(send(w.staff, id, `Hi ${mentionToken(w.staff3.id)}`)))?.code).toBe("invalid_input");
    expect((await refused(send(w.staff, id, `Hi ${mentionToken(freshId())}`)))?.code).toBe("invalid_input");
    const many = Array.from({ length: 21 }, () => mentionToken(freshId())).join(" ");
    expect((await refused(send(w.staff, id, many)))?.code).toBe("invalid_input");
    expect(await count("select 1 from staff_messages where conversation_id = $1", [id])).toBe(0);
  });

  it("reach a person who muted the conversation, but not one who chose to hear nothing", async () => {
    const id = await group(w.staff, w.staff2, w.staff3);
    await setPreferences(w.staff2, id, { muted: true });
    await setPreferences(w.staff3, id, { notify: "none" });
    await send(w.staff, id, `Ping ${mentionToken(w.staff2.id)} and ${mentionToken(w.staff3.id)}`);
    expect(await noticesFor(w.staff2.id, "staff_message_mention")).toHaveLength(1);
    expect(await noticesFor(w.staff3.id, "staff_message_mention")).toEqual([]);
  });
});

describe("notices for new messages", () => {
  it("tell the other person once per unread burst, and again after they have read", async () => {
    const dm = (await createDirect(w.staff, w.staff2.id)).id;
    await send(w.staff, dm, "One");
    await send(w.staff, dm, "Two");
    await send(w.staff, dm, "Three");
    const first = await noticesFor(w.staff2.id, "staff_message_direct");
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ title: "New direct message", body: `From ${w.staff.name}.`, dedupe_key: `staffmsg:${dm}:0` });
    expect(await noticesFor(w.staff.id)).toEqual([]);
    expect(await unreadCount(w.staff2.id)).toBe(1);
    await markRead(w.staff2, dm, 3);
    expect(await unreadCount(w.staff2.id)).toBe(0);
    await send(w.staff, dm, "Four");
    await send(w.staff, dm, "Five");
    expect(await noticesFor(w.staff2.id, "staff_message_direct")).toHaveLength(2);
    expect((await noticesFor(w.staff2.id, "staff_message_direct"))[1].dedupe_key).toBe(`staffmsg:${dm}:3`);
  });

  it("never carry the text of a message, and a channel tells only those who asked for everything or were mentioned", async () => {
    const ch = (await createChannel(w.manager, { name: channelName(), visibility: "staff" })).id;
    await joinChannel(w.staff, ch);
    await joinChannel(w.staff2, ch);
    await setPreferences(w.staff2, ch, { notify: "all" });
    await send(w.manager, ch, "The launch password is swordfish");
    expect(await noticesFor(w.staff.id)).toEqual([]);
    const loud = await noticesFor(w.staff2.id);
    expect(loud).toHaveLength(1);
    expect(loud[0].title).toBe("New message in a channel");
    expect(JSON.stringify(await rows("select title, body from notifications"))).not.toContain("swordfish");
  });

  it("respect a mute and a choice of nothing", async () => {
    const id = await group(w.staff, w.staff2, w.staff3);
    await setPreferences(w.staff2, id, { muted: true });
    await setPreferences(w.staff3, id, { notify: "none" });
    await send(w.staff, id, "Quiet please");
    expect(await noticesFor(w.staff2.id, "staff_message_direct")).toEqual([]);
    expect(await noticesFor(w.staff3.id, "staff_message_direct")).toEqual([]);
    // Someone who did not mute or opt out of anything is told, so the check above is not passing for want of a notice.
    await send(w.staff2, id, "Now you");
    expect(await noticesFor(w.staff.id, "staff_message_direct")).toHaveLength(1);
  });

  it("reach the staff feed with a link into the conversation and are cleared when the conversation is read", async () => {
    const dm = (await createDirect(w.staff, w.staff2.id)).id;
    const sent = await send(w.staff, dm, "Look");
    const feed = await listNotifications(w.staff2.id, { limit: 10 });
    expect(feed.items.map((i) => [i.kind, i.link])).toEqual([["staff_message_direct", `/admin/messages/${dm}`]]);
    expect(feed.unread).toBe(1);
    await markRead(w.staff2, dm, sent.message.seq);
    expect((await listNotifications(w.staff2.id, { limit: 10 })).unread).toBe(0);
  });
});

describe("editing and deleting", () => {
  it("lets the author change their own message, marks it edited, and says new mentions once", async () => {
    const id = await group(w.staff, w.staff2, w.staff3);
    const sent = (await send(w.staff, id, `Hello ${mentionToken(w.staff2.id)}`)).message;
    const edited = await editMessage(w.staff, { messageId: sent.id, body: `Hello ${mentionToken(w.staff2.id)} and ${mentionToken(w.staff3.id)}` });
    expect(edited.editedAt).not.toBeNull();
    expect(edited.mentions).toEqual([w.staff2.id, w.staff3.id]);
    expect(await noticesFor(w.staff2.id, "staff_message_mention")).toHaveLength(1);
    expect(await noticesFor(w.staff3.id, "staff_message_mention")).toHaveLength(1);
    // The same text again is not an edit.
    const same = await editMessage(w.staff, { messageId: sent.id, body: `Hello ${mentionToken(w.staff2.id)} and ${mentionToken(w.staff3.id)}` });
    expect(same.editedAt).toBe(edited.editedAt);
    expect((await refused(editMessage(w.staff, { messageId: sent.id, body: "" })))?.code).toBe("invalid_input");
    expect((await refused(editMessage(w.staff, { messageId: sent.id, body: `Hi ${mentionToken(freshId())}` })))?.code).toBe("invalid_input");
  });

  it("refuses an edit of someone else's message, of a deleted one, in an archived conversation, and by a stranger", async () => {
    const id = await group(w.staff, w.staff2);
    const sent = (await send(w.staff, id, "Mine")).message;
    expect((await refused(editMessage(w.staff2, { messageId: sent.id, body: "Not yours" })))?.code).toBe("forbidden");
    expect((await refused(editMessage(w.superAdmin, { messageId: sent.id, body: "Not yours" })))?.code).toBe("not_found");
    expect((await refused(editMessage(w.staff, { messageId: freshId(), body: "Nothing" })))?.code).toBe("not_found");
    await setArchived(w.staff, id, true);
    expect((await refused(editMessage(w.staff, { messageId: sent.id, body: "Too late" })))?.code).toBe("conflict");
    await setArchived(w.staff, id, false);
    await deleteMessage(w.staff, sent.id);
    expect((await refused(editMessage(w.staff, { messageId: sent.id, body: "Back from the dead" })))?.code).toBe("conflict");
    const [row] = await rows<{ body: string }>("select body from staff_messages where id = $1", [sent.id]);
    expect(row.body).toBe("");
  });

  it("deletes the author's own message: the place stays, the text, mentions and reactions go", async () => {
    const id = await group(w.staff, w.staff2);
    const sent = (await send(w.staff, id, `Secret ${mentionToken(w.staff2.id)}`)).message;
    await setReaction(w.staff2, { messageId: sent.id, reaction: "heart", on: true });
    await deleteMessage(w.staff, sent.id);
    await deleteMessage(w.staff, sent.id);
    const page = await listMessages(w.staff2, id);
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({ id: sent.id, seq: 1, deleted: true, body: "", mentions: [], reactions: [], attachments: [] });
    const [row] = await rows<{ body: string; mentions: string[]; deleted_by: string }>("select body, mentions, deleted_by from staff_messages where id = $1", [sent.id]);
    expect(row).toEqual({ body: "", mentions: [], deleted_by: w.staff.id });
    expect(await count("select 1 from staff_message_reactions where message_id = $1", [sent.id])).toBe(0);
    expect((await refused(deleteMessage(w.staff2, sent.id)))).toBeNull();
  });

  it("lets a member delete only their own message, in a group or a direct message", async () => {
    const id = await group(w.staff, w.staff2);
    const sent = (await send(w.staff, id, "Hands off")).message;
    expect((await refused(deleteMessage(w.staff2, sent.id)))?.code).toBe("forbidden");
    expect((await refused(deleteMessage(w.superAdmin, sent.id)))?.code).toBe("not_found");
    const dm = (await createDirect(w.staff, w.staff3.id)).id;
    const note = (await send(w.staff, dm, "Private")).message;
    expect((await refused(deleteMessage(w.staff3, note.id)))?.code).toBe("forbidden");
    expect((await refused(deleteMessage(w.superAdmin, note.id)))?.code).toBe("not_found");
    expect(await count("select 1 from staff_messages where deleted_at is not null and id = any($1::uuid[])", [[sent.id, note.id]])).toBe(0);
  });

  it("lets a moderator delete another person's message in a channel they belong to, and records who did it (without the text)", async () => {
    const ch = (await createChannel(w.manager, { name: channelName(), visibility: "staff" })).id;
    await joinChannel(w.staff, ch);
    await joinChannel(w.superAdmin, ch);
    const rude = (await send(w.staff, ch, "Something the moderator removes, in plain words")).message;
    expect((await refused(deleteMessage(w.manager, rude.id)))?.code).toBe("forbidden");
    await deleteMessage(w.superAdmin, rude.id);
    const [row] = await rows<{ deleted_by: string; body: string }>("select deleted_by, body from staff_messages where id = $1", [rude.id]);
    expect(row).toEqual({ deleted_by: w.superAdmin.id, body: "" });
    const audit = await rows<{ action: string; actor_user_id: string; metadata: Record<string, unknown> }>("select action, actor_user_id, metadata from audit_logs where target_id = $1", [rude.id]);
    expect(audit).toEqual([{ action: "staff_messages.message_removed_by_moderator", actor_user_id: w.superAdmin.id, metadata: { conversation: ch } }]);
    // A moderator who is not in the channel, or not the one who may moderate, has no way in.
    const outsider = await staffPerson("agency_super_admin");
    const another = (await send(w.staff, ch, "Another one")).message;
    expect((await refused(deleteMessage(outsider, another.id)))?.code).toBe("not_found");
  });
});

describe("reactions", () => {
  it("are added and taken away by the person, once each, and counted for everyone", async () => {
    const id = await group(w.staff, w.staff2, w.staff3);
    const sent = (await send(w.staff, id, "React to me")).message;
    expect(await setReaction(w.staff2, { messageId: sent.id, reaction: "thumbs_up", on: true })).toEqual([{ reaction: "thumbs_up", count: 1, mine: true }]);
    expect(await setReaction(w.staff2, { messageId: sent.id, reaction: "thumbs_up", on: true })).toEqual([{ reaction: "thumbs_up", count: 1, mine: true }]);
    expect(await setReaction(w.staff3, { messageId: sent.id, reaction: "thumbs_up", on: true })).toEqual([{ reaction: "thumbs_up", count: 2, mine: true }]);
    await setReaction(w.staff3, { messageId: sent.id, reaction: "rocket", on: true });
    const seen = (await listMessages(w.staff, id)).messages[0];
    expect(seen.reactions).toEqual([{ reaction: "thumbs_up", count: 2, mine: false }, { reaction: "rocket", count: 1, mine: false }]);
    expect(await setReaction(w.staff2, { messageId: sent.id, reaction: "thumbs_up", on: false })).toEqual([{ reaction: "thumbs_up", count: 1, mine: false }, { reaction: "rocket", count: 1, mine: false }]);
    expect(await setReaction(w.staff2, { messageId: sent.id, reaction: "thumbs_up", on: false })).toHaveLength(2);
  });

  it("are refused for a name that is not on the list, for a stranger, for a deleted message and in an archived conversation", async () => {
    const id = await group(w.staff, w.staff2);
    const sent = (await send(w.staff, id, "React")).message;
    expect((await refused(setReaction(w.staff2, { messageId: sent.id, reaction: "<b>", on: true })))?.code).toBe("invalid_input");
    expect((await refused(setReaction(w.staff2, { messageId: sent.id, reaction: "", on: true })))?.code).toBe("invalid_input");
    expect((await refused(setReaction(w.staff3, { messageId: sent.id, reaction: "heart", on: true })))?.code).toBe("not_found");
    expect((await refused(setReaction(w.superAdmin, { messageId: sent.id, reaction: "heart", on: true })))?.code).toBe("not_found");
    await setArchived(w.staff, id, true);
    expect((await refused(setReaction(w.staff2, { messageId: sent.id, reaction: "heart", on: true })))?.code).toBe("conflict");
    await setArchived(w.staff, id, false);
    await deleteMessage(w.staff, sent.id);
    expect((await refused(setReaction(w.staff2, { messageId: sent.id, reaction: "heart", on: true })))?.code).toBe("conflict");
    expect(await count("select 1 from staff_message_reactions where message_id = $1", [sent.id])).toBe(0);
  });
});

describe("the read cursor", () => {
  it("moves forward only and never past the newest message, whatever order requests arrive in", async () => {
    const id = await group(w.staff, w.staff2);
    for (let i = 1; i <= 5; i++) await send(w.staff, id, `Message ${i}`);
    expect((await listConversations(w.staff2))[0].unread).toBe(5);
    expect(await markRead(w.staff2, id, 3)).toEqual({ lastReadSeq: 3, moved: true });
    expect(await markRead(w.staff2, id, 2)).toEqual({ lastReadSeq: 3, moved: false });
    expect(await markRead(w.staff2, id, 3)).toEqual({ lastReadSeq: 3, moved: false });
    expect(await markRead(w.staff2, id, 99)).toEqual({ lastReadSeq: 5, moved: true });
    expect(await markRead(w.staff2, id, 0)).toEqual({ lastReadSeq: 5, moved: false });
    expect((await listConversations(w.staff2))[0].unread).toBe(0);
    await send(w.staff, id, "Six");
    expect((await listConversations(w.staff2))[0].unread).toBe(1);
    // Two requests at once end where the larger one says.
    await Promise.all([markRead(w.staff2, id, 4), markRead(w.staff2, id, 6)]);
    expect((await listConversations(w.staff2))[0].lastReadSeq).toBe(6);
  });

  it("is the sender's own: writing counts as having read up to that message, and nobody else's cursor moves", async () => {
    const id = await group(w.staff, w.staff2);
    await send(w.staff, id, "One");
    await send(w.staff2, id, "Two");
    const mine = (await listConversations(w.staff2))[0];
    expect(mine).toMatchObject({ lastReadSeq: 2, unread: 0 });
    expect((await listConversations(w.staff))[0]).toMatchObject({ lastReadSeq: 1, unread: 1 });
  });

  it("refuses a stranger, a bad number and a person who left, and raises the revision only when the cursor moved", async () => {
    const id = await group(w.staff, w.staff2);
    await send(w.staff, id, "One");
    expect((await refused(markRead(w.staff3, id, 1)))?.code).toBe("not_found");
    expect((await refused(markRead(w.superAdmin, id, 1)))?.code).toBe("not_found");
    expect((await refused(markRead(w.staff2, id, -1)))?.code).toBe("invalid_input");
    expect((await refused(markRead(w.staff2, id, 1.5)))?.code).toBe("invalid_input");
    expect((await refused(markRead(w.staff2, id, "1")))?.code).toBe("invalid_input");
    expect((await refused(markRead(w.staff2, "nope", 1)))?.code).toBe("not_found");
    const before = await inboxRevision(w.staff2.id);
    await markRead(w.staff2, id, 1);
    const after = await inboxRevision(w.staff2.id);
    expect(after).toBe(before + 1);
    await markRead(w.staff2, id, 1);
    expect(await inboxRevision(w.staff2.id)).toBe(after);
  });
});

describe("the revision a poll reads", () => {
  it("rises for everyone in a conversation when something changes in it, and for no one else", async () => {
    const id = await group(w.staff, w.staff2);
    const before = { a: await inboxRevision(w.staff.id), b: await inboxRevision(w.staff2.id), c: await inboxRevision(w.staff3.id) };
    const sent = await send(w.staff, id, "Hello");
    expect(await inboxRevision(w.staff.id)).toBe(before.a + 1);
    expect(await inboxRevision(w.staff2.id)).toBe(before.b + 1);
    expect(await inboxRevision(w.staff3.id)).toBe(before.c);
    await setReaction(w.staff2, { messageId: sent.message.id, reaction: "heart", on: true });
    await editMessage(w.staff, { messageId: sent.message.id, body: "Hello again" });
    await deleteMessage(w.staff, sent.message.id);
    expect(await inboxRevision(w.staff2.id)).toBe(before.b + 4);
    expect(await inboxRevision(w.staff3.id)).toBe(before.c);
    // Someone added hears about it; someone removed too.
    await addMembers(w.staff, id, [w.staff3.id]);
    expect(await inboxRevision(w.staff3.id)).toBe(before.c + 1);
  });

  it("answers a poll in one read: the revision while the person is allowed, and only that their standing changed once they are not", async () => {
    const id = await group(w.staff, w.staff2);
    expect(await inboxStatus(w.staff2)).toEqual({ access: "ok", revision: await inboxRevision(w.staff2.id) });
    const before = await inboxStatus(w.staff2);
    await send(w.staff, id, "Hello");
    const after = await inboxStatus(w.staff2);
    expect(after.access === "ok" && before.access === "ok" && after.revision).toBe(before.access === "ok" ? before.revision + 1 : -1);
    // The same answer for anyone whose standing changed, with no word about any conversation.
    await override(w.staff2.id, "agency.messages.use", "deny");
    expect(await inboxStatus(w.staff2)).toEqual({ access: "changed", reason: "forbidden" });
    await clearOverride(w.staff2.id, "agency.messages.use");
    expect(await inboxStatus(w.staff2)).toMatchObject({ access: "ok" });
    expect(await inboxStatus({ ...w.staff2, platformRole: "agency_manager" })).toEqual({ access: "changed", reason: "forbidden" });
    expect(await inboxStatus({ id: "nobody", platformRole: "agency_staff" })).toEqual({ access: "changed", reason: "forbidden" });
    expect(await inboxStatus({ id: freshId(), platformRole: "agency_staff" })).toEqual({ access: "changed", reason: "forbidden" });
    await disable(w.staff3.id);
    expect(await inboxStatus(w.staff3)).toEqual({ access: "changed", reason: "forbidden" });
    await setMessages(false);
    expect(await inboxStatus(w.staff)).toEqual({ access: "changed", reason: "not_enabled" });
    await setMessages(true);
    expect(await inboxStatus(w.staff)).toMatchObject({ access: "ok" });
  });

  it("carries nothing but a number: a person reads their own and nobody else's", async () => {
    const id = await group(w.staff, w.staff2);
    await send(w.staff, id, "Hello");
    expect(await inboxRevision(w.staff3.id)).toBe(0);
    const visible = await rows<{ user_id: string }>("select user_id from staff_inbox_state where user_id = any($1::uuid[])", [[w.staff.id, w.staff2.id, w.staff3.id]]);
    expect(visible.map((v) => v.user_id).sort()).toEqual([w.staff.id, w.staff2.id].sort());
  });
});

describe("search", () => {
  it("finds messages in the person's conversations only, newest first, ignoring case", async () => {
    const mine = await group(w.staff, w.staff2);
    const theirs = await group(w.staff3, w.manager);
    const dm = (await createDirect(w.staff, w.staff2.id)).id;
    await send(w.staff, mine, "The Quarterly report is ready");
    await send(w.staff2, dm, "quarterly numbers attached");
    await send(w.staff3, theirs, "quarterly gossip nobody here should see");
    const found = await searchMessages(w.staff, { query: "QUARTERLY" });
    expect(found.hits.map((h) => h.snippet.text)).toEqual(["quarterly numbers attached", "The Quarterly report is ready"]);
    expect(found.hits[0]).toMatchObject({ conversationKind: "direct", conversationName: w.staff2.name, author: { name: w.staff2.name } });
    expect(found.hits[0].snippet.match).toEqual({ start: 0, end: 9 });
    expect(found.truncated).toBe(false);
    // The Super Admin finds none of it: they are in none of these conversations.
    expect((await searchMessages(w.superAdmin, { query: "quarterly" })).hits).toEqual([]);
    expect((await searchMessages(w.staff3, { query: "quarterly" })).hits.map((h) => h.conversationId)).toEqual([theirs]);
  });

  it("can be limited to one conversation, and a conversation the person is not in matches nothing", async () => {
    const a = await group(w.staff, w.staff2);
    const b = await group(w.staff, w.staff2);
    await send(w.staff, a, "needle in a");
    await send(w.staff, b, "needle in b");
    expect((await searchMessages(w.staff, { query: "needle", conversationId: b })).hits.map((h) => h.conversationId)).toEqual([b]);
    expect((await searchMessages(w.staff3, { query: "needle", conversationId: b })).hits).toEqual([]);
    expect((await refused(searchMessages(w.staff, { query: "needle", conversationId: "nope" })))?.code).toBe("not_found");
  });

  it("looks for the words as typed: a percent sign, an underscore and a backslash are just characters", async () => {
    const id = await group(w.staff, w.staff2);
    await send(w.staff, id, "Growth was 100% this quarter");
    await send(w.staff, id, "snake_case_name and plain text");
    await send(w.staff, id, "C:\\temp\\file path");
    expect((await searchMessages(w.staff, { query: "100%" })).hits).toHaveLength(1);
    expect((await searchMessages(w.staff, { query: "%%" })).hits).toHaveLength(0);
    expect((await searchMessages(w.staff, { query: "e_c" })).hits).toHaveLength(1);
    expect((await searchMessages(w.staff, { query: "n_m" })).hits).toHaveLength(0);
    expect((await searchMessages(w.staff, { query: "temp\\file" })).hits).toHaveLength(1);
    expect((await refused(searchMessages(w.staff, { query: "%" })))?.code).toBe("invalid_input");
  });

  it("does not list deleted messages, ignores the ids inside mentions, and refuses a query that is too short", async () => {
    const id = await group(w.staff, w.staff2);
    const gone = (await send(w.staff, id, "remember the milk")).message;
    await send(w.staff, id, `ask ${mentionToken(w.staff2.id)} about it`);
    await deleteMessage(w.staff, gone.id);
    expect((await searchMessages(w.staff, { query: "milk" })).hits).toEqual([]);
    // A short query that happens to occur inside the person's id is not a hit.
    const piece = w.staff2.id.slice(9, 13);
    expect((await searchMessages(w.staff, { query: piece })).hits).toEqual([]);
    expect((await searchMessages(w.staff, { query: "ask" })).hits[0].snippet.text).toBe(`ask @${w.staff2.name} about it`);
    expect((await refused(searchMessages(w.staff, { query: "a" })))?.code).toBe("invalid_input");
    expect((await refused(searchMessages(w.staff, { query: "x".repeat(101) })))?.code).toBe("invalid_input");
  });

  it("is limited in speed, and shows at most thirty hits", async () => {
    const id = await group(w.staff, w.staff2);
    await withSystem(async (db) => {
      await db.query("update staff_conversations set last_seq = 40 where id = $1", [id]);
      await db.query(
        "insert into staff_messages (org_id, conversation_id, seq, author_id, body, client_message_id) select $1, $2, g, $3, 'bulk entry ' || g, gen_random_uuid() from generate_series(1, 40) g",
        [w.agencyId, id, w.staff.id],
      );
    });
    const found = await searchMessages(w.staff, { query: "bulk entry" });
    expect(found.hits).toHaveLength(30);
    expect(found.truncated).toBe(true);
    await seedRateHits(RATE_LIMITS.staffMessageSearchByUser, w.staff.id, RATE_LIMITS.staffMessageSearchByUser.limit);
    expect(await refused(searchMessages(w.staff, { query: "bulk" }))).toMatchObject({ code: "rate_limited" });
  });
});

describe("pages of a conversation", () => {
  it("come oldest first, in pages, with the unread position", async () => {
    const id = await group(w.staff, w.staff2);
    await withSystem(async (db) => {
      await db.query("update staff_conversations set last_seq = 120 where id = $1", [id]);
      await db.query(
        "insert into staff_messages (org_id, conversation_id, seq, author_id, body, client_message_id) select $1, $2, g, $3, 'm' || g, gen_random_uuid() from generate_series(1, 120) g",
        [w.agencyId, id, w.staff.id],
      );
    });
    const latest = await listMessages(w.staff2, id);
    expect(latest.messages).toHaveLength(50);
    expect(latest.messages[0].seq).toBe(71);
    expect(latest.messages[49].seq).toBe(120);
    expect(latest).toMatchObject({ hasMore: true, lastSeq: 120, lastReadSeq: 0 });
    const older = await listMessages(w.staff2, id, { beforeSeq: 71 });
    expect([older.messages[0].seq, older.messages[49].seq, older.hasMore]).toEqual([21, 70, true]);
    const oldest = await listMessages(w.staff2, id, { beforeSeq: 21 });
    expect([oldest.messages.length, oldest.messages[0].seq, oldest.hasMore]).toEqual([20, 1, false]);
    expect((await listMessages(w.staff2, id, { limit: 5 })).messages.map((m) => m.seq)).toEqual([116, 117, 118, 119, 120]);
    expect((await refused(listMessages(w.staff3, id)))?.code).toBe("not_found");
    expect((await refused(listMessages(w.superAdmin, id)))?.code).toBe("not_found");
    expect((await refused(listMessages(w.staff2, "nope")))?.code).toBe("not_found");
  });
});
