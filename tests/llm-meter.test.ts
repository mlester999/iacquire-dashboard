import crypto from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { currentRate, getBalance } from "@/server/billing/ledger";
import { publishUnitRate } from "@/server/billing/service";
import { applyMarkup } from "@/lib/billing";
import { chargeModelUsage, meterModelUse, modelCallKey, recordModelUse } from "@/server/llm/meter";
import { messagingOrg, type MessagingOrg } from "./support/messaging";

// The shared metering helper for model calls. Real services on the embedded database; no model is involved, only the token counts one reported.
// Order matters in this file: the first tests run before any "llm" unit rate is published (nothing is priced), the later ones after.

let m: MessagingOrg;
let other: MessagingOrg;
beforeAll(async () => {
  m = await messagingOrg({ name: "Meter Co", credits: 50 });
  other = await messagingOrg({ name: "Other Meter Co", credits: 50 });
});

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const lines = (orgId: string, feature?: string) =>
  rows<{ unit_type: string; quantity: string; wholesale_micros: string; client_micros: string; charged_micros: string; uncollected_micros: string; billing_status: string; provider: string; job_reference: string; provider_reference: string }>(
    `select unit_type, quantity::text, wholesale_micros::text, client_micros::text, charged_micros::text, uncollected_micros::text, billing_status, provider, job_reference, provider_reference
     from metered_usage_events where org_id = $1 and provider = 'llm' ${feature ? "and job_reference = $2" : ""} order by unit_type, provider_reference`,
    feature ? [orgId, `ai:${feature}`] : [orgId],
  );
const balance = async (org: MessagingOrg) => (await withSystem((db) => getBalance(db, org.org.id))).availableMicros;
const incidents = (key: string) => rows<{ occurrences: number; status: string; title: string; detail: string; org_id: string | null }>("select occurrences, status, title, detail, org_id from incidents where dedupe_key = $1", [key]);

describe("recording a call when no rate is published", () => {
  it("records the tokens as zero-cost lines, tagged with the feature, and charges nothing", async () => {
    const before = await balance(m);
    const r = await meterModelUse({ orgId: m.org.id, feature: "inbox_ai", key: "call-1", usage: { inputTokens: 1200, outputTokens: 300 } });
    expect(r).toEqual({ status: "recorded", chargedMicros: 0, uncollectedMicros: 0 });
    expect(await lines(m.org.id, "inbox_ai")).toEqual([
      expect.objectContaining({ unit_type: "ai_tokens_in", quantity: "1200.000000", wholesale_micros: "0", client_micros: "0", charged_micros: "0", billing_status: "settled", provider: "llm", job_reference: "ai:inbox_ai", provider_reference: "ai:inbox_ai:call-1:ai_tokens_in" }),
      expect.objectContaining({ unit_type: "ai_tokens_out", quantity: "300.000000", provider_reference: "ai:inbox_ai:call-1:ai_tokens_out" }),
    ]);
    expect(await balance(m)).toBe(before);
  });

  it("records a call once: the same key again changes nothing, a different key is another call", async () => {
    const again = await meterModelUse({ orgId: m.org.id, feature: "inbox_ai", key: "call-1", usage: { inputTokens: 1200, outputTokens: 300 } });
    expect(again.status).toBe("duplicate");
    expect(await lines(m.org.id, "inbox_ai")).toHaveLength(2);
    expect((await meterModelUse({ orgId: m.org.id, feature: "inbox_ai", key: "call-2", usage: { inputTokens: 5, outputTokens: 6 } })).status).toBe("recorded");
    expect(await lines(m.org.id, "inbox_ai")).toHaveLength(4);
    // The same key under another feature is another call, and under another workspace too.
    expect((await meterModelUse({ orgId: m.org.id, feature: "support_ai", key: "call-1", usage: { inputTokens: 5, outputTokens: null } })).status).toBe("recorded");
    expect((await meterModelUse({ orgId: other.org.id, feature: "inbox_ai", key: "call-1", usage: { inputTokens: 5, outputTokens: null } })).status).toBe("recorded");
    expect(await lines(other.org.id)).toHaveLength(1);
  });

  it("leaves nothing behind for a call that reported no tokens, and says so", async () => {
    const before = (await lines(m.org.id)).length;
    for (const usage of [null, undefined, { inputTokens: null, outputTokens: null }, { inputTokens: 0, outputTokens: 0 }, { inputTokens: -5, outputTokens: Number.NaN }]) {
      expect(await meterModelUse({ orgId: m.org.id, feature: "inbox_ai", key: "no-tokens", usage }), JSON.stringify(usage)).toEqual({ status: "no_usage", chargedMicros: 0, uncollectedMicros: 0 });
    }
    expect((await lines(m.org.id)).length).toBe(before);
  });

  it("records only the side the provider reported", async () => {
    await meterModelUse({ orgId: m.org.id, feature: "help_assistant", key: "out-only", usage: { inputTokens: null, outputTokens: 77 } });
    expect(await lines(m.org.id, "help_assistant")).toEqual([expect.objectContaining({ unit_type: "ai_tokens_out", quantity: "77.000000" })]);
  });

  it("does not charge the Hermes reply path for a unit nobody priced either", async () => {
    const messageId = crypto.randomUUID();
    await withSystem((db) => chargeModelUsage(db, m.org.id, messageId, { inputTokens: 400, outputTokens: 100 }));
    expect(await rows("select 1 from metered_usage_events where org_id = $1 and provider_reference like $2", [m.org.id, `reply:${messageId}:%`])).toHaveLength(0);
  });
});

