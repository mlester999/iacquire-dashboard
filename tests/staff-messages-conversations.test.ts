import { beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { addMembers, channelDirectory, createChannel, createDirect, createGroup, getConversation, joinChannel, leaveConversation, listConversations, removeMember, setArchived, setPreferences, updateConversation } from "@/server/staff-messages/conversations";
import { sendMessage } from "@/server/staff-messages/messages";
import { listStaffDirectory } from "@/server/staff-messages/directory";
import { MAX_MEMBERS } from "@/lib/staff-messages/limits";
import { resetRateLimits } from "./support/support-world";
import { channelName, clearOverride, count, disable, freshId, override, rows, setMessages, staffPerson, staffWorld, type Person, type World } from "./support/staff-messages";

// Conversations of staff Messages (migration 0096): direct messages, groups and channels, who may start and run them, and what they leave behind.

let w: World;
beforeEach(async () => {
  await resetRateLimits();
  w = await staffWorld();
});

const events = (id: string) => rows<{ kind: string; actor_id: string | null; subject_id: string | null }>("select kind, actor_id, subject_id from staff_conversation_events where conversation_id = $1 order by id", [id]);
const members = (id: string) => rows<{ user_id: string; role: string; left: boolean; notify: string }>("select user_id, role, left_at is not null as left, notify from staff_conversation_members where conversation_id = $1 order by joined_at, user_id", [id]);
const noticesFor = (userId: string, kind: string) => rows<{ title: string; body: string; link: string | null }>("select title, body, link from notifications where user_id = $1 and kind = $2 order by created_at", [userId, kind]);
const refused = async (p: Promise<unknown>) => p.then(() => null, (e: Error & { code?: string }) => ({ code: e.code, message: e.message }));

describe("direct messages", () => {
  it("are one per pair of people, whoever opens it first, with both people in it", async () => {
    const first = await createDirect(w.staff, w.staff2.id);
    const again = await createDirect(w.staff2, w.staff.id);
    const same = await createDirect(w.staff, w.staff2.id.toUpperCase());
    expect(first.created).toBe(true);
    expect(again).toEqual({ id: first.id, created: false });
    expect(same).toEqual({ id: first.id, created: false });
    expect((await members(first.id)).map((m) => m.user_id).sort()).toEqual([w.staff.id, w.staff2.id].sort());
    expect(await events(first.id)).toEqual([{ kind: "created", actor_id: w.staff.id, subject_id: null }]);
    expect(await count("select 1 from staff_conversations where kind = 'direct' and direct_key like $1", [`%${w.staff.id}%`])).toBe(1);
  });

  it("are opened by two people at once without making two", async () => {
    const [a, b] = await Promise.all([createDirect(w.manager, w.staff3.id), createDirect(w.staff3, w.manager.id)]);
    expect(a.id).toBe(b.id);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
  });

  it("are refused with yourself, with someone who is not a valid person, and with someone who is not on the team or cannot use Messages", async () => {
    expect((await refused(createDirect(w.staff, w.staff.id)))?.code).toBe("invalid_input");
    expect((await refused(createDirect(w.staff, "nobody")))?.code).toBe("invalid_input");
    expect((await refused(createDirect(w.staff, freshId())))?.code).toBe("invalid_input");
    const client = await staffPerson("none");
    expect((await refused(createDirect(w.staff, client.id)))?.code).toBe("invalid_input");
    const denied = await staffPerson("agency_staff");
    await override(denied.id, "agency.messages.use", "deny");
    expect((await refused(createDirect(w.staff, denied.id)))?.code).toBe("invalid_input");
    const gone = await staffPerson("agency_staff");
    await disable(gone.id);
    expect((await refused(createDirect(w.staff, gone.id)))?.code).toBe("invalid_input");
    expect(await count("select 1 from staff_conversations where kind = 'direct' and (direct_key like $1 or direct_key like $2 or direct_key like $3)", [`%${client.id}%`, `%${denied.id}%`, `%${gone.id}%`])).toBe(0);
  });

  it("are not named, and can't be left, archived or renamed", async () => {
    const dm = await createDirect(w.staff, w.staff2.id);
    expect((await refused(leaveConversation(w.staff, dm.id)))?.code).toBe("invalid_input");
    expect((await refused(setArchived(w.staff, dm.id, true)))?.code).toBe("forbidden");
    expect((await refused(updateConversation(w.staff, dm.id, { name: "x" })))?.code).toBe("forbidden");
    expect((await refused(addMembers(w.staff, dm.id, [w.staff3.id])))?.code).toBe("forbidden");
  });

  it("reopen for someone whose membership had been closed", async () => {
    const dm = await createDirect(w.staff, w.staff2.id);
    await withSystem((db) => db.query("update staff_conversation_members set left_at = now() where conversation_id = $1 and user_id = $2", [dm.id, w.staff2.id]));
    expect(await createDirect(w.staff, w.staff2.id)).toEqual({ id: dm.id, created: false });
    expect((await members(dm.id)).every((m) => !m.left)).toBe(true);
  });
});

describe("groups", () => {
  it("are private, owned by the person who starts them, and tell the others they were added (not the owner)", async () => {
    const g = await createGroup(w.staff, { name: "  Design   review ", memberIds: [w.staff2.id, w.staff3.id, w.staff.id, w.staff2.id.toUpperCase()] });
    const m = await members(g.id);
    expect(m.map((x) => [x.user_id, x.role]).sort()).toEqual([[w.staff.id, "owner"], [w.staff2.id, "member"], [w.staff3.id, "member"]].sort());
    expect(m.every((x) => x.notify === "all")).toBe(true);
    const [conv] = await rows<{ name: string; kind: string; visibility: string; created_by: string }>("select name, kind, visibility, created_by from staff_conversations where id = $1", [g.id]);
    expect(conv).toEqual({ name: "Design review", kind: "group", visibility: "private", created_by: w.staff.id });
    expect((await events(g.id)).map((e) => e.kind)).toEqual(["created", "member_added", "member_added"]);
    expect(await noticesFor(w.staff.id, "staff_message_added")).toEqual([]);
    const told = await noticesFor(w.staff2.id, "staff_message_added");
    expect(told).toEqual([{ title: "You were added to a conversation", body: `${w.staff.name} added you to Design review.`, link: `/admin/messages/${g.id}` }]);
  });

  it("need a name and another person, and only people who can be messaged", async () => {
    expect((await refused(createGroup(w.staff, { name: "", memberIds: [w.staff2.id] })))?.code).toBe("invalid_input");
    expect((await refused(createGroup(w.staff, { name: "Solo", memberIds: [] })))?.code).toBe("invalid_input");
    expect((await refused(createGroup(w.staff, { name: "Solo", memberIds: [w.staff.id] })))?.code).toBe("invalid_input");
    expect((await refused(createGroup(w.staff, { name: "Bad", memberIds: ["nope"] })))?.code).toBe("invalid_input");
    const client = await staffPerson("none");
    expect((await refused(createGroup(w.staff, { name: "With a client", memberIds: [w.staff2.id, client.id] })))?.code).toBe("invalid_input");
    expect(await count("select 1 from staff_conversations where name in ('Solo', 'Bad', 'With a client')")).toBe(0);
    expect((await refused(createGroup(w.staff, { name: "Too big", memberIds: Array.from({ length: MAX_MEMBERS }, () => freshId()) })))?.code).toBe("invalid_input");
  });

  it("are for anyone who may use Messages, and for no one who may not", async () => {
    const denied = await staffPerson("agency_staff");
    await override(denied.id, "agency.messages.use", "deny");
    expect((await refused(createGroup(denied, { name: "Nope", memberIds: [w.staff.id] })))?.code).toBe("forbidden");
  });

  it("are run by their owner: members can't rename, add, remove or archive, and a manager's role gives no say over someone's group", async () => {
    const g = await createGroup(w.staff, { name: "Ops", memberIds: [w.staff2.id, w.manager.id] });
    for (const who of [w.staff2, w.manager]) {
      expect((await refused(updateConversation(who, g.id, { name: "Mine now" })))?.code).toBe("forbidden");
      expect((await refused(addMembers(who, g.id, [w.staff3.id])))?.code).toBe("forbidden");
      expect((await refused(removeMember(who, g.id, w.staff.id)))?.code).toBe("forbidden");
      expect((await refused(setArchived(who, g.id, true)))?.code).toBe("forbidden");
    }
    await updateConversation(w.staff, g.id, { name: "Operations", topic: "Weekly" });
    expect(await events(g.id)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "renamed" }), expect.objectContaining({ kind: "topic_changed" })]));
    // Saying the same thing again changes nothing and adds no event.
    const before = (await events(g.id)).length;
    await updateConversation(w.staff, g.id, { name: "Operations", topic: "Weekly" });
    expect((await events(g.id)).length).toBe(before);
  });

  it("reads as not found to a person who is not in them, whatever their role", async () => {
    const g = await createGroup(w.staff, { name: "Private", memberIds: [w.staff2.id] });
    const target = await staffPerson("agency_staff");
    for (const outsider of [w.staff3, w.manager, w.superAdmin]) {
      expect((await refused(getConversation(outsider, g.id)))?.code).toBe("not_found");
      expect((await refused(addMembers(outsider, g.id, [target.id])))?.code).toBe("not_found");
      expect((await refused(joinChannel(outsider, g.id)))?.code).toBe("not_found");
      expect((await refused(setArchived(outsider, g.id, true)))?.code).toBe("not_found");
      expect((await refused(leaveConversation(outsider, g.id)))?.code).toBe("not_found");
    }
    expect((await refused(getConversation(w.staff, freshId())))?.code).toBe("not_found");
    expect((await refused(getConversation(w.staff, "not an id")))?.code).toBe("not_found");
  });
});

