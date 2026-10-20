import "server-only";
import { withSystem, type Queryable } from "@/server/db";

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

const windowOf = (rule: RateLimitRule, now: number) => {
  const windowMs = rule.windowSeconds * 1000;
  const start = Math.floor(now / windowMs) * windowMs;
  return { start: new Date(start), retryAfterSeconds: Math.max(1, Math.ceil((start + windowMs - now) / 1000)) };
};

/** consumeRateLimit inside the caller's transaction (transactions can't nest), for gates that run inside one. */
export async function consumeRateLimitInTx(db: Queryable, rule: RateLimitRule, key: string): Promise<RateLimitResult> {
  const w = windowOf(rule, Date.now());
  const res = await db.query<{ hits: number }>(
    `insert into rate_limit_buckets (bucket_key, window_start, hits) values ($1, $2, 1)
     on conflict (bucket_key, window_start) do update set hits = rate_limit_buckets.hits + 1
     returning hits`,
    [`${rule.name}:${key}`, w.start.toISOString()],
  );
  const hits = res.rows[0]?.hits ?? 1;
  return { allowed: hits <= rule.limit, remaining: Math.max(0, rule.limit - hits), retryAfterSeconds: w.retryAfterSeconds };
}

/**
 * Whether `key` has already used up the rule's limit in the current window, without counting this request. For gates that count only
 * failures: the gate is checked first (so a blocked caller costs nothing more), and a failure is then counted with consumeRateLimitInTx.
 */
export async function rateLimitReachedInTx(db: Queryable, rule: RateLimitRule, key: string): Promise<RateLimitResult> {
  const w = windowOf(rule, Date.now());
  const res = await db.query<{ hits: number }>("select hits from rate_limit_buckets where bucket_key = $1 and window_start = $2", [`${rule.name}:${key}`, w.start.toISOString()]);
  const hits = res.rows[0]?.hits ?? 0;
  return { allowed: hits < rule.limit, remaining: Math.max(0, rule.limit - hits), retryAfterSeconds: w.retryAfterSeconds };
}

