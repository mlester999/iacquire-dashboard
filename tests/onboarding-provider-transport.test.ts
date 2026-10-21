import { afterEach, describe, expect, it, vi } from "vitest";
import { llmComplete, type LlmConfig } from "@/server/llm/client";

afterEach(() => vi.unstubAllGlobals());
const config: LlmConfig = { baseUrl: "https://configured-provider.test/v1", format: "openai", model: "configured-model", apiKey: "server-secret", source: "portal" };
const input = { system: "Use only supplied facts.", user: '{"business":"Marko Bar"}', maxTokens: 1200, timeoutMs: 25_000 };

describe("shared provider transport for onboarding", () => {
  it.each(["openai", "anthropic"] as const)("builds the configured %s HTTP request through the existing client (mock transport)", async (format) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(format === "openai" ? { choices: [{ message: { content: '{"value":"A draft"}' } }] } : { content: [{ type: "text", text: '{"value":"A draft"}' }] })));
    vi.stubGlobal("fetch", fetcher);
    expect(await llmComplete({ ...config, format }, input)).toEqual({ ok: true, text: '{"value":"A draft"}' });
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toContain(format === "openai" ? "/chat/completions" : "/v1/messages");
    expect(JSON.parse(request.body)).toMatchObject({ model: "configured-model", max_tokens: 1200 });
    expect(JSON.parse(request.body).messages.at(-1).content).toContain("Marko Bar");
    expect(request.redirect).toBe("error");
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(await llmComplete({ ...config, format }, input))).not.toContain("server-secret");
  });

  it.each(["timeout", "cancel"])("aborts the provider request on %s without returning secrets", async (kind) => {
    let observed: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, options) => new Promise((_resolve, reject) => {
      observed = options.signal;
      options.signal.addEventListener("abort", () => reject(new Error("upstream secret failure")), { once: true });
    })));
    const controller = new AbortController();
    const pending = llmComplete(config, { ...input, timeoutMs: kind === "timeout" ? 10 : 25_000 }, controller.signal);
    if (kind === "cancel") controller.abort();
    expect(await pending).toEqual({ ok: false, status: 0 });
    expect(observed?.aborted).toBe(true);
  });
});