describe("adding and removing people", () => {
  it("lets the owner add people, who start with nothing unread, and lets someone who left be added again", async () => {
    const g = await createGroup(w.staff, { name: "Late joiners", memberIds: [w.staff2.id] });
    await sendMessage(w.staff, { conversationId: g.id, clientMessageId: freshId(), body: "First" });
    await sendMessage(w.staff, { conversationId: g.id, clientMessageId: freshId(), body: "Second" });
    expect(await addMembers(w.staff, g.id, [w.staff3.id, w.staff3.id, w.staff.id])).toEqual({ added: 1 });
    const [joined] = await rows<{ last_read_seq: string }>("select last_read_seq::text from staff_conversation_members where conversation_id = $1 and user_id = $2", [g.id, w.staff3.id]);
    expect(joined.last_read_seq).toBe("2");
    expect(await addMembers(w.staff, g.id, [w.staff3.id])).toEqual({ added: 0 });
    await leaveConversation(w.staff3, g.id);
    expect(await addMembers(w.staff, g.id, [w.staff3.id])).toEqual({ added: 1 });
    expect((await members(g.id)).filter((m) => !m.left)).toHaveLength(3);
    expect((await events(g.id)).filter((e) => e.kind === "member_added").map((e) => e.subject_id)).toEqual([w.staff2.id, w.staff3.id, w.staff3.id]);
  });

  it("removes a person (not the person asking) and says so in the history", async () => {
    const g = await createGroup(w.staff, { name: "Trim", memberIds: [w.staff2.id, w.staff3.id] });
    await removeMember(w.staff, g.id, w.staff2.id);
    expect((await members(g.id)).find((m) => m.user_id === w.staff2.id)?.left).toBe(true);
    expect((await events(g.id)).at(-1)).toEqual({ kind: "member_removed", actor_id: w.staff.id, subject_id: w.staff2.id });
    expect((await refused(getConversation(w.staff2, g.id)))?.code).toBe("not_found");
    expect((await refused(removeMember(w.staff, g.id, w.staff.id)))?.code).toBe("invalid_input");
    expect((await refused(removeMember(w.staff, g.id, w.staff2.id)))?.code).toBe("not_found");
    expect((await refused(removeMember(w.staff, g.id, "x")))?.code).toBe("invalid_input");
  });

  it("hands a group to the person who has been in it longest when its last owner leaves", async () => {
    // staff3 is in from the start, staff2 comes later: of the two, staff3 has been in it longest.
    const g = await createGroup(w.staff, { name: "Pass it on", memberIds: [w.staff3.id] });
    await addMembers(w.staff, g.id, [w.staff2.id]);
    await leaveConversation(w.staff, g.id);
    const m = (await members(g.id)).filter((x) => !x.left);
    expect(m.map((x) => [x.user_id, x.role]).sort()).toEqual([[w.staff2.id, "member"], [w.staff3.id, "owner"]].sort());
    // The new owner can now run it.
    await addMembers(w.staff3, g.id, [w.manager.id]);
    expect((await events(g.id)).at(-1)?.kind).toBe("member_added");
  });

  it("holds a conversation to 200 people", async () => {
    const g = await createGroup(w.staff, { name: "Packed", memberIds: [w.staff2.id] });
    const extra = Array.from({ length: MAX_MEMBERS - 2 }, () => freshId());
    await withSystem(async (db) => {
      // 198 more people, made directly: the limit is about people in the conversation, so they need only be eligible accounts.
      for (const id of extra) await db.query("insert into users (id, email, full_name, email_verified_at, platform_role) values ($1, $2, 'Filler', now(), 'agency_staff')", [id, `${id}@example.test`]);
      await db.query("insert into staff_conversation_members (conversation_id, user_id, org_id, added_by) select $1, u, $2, $3 from unnest($4::uuid[]) as u", [g.id, w.agencyId, w.staff.id, extra]);
    });
    expect((await members(g.id)).filter((m) => !m.left)).toHaveLength(MAX_MEMBERS);
    expect((await refused(addMembers(w.staff, g.id, [w.staff3.id])))?.code).toBe("conflict");
    expect((await members(g.id)).filter((m) => !m.left)).toHaveLength(MAX_MEMBERS);
  });
});

