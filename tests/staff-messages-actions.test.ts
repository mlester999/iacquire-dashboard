import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChannel, createDirect, createGroup } from "@/server/staff-messages/conversations";
import { listMessages } from "@/server/staff-messages/messages";
import { loadStaffMessageSettings, staffMessagesEnabled } from "@/server/staff-messages/settings";
import { EDIT_CONFLICT_MESSAGE } from "@/server/staff-messages/messages";
import { resetRateLimits } from "./support/support-world";
import { channelName, clearOverride, count, disable, enable, freshId, override, rows, setMessages, staffPerson, staffWorld, type Person, type World } from "./support/staff-messages";

// The server actions behind the Messages screens: who they refuse (a signed-out visitor, a client, a person denied Messages, a stale session, the module being off), what they
// check before the services do (the shape of the input), and that they change what they say they change. The signed-in person is handed to the action; everything below it is
// the real service on embedded Postgres.

const mocks = vi.hoisted(() => ({ user: null as unknown, revalidate: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/server/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/session")>()),
  requireUserOrThrow: async () => {
    if (!mocks.user) throw new (await import("@/server/errors")).AppError("unauthenticated", "Your session has ended. Please sign in again.");
    return mocks.user;
  },
}));

import * as A from "@/app/actions/staff-messages";

let w: World;
beforeEach(async () => {
  await resetRateLimits();
  mocks.revalidate.mockReset();
  w = await staffWorld();
  mocks.user = null;
});
const as = (who: Person | null) => {
  mocks.user = who;
};
const group = async (owner: Person, ...others: Person[]) => (await createGroup(owner, { name: `g-${freshId().slice(0, 6)}`, memberIds: others.map((o) => o.id) })).id;
const fail = (code: string, error?: string | RegExp) => ({ ok: false, code, error: error instanceof RegExp ? expect.stringMatching(error) : (error ?? expect.any(String)) });

