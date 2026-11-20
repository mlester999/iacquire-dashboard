"use server";

import { getGrowthPartnerConversationPage, searchGrowthPartnerConversation } from "@/server/ai-growth-partner/service";
import { actionError, AppError } from "@/server/errors";
import { requireOrgContext } from "@/server/tenancy/context";
import { z } from "zod";

const cursorSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
}).strict();
const beforeSchema = z.union([z.string().datetime({ offset: true }), cursorSchema]);

function serializeCursor(cursor: { createdAt: Date | string; id: string } | null) {
  if (!cursor) return null;
  return {
    id: cursor.id,
    createdAt: cursor.createdAt instanceof Date ? cursor.createdAt.toISOString() : new Date(cursor.createdAt).toISOString(),
  };
}

function requireClientWorkspace(kind: string) {
  if (kind !== "client") throw new AppError("forbidden", "The AI Growth Partner is available in client workspaces.");
}

export async function refreshGrowthPartnerConversationAction() {
  try {
    const ctx = await requireOrgContext();
    requireClientWorkspace(ctx.org.kind);
    const data = await getGrowthPartnerConversationPage(ctx);
    if (!data) throw new AppError("not_found", "The permanent AI Growth Partner conversation is not connected.");
    return {
      ok: true as const,
      data: {
        conversation: {
          ...data.conversation,
          lastMessageAt: data.conversation.lastMessageAt?.toISOString() ?? null,
          createdAt: data.conversation.createdAt.toISOString(),
        },
        messages: data.messages.map((message) => ({ ...message, createdAt: message.createdAt.toISOString() })),
        hasMore: data.hasMore,
        nextCursor: serializeCursor(data.nextCursor),
      },
    };
  } catch (err) {
    return actionError(err);
  }
}

export async function loadOlderGrowthPartnerMessagesAction(before: string | { createdAt: string; id: string }) {
  try {
    const ctx = await requireOrgContext();
    requireClientWorkspace(ctx.org.kind);
    const parsedBefore = beforeSchema.safeParse(before);
    if (!parsedBefore.success) {
      throw new AppError("invalid_input", "That message page is invalid.");
    }
    const cursor = typeof parsedBefore.data === "string"
      ? new Date(parsedBefore.data)
      : { createdAt: parsedBefore.data.createdAt, id: parsedBefore.data.id };
    const data = await getGrowthPartnerConversationPage(ctx, cursor);
    if (!data) throw new AppError("not_found", "The permanent AI Growth Partner conversation is not connected.");
    return {
      ok: true as const,
      data: {
        messages: data.messages.map((message) => ({ ...message, createdAt: message.createdAt.toISOString() })),
        hasMore: data.hasMore,
        nextCursor: serializeCursor(data.nextCursor),
      },
    };
  } catch (err) {
    return actionError(err);
  }
}

export async function searchGrowthPartnerConversationAction(query: string) {
  try {
    const ctx = await requireOrgContext();
    requireClientWorkspace(ctx.org.kind);
    if (typeof query !== "string") throw new AppError("invalid_input", "Enter text to search the conversation.");
    const rows = await searchGrowthPartnerConversation(ctx, query);
    return {
      ok: true as const,
      data: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    };
  } catch (err) {
    return actionError(err);
  }
}
