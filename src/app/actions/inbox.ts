"use server";

import { revalidatePath } from "next/cache";
import { actionError, AppError } from "@/server/errors";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { assertInboxEnabled } from "@/server/messaging/inbox-switch";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { addInternalNote, approveDraft, bulkUpdateConversations, discardDraft, getMessagesByIds, getOlderMessages, markConversationRead, markConversationUnread, retryFailedMessage, sendHumanReply, setChannelEnabled, setConversationState, updateMessagingSettings, withDeliveryDetail, type BulkAction, type MessagingSettingsInput } from "@/server/messaging/inbox";
import { assignAiEmployee, pauseAi, transferConversation } from "@/server/messaging/ai-control";
import { addContactNoteFromConversation, createDealFromConversation, createTaskFromConversation, setLeadStatusFromConversation } from "@/server/messaging/inbox-context";
import { assignConversation, claimEscalation, declineEscalation, resolveEscalation, resumeAi, takeOverConversation } from "@/server/messaging/handoff";
import { addMemory, deleteMemory, recordConsent } from "@/server/messaging/contacts";
import { dispatchMessage } from "@/server/messaging/send";
import { setAvailability, setEscalationAuthorization, setNotificationPreferences, setOwnerPriorityMode, type NotificationPreferenceInput } from "@/server/staff/service";
import { isChannel } from "@/lib/messaging";
import { isConversationOutcome } from "@/lib/inbox";
import { extractTokens } from "@/lib/messaging/tokens";
import { withSystem } from "@/server/db";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: string, what = "item") => {
  if (!uuid.test(value)) throw new AppError("invalid_input", `Choose a valid ${what}.`);
  return value;
};
const refresh = () => {
  revalidatePath("/inbox");
  revalidatePath("/overview");
};

/** Sends right after queuing so the person sees a real outcome; anything that cannot go is shown with its reason. */
async function sendNow(messageId: string) {
  try {
    return (await dispatchMessage(messageId)).status;
  } catch {
    return "queued" as const;
  }
}

export async function sendReplyAction(conversationId: string, body: string, templateId?: string | null) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("inbox.reply");
    const limit = await consumeRateLimit(RATE_LIMITS.inboxSendByUser, ctx.user.id);
    if (!limit.allowed) throw new AppError("rate_limited", "You are sending quickly. Please wait a moment.", { retryAfterSeconds: limit.retryAfterSeconds });
    // A token such as {{contact.first_name}} is only ever filled when a canned reply is inserted; one left in the text would reach the
    // customer exactly as typed, so the reply is refused until it is replaced.
    const leftover = extractTokens(body ?? "").find((t) => t.known);
    if (leftover) throw new AppError("invalid_input", `Replace ${leftover.raw} with the real details before sending.`);
    const queued = await sendHumanReply(ctx, id(conversationId, "conversation"), body, { templateId: templateId ?? null });
    const status = await sendNow(queued.messageId);
    refresh();
    return { ok: true as const, data: { messageId: queued.messageId, status } };
  } catch (err) {
    return actionError(err);
  }
}

export async function takeOverAction(conversationId: string) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("inbox.reply");
    await takeOverConversation(ctx, id(conversationId, "conversation"));
    refresh();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function resumeAiAction(conversationId: string) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("inbox.resume_ai");
    await resumeAi(ctx, id(conversationId, "conversation"));
    refresh();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function addNoteAction(conversationId: string, body: string) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("inbox.notes");
    await addInternalNote(ctx, id(conversationId, "conversation"), body);
    refresh();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function approveDraftAction(messageId: string) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("inbox.reply");
    await approveDraft(ctx, id(messageId, "message"));
    const status = await sendNow(messageId);
    refresh();
    revalidatePath("/approvals");
    return { ok: true as const, data: { status } };
  } catch (err) {
    return actionError(err);
  }
}

