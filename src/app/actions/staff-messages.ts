"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import type { StaffUser } from "@/server/staff-messages/access";
import { addMembers, channelDirectory, createChannel, createDirect, createGroup, joinChannel, leaveConversation, removeMember, setArchived, setPreferences, updateConversation } from "@/server/staff-messages/conversations";
import { deleteMessage, editMessage, sendMessage, setReaction } from "@/server/staff-messages/messages";
import { markRead } from "@/server/staff-messages/read";
import { searchMessages } from "@/server/staff-messages/search";
import { discardStaged } from "@/server/staff-messages/attachments";
import { listStaffDirectory } from "@/server/staff-messages/directory";
import { setRetentionDays, setStaffMessagesEnabled } from "@/server/staff-messages/settings";
import { MAX_BODY_CHARS, MAX_NAME_CHARS, MAX_TOPIC_CHARS } from "@/lib/staff-messages/limits";

// Server actions for staff Messages (/admin/messages). Each one starts from the signed-in agency account (requireAgencyOrThrow) and hands off to a service that re-reads that
// person's standing, the module switch and their place in the conversation from the database for this exact request, so an id forged in the browser reaches nothing the
// person could not reach from the screen. These parse the shape of the input (the services check every rule) and say nothing a person should not read.

const BAD = "Check what you entered and try again.";
const uuid = z.string({ error: BAD }).uuid({ error: "That item was not found." });
const ids = z.array(uuid).max(250, { error: BAD });
const text = (max: number) => z.string({ error: BAD }).max(max * 4, { error: BAD });

