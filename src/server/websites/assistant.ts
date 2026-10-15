import "server-only";
import { AppError } from "@/server/errors";
import type { OrgContext } from "@/server/tenancy/context";
import { llmComplete, resolveLlmConfig } from "@/server/llm/client";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { MAX_REQUEST, SYSTEM_PROMPT, briefSchema, buildUserPrompt, parseModelPlan } from "@/lib/website/assistant/brief";
import type { Plan } from "@/lib/website/assistant/ops";

/** Whether the agency has connected an AI provider. The built-in assistant works without one. */
export async function assistantAiAvailable(): Promise<boolean> {
  return (await resolveLlmConfig().catch(() => null)) !== null;
}

/**
 * Asks the connected AI provider to suggest edits. It is sent a short outline of the page, never contact details or the whole site, and
 * what comes back is only a suggestion: it is reduced to the closed list of allowed edits here and checked again against the live
 * document in the browser before anything is shown or applied. Returns null when no provider is connected or it can't answer.
 */
export async function suggestWithAi(ctx: OrgContext, input: { request: string; brief: unknown }): Promise<Plan | null> {
  if (!ctx.can("website.edit")) throw new AppError("forbidden", "Your role doesn't allow editing the website.");
  const request = String(input.request ?? "").trim();
  if (request.length < 3) throw new AppError("invalid_input", "Say what you'd like to change.");
  if (request.length > MAX_REQUEST) throw new AppError("invalid_input", `Please keep the request under ${MAX_REQUEST} characters.`);
  const brief = briefSchema.safeParse(input.brief);
  if (!brief.success) throw new AppError("invalid_input", "That request wasn't valid. Reload the editor and try again.");
  const config = await resolveLlmConfig().catch(() => null);
  if (!config) return null;
  const limit = await consumeRateLimit(RATE_LIMITS.websiteAssistByOrg, ctx.org.orgId);
  if (!limit.allowed) throw new AppError("rate_limited", "You've used the assistant a lot in the last hour. Try again shortly, or edit by hand.", { retryAfterSeconds: limit.retryAfterSeconds });
  const reply = await llmComplete(config, { system: SYSTEM_PROMPT, user: buildUserPrompt(brief.data, request), maxTokens: 1200, temperature: 0.2, timeoutMs: 25_000 });
  if (!reply.ok) return null;
  return parseModelPlan(reply.text);
}