describe("failures never reach the caller", () => {
  it("returns failed for a workspace that does not exist, logs only the error class, and opens one platform incident that later failures refresh", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const ghost = crypto.randomUUID();
      const r = await meterModelUse({ orgId: ghost, feature: "webchat_reply", key: "ghost-1", usage: { inputTokens: 10, outputTokens: 10 } });
      expect(r).toEqual({ status: "failed", chargedMicros: 0, uncollectedMicros: 0 });
      expect(log).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(log.mock.calls[0]);
      expect(logged).toMatch(/webchat_reply/);
      expect(logged).not.toContain(ghost);
      const [inc] = await incidents("metering:failed:webchat_reply");
      expect(inc).toMatchObject({ occurrences: 1, status: "open", org_id: null });
      expect(inc.title).toMatch(/AI usage could not be recorded \(webchat_reply\)/);
      expect(inc.detail).not.toContain(ghost);
      await meterModelUse({ orgId: ghost, feature: "webchat_reply", key: "ghost-2", usage: { inputTokens: 10, outputTokens: 10 } });
      expect(await incidents("metering:failed:webchat_reply")).toEqual([expect.objectContaining({ occurrences: 2, status: "open" })]);
      // Nothing was recorded for the failed calls, and a workspace that exists is not affected.
      expect(await rows("select 1 from metered_usage_events where provider_reference like 'ai:webchat_reply:ghost-%'")).toHaveLength(0);
    } finally {
      log.mockRestore();
    }
  });

  it("treats a bad feature name or key as a failure to report, not a crash", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const bad of [{ feature: "Not A Feature", key: "k" }, { feature: "x", key: "k" }, { feature: "ok_feature", key: "" }, { feature: "ok_feature", key: "k".repeat(121) }]) {
        const r = await meterModelUse({ orgId: m.org.id, ...bad, usage: { inputTokens: 1, outputTokens: 1 } });
        expect(r.status, JSON.stringify(bad)).toBe("failed");
      }
      expect((await incidents("metering:failed:unknown"))[0].status).toBe("open");
    } finally {
      log.mockRestore();
    }
  });

  it("recordModelUse, inside a caller's transaction, throws instead, so that caller decides", async () => {
    await expect(withSystem((db) => recordModelUse(db, { orgId: crypto.randomUUID(), feature: "social_ai", key: "tx-1", usage: { inputTokens: 1, outputTokens: 1 } }))).rejects.toThrow();
  });
});