describe("who may call an action at all", () => {
  it("answers every action from a signed-out visitor with 'unauthenticated' and a client with 'forbidden', and changes nothing", async () => {
    const id = await group(w.staff, w.staff2);
    const calls: Array<() => Promise<unknown>> = [
      () => A.sendMessageAction({ conversationId: id, clientMessageId: freshId(), body: "hello" }),
      () => A.editMessageAction({ messageId: freshId(), body: "x" }),
      () => A.deleteMessageAction(freshId()),
      () => A.reactAction({ messageId: freshId(), reaction: "heart", on: true }),
      () => A.markReadAction({ conversationId: id, seq: 1 }),
      () => A.searchMessagesAction({ query: "hello" }),
      () => A.discardAttachmentAction(freshId()),
      () => A.startDirectAction(w.staff2.id),
      () => A.startGroupAction({ name: "Group", memberIds: [w.staff2.id] }),
      () => A.startChannelAction({ name: "chan", visibility: "staff" }),
      () => A.joinChannelAction(id),
      () => A.leaveConversationAction(id),
      () => A.addMembersAction({ conversationId: id, memberIds: [w.staff3.id] }),
      () => A.removeMemberAction({ conversationId: id, memberId: w.staff2.id }),
      () => A.updateConversationAction({ conversationId: id, name: "Renamed" }),
      () => A.archiveConversationAction({ conversationId: id, archived: true }),
      () => A.preferencesAction({ conversationId: id, muted: true }),
      () => A.staffDirectoryAction(),
      () => A.channelDirectoryAction(),
      () => A.setMessagesEnabledAction(false),
      () => A.setRetentionAction(90),
    ];
    const before = { messages: await count("select 1 from staff_messages"), conversations: await count("select 1 from staff_conversations"), members: await count("select 1 from staff_conversation_members") };
    as(null);
    for (const [i, call] of calls.entries()) expect(await call(), `signed out, call ${i}`).toMatchObject(fail("unauthenticated"));
    as(await staffPerson("none"));
    for (const [i, call] of calls.entries()) expect(await call(), `client, call ${i}`).toMatchObject(fail("forbidden", "Agency access is required."));
    expect({ messages: await count("select 1 from staff_messages"), conversations: await count("select 1 from staff_conversations"), members: await count("select 1 from staff_conversation_members") }).toEqual(before);
    expect(await staffMessagesEnabled()).toBe(true);
  });

  it("refuses a person denied the permission, a disabled one and one with a stale role, on every conversation action", async () => {
    const id = await group(w.staff, w.staff2);
    const denied = await staffPerson("agency_staff");
    await override(denied.id, "agency.messages.use", "deny");
    as(denied);
    for (const result of [await A.sendMessageAction({ conversationId: id, clientMessageId: freshId(), body: "hello" }), await A.staffDirectoryAction(), await A.startDirectAction(w.staff.id), await A.searchMessagesAction({ query: "hello" })]) {
      expect(result).toMatchObject(fail("forbidden"));
    }
    await clearOverride(denied.id, "agency.messages.use");
    expect(await A.staffDirectoryAction()).toMatchObject({ ok: true });
    await disable(denied.id);
    expect(await A.staffDirectoryAction()).toMatchObject(fail("forbidden"));
    await enable(denied.id);
    as({ ...denied, platformRole: "agency_manager" });
    expect(await A.staffDirectoryAction()).toMatchObject(fail("forbidden"));
  });

  it("refuses everyone but the settings while the module is off, and lets a Super Admin switch it back on", async () => {
    const id = await group(w.staff, w.staff2);
    await setMessages(false);
    as(w.staff);
    for (const result of [await A.sendMessageAction({ conversationId: id, clientMessageId: freshId(), body: "hello" }), await A.markReadAction({ conversationId: id, seq: 1 }), await A.staffDirectoryAction(), await A.channelDirectoryAction()]) {
      expect(result).toMatchObject(fail("not_enabled"));
    }
    expect(await A.setMessagesEnabledAction(true)).toMatchObject(fail("forbidden", /Super Admin/));
    as(w.manager);
    expect(await A.setMessagesEnabledAction(true)).toMatchObject(fail("forbidden"));
    expect(await staffMessagesEnabled()).toBe(false);
    as(w.superAdmin);
    expect(await A.setMessagesEnabledAction(true)).toEqual({ ok: true, data: undefined });
    expect(await staffMessagesEnabled()).toBe(true);
    expect(mocks.revalidate).toHaveBeenCalledWith("/admin", "layout");
    as(w.staff);
    expect(await A.staffDirectoryAction()).toMatchObject({ ok: true });
  });
});

describe("the settings", () => {
  it("are for a Super Admin only, audited, and refuse a period that is not a whole number of days in range", async () => {
    for (const who of [w.staff, w.manager]) {
      as(who);
      expect(await A.setRetentionAction(90), who.name).toMatchObject(fail("forbidden"));
      expect(await A.setMessagesEnabledAction(false), who.name).toMatchObject(fail("forbidden"));
    }
    as(w.superAdmin);
    expect(await A.setRetentionAction(90)).toEqual({ ok: true, data: { retentionDays: 90 } });
    expect((await loadStaffMessageSettings()).retentionDays).toBe(90);
    for (const bad of [0, 29, 3651, -5]) expect(await A.setRetentionAction(bad), String(bad)).toMatchObject(fail("invalid_input"));
    expect(await A.setRetentionAction(1.5)).toMatchObject(fail("invalid_input"));
    expect(await A.setRetentionAction("90" as unknown as number)).toMatchObject(fail("invalid_input"));
    expect((await loadStaffMessageSettings()).retentionDays).toBe(90);
    expect(await A.setRetentionAction(null)).toEqual({ ok: true, data: { retentionDays: null } });
    expect(mocks.revalidate).toHaveBeenCalledWith("/admin/messages/settings");
    const audit = await rows<{ action: string }>("select action from audit_logs where actor_user_id = $1 and action like 'staff_messages.%' order by created_at", [w.superAdmin.id]);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["staff_messages.retention_changed"]));
  });
});

