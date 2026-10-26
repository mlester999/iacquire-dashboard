import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { env } from "@/server/env";
import { notifyOrgRoles } from "@/server/notifications";
import { consumeRateLimit, rateLimitReachedInTx, type RateLimitRule } from "@/server/security/rate-limit";

// The two cost and safety controls of the public website chat that do not belong to one workspace's widget settings:
//  * WEBCHAT_PUBLIC_DISABLED: the platform-wide emergency switch. The public API answers "unavailable" and the widget leaves the page alone. Nothing is deleted.
//  * WEBCHAT_DAILY_AI_REPLIES: how many AI replies one workspace's chat may write per UTC day. Each reply reaches the platform's language model, which iAcquire pays
//    for, and the widget key is public, so the allowance is counted in the database before the model is asked.

export const webchatPublicDisabled = () => env().WEBCHAT_PUBLIC_DISABLED;

export const UNAVAILABLE_MESSAGE = "Chat is temporarily unavailable.";

/** The daily allowance as a rate-limit rule. The counter is per workspace and per UTC day, kept in the database so it holds across servers. */
export function dailyAiReplyRule(): RateLimitRule {
  return { name: "webchat:ai:daily", limit: env().WEBCHAT_DAILY_AI_REPLIES, windowSeconds: 86_400 };
}

export interface DailyAiReply {
  allowed: boolean;
  cap: number;
  /** Seconds until the allowance renews (the next UTC midnight). */
  retryAfterSeconds: number;
}

/**
 * Takes one AI reply from the workspace's allowance for today. Called immediately before the model is asked, so a refusal costs nothing. A reply that was
 * counted is counted even when the model then fails: the attempt, not the success, is what spends money.
 */
export async function takeDailyAiReply(orgId: string): Promise<DailyAiReply> {
  const rule = dailyAiReplyRule();
  const r = await consumeRateLimit(rule, orgId);
  return { allowed: r.allowed, cap: rule.limit, retryAfterSeconds: r.retryAfterSeconds };
}

/** Whether today's allowance is already used up, without taking from it. For the widget's config and the owner's checks. */
export async function dailyAiRepliesReached(db: Queryable, orgId: string): Promise<boolean> {
  return !(await rateLimitReachedInTx(db, dailyAiReplyRule(), orgId)).allowed;
}

/** Tells the owners, once a day, that the assistant stopped answering because of the allowance (the chat itself keeps working). Best effort. */
export async function noteDailyCapReached(orgId: string, cap: number): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  try {
    await withSystem((db) =>
      notifyOrgRoles(db, orgId, ["owner", "admin"], {
        kind: "usage_limit_approaching",
        severity: "warning",
        title: "The website assistant reached today's reply limit",
        body: `It has written ${cap} ${cap === 1 ? "reply" : "replies"} today. For the rest of the day your team is asked to answer new messages in the chat. The allowance renews at midnight UTC.`,
        link: "/website/chat",
        dedupeKey: `webchat-ai-cap:${day}`,
      }),
    );
  } catch {
    // The visitor's chat must not fail because a notice could not be written.
  }
}