export async function discardDraftAction(messageId: string) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("inbox.reply");
    await discardDraft(ctx, id(messageId, "message"));
    refresh();
    revalidatePath("/approvals");
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function claimEscalationAction(escalationId: string) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("escalations.respond");
    const out = await claimEscalation(ctx, id(escalationId, "escalation"));
    refresh();
    return { ok: true as const, data: { conversationId: out.conversationId } };
  } catch (err) {
    return actionError(err);
  }
}

export async function declineEscalationAction(escalationId: string) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("escalations.respond");
    await declineEscalation(ctx, id(escalationId, "escalation"));
    refresh();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function resolveEscalationAction(escalationId: string, resolution: string) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("escalations.respond");
    await resolveEscalation(ctx, id(escalationId, "escalation"), resolution ?? "");
    refresh();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function assignConversationAction(conversationId: string, userId: string | null) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("inbox.assign");
    await assignConversation(ctx, id(conversationId, "conversation"), userId ? id(userId, "teammate") : null);
    refresh();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function setConversationStateAction(conversationId: string, input: { status?: string; priority?: string; outcome?: string | null; archived?: boolean; seenInboundAt?: string | null }) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("inbox.reply");
    const status = input.status === "open" || input.status === "closed" ? input.status : undefined;
    const priority = ["low", "normal", "high", "urgent"].includes(input.priority ?? "") ? (input.priority as "low" | "normal" | "high" | "urgent") : undefined;
    const outcome = input.outcome == null ? undefined : isConversationOutcome(input.outcome) ? input.outcome : undefined;
    if (input.outcome != null && !outcome) throw new AppError("invalid_input", "Choose how this ended.");
    await setConversationState(ctx, id(conversationId, "conversation"), { status, priority, outcome, archived: typeof input.archived === "boolean" ? input.archived : undefined, seenInboundAt: input.seenInboundAt ?? null });
    refresh();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

/** Stops AI replies on a conversation without handing it to a person. Lifting the pause is resumeAiAction. */
export async function pauseAiAction(conversationId: string, reason?: string) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("inbox.reply");
    await pauseAi(ctx, id(conversationId, "conversation"), reason);
    refresh();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function assignAiEmployeeAction(conversationId: string, agentId: string) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("inbox.assign");
    const out = await assignAiEmployee(ctx, id(conversationId, "conversation"), id(agentId, "AI employee"));
    refresh();
    return { ok: true as const, data: out };
  } catch (err) {
    return actionError(err);
  }
}

export async function transferConversationAction(conversationId: string, userId: string) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("inbox.reply");
    await transferConversation(ctx, id(conversationId, "conversation"), id(userId, "teammate"));
    refresh();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

/** Sends a failed message again (see retryFailedMessage). Goes through the same send path and limits as a typed reply. */
export async function retryMessageAction(messageId: string, acknowledgeUnconfirmed = false) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("inbox.reply");
    const limit = await consumeRateLimit(RATE_LIMITS.inboxSendByUser, ctx.user.id);
    if (!limit.allowed) throw new AppError("rate_limited", "You are sending quickly. Please wait a moment.", { retryAfterSeconds: limit.retryAfterSeconds });
    const queued = await retryFailedMessage(ctx, id(messageId, "message"), { acknowledgeUnconfirmed: acknowledgeUnconfirmed === true });
    const status = await sendNow(queued.messageId);
    refresh();
    return { ok: true as const, data: { messageId: queued.messageId, status } };
  } catch (err) {
    return actionError(err);
  }
}

export async function markUnreadAction(conversationId: string) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("inbox.view");
    await markConversationUnread(ctx, id(conversationId, "conversation"));
    refresh();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

