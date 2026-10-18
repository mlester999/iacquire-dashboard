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
});
