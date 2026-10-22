import type { ConversationInsights, SuggestedReply } from "@/server/messaging/inbox-ai";

// The browser side of AI help in the inbox. A plain POST to a route (not a server action: a model call takes seconds and server actions queue
// behind each other, so this must not make Send wait). It only ever returns text for a person to read.

export type AssistResult<T> = { ok: true; data: T } | { ok: false; reason: string };

async function post<T>(conversationId: string, kind: "insights" | "reply", signal?: AbortSignal): Promise<AssistResult<T>> {
  try {
    const res = await fetch(`/api/inbox/conversations/${conversationId}/assist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    const body = (await res.json().catch(() => null)) as ({ ok?: boolean; data?: T; reason?: string; error?: string } | null);
    if (!body) return { ok: false, reason: "The AI service didn't answer. Try again in a moment." };
    if (!res.ok) return { ok: false, reason: body.error ?? "That didn't work." };
    if (body.ok === true && body.data) return { ok: true, data: body.data };
    return { ok: false, reason: body.reason ?? "The AI service couldn't answer just now." };
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") return { ok: false, reason: "Cancelled." };
    return { ok: false, reason: "The AI service couldn't be reached. Try again in a moment." };
  }
}

export const requestInsights = (conversationId: string, signal?: AbortSignal) => post<ConversationInsights>(conversationId, "insights", signal);
export const requestSuggestedReply = (conversationId: string, signal?: AbortSignal) => post<SuggestedReply>(conversationId, "reply", signal);
