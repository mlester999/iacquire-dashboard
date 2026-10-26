// Messages the page has composed and is sending, or could not send. A message keeps the id its browser made for it for as long as it is in this list, so trying again after a
// dropped connection cannot post it twice (the server answers a repeat with the message it already made). Pure.

import type { ErrorCode } from "@/server/errors";
import type { PendingMessage } from "@/lib/staff-messages/composer";

export type { PendingMessage };

export function addPending(list: readonly PendingMessage[], message: PendingMessage): PendingMessage[] {
  return list.some((p) => p.clientId === message.clientId) ? [...list] : [...list, message];
}

export function markSending(list: readonly PendingMessage[], clientId: string): PendingMessage[] {
  return list.map((p) => (p.clientId === clientId ? { ...p, status: "sending", error: null, errorCode: null } : p));
}

/** `code` is the server's code for a refusal, or null when no answer came back at all (a dropped connection), which is the case where trying again is safe and expected. */
export function markFailed(list: readonly PendingMessage[], clientId: string, error: string | null, code: string | null = null): PendingMessage[] {
  return list.map((p) => (p.clientId === clientId ? { ...p, status: "failed", error, errorCode: code } : p));
}

export const removePending = (list: readonly PendingMessage[], clientId: string): PendingMessage[] => list.filter((p) => p.clientId !== clientId);

/** The pending messages for the main view (`threadRootId` null) or for one thread, oldest first. */
export function pendingFor(list: readonly PendingMessage[], conversationId: string | null, threadRootId: string | null): PendingMessage[] {
  return list.filter((p) => p.conversationId === conversationId && p.threadRootId === threadRootId);
}

/** Whether trying the same send again could work. A refusal that says the person may not do it, or that the thing is gone, will not change by waiting. */
export function canRetry(code: ErrorCode | string | null | undefined): boolean {
  if (!code) return true;
  return !["forbidden", "not_found", "not_enabled", "unauthenticated", "invalid_input", "conflict"].includes(code);
}

/** The words under a message that was not sent. */
export function failureText(error: string | null, code: ErrorCode | string | null | undefined): string {
  if (code === "rate_limited") return error ?? "You are sending messages very quickly. Wait a moment and try again.";
  if (!error) return "Not sent. Check your connection and try again.";
  return canRetry(code) ? `Not sent. ${error}` : error;
}
