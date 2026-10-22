import "server-only";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { INBOX_UNAVAILABLE_MESSAGE } from "@/lib/inbox";

// The Unified Inbox's kill switch: INBOX_DISABLED=true (see src/server/env.ts). It switches off the inbox as a screen and an API: the /inbox page,
// /api/inbox/*, the server actions the inbox calls, and the notices the inbox raises. It does NOT touch receiving, storing or sending messages,
// the AI employees, the workflow engine or the settings screens, so customers' messages are still received and kept while it is off.
// An operator uses it to take the new screen away quickly (set the variable and redeploy); it does not bring the previous screen back.

export { INBOX_UNAVAILABLE_MESSAGE };

/** True unless an operator switched the inbox off. */
export const inboxEnabled = () => !env().INBOX_DISABLED;

/** Throws the "temporarily unavailable" error (HTTP 503 with Retry-After) when the inbox is switched off. Costs no database access. */
export function assertInboxEnabled(): void {
  if (!inboxEnabled()) throw new AppError("unavailable", INBOX_UNAVAILABLE_MESSAGE, { retryAfterSeconds: 60 });
}