describe("keys", () => {
  it("makes a key unique to each call, within the length the usage line allows", () => {
    const keys = new Set(Array.from({ length: 200 }, () => modelCallKey("inbound-message-id")));
    expect(keys.size).toBe(200);
    expect(modelCallKey("p".repeat(500)).length).toBeLessThanOrEqual(120);
  });

  it("keeps a very long key within the 160 characters of a usage reference without letting two keys collapse into one", async () => {
    const a = "a".repeat(100);
    const b = `${"a".repeat(99)}b`;
    await meterModelUse({ orgId: m.org.id, feature: "lead_scoring", key: a, usage: { inputTokens: 3, outputTokens: null } });
    await meterModelUse({ orgId: m.org.id, feature: "lead_scoring", key: b, usage: { inputTokens: 3, outputTokens: null } });
    const stored = await lines(m.org.id, "lead_scoring");
    expect(stored).toHaveLength(2);
    expect(stored.every((l) => l.provider_reference.length <= 160)).toBe(true);
    expect(new Set(stored.map((l) => l.provider_reference)).size).toBe(2);
  });
});

describe("charging where a rate is published", () => {
  // Rates are per 1,000 tokens, in micro-dollars wholesale, exactly as the Hermes reply path reads them.
  const IN = 2_000;
  const OUT = 6_000;
  beforeAll(async () => {
    await publishUnitRate(m.superAdmin, { provider: "llm", unitType: "ai_tokens_in", wholesaleMicrosPerUnit: IN });
    await publishUnitRate(m.superAdmin, { provider: "llm", unitType: "ai_tokens_out", wholesaleMicrosPerUnit: OUT });
  });
  const expected = async (tokensIn: number, tokensOut: number) => {
    const bps = (await withSystem((db) => currentRate(db))).markupBps;
    const wIn = Math.ceil((IN * tokensIn) / 1000);
    const wOut = Math.ceil((OUT * tokensOut) / 1000);
    return { wIn, wOut, cIn: applyMarkup(wIn, bps), cOut: applyMarkup(wOut, bps) };
  };

  it("charges the workspace's credits for the tokens, once, and records each line with what was charged", async () => {
    const e = await expected(1500, 500);
    const before = await balance(m);
    const r = await meterModelUse({ orgId: m.org.id, feature: "webchat_reply", key: "priced-1", usage: { inputTokens: 1500, outputTokens: 500 } });
    expect(r).toEqual({ status: "recorded", chargedMicros: e.cIn + e.cOut, uncollectedMicros: 0 });
    expect(await balance(m)).toBe(before - (e.cIn + e.cOut));
    expect(await lines(m.org.id, "webchat_reply")).toEqual([
      expect.objectContaining({ unit_type: "ai_tokens_in", wholesale_micros: String(e.wIn), client_micros: String(e.cIn), charged_micros: String(e.cIn), billing_status: "settled" }),
      expect.objectContaining({ unit_type: "ai_tokens_out", wholesale_micros: String(e.wOut), client_micros: String(e.cOut), charged_micros: String(e.cOut) }),
    ]);
    const ledger = await rows<{ kind: string; delta_micros: string }>("select kind, delta_micros::text from credit_ledger_entries where org_id = $1 and kind = 'usage_consumed' order by id desc limit 2", [m.org.id]);
    expect(ledger.map((l) => Number(l.delta_micros)).sort()).toEqual([-e.cIn, -e.cOut].sort());
  });

  it("never charges one call twice, however many times its recording is replayed", async () => {
    const before = await balance(m);
    for (let i = 0; i < 4; i += 1) {
      expect((await meterModelUse({ orgId: m.org.id, feature: "webchat_reply", key: "priced-1", usage: { inputTokens: 1500, outputTokens: 500 } })).status).toBe("duplicate");
    }
    expect(await balance(m)).toBe(before);
    expect(await lines(m.org.id, "webchat_reply")).toHaveLength(2);
  });

  it("replays concurrently without charging twice either", async () => {
    const key = "priced-concurrent";
    const before = await balance(m);
    const e = await expected(800, 200);
    const results = await Promise.all(Array.from({ length: 5 }, () => meterModelUse({ orgId: m.org.id, feature: "social_ai", key, usage: { inputTokens: 800, outputTokens: 200 } })));
    expect(results.filter((r) => r.status === "recorded")).toHaveLength(1);
    expect(results.filter((r) => r.status === "duplicate")).toHaveLength(4);
    expect(await balance(m)).toBe(before - (e.cIn + e.cOut));
  });

  it("rounds each line up to a whole micro-dollar, and charges any token count the formula says, never a negative amount", async () => {
    const org = await messagingOrg({ name: "Property Meter Co", credits: 500 });
    let seed = 99;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let i = 0; i < 25; i += 1) {
      const tin = 1 + (next() % 30_000);
      const tout = 1 + (next() % 9_000);
      const e = await expected(tin, tout);
      const before = await balance(org);
      const r = await meterModelUse({ orgId: org.org.id, feature: "inbox_ai", key: `prop-${i}`, usage: { inputTokens: tin, outputTokens: tout } });
      expect(r.chargedMicros, `${tin}/${tout}`).toBe(e.cIn + e.cOut);
      expect(r.chargedMicros).toBeGreaterThan(0);
      expect(await balance(org)).toBe(before - r.chargedMicros);
    }
    expect(await balance(org)).toBeGreaterThanOrEqual(0);
  });

  it("records what could not be collected when the balance runs out, never taking the balance below zero, and tells the owners", async () => {
    const broke = await messagingOrg({ name: "Broke Meter Co", credits: 0 });
    const e = await expected(1000, 1000);
    const r = await meterModelUse({ orgId: broke.org.id, feature: "webchat_reply", key: "broke-1", usage: { inputTokens: 1000, outputTokens: 1000 } });
    expect(r).toEqual({ status: "recorded", chargedMicros: 0, uncollectedMicros: e.cIn + e.cOut });
    expect(await balance(broke)).toBe(0);
    expect((await lines(broke.org.id)).map((l) => l.billing_status)).toEqual(["uncollected", "uncollected"]);
    expect(await rows("select 1 from notifications where org_id = $1 and kind = 'billing_credits_exhausted'", [broke.org.id])).not.toHaveLength(0);
  });

  it("uses the same charge as the Hermes reply path for the same tokens, keyed by the reply message and charged once", async () => {
    const e = await expected(400, 100);
    const messageId = crypto.randomUUID();
    const before = await balance(m);
    await withSystem((db) => chargeModelUsage(db, m.org.id, messageId, { inputTokens: 400, outputTokens: 100 }));
    expect(await balance(m)).toBe(before - (e.cIn + e.cOut));
    expect((await rows<{ provider_reference: string }>("select provider_reference from metered_usage_events where org_id = $1 and message_id = $2 order by provider_reference", [m.org.id, messageId])).map((r) => r.provider_reference)).toEqual([`reply:${messageId}:ai_tokens_in`, `reply:${messageId}:ai_tokens_out`]);
    await withSystem((db) => chargeModelUsage(db, m.org.id, messageId, { inputTokens: 400, outputTokens: 100 }));
    expect(await balance(m)).toBe(before - (e.cIn + e.cOut));
    // The meter helper charges the same amount for the same tokens.
    const viaMeter = await meterModelUse({ orgId: m.org.id, feature: "inbox_ai", key: "same-as-hermes", usage: { inputTokens: 400, outputTokens: 100 } });
    expect(viaMeter.chargedMicros).toBe(e.cIn + e.cOut);
  });

  it("keeps one workspace's usage out of another's", async () => {
    expect((await lines(other.org.id)).every((l) => l.provider_reference.includes(":call-1:"))).toBe(true);
    expect(await rows("select 1 from metered_usage_events where org_id = $1 and provider_reference like 'ai:webchat_reply:%'", [other.org.id])).toHaveLength(0);
  });
});
