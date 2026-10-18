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

export type LlmResolutionReason =
  | "ready"
  | "not_configured"
  | "status_not_eligible"
  | "missing_credential"
  | "credential_unavailable"
  | "invalid_config"
  | "endpoint_not_allowed"
  | "environment"
  | "database_unavailable";

export interface LlmResolution {
  config: LlmConfig | null;
  reason: LlmResolutionReason;
  connectionStatus: string | null;
  provider: string | null;
  model: string | null;
  host: string | null;
  /** Result of the integration's model-listing check, when one has run. */
  modelListed?: boolean | null;
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

export type LlmStreamEvent =
  | { type: "delta"; text: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number };

export interface LlmStreamInput {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens: number;
  temperature?: number;
  timeoutMs?: number;
}

export class LlmStreamError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("The AI provider could not complete this request.");
    this.name = "LlmStreamError";
    this.status = status;
  }
}

/**
 * Streams one completion. Supports OpenAI Chat Completions SSE and Anthropic Messages SSE. If a
 * compatible endpoint answers with plain JSON instead, the full text is yielded once so a provider
 * that does not stream still works honestly.
 */
export async function* llmStream(c: LlmConfig, input: LlmStreamInput, signal?: AbortSignal): AsyncGenerator<LlmStreamEvent> {
  const timeout = AbortSignal.timeout(input.timeoutMs ?? 60_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const temperature = input.temperature ?? 0.3;
  const body =
    c.format === "anthropic"
      ? { model: c.model, max_tokens: input.maxTokens, temperature, system: input.system, messages: input.messages, stream: true }
      : {
          model: c.model,
          max_tokens: input.maxTokens,
          temperature,
          messages: [{ role: "system", content: input.system }, ...input.messages],
          stream: true,
        };
  const res = await fetch(llmChatUrl(c), {
    method: "POST",
    headers: llmHeaders(c.format, c.apiKey),
    body: JSON.stringify(body),
    redirect: "error",
    cache: "no-store",
    signal: combined,
  });
  if (!res.ok || !res.body) throw new LlmStreamError(res.status);
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      content?: Array<{ type?: string; text?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number };
    };
    const text = (c.format === "anthropic" ? json.content?.find((p) => p.type === "text")?.text : json.choices?.[0]?.message?.content)?.trim();
    if (text) yield { type: "delta", text };
    if (json.usage) yield { type: "usage", inputTokens: json.usage.prompt_tokens ?? json.usage.input_tokens, outputTokens: json.usage.completion_tokens ?? json.usage.output_tokens };
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }
        const text = c.format === "anthropic" ? anthropicDelta(event) : openAiDelta(event);
        if (text) yield { type: "delta", text };
        const usage = usageFrom(event);
        if (usage) yield { type: "usage", ...usage };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function openAiDelta(event: Record<string, unknown>): string {
  const choices = event.choices;
  if (!Array.isArray(choices)) return "";
  const delta = (choices[0] as { delta?: { content?: unknown } } | undefined)?.delta?.content;
  return typeof delta === "string" ? delta : "";
}

function anthropicDelta(event: Record<string, unknown>): string {
  if (event.type !== "content_block_delta") return "";
  const delta = event.delta as { text?: unknown } | undefined;
  return typeof delta?.text === "string" ? delta.text : "";
}

function usageFrom(event: Record<string, unknown>): { inputTokens?: number; outputTokens?: number } | null {
  const usage = (event.usage ?? (event.message as { usage?: unknown } | undefined)?.usage) as
    | { prompt_tokens?: unknown; completion_tokens?: unknown; input_tokens?: unknown; output_tokens?: unknown }
    | undefined;
  if (!usage) return null;
  const input = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  const output = typeof usage.completion_tokens === "number" ? usage.completion_tokens : typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
  return input !== undefined || output !== undefined ? { inputTokens: input, outputTokens: output } : null;
}

let cache: { at: number; value: LlmConfig } | null = null;
const CACHE_MS = 30_000;
/** Call after the agency changes the connection so this instance stops using the old key. */
export function invalidateLlmConfig() {
  cache = null;
}