/** Signs the person in as an agency account, then runs the service. The input is parsed inside, so a malformed one is an answer, not a crash. */
async function act<T>(fn: (user: StaffUser) => Promise<T>) {
  return guard(async () => {
    const session = await requireAgencyOrThrow();
    return fn({ id: session.id, platformRole: session.platformRole });
  });
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const send = z.object({
  conversationId: uuid,
  clientMessageId: uuid,
  body: text(MAX_BODY_CHARS),
  threadRootId: uuid.nullable().optional(),
  attachmentIds: z.array(uuid).max(10, { error: BAD }).optional(),
});

/** Posts a message. `clientMessageId` is made by the browser for each message it composes, so a retry cannot post it twice. */
export async function sendMessageAction(input: z.input<typeof send>) {
  return act((user) => sendMessage(user, send.parse(input)));
}

const edit = z.object({ messageId: uuid, body: text(MAX_BODY_CHARS), expectedEditedAt: z.string({ error: BAD }).max(40).nullable().optional() });

/** `expectedEditedAt` is the edit stamp the editor opened with (null for a message never edited); a message edited since is refused, not overwritten. */
export async function editMessageAction(input: z.input<typeof edit>) {
  return act((user) => editMessage(user, edit.parse(input)));
}

export async function deleteMessageAction(messageId: string) {
  return act((user) => deleteMessage(user, uuid.parse(messageId)));
}

const react = z.object({ messageId: uuid, reaction: z.string({ error: BAD }).max(40), on: z.boolean({ error: BAD }) });

export async function reactAction(input: z.input<typeof react>) {
  return act((user) => setReaction(user, react.parse(input)));
}

const read = z.object({ conversationId: uuid, seq: z.number({ error: BAD }).int({ error: BAD }).min(0, { error: BAD }) });

/** Says the person has read a conversation up to a message number. Forward only: a late or repeated request changes nothing. */
export async function markReadAction(input: z.input<typeof read>) {
  return act((user) => {
    const v = read.parse(input);
    return markRead(user, v.conversationId, v.seq);
  });
}

const search = z.object({ query: text(100), conversationId: uuid.nullable().optional() });

export async function searchMessagesAction(input: z.input<typeof search>) {
  return act((user) => searchMessages(user, search.parse(input)));
}

export async function discardAttachmentAction(attachmentId: string) {
  return act((user) => discardStaged(user, uuid.parse(attachmentId)));
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export async function startDirectAction(userId: string) {
  return act((user) => createDirect(user, uuid.parse(userId)));
}

const group = z.object({ name: text(MAX_NAME_CHARS), memberIds: ids });

export async function startGroupAction(input: z.input<typeof group>) {
  return act((user) => createGroup(user, group.parse(input)));
}

const channel = z.object({
  name: text(MAX_NAME_CHARS),
  topic: text(MAX_TOPIC_CHARS).nullable().optional(),
  visibility: z.enum(["staff", "private"], { error: "Choose whether the channel is open to the team or private." }),
  memberIds: ids.optional(),
});

export async function startChannelAction(input: z.input<typeof channel>) {
  return act((user) => createChannel(user, channel.parse(input)));
}

export async function joinChannelAction(conversationId: string) {
  return act(async (user) => {
    await joinChannel(user, uuid.parse(conversationId));
  });
}

export async function leaveConversationAction(conversationId: string) {
  return act(async (user) => {
    await leaveConversation(user, uuid.parse(conversationId));
  });
}

const members = z.object({ conversationId: uuid, memberIds: ids });

export async function addMembersAction(input: z.input<typeof members>) {
  return act((user) => {
    const v = members.parse(input);
    return addMembers(user, v.conversationId, v.memberIds);
  });
}

const remove = z.object({ conversationId: uuid, memberId: uuid });

export async function removeMemberAction(input: z.input<typeof remove>) {
  return act(async (user) => {
    const v = remove.parse(input);
    await removeMember(user, v.conversationId, v.memberId);
  });
}

const rename = z.object({
  conversationId: uuid,
  name: text(MAX_NAME_CHARS).optional(),
  topic: text(MAX_TOPIC_CHARS).optional(),
  expectedName: z.string().max(400).nullable().optional(),
  expectedTopic: z.string().max(1200).nullable().optional(),
});

/** The expected values are what the form started from: if someone changed the name or topic meanwhile, nothing is saved and the person is told. */
export async function updateConversationAction(input: z.input<typeof rename>) {
  return act(async (user) => {
    const { conversationId, ...rest } = rename.parse(input);
    await updateConversation(user, conversationId, rest);
  });
}

const archive = z.object({ conversationId: uuid, archived: z.boolean({ error: BAD }) });

export async function archiveConversationAction(input: z.input<typeof archive>) {
  return act(async (user) => {
    const v = archive.parse(input);
    await setArchived(user, v.conversationId, v.archived);
  });
}

const prefs = z.object({ conversationId: uuid, muted: z.boolean({ error: BAD }).optional(), notify: z.enum(["all", "mentions", "none"], { error: BAD }).optional() });

export async function preferencesAction(input: z.input<typeof prefs>) {
  return act(async (user) => {
    const { conversationId, ...rest } = prefs.parse(input);
    await setPreferences(user, conversationId, rest);
  });
}

// ---------------------------------------------------------------------------
// Finding people and channels
// ---------------------------------------------------------------------------

/** The people who can be messaged or added: a name and a role each, never an address. */
export async function staffDirectoryAction() {
  return act((user) => listStaffDirectory(user));
}

/** The channels open to the whole team (names, topics and head counts; the messages stay with the members). */
export async function channelDirectoryAction() {
  return act((user) => channelDirectory(user));
}

// ---------------------------------------------------------------------------
// The Super Admin's settings
// ---------------------------------------------------------------------------

export async function setMessagesEnabledAction(enabled: boolean) {
  const result = await act(async (user) => {
    await setStaffMessagesEnabled(user, z.boolean().parse(enabled));
  });
  // The agency navigation reads the switch when it is built.
  if (result.ok) revalidatePath("/admin", "layout");
  return result;
}

/** A number of days, or null for none (nothing is ever deleted by age). The first clean-up after a period is set deletes older messages for good. */
export async function setRetentionAction(days: number | null) {
  const result = await act((user) => setRetentionDays(user, z.number({ error: BAD }).int({ error: BAD }).nullable().parse(days)));
  if (result.ok) revalidatePath("/admin/messages/settings");
  return result;
}