export const RATE_LIMITS = {
  loginByIp: { name: "login:ip", limit: 30, windowSeconds: 900 },
  loginByAccount: { name: "login:acct", limit: 8, windowSeconds: 900 },
  passwordResetByIp: { name: "reset:ip", limit: 10, windowSeconds: 3600 },
  passwordResetByEmail: { name: "reset:email", limit: 3, windowSeconds: 3600 },
  verifyResendByUser: { name: "verify:user", limit: 4, windowSeconds: 3600 },
  inviteAcceptByIp: { name: "invite:ip", limit: 20, windowSeconds: 900 },
  invitationResend: { name: "invite:resend", limit: 6, windowSeconds: 3600 },
  accessRequestByIp: { name: "access:ip", limit: 5, windowSeconds: 3600 },
  agentMessageByUser: { name: "agent:user", limit: 30, windowSeconds: 60 },
  // Real provider runs against an unsaved employee draft. Separate from production chat so a test cannot exhaust a
  // person's chat allowance, and vice versa.
  agentPreviewByUser: { name: "agent:preview:user", limit: 10, windowSeconds: 60 },
  helpMessageByUser: { name: "help:user", limit: 20, windowSeconds: 60 },
  aqiMessageByUser: { name: "aqi:user", limit: 20, windowSeconds: 60 },
  // Automatic conversation naming is a tiny background call, but it must never be loopable.
  aqiTitleByUser: { name: "aqi:title:user", limit: 30, windowSeconds: 3600 },
  // AQi Operations: confirming a proposed action and re-running a read card. Both reach production systems, so they are separate from chat.
  aqiOpsActionByUser: { name: "aqi:ops:action:user", limit: 12, windowSeconds: 600 },
  aqiOpsRefreshByUser: { name: "aqi:ops:refresh:user", limit: 40, windowSeconds: 300 },
  supportTicketByUser: { name: "ticket:user", limit: 10, windowSeconds: 3600 },
  // Replies inside a request, per person. High enough for a real back-and-forth, low enough to stop a loop.
  supportReplyByUser: { name: "support:reply:user", limit: 60, windowSeconds: 3600 },
  // Optional AI help on requests (rewrites, category suggestions, summaries, drafts). Each call can reach the AI provider.
  supportAiByUser: { name: "support:ai:user", limit: 20, windowSeconds: 3600 },
  supportAgencyActionByUser: { name: "support:agency:user", limit: 600, windowSeconds: 3600 },
  // "Similar requests" suggestions while a person types a title.
  supportSimilarByUser: { name: "support:similar:user", limit: 200, windowSeconds: 3600 },
  uploadByUser: { name: "upload:user", limit: 30, windowSeconds: 3600 },
  // Re-running bounded extraction against an already stored document, per user.
  knowledgeReprocessByUser: { name: "knowledge:reprocess:user", limit: 20, windowSeconds: 3600 },
  researchByOrg: { name: "research:org", limit: 20, windowSeconds: 3600 },
  projectRequestByUser: { name: "project:request", limit: 6, windowSeconds: 3600 },
  projectActivityByUser: { name: "project:activity", limit: 40, windowSeconds: 3600 },
  quoteDecisionByUser: { name: "project:quote", limit: 12, windowSeconds: 3600 },
  publicContentByIp: { name: "public:ip", limit: 120, windowSeconds: 60 },
  maintenanceByUser: { name: "maintenance:user", limit: 10, windowSeconds: 3600 },
  topupByOrg: { name: "billing:topup", limit: 10, windowSeconds: 3600 },
  inboxSendByUser: { name: "inbox:send", limit: 60, windowSeconds: 60 },
  onboardingAssistByOrg: { name: "onboarding:assist", limit: 25, windowSeconds: 3600 },
  onboardingSiteReadByOrg: { name: "onboarding:site", limit: 8, windowSeconds: 3600 },
  websiteAssistByOrg: { name: "website:assist", limit: 40, windowSeconds: 3600 },
  // Public booking pages (/book/*) and their API. Keys are hashed IPs, org ids, or the sha256 of a manage secret, never raw values.
  bookingPageByIp: { name: "booking:page:ip", limit: 120, windowSeconds: 60 },
  bookingSlotsByIp: { name: "booking:slots:ip", limit: 90, windowSeconds: 60 },
  bookingSubmitByIp: { name: "booking:submit:ip", limit: 10, windowSeconds: 3600 },
  bookingSubmitByOrg: { name: "booking:submit:org", limit: 120, windowSeconds: 3600 },
  bookingManageByIp: { name: "booking:manage:ip", limit: 30, windowSeconds: 3600 },
  bookingManageByToken: { name: "booking:manage:token", limit: 8, windowSeconds: 3600 },
  bookingIcsByIp: { name: "booking:ics:ip", limit: 30, windowSeconds: 600 },
  // The public CRM API (/api/v1/crm, docs/crm-api.md): per API key id, and failed authentication per hashed client address.
  crmApiByKey: { name: "crm-api:key", limit: 120, windowSeconds: 60 },
  crmApiAuthFailureByIp: { name: "crm-api:auth-fail:ip", limit: 30, windowSeconds: 600 },
  // Test sends and manual redeliveries from Settings → API & Webhooks, per workspace.
  crmWebhookManualByOrg: { name: "crm-webhook:manual:org", limit: 30, windowSeconds: 3600 },
  // CRM tool calls from a client's own AI employee (/api/agent-tools), per employee (agent instance id), whatever token it holds.
  agentToolCallsByEmployee: { name: "agent-tools:employee", limit: 60, windowSeconds: 60 },
  // Requests to /api/agent-tools with a missing, unknown, expired or revoked credential, per hashed client address. Valid calls never count.
  agentToolAuthFailureByIp: { name: "agent-tools:auth-fail:ip", limit: 30, windowSeconds: 600 },
  // Voice provider webhooks (/api/webhooks/vapi and /retell) that name a connected assistant but fail authentication, per connection and
  // hashed client address. Past the limit, that address's requests for that connection are refused before the vault is read. Requests that
  // authenticate never count, so a provider's own traffic (from its own addresses) isn't held back by someone else's forged requests.
  voiceWebhookAuthFailure: { name: "voice-webhook:auth-fail", limit: 20, windowSeconds: 600 },
} satisfies Record<string, RateLimitRule>;
