import "server-only";
import { withSystem } from "@/server/db";

export interface RateLimitRule {
  /** Logical bucket name, e.g. "login:ip". */
  name: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window counter stored in PostgreSQL so limits hold across server instances.
 * The key must not contain raw personal data; callers pass hashed identifiers.
 */
export async function consumeRateLimit(rule: RateLimitRule, key: string): Promise<RateLimitResult> {
  const now = Date.now();
  const windowMs = rule.windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
  const bucketKey = `${rule.name}:${key}`;
  const hits = await withSystem(async (db) => {
    const res = await db.query<{ hits: number }>(
      `insert into rate_limit_buckets (bucket_key, window_start, hits) values ($1, $2, 1)
       on conflict (bucket_key, window_start) do update set hits = rate_limit_buckets.hits + 1
       returning hits`,
      [bucketKey, windowStart.toISOString()],
    );
    // Opportunistic cleanup of expired windows.
    if (Math.random() < 0.02) {
      await db.query("delete from rate_limit_buckets where window_start < now() - interval '1 day'");
    }
    return res.rows[0]?.hits ?? 1;
  });
  const retryAfterSeconds = Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now) / 1000));
  return { allowed: hits <= rule.limit, remaining: Math.max(0, rule.limit - hits), retryAfterSeconds };
}

export const RATE_LIMITS = {
  loginByIp: { name: "login:ip", limit: 30, windowSeconds: 900 },
  loginByAccount: { name: "login:acct", limit: 8, windowSeconds: 900 },
  passwordResetByIp: { name: "reset:ip", limit: 10, windowSeconds: 3600 },
  passwordResetByEmail: { name: "reset:email", limit: 3, windowSeconds: 3600 },
  verifyResendByUser: { name: "verify:user", limit: 4, windowSeconds: 3600 },
  inviteAcceptByIp: { name: "invite:ip", limit: 20, windowSeconds: 900 },
  accessRequestByIp: { name: "access:ip", limit: 5, windowSeconds: 3600 },
  agentMessageByUser: { name: "agent:user", limit: 30, windowSeconds: 60 },
  helpMessageByUser: { name: "help:user", limit: 20, windowSeconds: 60 },
  supportTicketByUser: { name: "ticket:user", limit: 10, windowSeconds: 3600 },
  uploadByUser: { name: "upload:user", limit: 30, windowSeconds: 3600 },
  researchByOrg: { name: "research:org", limit: 20, windowSeconds: 3600 },
  projectRequestByUser: { name: "project:request", limit: 6, windowSeconds: 3600 },
  projectActivityByUser: { name: "project:activity", limit: 40, windowSeconds: 3600 },
  quoteDecisionByUser: { name: "project:quote", limit: 12, windowSeconds: 3600 },
  publicContentByIp: { name: "public:ip", limit: 120, windowSeconds: 60 },
  maintenanceByUser: { name: "maintenance:user", limit: 10, windowSeconds: 3600 },
  topupByOrg: { name: "billing:topup", limit: 10, windowSeconds: 3600 },
  inboxSendByUser: { name: "inbox:send", limit: 60, windowSeconds: 60 },
} satisfies Record<string, RateLimitRule>;
