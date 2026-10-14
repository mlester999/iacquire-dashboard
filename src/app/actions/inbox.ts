"use server";

import { revalidatePath } from "next/cache";
import { actionError, AppError } from "@/server/errors";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { addInternalNote, approveDraft, discardDraft, markConversationRead, sendHumanReply, setChannelEnabled, setConversationState, updateMessagingSettings, type MessagingSettingsInput } from "@/server/messaging/inbox";
import { assignConversation, claimEscalation, declineEscalation, resolveEscalation, resumeAi, takeOverConversation } from "@/server/messaging/handoff";
import { addMemory, deleteMemory, recordConsent } from "@/server/messaging/contacts";
import { dispatchMessage } from "@/server/messaging/send";
import { setAvailability, setEscalationAuthorization, setNotificationPreferences, setOwnerPriorityMode, type NotificationPreferenceInput } from "@/server/staff/service";
import { isChannel } from "@/lib/messaging";
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
    const ctx = await requireOrgContextOrThrow("inbox.reply");
    const limit = await consumeRateLimit(RATE_LIMITS.inboxSendByUser, ctx.user.id);
    if (!limit.allowed) throw new AppError("rate_limited", "You are sending quickly. Please wait a moment.", { retryAfterSeconds: limit.retryAfterSeconds });
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
    const ctx = await requireOrgContextOrThrow("inbox.assign");
    await assignConversation(ctx, id(conversationId, "conversation"), userId ? id(userId, "teammate") : null);
    refresh();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function setConversationStateAction(conversationId: string, input: { status?: string; priority?: string }) {
  try {
    const ctx = await requireOrgContextOrThrow("inbox.reply");
    const status = input.status === "open" || input.status === "closed" ? input.status : undefined;
    const priority = ["low", "normal", "high", "urgent"].includes(input.priority ?? "") ? (input.priority as "low" | "normal" | "high" | "urgent") : undefined;
    await setConversationState(ctx, id(conversationId, "conversation"), { status, priority });
    refresh();
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function markReadAction(conversationId: string) {
  try {
    const ctx = await requireOrgContextOrThrow("inbox.view");
    await markConversationRead(ctx, id(conversationId, "conversation"));
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function addMemoryAction(contactId: string, kind: string, content: string) {
  try {
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
