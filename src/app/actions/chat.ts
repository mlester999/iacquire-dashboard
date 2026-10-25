"use server";

import { revalidatePath } from "next/cache";
import { requireWorkforceContextOrThrow } from "@/server/workforce/workspace-access";
import { deleteConversation, getConversation, listConversations, renameConversation } from "@/server/chat/service";
import { getAgentByRole, createConfigVersion, editableSettings } from "@/server/workforce/service";
import { withSystem } from "@/server/db";
import { actionError, AppError } from "@/server/errors";
import { AGENT_BY_KEY, isAgentRoleKey } from "@/lib/agents";
import { REPLY_LENGTHS, type ReplyLength } from "@/lib/agent-settings";
import { configAttribution } from "@/lib/config-review";

export async function searchConversationsAction(role: string, query: string) {
  try {
    const ctx = await requireWorkforceContextOrThrow("agents.use");
    if (!isAgentRoleKey(role)) throw new AppError("not_found", "Unknown employee.");
    const agent = await getAgentByRole(ctx.user.id, ctx.org.orgId, role);
    if (!agent) throw new AppError("not_found", "Unknown employee.");
    const rows = await listConversations(ctx, agent.id, query);
    return { ok: true as const, data: rows.map((r) => ({ id: r.id, title: r.title, lastMessageAt: (r.last_message_at ?? r.created_at).toISOString() })) };
  } catch (err) {
    return actionError(err);
  }
}

export async function loadConversationAction(conversationId: string) {
  try {
    const ctx = await requireWorkforceContextOrThrow("agents.use");
    const data = await getConversation(ctx, conversationId);
    if (!data) throw new AppError("not_found", "Conversation not found.");
    return {
      ok: true as const,
      data: {
        id: data.conversation.id,
        title: data.conversation.title,
        messages: data.messages.map((m) => ({ ...m, created_at: new Date(m.created_at).toISOString() })),
        hasMore: data.hasMore,
      },
    };
  } catch (err) {
    return actionError(err);
  }
}

/** Loads one older page of a conversation the signed-in user is allowed to read. */
export async function loadOlderMessagesAction(conversationId: string, before: string) {
  try {
    const ctx = await requireWorkforceContextOrThrow("agents.use");
    if (!/^\d{4}-\d{2}-\d{2}T/.test(before) || Number.isNaN(Date.parse(before))) throw new AppError("invalid_input", "That message page is invalid.");
    const data = await getConversation(ctx, conversationId, before);
    if (!data) throw new AppError("not_found", "Conversation not found.");
    return {
      ok: true as const,
      data: {
        messages: data.messages.map((m) => ({ ...m, created_at: new Date(m.created_at).toISOString() })),
        hasMore: data.hasMore,
      },
    };
  } catch (err) {
    return actionError(err);
  }
}

export async function renameConversationAction(conversationId: string, title: string) {
  try {
    const ctx = await requireWorkforceContextOrThrow("agents.use");
    await renameConversation(ctx, conversationId, title);
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function deleteConversationAction(conversationId: string) {
  try {
    const ctx = await requireWorkforceContextOrThrow("agents.use");
    await deleteConversation(ctx, conversationId);
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

/** Quick reply-length preference from the chat header. Creates and applies a new config version. */
export async function setReplyLengthAction(role: string, length: string) {
  try {
    const ctx = await requireWorkforceContextOrThrow("agents.configure");
    if (!isAgentRoleKey(role) || !REPLY_LENGTHS.includes(length as ReplyLength)) throw new AppError("invalid_input", "Unknown option.");
    const agent = await getAgentByRole(ctx.user.id, ctx.org.orgId, role);
    if (!agent) throw new AppError("not_found", "Unknown employee.");
    const result = await withSystem(async (db) => {
      // Use the draft-aware settings so a quick preference change cannot silently discard a version
      // that is already waiting for review. If that draft contains sensitive changes, the new
      // version is held as a whole instead of auto-applying a partial replacement.
      const { settings } = await editableSettings(db, agent.id, ctx.org.orgId);
      if (settings.replyLength === length) return null;
      const attribution = configAttribution({ orgKind: ctx.org.kind, platformRole: ctx.user.platformRole });
      return createConfigVersion(db, {
        orgId: ctx.org.orgId,
        agentId: agent.id,
        settings: { ...settings, replyLength: length as ReplyLength },
        source: attribution.source,
        actorKind: attribution.actorKind,
        changeRequest: `Reply length set to ${length}`,
        userId: ctx.user.id,
        apply: true,
      });
    });
    revalidatePath(`/chat/${AGENT_BY_KEY[role].slug}`);
    revalidatePath(`/employees/${AGENT_BY_KEY[role].slug}`);
    return { ok: true as const, data: { version: result?.version ?? null, status: result?.status ?? null } };
  } catch (err) {
    return actionError(err);
  }
}
