import { describe, expect, it } from "vitest";
import { parsePromptAuditResponse } from "@/server/integrations/hermes/inference-only";

const base = {
  ok: true,
  requestId: "9ac702c3-4b0f-47fd-8e69-081f27544bb3",
  mode: "prompt_audit",
  role: "lead_hunter",
  profile: "iacquire-lead-hunter",
  hermesVersion: "0.22.5",
  soulBytes: 2_404,
  providerOnlyMessageBytes: 5_900,
  chatMessageBytes: 5_940,
  syntheticProviderRequests: 2,
  toolSchemas: 0,
  toolCalls: 0,
};

describe("Hermes no-call prompt audit response", () => {
  it("accepts pinned role measurements and preserves application byte counts", () => {
    expect(parsePromptAuditResponse(base, {
      requestId: "9ac702c3-4b0f-47fd-8e69-081f27544bb3",
      role: "lead_hunter",
      appInstructionBytes: 4_812,
    })).toEqual({
      requestId: "9ac702c3-4b0f-47fd-8e69-081f27544bb3",
      role: "lead_hunter",
      profile: "iacquire-lead-hunter",
      hermesVersion: "0.22.5",
      appInstructionBytes: 4_812,
      soulBytes: 2_404,
      providerOnlyMessageBytes: 5_900,
      chatMessageBytes: 5_940,
      syntheticProviderRequests: 2,
      promptLimitBytes: 24_576,
    });
  });

  it("reports live-sized measurements against the 24 KiB budget", () => {
    // Lead Hunter in the 2026-10-30 audit: 14,091 bytes of instructions, 17,910 as a chat message.
    const live = parsePromptAuditResponse(
      { ...base, soulBytes: 2_404, providerOnlyMessageBytes: 17_873, chatMessageBytes: 17_910 },
      { requestId: base.requestId, role: "lead_hunter", appInstructionBytes: 14_091 },
    );
    expect(live.promptLimitBytes).toBe(24_576);
    expect(live.chatMessageBytes).toBeLessThanOrEqual(live.promptLimitBytes);
  });

  it("rejects a different profile, unexpected tool exposure, and oversized invalid counts", () => {
    const expected = { requestId: base.requestId, role: "lead_hunter" as const, appInstructionBytes: 100 };
    expect(() => parsePromptAuditResponse({ ...base, profile: "iacquire-crm-manager" }, expected)).toThrow();
    expect(() => parsePromptAuditResponse({ ...base, toolSchemas: 1 }, expected)).toThrow();
    expect(() => parsePromptAuditResponse({ ...base, chatMessageBytes: 48 * 1024 + 1 }, expected)).toThrow();
  });
});