/** One safe action on up to 50 conversations. There is no bulk send. Each conversation is checked on its own; refusals are reported by reason. */
export async function bulkConversationsAction(conversationIds: string[], action: { kind: string; outcome?: string | null; priority?: string; userId?: string | null }) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("inbox.view");
    const limit = await consumeRateLimit(RATE_LIMITS.inboxBulkByUser, ctx.user.id);
    if (!limit.allowed) throw new AppError("rate_limited", "You are doing that quickly. Please wait a moment.", { retryAfterSeconds: limit.retryAfterSeconds });
    if (!Array.isArray(conversationIds)) throw new AppError("invalid_input", "Choose at least one conversation.");
    let parsed: BulkAction;
    switch (action.kind) {
      case "mark_read":
      case "mark_unread":
      case "reopen":
      case "archive":
      case "unarchive":
        parsed = { kind: action.kind };
        break;
      case "resolve":
        if (action.outcome != null && !isConversationOutcome(action.outcome)) throw new AppError("invalid_input", "Choose how this ended.");
        parsed = { kind: "resolve", outcome: action.outcome ?? null };
        break;
      case "priority":
        if (!["low", "normal", "high", "urgent"].includes(action.priority ?? "")) throw new AppError("invalid_input", "Choose a priority.");
        parsed = { kind: "priority", priority: action.priority as "low" | "normal" | "high" | "urgent" };
        break;
      case "assign":
        parsed = { kind: "assign", userId: action.userId ? id(action.userId, "teammate") : null };
        break;
      default:
        throw new AppError("invalid_input", "Choose an action.");
    }
    const out = await bulkUpdateConversations(ctx, conversationIds.map((c) => id(String(c), "conversation")), parsed);
    refresh();
    return { ok: true as const, data: out };
  } catch (err) {
    return actionError(err);
  }
}

export async function createTaskFromConversationAction(conversationId: string, input: { title: string; dueAt?: string | null; priority?: string; assigneeId?: string | null }) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("inbox.view");
    const priority = ["low", "normal", "high", "urgent"].includes(input.priority ?? "") ? (input.priority as "low" | "normal" | "high" | "urgent") : "normal";
    const out = await createTaskFromConversation(ctx, id(conversationId, "conversation"), { title: String(input.title ?? ""), dueAt: input.dueAt ?? null, priority, assigneeId: input.assigneeId ? id(input.assigneeId, "teammate") : null });
    refresh();
    return { ok: true as const, data: out };
  } catch (err) {
    return actionError(err);
  }
}

export async function createDealFromConversationAction(conversationId: string, input: { name?: string | null; value?: number | null } = {}) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("inbox.view");
    const value = typeof input.value === "number" && Number.isFinite(input.value) ? input.value : null;
    const out = await createDealFromConversation(ctx, id(conversationId, "conversation"), { name: input.name ?? null, value });
    refresh();
    return { ok: true as const, data: out };
  } catch (err) {
    return actionError(err);
  }
}

export async function addContactNoteFromConversationAction(conversationId: string, body: string) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("inbox.view");
    const out = await addContactNoteFromConversation(ctx, id(conversationId, "conversation"), String(body ?? ""));
    refresh();
    return { ok: true as const, data: out };
  } catch (err) {
    return actionError(err);
  }
}

export async function setLeadStatusAction(conversationId: string, leadStatus: string) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("inbox.view");
    await setLeadStatusFromConversation(ctx, id(conversationId, "conversation"), String(leadStatus ?? ""));
    refresh();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function markReadAction(conversationId: string) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("inbox.view");
    await markConversationRead(ctx, id(conversationId, "conversation"));
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

/**
 * "Load older messages": the page of the conversation just before the oldest message shown, oldest first, each with its provider and
 * delivery events, under the same visibility as opening the conversation. Read only.
 */
export async function loadOlderMessagesAction(conversationId: string, beforeId: string) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("inbox.view");
    const page = await getOlderMessages(ctx, id(conversationId, "conversation"), id(beforeId, "message"));
    return { ok: true as const, data: { messages: await withDeliveryDetail(ctx.user.id, page.messages), olderMessages: page.olderMessages ?? null } };
  } catch (err) {
    return actionError(err);
  }
}

/**
 * The current version of messages the thread loaded earlier with an older page, each with its provider and delivery events: re-read when a
 * draft among them stopped being one (approved or discarded), so it keeps its place with its real status. The same visibility as opening
 * the conversation. Read only.
 */