describe("what a person may do, role by role", () => {
  it("lets every agency role write direct messages and private groups, and only the roles with the channels permission start channels", async () => {
    for (const [who, mayChannel] of [[w.staff, false], [w.manager, true], [w.superAdmin, true]] as const) {
      as(who);
      const dm = await A.startDirectAction(who === w.staff ? w.staff2.id : w.staff.id);
      expect(dm, who.name).toMatchObject({ ok: true });
      const grp = await A.startGroupAction({ name: `Group of ${who.name}`, memberIds: [w.staff3.id] });
      expect(grp, who.name).toMatchObject({ ok: true });
      const channel = await A.startChannelAction({ name: channelName("c"), visibility: "staff" });
      expect(channel.ok, who.name).toBe(mayChannel);
      if (!channel.ok) expect(channel).toMatchObject(fail("forbidden", /channels permission/));
    }
  });

  it("lets an override give a staff member channels and take them from a manager", async () => {
    await override(w.staff.id, "agency.messages.channels", "allow");
    as(w.staff);
    expect(await A.startChannelAction({ name: channelName("allowed"), visibility: "staff" })).toMatchObject({ ok: true });
    await override(w.manager.id, "agency.messages.channels", "deny");
    as(w.manager);
    expect(await A.startChannelAction({ name: channelName("denied"), visibility: "staff" })).toMatchObject(fail("forbidden"));
    await clearOverride(w.staff.id, "agency.messages.channels");
    await clearOverride(w.manager.id, "agency.messages.channels");
  });

  it("sends, reads back, reacts, edits, marks read, deletes and searches for a member, and keeps every one of those out of reach of a non-member, who gets the answer for a made-up id", async () => {
    const id = await group(w.staff, w.staff2);
    as(w.staff);
    const sent = await A.sendMessageAction({ conversationId: id, clientMessageId: freshId(), body: "Quarterly planning notes" });
    expect(sent).toMatchObject({ ok: true, data: { duplicate: false, message: { body: "Quarterly planning notes", seq: 1, mine: true } } });
    if (!sent.ok) return;
    const messageId = sent.data.message.id;
    expect(await A.reactAction({ messageId, reaction: "heart", on: true })).toMatchObject({ ok: true, data: [{ reaction: "heart", count: 1, mine: true }] });
    const edited = await A.editMessageAction({ messageId, body: "Quarterly planning notes v2", expectedEditedAt: null });
    expect(edited).toMatchObject({ ok: true, data: { body: "Quarterly planning notes v2" } });
    as(w.staff2);
    expect(await A.markReadAction({ conversationId: id, seq: 1 })).toEqual({ ok: true, data: { lastReadSeq: 1, moved: true } });
    expect(await A.markReadAction({ conversationId: id, seq: 1 })).toEqual({ ok: true, data: { lastReadSeq: 1, moved: false } });
    expect(await A.searchMessagesAction({ query: "planning" })).toMatchObject({ ok: true, data: { hits: [{ messageId }] } });
    expect(await A.editMessageAction({ messageId, body: "Hijack" })).toMatchObject(fail("forbidden", "You can only edit your own messages."));
    expect(await A.deleteMessageAction(messageId)).toMatchObject(fail("forbidden", "You can only delete your own messages."));

    // Somebody to try to add: asking to add oneself would be refused for a different reason before the conversation is looked at.
    const extra = await staffPerson("agency_staff");
    for (const outsider of [w.staff3, w.manager, w.superAdmin]) {
      as(outsider);
      const real = [
        await A.sendMessageAction({ conversationId: id, clientMessageId: freshId(), body: "Let me in" }),
        await A.markReadAction({ conversationId: id, seq: 1 }),
        await A.editMessageAction({ messageId, body: "Hijack" }),
        await A.deleteMessageAction(messageId),
        await A.reactAction({ messageId, reaction: "heart", on: true }),
        await A.updateConversationAction({ conversationId: id, name: "Mine now" }),
        await A.addMembersAction({ conversationId: id, memberIds: [extra.id] }),
      ];
      const fake = [
        await A.sendMessageAction({ conversationId: freshId(), clientMessageId: freshId(), body: "Let me in" }),
        await A.markReadAction({ conversationId: freshId(), seq: 1 }),
        await A.editMessageAction({ messageId: freshId(), body: "Hijack" }),
        await A.deleteMessageAction(freshId()),
        await A.reactAction({ messageId: freshId(), reaction: "heart", on: true }),
        await A.updateConversationAction({ conversationId: freshId(), name: "Mine now" }),
        await A.addMembersAction({ conversationId: freshId(), memberIds: [extra.id] }),
      ];
      expect(real, outsider.name).toEqual(fake);
      for (const r of real) expect(r).toMatchObject({ ok: false, code: "not_found" });
      expect(await A.searchMessagesAction({ query: "planning" }), outsider.name).toEqual({ ok: true, data: { hits: [], truncated: false } });
    }
    as(w.staff);
    expect(await A.deleteMessageAction(messageId)).toEqual({ ok: true, data: undefined });
    expect((await listMessages(w.staff, id)).messages[0]).toMatchObject({ deleted: true, body: "" });
  });

  it("refuses a stale edit with a conflict and the plain sentence, and keeps the newer text", async () => {
    const id = await group(w.staff, w.staff2);
    as(w.staff);
    const sent = await A.sendMessageAction({ conversationId: id, clientMessageId: freshId(), body: "Draft one" });
    if (!sent.ok) throw new Error("send failed");
    const messageId = sent.data.message.id;
    const first = await A.editMessageAction({ messageId, body: "Draft two", expectedEditedAt: null });
    expect(first).toMatchObject({ ok: true });
    expect(await A.editMessageAction({ messageId, body: "Draft three", expectedEditedAt: null })).toEqual({ ok: false, code: "conflict", error: EDIT_CONFLICT_MESSAGE });
    expect((await listMessages(w.staff, id)).messages[0].body).toBe("Draft two");
  });

  it("posts a retried send once, whichever way the answer was lost", async () => {
    const id = await group(w.staff, w.staff2);
    as(w.staff);
    const clientMessageId = freshId();
    const a = await A.sendMessageAction({ conversationId: id, clientMessageId, body: "Exactly once" });
    const b = await A.sendMessageAction({ conversationId: id, clientMessageId, body: "Exactly once" });
    expect(a).toMatchObject({ ok: true, data: { duplicate: false } });
    expect(b).toMatchObject({ ok: true, data: { duplicate: true } });
    expect(await count("select 1 from staff_messages where conversation_id = $1", [id])).toBe(1);
  });

  it("joins an open channel and refuses a private one, leaves, is added and removed, renames with a stale form refused, archives and brings back, and mutes", async () => {
    const open = (await createChannel(w.manager, { name: channelName("open"), visibility: "staff" })).id;
    const closed = (await createChannel(w.manager, { name: channelName("closed"), visibility: "private" })).id;
    as(w.staff);
    expect(await A.joinChannelAction(open)).toEqual({ ok: true, data: undefined });
    expect(await A.joinChannelAction(closed)).toMatchObject(fail("not_found"));
    expect(await A.preferencesAction({ conversationId: open, muted: true, notify: "none" })).toEqual({ ok: true, data: undefined });
    expect(await A.preferencesAction({ conversationId: open, notify: "sometimes" as unknown as "all" })).toMatchObject(fail("invalid_input"));
    expect(await A.leaveConversationAction(open)).toEqual({ ok: true, data: undefined });
    as(w.manager);
    expect(await A.addMembersAction({ conversationId: closed, memberIds: [w.staff.id] })).toEqual({ ok: true, data: { added: 1 } });
    expect(await A.removeMemberAction({ conversationId: closed, memberId: w.staff.id })).toEqual({ ok: true, data: undefined });
    expect(await A.updateConversationAction({ conversationId: open, topic: "Fresh topic", expectedTopic: null })).toEqual({ ok: true, data: undefined });
    expect(await A.updateConversationAction({ conversationId: open, topic: "Stale write", expectedTopic: null })).toMatchObject(fail("conflict"));
    expect(await A.archiveConversationAction({ conversationId: open, archived: true })).toEqual({ ok: true, data: undefined });
    expect(await A.sendMessageAction({ conversationId: open, clientMessageId: freshId(), body: "Anyone?" })).toMatchObject(fail("conflict", /archived/));
    expect(await A.archiveConversationAction({ conversationId: open, archived: false })).toEqual({ ok: true, data: undefined });
    const directory = await A.channelDirectoryAction();
    expect(directory).toMatchObject({ ok: true });
    if (directory.ok) expect(directory.data.map((c) => c.id)).toContain(open);
    if (directory.ok) expect(directory.data.map((c) => c.id)).not.toContain(closed);
  });
});

