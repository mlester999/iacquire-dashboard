import { afterEach, describe, expect, it, vi } from "vitest";
import { llmComplete, usageFromBody, type LlmConfig } from "@/server/llm/client";

// What llmComplete reports about a call's token usage. The provider is a replaced HTTP layer here: no model is ever contacted.

afterEach(() => vi.unstubAllGlobals());

const base: LlmConfig = { baseUrl: "https://configured-provider.test/v1", format: "openai", model: "configured-model", apiKey: "server-secret-key", source: "portal" };
const input = { system: "Use only supplied facts.", user: "Question", maxTokens: 300 };

const answerWith = (format: "openai" | "anthropic", text: string, usage?: Record<string, unknown>) =>
  new Response(JSON.stringify(format === "openai" ? { choices: [{ message: { content: text } }], ...(usage ? { usage } : {}) } : { content: [{ type: "text", text }], ...(usage ? { usage } : {}) }));

describe("usageFromBody", () => {
  it("reads OpenAI-style counts", () => {
    expect(usageFromBody({ usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 } })).toEqual({ inputTokens: 120, outputTokens: 45 });
  });

  it("reads Anthropic-style counts", () => {
    expect(usageFromBody({ usage: { input_tokens: 80, output_tokens: 12, cache_read_input_tokens: 5 } })).toEqual({ inputTokens: 80, outputTokens: 12 });
  });

  it("keeps a side the provider did not report as null, and reports nothing when neither side is there", () => {
    expect(usageFromBody({ usage: { completion_tokens: 9 } })).toEqual({ inputTokens: null, outputTokens: 9 });
    expect(usageFromBody({ usage: { input_tokens: 9 } })).toEqual({ inputTokens: 9, outputTokens: null });
    expect(usageFromBody({ usage: {} })).toBeNull();
    expect(usageFromBody({})).toBeNull();
    expect(usageFromBody(null)).toBeNull();
    expect(usageFromBody("usage")).toBeNull();
    expect(usageFromBody({ usage: "lots" })).toBeNull();
  });

  it("treats anything that is not a plain non-negative number as not reported", () => {
    for (const bad of ["12", -3, Number.NaN, Number.POSITIVE_INFINITY, null, {}, [5], true]) {
      expect(usageFromBody({ usage: { prompt_tokens: bad, completion_tokens: bad } }), String(bad)).toBeNull();
    }
    // A fractional count is rounded rather than carried as a fraction.
    expect(usageFromBody({ usage: { prompt_tokens: 10.4, completion_tokens: 0 } })).toEqual({ inputTokens: 10, outputTokens: 0 });
  });

  it("reads back exactly what either format carries, for any counts", () => {
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let i = 0; i < 60; i += 1) {
      const a = next() % 200_000;
      const b = next() % 50_000;
      expect(usageFromBody({ usage: { prompt_tokens: a, completion_tokens: b } })).toEqual({ inputTokens: a, outputTokens: b });
      expect(usageFromBody({ usage: { input_tokens: a, output_tokens: b } })).toEqual({ inputTokens: a, outputTokens: b });
    }
  });
});

describe("llmComplete", () => {
  it.each(["openai", "anthropic"] as const)("returns the %s usage next to the text", async (format) => {
    const usage = format === "openai" ? { prompt_tokens: 321, completion_tokens: 54 } : { input_tokens: 321, output_tokens: 54 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answerWith(format, "A fair answer.", usage)));
    expect(await llmComplete({ ...base, format }, input)).toEqual({ ok: true, text: "A fair answer.", usage: { inputTokens: 321, outputTokens: 54 } });
  });

  it.each(["openai", "anthropic"] as const)("returns exactly {ok, text} when the provider reports no usage (%s), so existing callers and tests see no change", async (format) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answerWith(format, "No counts here.")));
    const reply = await llmComplete({ ...base, format }, input);
    expect(reply).toStrictEqual({ ok: true, text: "No counts here." });
    expect("usage" in reply).toBe(false);
  });

  it("carries the counts on a failure too when the provider answered with no text, because that call still cost what the provider says", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "   " } }], usage: { prompt_tokens: 40, completion_tokens: 0 } }))));
    expect(await llmComplete(base, input)).toStrictEqual({ ok: false, status: 0, usage: { inputTokens: 40, outputTokens: 0 } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [] }))));
    expect(await llmComplete(base, input)).toStrictEqual({ ok: false, status: 0 });
  });

  it("reports an HTTP failure by status only, and never includes the key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream says server-secret-key is wrong", { status: 401 })));
    const reply = await llmComplete(base, input);
    expect(reply).toStrictEqual({ ok: false, status: 401 });
    expect(JSON.stringify(reply)).not.toContain("server-secret-key");
  });

  it("returns a failure without usage when the call never completed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom server-secret-key")));
    const reply = await llmComplete(base, input);
    expect(reply).toStrictEqual({ ok: false, status: 0 });
  });
});