export async function loadMessagesByIdAction(conversationId: string, messageIds: string[]) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("inbox.view");
    if (!Array.isArray(messageIds)) throw new AppError("invalid_input", "Choose valid messages.");
    const messages = await getMessagesByIds(ctx, id(conversationId, "conversation"), messageIds.map((m) => id(String(m), "message")));
    return { ok: true as const, data: { messages: await withDeliveryDetail(ctx.user.id, messages) } };
  } catch (err) {
    return actionError(err);
  }
}

export async function addMemoryAction(contactId: string, kind: string, content: string) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("contacts.edit");
    if (kind !== "confirmed_fact" && kind !== "ai_summary") throw new AppError("invalid_input", "Choose a note type.");
    await addMemory(ctx, { contactId: id(contactId, "contact"), kind, content });
    refresh();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function deleteMemoryAction(memoryId: string) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("contacts.edit");
    await deleteMemory(ctx, id(memoryId, "note"));
    refresh();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

/** Records a consent decision a person collected outside the conversation (for example, a web form or a phone call). */
export async function recordConsentAction(contactId: string, channel: string, purpose: string, status: string, evidence: string) {
  try {
    assertInboxEnabled();
    const ctx = await requireOrgContextOrThrow("consent.manage");
    if (!isChannel(channel) || !["service", "marketing"].includes(purpose) || !["granted", "revoked"].includes(status)) throw new AppError("invalid_input", "Check the consent details.");
    if (evidence.trim().length < 5) throw new AppError("invalid_input", "Record how this consent was given or withdrawn.");
    await withSystem(async (db) => {
      const own = await db.query("select 1 from contacts where id = $1 and org_id = $2 and deleted_at is null", [id(contactId, "contact"), ctx.org.orgId]);
      if (!own.rows[0]) throw new AppError("not_found", "Contact not found.");
      await recordConsent(db, { orgId: ctx.org.orgId, contactId, channel, purpose: purpose as "service" | "marketing", status: status as "granted" | "revoked", source: "staff_recorded", evidence, recordedBy: ctx.user.id });
    });
    refresh();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function updateMessagingSettingsAction(input: MessagingSettingsInput) {
  try {
    const ctx = await requireOrgContextOrThrow("messaging.configure");
    await updateMessagingSettings(ctx, input);
    revalidatePath("/settings/messaging");
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function setChannelEnabledAction(channel: string, enabled: boolean) {
  try {
    const ctx = await requireOrgContextOrThrow("messaging.configure");
    if (!isChannel(channel)) throw new AppError("invalid_input", "Choose a channel.");
    await setChannelEnabled(ctx, channel, enabled === true);
    revalidatePath("/settings/messaging");
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function setAvailabilityAction(availability: string, note?: string, untilIso?: string | null) {
  try {
    const ctx = await requireOrgContextOrThrow("staff.availability");
    if (!["available", "busy", "away"].includes(availability)) throw new AppError("invalid_input", "Choose Available, Busy or Away.");
    await setAvailability(ctx, { availability: availability as "available" | "busy" | "away", note, until: untilIso ? new Date(untilIso) : null });
    revalidatePath("/settings/escalations");
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function setNotificationPreferencesAction(input: NotificationPreferenceInput) {
  try {
    const ctx = await requireOrgContextOrThrow("staff.availability");
    await setNotificationPreferences(ctx, { notifyEmail: input.notifyEmail === true, notifySms: input.notifySms === true, notifyWhatsapp: input.notifyWhatsapp === true, alertPhone: input.alertPhone, acknowledgeCosts: input.acknowledgeCosts === true });
    revalidatePath("/settings/escalations");
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function setOwnerPriorityModeAction(mode: string) {
  try {
    const ctx = await requireOrgContextOrThrow();
    await setOwnerPriorityMode(ctx, mode);
    revalidatePath("/settings/escalations");
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function setEscalationAuthorizationAction(userId: string, categories: string[], responsibilities?: string[]) {
  try {
    const ctx = await requireOrgContextOrThrow("escalations.configure");
    await setEscalationAuthorization(ctx, id(userId, "teammate"), { categories, responsibilities });
    revalidatePath("/settings/escalations");
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}