describe("channels", () => {
  it("are made by those with the channels permission: managers and the Super Admin, not staff", async () => {
    expect((await refused(createChannel(w.staff, { name: channelName(), visibility: "staff" })))?.code).toBe("forbidden");
    const open = await createChannel(w.manager, { name: "#Launch Plans", topic: "Everything about launches", visibility: "staff" });
    const [row] = await rows<{ name: string; topic: string; visibility: string; kind: string }>("select name, topic, visibility, kind from staff_conversations where id = $1", [open.id]);
    expect(row).toEqual({ name: "launch-plans", topic: "Everything about launches", visibility: "staff", kind: "channel" });
    expect((await members(open.id)).map((m) => [m.user_id, m.role, m.notify])).toEqual([[w.manager.id, "owner", "mentions"]]);
    expect((await createChannel(w.superAdmin, { name: channelName(), visibility: "private", memberIds: [w.staff.id] })).created).toBe(true);
    // A person with the permission delegated to them, one by one, can too.
    await override(w.staff3.id, "agency.messages.channels", "allow");
    expect((await createChannel(w.staff3, { name: channelName(), visibility: "staff" })).created).toBe(true);
    await clearOverride(w.staff3.id, "agency.messages.channels");
    expect((await refused(createChannel(w.staff3, { name: channelName(), visibility: "staff" })))?.code).toBe("forbidden");
  });

  it("refuse a bad name, a bad visibility and a name already in use (whatever the case), and free the name when archived", async () => {
    const name = channelName("dup");
    const a = await createChannel(w.manager, { name, visibility: "staff" });
    expect((await refused(createChannel(w.superAdmin, { name: name.toUpperCase(), visibility: "private" })))?.code).toBe("conflict");
    expect((await refused(createChannel(w.manager, { name: "bad/name", visibility: "staff" })))?.code).toBe("invalid_input");
    expect((await refused(createChannel(w.manager, { name: channelName(), visibility: "everyone" })))?.code).toBe("invalid_input");
    await setArchived(w.manager, a.id, true);
    const b = await createChannel(w.superAdmin, { name, visibility: "staff" });
    expect(b.id).not.toBe(a.id);
    // Bringing the old one back would now collide with the new one.
    expect((await refused(setArchived(w.manager, a.id, false)))?.code).toBe("conflict");
  });

  it("tell invited people they were added, and give invited people mentions-only notices by default", async () => {
    const c = await createChannel(w.manager, { name: channelName(), visibility: "private", memberIds: [w.staff.id, w.staff2.id] });
    expect((await members(c.id)).map((m) => m.notify)).toEqual(["mentions", "mentions", "mentions"]);
    expect((await noticesFor(w.staff.id, "staff_message_added"))[0].body).toMatch(/added you to #/);
  });

  it("can be joined by anyone who may use Messages when open, and by no one when private", async () => {
    const open = await createChannel(w.manager, { name: channelName(), visibility: "staff" });
    const priv = await createChannel(w.manager, { name: channelName(), visibility: "private" });
    await joinChannel(w.staff, open.id);
    await joinChannel(w.staff, open.id);
    expect((await members(open.id)).filter((m) => m.user_id === w.staff.id)).toHaveLength(1);
    expect((await members(open.id)).find((m) => m.user_id === w.staff.id)).toMatchObject({ role: "member", notify: "mentions" });
    expect((await refused(joinChannel(w.staff, priv.id)))?.code).toBe("not_found");
    expect((await refused(joinChannel(w.superAdmin, priv.id)))?.code).toBe("not_found");
    await leaveConversation(w.staff, open.id);
    expect((await members(open.id)).find((m) => m.user_id === w.staff.id)?.left).toBe(true);
    await joinChannel(w.staff, open.id);
    expect((await members(open.id)).find((m) => m.user_id === w.staff.id)?.left).toBe(false);
    const denied = await staffPerson("agency_staff");
    await override(denied.id, "agency.messages.use", "deny");
    expect((await refused(joinChannel(denied, open.id)))?.code).toBe("forbidden");
  });

  it("are run by the channels permission when open, and only by their owners when private", async () => {
    const open = await createChannel(w.manager, { name: channelName(), visibility: "staff" });
    const priv = await createChannel(w.manager, { name: channelName(), visibility: "private", memberIds: [w.staff.id] });
    // Another manager (not a member) runs the open channel.
    const other = await staffPerson("agency_manager");
    await addMembers(other, open.id, [w.staff2.id]);
    await updateConversation(other, open.id, { topic: "Run by another manager" });
    expect((await members(open.id)).some((m) => m.user_id === w.staff2.id)).toBe(true);
    // But not the private channel: it does not even exist for them.
    expect((await refused(addMembers(other, priv.id, [w.staff2.id])))?.code).toBe("not_found");
    expect((await refused(updateConversation(other, priv.id, { topic: "x" })))?.code).toBe("not_found");
    // A member who is not the owner can't change it.
    expect((await refused(addMembers(w.staff, priv.id, [w.staff2.id])))?.code).toBe("forbidden");
  });

  it("can be archived without reading them: by the owner, by the channels permission and by a moderator, even a private one the person is not in", async () => {
    const priv = await createChannel(w.manager, { name: channelName(), visibility: "private", memberIds: [w.staff.id] });
    await sendMessage(w.manager, { conversationId: priv.id, clientMessageId: freshId(), body: "Secret plans" });
    const otherManager = await staffPerson("agency_manager");
    await setArchived(otherManager, priv.id, true);
    expect((await rows("select 1 from staff_conversations where id = $1 and archived_at is not null", [priv.id])).length).toBe(1);
    // Archiving gave the other manager no way to read it.
    expect((await refused(getConversation(otherManager, priv.id)))?.code).toBe("not_found");
    await setArchived(w.superAdmin, priv.id, false);
    expect((await events(priv.id)).map((e) => e.kind).slice(-2)).toEqual(["archived", "unarchived"]);
    // Staff, who are members but not owners, may not.
    expect((await refused(setArchived(w.staff, priv.id, true)))?.code).toBe("forbidden");
    // Doing it again to the same state is quiet.
    const before = (await events(priv.id)).length;
    await setArchived(w.superAdmin, priv.id, false);
    expect((await events(priv.id)).length).toBe(before);
  });

  it("are listed for the whole team, joined or not, without their messages, and private ones are not listed", async () => {
    const open = await createChannel(w.manager, { name: channelName("dir"), topic: "Visible", visibility: "staff" });
    const priv = await createChannel(w.manager, { name: channelName("dir"), visibility: "private" });
    const archivedOne = await createChannel(w.manager, { name: channelName("dir"), visibility: "staff" });
    await setArchived(w.manager, archivedOne.id, true);
    await joinChannel(w.staff, open.id);
    const forStaff = await channelDirectory(w.staff);
    expect(forStaff.find((c) => c.id === open.id)).toMatchObject({ topic: "Visible", memberCount: 2, joined: true });
    expect((await channelDirectory(w.staff2)).find((c) => c.id === open.id)).toMatchObject({ joined: false, memberCount: 2 });
    for (const who of [w.staff, w.superAdmin]) {
      const ids = (await channelDirectory(who)).map((c) => c.id);
      expect(ids).not.toContain(priv.id);
      expect(ids).not.toContain(archivedOne.id);
    }
    // Previewing an open channel one has not joined shows the head count and what one may do, not the people or the messages.
    const preview = await getConversation(w.staff2, open.id);
    expect(preview.members).toBeNull();
    expect(preview.memberCount).toBe(2);
    expect(preview.can).toMatchObject({ join: true, post: false, leave: false });
  });
});

describe("the person's own conversations", () => {
  it("are listed newest activity first, a direct message by the other person's name, with what is unread", async () => {
    const dm = await createDirect(w.staff, w.staff2.id);
    const g = await createGroup(w.staff2, { name: "Standup", memberIds: [w.staff.id] });
    await sendMessage(w.staff2, { conversationId: dm.id, clientMessageId: freshId(), body: "Ping" });
    await sendMessage(w.staff2, { conversationId: dm.id, clientMessageId: freshId(), body: "Pong" });
    await sendMessage(w.staff2, { conversationId: g.id, clientMessageId: freshId(), body: "Morning" });
    const list = await listConversations(w.staff);
    expect(list.map((c) => c.id)).toEqual([g.id, dm.id]);
    expect(list[1]).toMatchObject({ kind: "direct", name: w.staff2.name, unread: 2, lastSeq: 2, lastReadSeq: 0, peer: { id: w.staff2.id, former: false } });
    expect(list[0]).toMatchObject({ kind: "group", name: "Standup", unread: 1, memberCount: 2 });
    // The sender has nothing unread in what they wrote.
    expect((await listConversations(w.staff2)).every((c) => c.unread === 0)).toBe(true);
    // A person with no conversations has an empty list; a stranger sees none of these.
    expect(await listConversations(w.staff3)).toEqual([]);
  });

  it("show a former colleague as 'Former team member' and no name", async () => {
    const dm = await createDirect(w.staff, w.staff3.id);
    await disable(w.staff3.id);
    const [item] = (await listConversations(w.staff)).filter((c) => c.id === dm.id);
    expect(item.name).toBe("Former team member");
    expect(item.peer).toMatchObject({ former: true, name: "Former team member" });
    expect(JSON.stringify(item)).not.toContain(w.staff3.name);
  });

  it("let the person mute a conversation and choose what to hear about, for themselves only", async () => {
    const g = await createGroup(w.staff, { name: "Loud", memberIds: [w.staff2.id] });
    await setPreferences(w.staff2, g.id, { muted: true, notify: "mentions" });
    expect((await members(g.id)).find((m) => m.user_id === w.staff2.id)).toMatchObject({ notify: "mentions" });
    expect((await listConversations(w.staff2))[0]).toMatchObject({ muted: true, notify: "mentions" });
    expect((await listConversations(w.staff))[0]).toMatchObject({ muted: false, notify: "all" });
    expect((await refused(setPreferences(w.staff2, g.id, { notify: "sometimes" })))?.code).toBe("invalid_input");
    expect((await refused(setPreferences(w.staff2, g.id, { muted: "yes" })))?.code).toBe("invalid_input");
    expect((await refused(setPreferences(w.staff3, g.id, { muted: true })))?.code).toBe("not_found");
  });

  it("explain what a person may do in a conversation", async () => {
    const g = await createGroup(w.staff, { name: "Flags", memberIds: [w.staff2.id] });
    expect((await getConversation(w.staff, g.id)).can).toEqual({ post: true, join: false, leave: true, manageMembers: true, rename: true, archive: true });
    expect((await getConversation(w.staff2, g.id)).can).toEqual({ post: true, join: false, leave: true, manageMembers: false, rename: false, archive: false });
    const view = await getConversation(w.staff2, g.id);
    expect(view.members?.map((m) => [m.name, m.role])).toEqual([[w.staff.name, "owner"], [w.staff2.name, "member"]]);
    expect(JSON.stringify(view)).not.toContain("@example.test");
    await setArchived(w.staff, g.id, true);
    expect((await getConversation(w.staff, g.id)).can).toMatchObject({ post: false, manageMembers: false, archive: true });
  });
});

describe("the people picker", () => {
  it("lists active agency accounts that may use Messages, with a name and a role and nothing else", async () => {
    const denied = await staffPerson("agency_staff");
    await override(denied.id, "agency.messages.use", "deny");
    const gone = await staffPerson("agency_manager");
    await disable(gone.id);
    const client = await staffPerson("none");
    const list = await listStaffDirectory(w.staff);
    const ids = list.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([w.staff.id, w.staff2.id, w.manager.id, w.superAdmin.id]));
    for (const excluded of [denied.id, gone.id, client.id]) expect(ids).not.toContain(excluded);
    expect(list.find((p) => p.id === w.staff.id)).toEqual({ id: w.staff.id, name: w.staff.name, role: "agency_staff", self: true });
    expect(list.find((p) => p.id === w.manager.id)).toMatchObject({ role: "agency_manager", self: false });
    expect(Object.keys(list[0]).sort()).toEqual(["id", "name", "role", "self"]);
    expect(JSON.stringify(list)).not.toContain("@example.test");
  });
});