describe("the shape of the input", () => {
  it("is checked before anything is read, with a plain sentence and no crash, for every kind of wrong", async () => {
    as(w.staff);
    const id = await group(w.staff, w.staff2);
    const bad = [
      await A.sendMessageAction({ conversationId: "not-an-id", clientMessageId: freshId(), body: "x" }),
      await A.sendMessageAction({ conversationId: id, clientMessageId: "nope", body: "x" }),
      await A.sendMessageAction({ conversationId: id, clientMessageId: freshId(), body: 42 as unknown as string }),
      await A.sendMessageAction({ conversationId: id, clientMessageId: freshId(), body: "x", attachmentIds: ["a"] }),
      await A.sendMessageAction({ conversationId: id, clientMessageId: freshId(), body: "x".repeat(40_000) }),
      await A.reactAction({ messageId: freshId(), reaction: "heart", on: "yes" as unknown as boolean }),
      await A.markReadAction({ conversationId: id, seq: -1 }),
      await A.markReadAction({ conversationId: id, seq: 1.5 }),
      await A.startDirectAction("nobody"),
      await A.startGroupAction({ name: "Group", memberIds: ["a"] }),
      await A.startChannelAction({ name: "chan", visibility: "everyone" as unknown as "staff" }),
      await A.searchMessagesAction({ query: 5 as unknown as string }),
      await A.discardAttachmentAction("x"),
    ];
    for (const r of bad) expect(r).toMatchObject({ ok: false, code: "invalid_input", error: expect.any(String) });
    for (const r of bad) if (!r.ok) expect(r.error).not.toMatch(/zod|invalid_type|expected|undefined|\[object/i);
    expect(await count("select 1 from staff_messages where conversation_id = $1", [id])).toBe(0);
  });

  it("lets the services say the rule that was broken, in their own words", async () => {
    as(w.staff);
    expect(await A.startDirectAction(w.staff.id)).toMatchObject(fail("invalid_input", /yourself/));
    expect(await A.startGroupAction({ name: "Alone", memberIds: [] })).toMatchObject(fail("invalid_input", /at least one other person/));
    expect(await A.startGroupAction({ name: "   ", memberIds: [w.staff2.id] })).toMatchObject(fail("invalid_input", /name/i));
    expect(await A.searchMessagesAction({ query: "a" })).toMatchObject(fail("invalid_input", /at least 2 characters/));
    expect(await A.sendMessageAction({ conversationId: await group(w.staff, w.staff2), clientMessageId: freshId(), body: "   " })).toMatchObject(fail("invalid_input", /Write something/));
  });

  it("starts a direct message that is the same one from either side", async () => {
    as(w.staff);
    const a = await A.startDirectAction(w.staff2.id);
    as(w.staff2);
    const b = await A.startDirectAction(w.staff.id);
    expect(a).toMatchObject({ ok: true, data: { created: true } });
    expect(b).toMatchObject({ ok: true, data: { created: false } });
    if (a.ok && b.ok) expect(a.data.id).toBe(b.data.id);
    expect((await createDirect(w.staff, w.staff2.id)).created).toBe(false);
  });
});