async function probePortal(): Promise<LlmResolution> {
  try {
    return await withSystem(async (db) => {
      const { rows } = await db.query<{ status: string; config: Record<string, unknown>; credential_id: string | null; preset: string | null; capabilities: Record<string, unknown> }>(
        "select status, config, credential_id, config->>'llmPreset' as preset, capabilities from integration_connections where org_id is null and provider = 'llm' order by updated_at desc limit 1",
      );
      const row = rows[0];
      if (!row) return { config: null, reason: "not_configured", connectionStatus: null, provider: null, model: null, host: null };
      const provider = row.preset ?? (row.config.apiFormat === "anthropic" ? "anthropic" : "openai-compatible");
      const model = typeof row.config.model === "string" ? row.config.model : null;
      if (!["connected", "permission_limited"].includes(row.status)) {
        return { config: null, reason: "status_not_eligible", connectionStatus: row.status, provider, model, host: null };
      }
      if (!row.credential_id) return { config: null, reason: "missing_credential", connectionStatus: row.status, provider, model, host: null };
      let apiKey: string | null;
      try {
        apiKey = await resolveCredential(db, row.credential_id, null, "llm");
      } catch {
        return { config: null, reason: "credential_unavailable", connectionStatus: row.status, provider, model, host: null };
      }
      const { baseUrl, apiFormat } = row.config;
      if (!apiKey) return { config: null, reason: "credential_unavailable", connectionStatus: row.status, provider, model, host: typeof baseUrl === "string" ? safeHost(baseUrl) : null };
      if (typeof baseUrl !== "string" || !model) {
        return { config: null, reason: "invalid_config", connectionStatus: row.status, provider, model, host: typeof baseUrl === "string" ? safeHost(baseUrl) : null };
      }
      let approvedBaseUrl: string;
      try {
        approvedBaseUrl = validateLlmEndpoint(baseUrl);
      } catch {
        return { config: null, reason: "endpoint_not_allowed", connectionStatus: row.status, provider, model, host: safeHost(baseUrl) };
      }
      return {
        config: { baseUrl: approvedBaseUrl, format: apiFormat === "anthropic" ? "anthropic" : "openai", model, apiKey, source: "portal" },
        reason: "ready",
        connectionStatus: row.status,
        provider,
        model,
        host: safeHost(approvedBaseUrl),
        modelListed: typeof row.capabilities.modelListed === "boolean" ? row.capabilities.modelListed : null,
      };
    });
  } catch {
    return { config: null, reason: "database_unavailable", connectionStatus: null, provider: null, model: null, host: null };
  }
}

function safeHost(value: string): string | null {
  try { return new URL(value).host; } catch { return null; }
}

function fromEnvironment(): LlmConfig | null {
  const e = env();
  if (e.HELP_LLM_PROVIDER !== "openai_compatible" || !e.LLM_BASE_URL || !e.LLM_API_KEY) return null;
  return { baseUrl: e.LLM_BASE_URL, format: "openai", model: e.LLM_MODEL, apiKey: e.LLM_API_KEY, source: "environment" };
}

/**
 * The connection verified in Integrations wins; the legacy LLM_* environment variables are the
 * fallback. Failures are not cached: a provider that was unavailable while it was being verified
 * must become usable on the next request rather than remaining negative for an arbitrary window.
 */
export async function resolveLlmConfigDetailed(): Promise<LlmResolution> {
  const portal = await probePortal();
  if (portal.config) return portal;
  const environment = fromEnvironment();
  if (environment) {
    return { ...portal, config: environment, reason: "environment", provider: "environment", model: environment.model, host: safeHost(environment.baseUrl) };
  }
  return portal;
}

export async function resolveLlmConfig(): Promise<LlmConfig | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const resolution = await resolveLlmConfigDetailed();
  if (!resolution.config) {
    cache = null;
    return null;
  }
  cache = { at: Date.now(), value: resolution.config };
  return resolution.config;
}
