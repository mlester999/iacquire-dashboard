import "server-only";
import { withSystem } from "@/server/db";
import { env } from "@/server/env";
import { resolveCredential } from "@/server/security/credentials";
import { validateLlmEndpoint } from "@/server/integrations/safety";
import type { LlmApiFormat } from "@/lib/integrations";

export interface LlmConfig {
  baseUrl: string;
  format: LlmApiFormat;
  model: string;
  apiKey: string;
  source: "portal" | "environment";
}

type Endpoint = Pick<LlmConfig, "baseUrl" | "format">;

export function llmHeaders(format: LlmApiFormat, apiKey: string): Record<string, string> {
  const common = { "Content-Type": "application/json", Accept: "application/json" };
  return format === "anthropic" ? { ...common, "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : { ...common, Authorization: `Bearer ${apiKey}` };
}
const root = (c: Endpoint) => c.baseUrl.replace(/\/+$/, "");
export const llmModelsUrl = (c: Endpoint) => (c.format === "anthropic" ? `${root(c)}/v1/models?limit=1000` : `${root(c)}/models`);
export const llmChatUrl = (c: Endpoint) => (c.format === "anthropic" ? `${root(c)}/v1/messages` : `${root(c)}/chat/completions`);

export type LlmReply = { ok: true; text: string } | { ok: false; status: number };

/** One non-streaming completion. Never throws and never includes the key or upstream body in its result. */
export async function llmComplete(
  c: LlmConfig,
  input: { system: string; user: string; maxTokens: number; temperature?: number; timeoutMs?: number },
): Promise<LlmReply> {
  const temperature = input.temperature ?? 0.2;
  const body =
    c.format === "anthropic"
      ? { model: c.model, max_tokens: input.maxTokens, temperature, system: input.system, messages: [{ role: "user", content: input.user }] }
      : { model: c.model, max_tokens: input.maxTokens, temperature, messages: [{ role: "system", content: input.system }, { role: "user", content: input.user }] };
  try {
    // Redirects are refused so the credential can never be forwarded to another host.
    const res = await fetch(llmChatUrl(c), { method: "POST", headers: llmHeaders(c.format, c.apiKey), body: JSON.stringify(body), redirect: "error", cache: "no-store", signal: AbortSignal.timeout(input.timeoutMs ?? 20_000) });
    if (!res.ok) return { ok: false, status: res.status };
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; content?: Array<{ type?: string; text?: string }> };
    const text = (c.format === "anthropic" ? json.content?.find((p) => p.type === "text")?.text : json.choices?.[0]?.message?.content)?.trim();
    return text ? { ok: true, text } : { ok: false, status: 0 };
  } catch {
    return { ok: false, status: 0 };
  }
}

let cache: { at: number; value: LlmConfig | null } | null = null;
const CACHE_MS = 30_000;
/** Call after the agency changes the connection so this instance stops using the old key. */
export function invalidateLlmConfig() {
  cache = null;
}

async function fromPortal(): Promise<LlmConfig | null> {
  return withSystem(async (db) => {
    const { rows } = await db.query<{ config: Record<string, unknown>; credential_id: string | null }>(
      "select config, credential_id from integration_connections where org_id is null and provider = 'llm' and status in ('connected','permission_limited')",
    );
    const row = rows[0];
    if (!row?.credential_id) return null;
    const apiKey = await resolveCredential(db, row.credential_id, null, "llm");
    const { baseUrl, model, apiFormat } = row.config;
    if (!apiKey || typeof baseUrl !== "string" || typeof model !== "string") return null;
    return { baseUrl: validateLlmEndpoint(baseUrl), format: apiFormat === "anthropic" ? "anthropic" : "openai", model, apiKey, source: "portal" } satisfies LlmConfig;
  });
}

function fromEnvironment(): LlmConfig | null {
  const e = env();
  if (e.HELP_LLM_PROVIDER !== "openai_compatible" || !e.LLM_BASE_URL || !e.LLM_API_KEY) return null;
  return { baseUrl: e.LLM_BASE_URL, format: "openai", model: e.LLM_MODEL, apiKey: e.LLM_API_KEY, source: "environment" };
}

/** The connection verified in Integrations wins; the legacy LLM_* environment variables are the fallback. */
export async function resolveLlmConfig(): Promise<LlmConfig | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = (await fromPortal().catch(() => null)) ?? fromEnvironment();
  cache = { at: Date.now(), value };
  return value;
}
