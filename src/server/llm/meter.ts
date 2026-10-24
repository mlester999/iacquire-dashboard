import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { chargeUsage } from "@/server/billing/ledger";
import { sanitizeErrorText } from "@/lib/ops";
import type { LlmUsage } from "@/server/llm/client";

// Metering for model calls the platform pays for. Every AI feature a workspace uses that calls llmComplete calls this once per call, with the token counts the provider
// reported (the `usage` field of llmComplete's result). The only callers that do not are AQi (it keeps its own cost accounting), the Super Admin's AQi connection check and the
// one-token connection ping in Integrations: none has a workspace to charge. tests/llm-callers-metered.test.ts lists them with the reasons and scans the source, so a new caller
// that neither meters nor is listed fails there. Before a call, src/server/llm/gate.ts says whether the workspace may use the model at all (active, not paused, credit).
//
// What it does, per call:
//   * records one usage line per token unit (input, output) in metered_usage_events, with the workspace, the feature ("ai:<feature>") and the token count;
//   * charges the workspace's credits when a unit rate has been published for provider "llm" (usage_unit_rates, rates per 1,000 tokens, the same math the Hermes reply
//     path uses). Where no rate is published the line is recorded at zero cost: tokens are visible, nothing is charged, and no price is invented here.
//   * is idempotent per call: `key` names the call, and the same key never records or charges twice (a unique reference per workspace and unit).
//   * never fails the caller. A customer-facing reply must not wait on, or be lost to, a metering problem: meterModelUse swallows the error, logs its class, and
//     opens one platform incident per feature so someone hears about it.
//
// Exports (keep this small):
//   meterModelUse(use)         the one most callers want: its own transaction, never throws.
//   recordModelUse(db, use)    the same inside the caller's transaction; throws on a database error, so the caller decides.
//   modelCallKey(prefix)       a key that is unique to one call; build it once per call and reuse it if recording that call is retried.
//   chargeModelUsage(...)      the Hermes reply path's charge (priced lines only, keyed by the reply message); shared so the two paths cannot drift.
//
// A provider that reports no token counts leaves nothing to record ("no_usage"); that is a gap in the provider's answer, not a free call, and it is returned as such.

export interface ModelUse {
  orgId: string;
  /** What the call was for: lower-case words and underscores ("webchat_reply", "social_ai"). It shows on the usage line as ai:<feature>. */
  feature: string;
  /** Names this one call. Recording the same key again changes nothing. */
  key: string;
  /** What llmComplete returned in `usage`. */
  usage: LlmUsage | null | undefined;
}

export interface MeterOutcome {
  status: "recorded" | "duplicate" | "no_usage" | "failed";
  /** Credits taken, in micro-dollars (0 when no rate is published). */
  chargedMicros: number;
  /** Credits that could not be collected because the balance ran out; recorded on the usage line for the agency to reconcile. */
  uncollectedMicros: number;
}

const FEATURE = /^[a-z][a-z0-9_]{1,40}$/;
type TokenUnit = "ai_tokens_in" | "ai_tokens_out";

/** A key unique to one model call. Make one per call and reuse it if recording that call is retried; the prefix says what the call belongs to (an inbound message id, a user id). */
export const modelCallKey = (prefix: string) => `${prefix.slice(0, 60)}:${crypto.randomUUID()}`;

const reference = (feature: string, key: string, unit: TokenUnit) => {
  const full = `ai:${feature}:${key}:${unit}`;
  // The column holds 160 characters; a longer key is shortened to a digest so two long keys can never collapse into one reference.
  return full.length <= 160 ? full : `ai:${feature}:${crypto.createHash("sha256").update(key).digest("hex").slice(0, 40)}:${unit}`;
};

/** The wholesale micro-dollars per 1,000 tokens iAcquire published for a model unit, or null when no rate has been published. */
async function publishedRate(db: Queryable, unit: TokenUnit): Promise<number | null> {
  const { rows } = await db.query<{ w: string }>(
    `select r.wholesale_micros_per_unit::text as w from usage_unit_rates r join usage_rate_versions v on v.id = r.rate_version_id
     where r.provider = 'llm' and r.unit_type = $1 order by v.version desc limit 1`,
    [unit],
  );
  return rows[0] ? Number(rows[0].w) : null;
}