describe("while the module is off", () => {
  it("refuses everything with a plain reason, and keeps what was there", async () => {
    const g = await createGroup(w.staff, { name: "Dormant", memberIds: [w.staff2.id] });
    await setMessages(false);
    for (const call of [() => listConversations(w.staff), () => createDirect(w.staff, w.staff2.id), () => getConversation(w.staff, g.id), () => channelDirectory(w.manager)]) {
      expect(await refused(call())).toMatchObject({ code: "not_enabled" });
    }
    await setMessages(null);
    expect((await refused(listConversations(w.staff)))?.code).toBe("not_enabled");
    await setMessages(true);
    expect((await listConversations(w.staff)).map((c) => c.id)).toContain(g.id);
  });

  it("is refused to a person whose session no longer matches their account: demoted, disabled, or a client", async () => {
    const person = await staffPerson("agency_staff");
    expect((await listConversations(person)).length).toBe(0);
    await withSystem((db) => db.query("update users set platform_role = 'agency_manager' where id = $1", [person.id]));
    expect((await refused(listConversations(person)))?.code).toBe("forbidden");
    await withSystem((db) => db.query("update users set platform_role = 'agency_staff' where id = $1", [person.id]));
    expect((await listConversations(person)).length).toBe(0);
    await disable(person.id);
    expect((await refused(listConversations(person)))?.code).toBe("forbidden");
    expect((await refused(listConversations({ id: "x", platformRole: "agency_staff" })))?.code).toBe("forbidden");
    const client: Person = { ...(await staffPerson("none")), platformRole: "agency_staff" };
    expect((await refused(listConversations(client)))?.code).toBe("forbidden");
  });
});
