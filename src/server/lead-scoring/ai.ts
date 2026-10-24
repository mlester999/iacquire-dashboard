import "server-only";
import { withSystem } from "@/server/db";
import { llmComplete, resolveLlmConfig, type LlmConfig } from "@/server/llm/client";
import { modelGate, type ModelGateReason } from "@/server/llm/gate";
import { meterModelUse, modelCallKey } from "@/server/llm/meter";
import { SYSTEM_PROMPT, buildSignalPrompt, parseSignals } from "@/lib/lead-scoring/ai-signals";
import type { AiSignals } from "@/lib/lead-scoring/types";

// The one place a model touches lead scoring. It is optional (off until a workspace turns it on and a model is configured), allowed (the workspace is
// active, not paused and has credit: see src/server/llm/gate.ts), bounded (a daily limit per workspace, a short prompt, a short answer, two tries), metered
// (every call is counted, tokens are estimated and marked so) and checked (the answer must be exactly the closed form in src/lib/lead-scoring/ai-signals.ts,
// with evidence). Any failure leaves the rules to score on their own; a model can lower nothing and raise nothing by failing.

export type ExtractionResult =
  | { status: "not_used" }
  | { status: "skipped_limit" }
  | { status: "fallback"; reason: "no_model" | ModelGateReason }
  | { status: "failed"; reason: "provider" | "not_json" | "schema" | "evidence" }
  | { status: "used"; signals: AiSignals; model: string };

export interface ExtractionDeps {
  resolve?: () => Promise<LlmConfig | null>;
  complete?: typeof llmComplete;
  /** Wait between the two tries (milliseconds). */
  backoffMs?: number;
}

const MAX_TRIES = 2;
const day = (d: Date) => d.toISOString().slice(0, 10);
const tokens = (chars: number) => Math.ceil(chars / 4);

export async function extractSignals(
  orgId: string,
  messages: Array<{ id: string; text: string }>,
  limits: { enabled: boolean; dailyLimit: number },
  now: Date,
  deps: ExtractionDeps = {},
): Promise<ExtractionResult> {
  if (!limits.enabled) return { status: "not_used" };
  const prompt = buildSignalPrompt(messages);
  if (!prompt) return { status: "not_used" };
  // Before a model is looked for and before the day's allowance is taken, so a refusal uses up nothing: a suspended or paused workspace, or one with no credit,
  // would cost iAcquire a call nobody can be charged for. The rules score on their own and the reason travels back.
  const allowed = await modelGate(orgId, { automation: "workflows", credit: true });
  if (!allowed.allowed) return { status: "fallback", reason: allowed.reason };
  const config = await (deps.resolve ?? resolveLlmConfig)();
  if (!config) return { status: "fallback", reason: "no_model" };

  // Reserve one call against the day's limit before spending it; the update only succeeds while the count is below the limit.
  const reserved = await withSystem(async (db) =>
    (await db.query(
      `insert into lead_score_usage (org_id, day, ai_calls) values ($1, $2, 1)
       on conflict (org_id, day) do update set ai_calls = lead_score_usage.ai_calls + 1 where lead_score_usage.ai_calls < $3 returning ai_calls`,
      [orgId, day(now), limits.dailyLimit],
    )).rows.length > 0,
  );
  if (!reserved) return { status: "skipped_limit" };

  const complete = deps.complete ?? llmComplete;
  let reply: string | null = null;
  for (let attempt = 1; attempt <= MAX_TRIES && reply === null; attempt += 1) {
    const r = await complete(config, { system: SYSTEM_PROMPT, user: prompt.user, maxTokens: 300, temperature: 0, timeoutMs: 20_000 });
    // The provider's own token counts are recorded (and charged where a rate is published) per call; the estimates below stay as the daily tally. Never fails the scoring.
    await meterModelUse({ orgId, feature: "lead_scoring", key: modelCallKey(orgId), usage: r.usage });
    if (r.ok) reply = r.text;
    // Only a timeout, a rate limit or a server error is worth a second try; anything else (a bad key, a refused request) would fail the same way.
    else if (attempt < MAX_TRIES && (r.status === 0 || r.status === 429 || r.status >= 500)) await new Promise((res) => setTimeout(res, deps.backoffMs ?? 400));
    else break;
  }
  const inputTokens = tokens(SYSTEM_PROMPT.length + prompt.user.length);
  if (reply === null) {
    await record(orgId, now, { failures: 1, input: inputTokens, output: 0 });
    return { status: "failed", reason: "provider" };
  }
  const parsed = parseSignals(reply, prompt.ids);
  await record(orgId, now, { failures: parsed.ok ? 0 : 1, input: inputTokens, output: tokens(reply.length) });
  if (!parsed.ok) return { status: "failed", reason: parsed.reason };
  return { status: "used", signals: parsed.signals, model: config.model.slice(0, 80) };
}

async function record(orgId: string, now: Date, u: { failures: number; input: number; output: number }): Promise<void> {
  await withSystem((db) =>
    db.query(
      `insert into lead_score_usage (org_id, day, ai_failures, input_tokens, output_tokens) values ($1, $2, $3, $4, $5)
       on conflict (org_id, day) do update set ai_failures = lead_score_usage.ai_failures + $3, input_tokens = lead_score_usage.input_tokens + $4, output_tokens = lead_score_usage.output_tokens + $5`,
      [orgId, day(now), u.failures, u.input, u.output],
    ),
  );
}
