"use server";

import { revalidatePath } from "next/cache";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { deleteConversation, getConversation, listConversations, renameConversation } from "@/server/chat/service";
import { getAgentByRole, createConfigVersion, currentSettings } from "@/server/workforce/service";
import { withSystem } from "@/server/db";
import { actionError, AppError } from "@/server/errors";
import { AGENT_BY_KEY, isAgentRoleKey } from "@/lib/agents";
import { REPLY_LENGTHS, type ReplyLength } from "@/lib/agent-settings";

export async function searchConversationsAction(role: string, query: string) {
  try {
    const ctx = await requireOrgContextOrThrow("agents.use");
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
    const ctx = await requireOrgContextOrThrow("agents.use");
    const data = await getConversation(ctx, conversationId);
    if (!data) throw new AppError("not_found", "Conversation not found.");
    return {
      ok: true as const,
      data: {
        id: data.conversation.id,
        title: data.conversation.title,
        messages: data.messages.map((m) => ({ ...m, created_at: new Date(m.created_at).toISOString() })),
      },
    };
  } catch (err) {
    return actionError(err);
  }
}

export async function renameConversationAction(conversationId: string, title: string) {
  try {
    const ctx = await requireOrgContextOrThrow("agents.use");
    await renameConversation(ctx, conversationId, title);
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function deleteConversationAction(conversationId: string) {
  try {
    const ctx = await requireOrgContextOrThrow("agents.use");
    await deleteConversation(ctx, conversationId);
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

/** Quick reply-length preference from the chat header. Creates and applies a new config version. */
export async function setReplyLengthAction(role: string, length: string) {
  try {
    const ctx = await requireOrgContextOrThrow("agents.configure");
    if (!isAgentRoleKey(role) || !REPLY_LENGTHS.includes(length as ReplyLength)) throw new AppError("invalid_input", "Unknown option.");
    const agent = await getAgentByRole(ctx.user.id, ctx.org.orgId, role);
    if (!agent) throw new AppError("not_found", "Unknown employee.");
    const result = await withSystem(async (db) => {
      const { settings } = await currentSettings(db, agent.id, ctx.org.orgId);
      if (settings.replyLength === length) return null;
      return createConfigVersion(db, {
        orgId: ctx.org.orgId,
        agentId: agent.id,
        settings: { ...settings, replyLength: length as ReplyLength },
        source: "client_edit",
        changeRequest: `Reply length set to ${length}`,
        userId: ctx.user.id,
        apply: true,
      });
    });
    revalidatePath(`/chat/${AGENT_BY_KEY[role].slug}`);
    return { ok: true as const, data: { version: result?.version ?? null } };
  } catch (err) {
    return actionError(err);
  }
}
