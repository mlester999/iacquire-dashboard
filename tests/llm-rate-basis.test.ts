// The published rate for a model's tokens is a price per 1,000 tokens (src/server/llm/meter.ts charges ceil(rate x tokens / 1000)). The Super Admin form, the stored
// unit label and the error text must all say so, and a rate entered the way the screen asks must charge what the screen says. Real billing services on the
// embedded database; no model is involved, only token counts.
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { currentRate } from "@/server/billing/ledger";
import { publishUnitRate } from "@/server/billing/service";
import { listCurrentUnitRates } from "@/server/billing/rates";
import { UNIT_LABELS, applyMarkup, rateFieldHint, rateFieldLabel, ratePlaceholder, rateSanityNote, rateUnitLabel, usdToMicros } from "@/lib/billing";
import { recordModelUse } from "@/server/llm/meter";
import { messagingOrg, type MessagingOrg } from "./support/messaging";

let m: MessagingOrg;
beforeAll(async () => {
  m = await messagingOrg({ name: "Rate Basis Co", credits: 50 });
});

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;

describe("what the screen says", () => {
  it("names the token units 'per 1,000' wherever a rate is shown, and leaves the other units as they were", () => {
    expect(rateUnitLabel("ai_tokens_in")).toBe("AI input tokens (per 1,000)");
    expect(rateUnitLabel("ai_tokens_out")).toBe("AI output tokens (per 1,000)");
    expect(rateUnitLabel("sms_segment")).toBe(UNIT_LABELS.sms_segment);
    expect(rateUnitLabel("something_new")).toBe("something_new");
    // The plain labels stay plain: they name a quantity of tokens on a usage line, not a price.
    expect(UNIT_LABELS.ai_tokens_in).toBe("AI input tokens");
  });

  it("labels the amount field per 1,000 tokens for the token units, and per unit otherwise", () => {
    expect(rateFieldLabel("ai_tokens_in")).toBe("We pay (USD per 1,000 tokens)");
    expect(rateFieldLabel("ai_tokens_out")).toBe("We pay (USD per 1,000 tokens)");
    expect(rateFieldLabel("sms_segment")).toBe("We pay (USD per unit)");
    expect(rateFieldHint("ai_tokens_in")).toMatch(/1,000 tokens, not one token/);
    expect(rateFieldHint("ai_tokens_in")).toMatch(/per million tokens.*divide it by 1,000/);
    expect(rateFieldHint("sms_segment")).toBeUndefined();
    expect(ratePlaceholder("ai_tokens_in")).not.toBe(ratePlaceholder("sms_segment"));
  });

  it("warns, without refusing, when a token rate looks like a price per single token or per million", () => {
    expect(rateSanityNote("ai_tokens_in", 0.000003)).toMatch(/per single token/);
    expect(rateSanityNote("ai_tokens_out", 15)).toMatch(/per million tokens/);
    expect(rateSanityNote("ai_tokens_in", 0.002)).toBeNull();
    expect(rateSanityNote("ai_tokens_in", 0.0003)).toBeNull(); // $0.30 per million tokens, a cheap model
    expect(rateSanityNote("sms_segment", 0.000003)).toBeNull();
    expect(rateSanityNote("ai_tokens_in", 0)).toBeNull();
    expect(rateSanityNote("ai_tokens_in", Number.NaN)).toBeNull();
  });
});

describe("what a published token rate charges", () => {
  it("is exactly what was typed per 1,000 tokens: $0.002 per 1,000 input tokens costs $0.002 for 1,000 and $0.005 for 2,500", async () => {
    // The Super Admin types 0.002 under "USD per 1,000 tokens"; the form's action turns dollars into micro-dollars the same way as usdToMicros.
    const typed = 0.002;
    await publishUnitRate(m.superAdmin, { provider: "llm", unitType: "ai_tokens_in", wholesaleMicrosPerUnit: usdToMicros(typed) });
    const bps = (await withSystem((db) => currentRate(db))).markupBps;

    await withSystem((db) => recordModelUse(db, { orgId: m.org.id, feature: "rate_basis", key: "thousand", usage: { inputTokens: 1000, outputTokens: null } }));
    await withSystem((db) => recordModelUse(db, { orgId: m.org.id, feature: "rate_basis", key: "twenty-five-hundred", usage: { inputTokens: 2500, outputTokens: null } }));
    const lines = await rows<{ quantity: string; wholesale_micros: string; client_micros: string; provider_reference: string }>(
      "select quantity::text, wholesale_micros::text, client_micros::text, provider_reference from metered_usage_events where org_id = $1 and provider = 'llm' and job_reference = 'ai:rate_basis' order by quantity",
      [m.org.id],
    );
    expect(lines.map((l) => [l.quantity, l.wholesale_micros])).toEqual([["1000.000000", String(usdToMicros(typed))], ["2500.000000", String(usdToMicros(typed * 2.5))]]);
    expect(lines.map((l) => l.client_micros)).toEqual([String(applyMarkup(usdToMicros(typed), bps)), String(applyMarkup(usdToMicros(typed * 2.5), bps))]);
  });

  it("stores the per-1,000 label, so the admin's rate table and the client's 'Your rate' table both say it", async () => {
    await publishUnitRate(m.superAdmin, { provider: "llm", unitType: "ai_tokens_out", wholesaleMicrosPerUnit: usdToMicros(0.006) });
    const rates = await listCurrentUnitRates();
    expect(rates.find((r) => r.provider === "llm" && r.unitType === "ai_tokens_in")?.label).toBe("AI input tokens (per 1,000)");
    expect(rates.find((r) => r.provider === "llm" && r.unitType === "ai_tokens_out")?.label).toBe("AI output tokens (per 1,000)");
    const stored = await rows<{ unit_label: string }>("select unit_label from usage_unit_rates where provider = 'llm' and unit_type = 'ai_tokens_in'");
    expect(stored[0].unit_label).toBe("AI input tokens (per 1,000)");
  });

  it("says per 1,000 tokens when a token rate is refused, and per unit for the others", async () => {
    await expect(publishUnitRate(m.superAdmin, { provider: "llm", unitType: "ai_tokens_in", wholesaleMicrosPerUnit: 0 })).rejects.toThrow(/per 1,000 tokens/);
    await expect(publishUnitRate(m.superAdmin, { provider: "ghl", unitType: "sms_segment", wholesaleMicrosPerUnit: 0 })).rejects.toThrow(/per unit/);
    await expect(publishUnitRate(m.superAdmin, { provider: "llm", unitType: "ai_tokens_in", wholesaleMicrosPerUnit: 1.5 })).rejects.toThrow(/micro-dollars/);
  });

  it("leaves a unit that is not tokens labelled as it always was", async () => {
    await publishUnitRate(m.superAdmin, { provider: "ghl", unitType: "email_send", wholesaleMicrosPerUnit: 400 });
    const stored = await rows<{ unit_label: string }>("select unit_label from usage_unit_rates where provider = 'ghl' and unit_type = 'email_send' order by published_at desc limit 1");
    expect(stored[0].unit_label).toBe(UNIT_LABELS.email_send);
  });
});