const tokensOf = (usage: LlmUsage | null | undefined): Array<{ unit: TokenUnit; tokens: number }> =>
  usage
    ? ([{ unit: "ai_tokens_in", tokens: usage.inputTokens ?? 0 }, { unit: "ai_tokens_out", tokens: usage.outputTokens ?? 0 }] as const).filter((l) => Number.isFinite(l.tokens) && l.tokens > 0)
    : [];

/** The Hermes reply path's usage charge: priced lines only, one per unit, keyed by the reply message so a replay never charges twice. */
export async function chargeModelUsage(db: Queryable, orgId: string, messageId: string, usage: LlmUsage): Promise<void> {
  for (const { unit, tokens } of tokensOf(usage)) {
    const rate = await publishedRate(db, unit);
    if (rate === null) continue;
    await chargeUsage(db, { orgId, usage: { provider: "llm", unitType: unit, quantity: tokens, wholesaleMicros: Math.ceil((rate * tokens) / 1000), providerReference: `reply:${messageId}:${unit}`, messageId } });
  }
}

const NO_USAGE: MeterOutcome = Object.freeze({ status: "no_usage", chargedMicros: 0, uncollectedMicros: 0 } as const);

function check(use: ModelUse) {
  if (!FEATURE.test(use.feature)) throw new Error(`Unknown AI feature name "${use.feature.slice(0, 60)}".`);
  if (!use.key || use.key.length > 120) throw new Error("A model call needs a key of 1 to 120 characters.");
}

/** Records (and, where a rate exists, charges) one model call inside the caller's transaction. Throws on a database error. */
export async function recordModelUse(db: Queryable, use: ModelUse): Promise<MeterOutcome> {
  check(use);
  const lines = tokensOf(use.usage);
  if (!lines.length) return NO_USAGE;
  let charged = 0;
  let uncollected = 0;
  let fresh = 0;
  for (const { unit, tokens } of lines) {
    const rate = await publishedRate(db, unit);
    const wholesale = rate === null ? 0 : Math.ceil((rate * tokens) / 1000);
    const c = await chargeUsage(db, { orgId: use.orgId, usage: { provider: "llm", unitType: unit, quantity: tokens, wholesaleMicros: wholesale, providerReference: reference(use.feature, use.key, unit), jobReference: `ai:${use.feature}` } });
    if (!c.duplicate) {
      fresh += 1;
      charged += c.chargedMicros;
      uncollected += c.uncollectedMicros;
    }
  }
  return { status: fresh ? "recorded" : "duplicate", chargedMicros: charged, uncollectedMicros: uncollected };
}

/**
 * Records one model call in its own transaction and never throws. On a problem it logs the error class and opens a platform incident for the feature
 * (one per feature, refreshed while it persists), and returns status "failed": the model's answer is still used.
 */
export async function meterModelUse(use: ModelUse): Promise<MeterOutcome> {
  try {
    check(use);
    // Nothing to record: no transaction is opened for it.
    if (!tokensOf(use.usage).length) return NO_USAGE;
    return await withSystem((db) => recordModelUse(db, use));
  } catch (err) {
    await reportMeteringFailure(use.feature, err);
    return { status: "failed", chargedMicros: 0, uncollectedMicros: 0 };
  }
}

async function reportMeteringFailure(feature: string, err: unknown): Promise<void> {
  // Class name only: a database error can carry row values.
  console.error("[iacquire] model usage was not recorded", { feature: FEATURE.test(feature) ? feature : "invalid", error: err instanceof Error ? err.name : "unknown" });
  try {
    const { recordUnhealthy } = await import("@/server/ops/incidents");
    const label = FEATURE.test(feature) ? feature : "unknown";
    await withSystem((db) =>
      recordUnhealthy(db, {
        key: `metering:failed:${label}`,
        source: "credits",
        orgId: null,
        subject: label,
        severity: "warning",
        title: `AI usage could not be recorded (${label})`,
        detail: `Replies and drafts are still delivered, but the model calls behind them are not being counted or charged. ${sanitizeErrorText(err, 200)}`,
        guidance: "Check the billing tables and the published AI usage rates. Close this incident by hand once usage lines are being recorded again.",
      }),
    );
  } catch {
    // The alert is best effort: if the database is what failed, the log line above is all there is.
  }
}
