import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Decision D2 (2026-10-30): the restricted inference path's prompt budget is 24 KiB of effective message text,
// 20,000 instruction characters, 8,192 input tokens and 128 output tokens. The limit lives in three layers (the
// app, the worker and the pinned-runtime runner) and they must agree: an app limit above the worker's, or a
// token check that compares against the byte budget, fails in confusing ways or loosens a safety check.
// docs/hermes-d2-prompt-budget-proposal-2026-10-30.md has the reasoning and the measured sizes.

const root = resolve(__dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const worker = read("services/hermes-inference-worker/worker.py");
const runner = read("services/hermes-inference-worker/inference_runner.py");
const app = read("src/server/integrations/hermes/inference-only.ts");
const deployment = read("services/hermes-inference-worker/DEPLOYMENT.md");

const python = (source: string, name: string) => {
  const match = source.match(new RegExp(`^${name} = ([\\d_]+)$`, "m"));
  if (!match) throw new Error(`${name} not found`);
  return Number(match[1].replace(/_/g, ""));
};
const typescript = (name: string) => {
  const match = app.match(new RegExp(`const ${name} = ([\\d_]+);`));
  if (!match) throw new Error(`${name} not found`);
  return Number(match[1].replace(/_/g, ""));
};

describe("restricted inference prompt budget (D2)", () => {
  it("is 24 KiB of message text in all three layers", () => {
    expect(python(worker, "MAX_PROMPT_BYTES")).toBe(24_576);
    expect(python(runner, "MAX_PROMPT_BYTES")).toBe(24_576);
    expect(typescript("MAX_PROMPT_BYTES")).toBe(24_576);
    expect(app).toContain("promptLimitBytes: 24_576;");
  });

  it("keeps the token ceilings in all three layers", () => {
    for (const value of [python(worker, "MAX_INPUT_TOKENS"), python(runner, "MAX_INPUT_TOKENS"), typescript("MAX_INPUT_TOKENS")]) {
      expect(value).toBe(8_192);
    }
    for (const value of [python(worker, "MAX_OUTPUT_TOKENS"), python(runner, "MAX_OUTPUT_TOKENS"), typescript("MAX_OUTPUT_TOKENS")]) {
      expect(value).toBe(128);
    }
  });

  it("checks provider-reported prompt tokens against the token ceiling, never against the byte budget", () => {
    expect(runner).toContain("prompt > MAX_INPUT_TOKENS");
    expect(runner).not.toContain("prompt > MAX_PROMPT_BYTES");
  });

  it("lets the largest measured role fit, with the instruction character cap above it", () => {
    // Lead Hunter in the 2026-10-30 no-call audit: 14,091 bytes of instructions, a 17,910-byte chat message.
    expect(python(worker, "MAX_INSTRUCTIONS_CHARS")).toBe(20_000);
    expect(14_091).toBeLessThan(python(worker, "MAX_INSTRUCTIONS_CHARS"));
    expect(17_910).toBeLessThan(typescript("MAX_PROMPT_BYTES"));
  });

  it("keeps the request body limits above a full budget", () => {
    // A 24 KiB prompt plus JSON framing and escaping has to fit the worker's and the app's 48 KiB body limits.
    expect(worker).toContain("MAX_BODY_BYTES = 48 * 1024");
    expect(app).toContain("const MAX_WORKER_BODY_BYTES = 48 * 1024;");
    expect(48 * 1024).toBeGreaterThan(1.5 * typescript("MAX_PROMPT_BYTES"));
  });

  it("is documented with the new numbers and not the old ones", () => {
    expect(deployment).toContain("24,576 UTF-8 bytes");
    expect(deployment).toContain("8,192 input");
    expect(deployment).not.toMatch(/(capped at|above|over) 6,144/);
  });
});
