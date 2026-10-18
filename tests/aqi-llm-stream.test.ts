import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LlmStreamError, llmStream, type LlmConfig } from "@/server/llm/client";

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"from AQi"}}]}\n\n');
      res.write('data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":3}}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    if (req.url === "/v1/messages" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"type":"content_block_delta","delta":{"text":"Anthropic "}}\n\n');
      res.write('data: {"type":"content_block_delta","delta":{"text":"answer"}}\n\n');
      res.write('data: {"type":"message_delta","usage":{"output_tokens":4}}\n\n');
      res.end();
      return;
    }
    if (req.url === "/plain/chat/completions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "Plain answer" } }], usage: { prompt_tokens: 2, completion_tokens: 2 } }));
      return;
    }
    if (req.url === "/v1/rate/chat/completions") {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "12" });
      res.end(JSON.stringify({ error: "rate_limited" }));
      return;
    }
    if (req.url === "/v1/slow/chat/completions") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"First "}}]}\n\n');
      const timer = setTimeout(() => { res.write('data: {"choices":[{"delta":{"content":"late"}}]}\n\n'); res.end(); }, 5000);
      req.on("close", () => clearTimeout(timer));
      return;
    }
    if (req.url === "/v1/partial/chat/completions") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"Partial "}}]}\n\n');
      setTimeout(() => res.destroy(), 50);
      return;
    }
    if (req.url === "/v1/timeout/chat/completions") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      return;
    }
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unavailable" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

function config(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return { baseUrl: `${baseUrl}/v1`, format: "openai", model: "test-model", apiKey: "test-key", source: "portal", ...overrides };
}

describe("AQi provider streaming", () => {
  it("streams OpenAI deltas and usage", async () => {
    const events = [];
    for await (const event of llmStream(config(), { system: "test", messages: [{ role: "user", content: "Hello" }], maxTokens: 50 })) events.push(event);
    expect(events.filter((event) => event.type === "delta").map((event) => "text" in event ? event.text : "").join("")).toBe("Hello from AQi");
    expect(events).toContainEqual({ type: "usage", inputTokens: 11, outputTokens: 3 });
  });

  it("streams Anthropic deltas", async () => {
    const events = [];
    for await (const event of llmStream(config({ format: "anthropic", baseUrl }), { system: "test", messages: [{ role: "user", content: "Hello" }], maxTokens: 50 })) events.push(event);
    expect(events.filter((event) => event.type === "delta").map((event) => "text" in event ? event.text : "").join("")).toBe("Anthropic answer");
  });

  it("falls back to a plain JSON response when streaming is not available", async () => {
    const events = [];
    for await (const event of llmStream(config({ baseUrl: `${baseUrl}/plain` }), { system: "test", messages: [{ role: "user", content: "Hello" }], maxTokens: 50 })) events.push(event);
    expect(events).toContainEqual({ type: "delta", text: "Plain answer" });
  });

  it("fails honestly when the provider rejects the request", async () => {
    await expect(async () => {
      for await (const event of llmStream(config({ baseUrl: `${baseUrl}/bad` }), { system: "test", messages: [{ role: "user", content: "Hello" }], maxTokens: 50 })) void event;
    }).rejects.toBeInstanceOf(LlmStreamError);
  });

  it("reports HTTP 429 as a retryable provider status", async () => {
    await expect(async () => {
      for await (const event of llmStream(config({ baseUrl: `${baseUrl}/v1/rate` }), { system: "test", messages: [{ role: "user", content: "Hello" }], maxTokens: 50 })) void event;
    }).rejects.toMatchObject({ status: 429 });
  });

  it("stops provider work when the caller aborts", async () => {
    const controller = new AbortController();
    await expect(async () => {
      for await (const event of llmStream(config({ baseUrl: `${baseUrl}/v1/slow` }), { system: "test", messages: [{ role: "user", content: "Hello" }], maxTokens: 50 }, controller.signal)) {
        if (event.type === "delta") controller.abort();
      }
    }).rejects.toMatchObject({ name: "AbortError" });
  });

  it("times out a provider that never answers", async () => {
    await expect(async () => {
      for await (const event of llmStream(config({ baseUrl: `${baseUrl}/v1/timeout` }), { system: "test", messages: [{ role: "user", content: "Hello" }], maxTokens: 50, timeoutMs: 100 })) void event;
    }).rejects.toBeDefined();
  });

  it("does not invent a completion when an interrupted stream ends early", async () => {
    let partial = "";
    let failed = false;
    try {
      for await (const event of llmStream(config({ baseUrl: `${baseUrl}/v1/partial` }), { system: "test", messages: [{ role: "user", content: "Hello" }], maxTokens: 50 })) {
        if (event.type === "delta") partial += event.text;
      }
    } catch {
      failed = true;
    }
    expect(partial).toBe("Partial ");
    expect(failed).toBe(true);
  });
});
