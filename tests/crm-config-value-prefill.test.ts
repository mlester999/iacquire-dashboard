import { describe, expect, it } from "vitest";
import { PREFILLABLE_KEYS, planConfigValuePrefill, type PrefillValue } from "@/lib/crm/blueprints/config-value-prefill";
import { CUSTOM_VALUE_LIMITS } from "@/lib/crm/custom-values";
import { STARTER_BLUEPRINTS } from "@/lib/crm/blueprints/starters";
import type { Answers } from "@/lib/onboarding/types";

// Configuration values that starters leave empty are filled only from answers the client gave, and only for the keys on the list. These are the rules that keep a link, a licence
// number or a payment term from ever being written on the client's behalf.

const value = (key: string, over: Partial<PrefillValue> = {}): PrefillValue => ({ key, label: key, type: "text", value: "", ...over });

const answers: Answers = {
  "a.business_name": "Brightside Roofing",
  "a.location": "Austin, Texas, USA",
  "a.territories": "Austin, Round Rock and Cedar Park",
  "a.hours": { mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]], sat: [["10:00", "14:00"]] },
  "d.appt_cancellation": "Free to reschedule up to 24 hours before.",
  "e.policies": "30-day workmanship warranty.",
  "a.website": "https://brightside.example.test",
};

describe("which values are filled, and from what", () => {
  it("fills each listed key from its own answer", () => {
    const keys = ["service_area", "business_address", "office_address", "clinic_address", "salon_address", "workshop_address", "restaurant_address", "opening_hours", "cancellation_policy", "brokerage_name"];
    const plan = planConfigValuePrefill(answers, keys.map((k) => value(k)));
    expect(Object.fromEntries(plan.map((p) => [p.key, [p.value, p.from]]))).toEqual({
      service_area: ["Austin, Round Rock and Cedar Park", "a.territories"],
      business_address: ["Austin, Texas, USA", "a.location"],
      office_address: ["Austin, Texas, USA", "a.location"],
      clinic_address: ["Austin, Texas, USA", "a.location"],
      salon_address: ["Austin, Texas, USA", "a.location"],
      workshop_address: ["Austin, Texas, USA", "a.location"],
      restaurant_address: ["Austin, Texas, USA", "a.location"],
      opening_hours: ["Mon 09:00–17:00; Tue 09:00–17:00; Sat 10:00–14:00", "a.hours"],
      cancellation_policy: ["Free to reschedule up to 24 hours before.", "d.appt_cancellation"],
      brokerage_name: ["Brightside Roofing", "a.business_name"],
    });
  });

  it("covers every key the module lists and nothing else", () => {
    const plan = planConfigValuePrefill(answers, PREFILLABLE_KEYS.map((k) => value(k)));
    expect(plan.map((p) => p.key).sort()).toEqual([...PREFILLABLE_KEYS].sort());
  });

  it("leaves a key that is not on the list empty, even when an answer could fit it", () => {
    const plan = planConfigValuePrefill(answers, [value("parking_info"), value("drop_off_instructions"), value("some_new_key"), value("service_area")]);
    expect(plan.map((p) => p.key)).toEqual(["service_area"]);
  });
});

describe("what is never filled", () => {
  const sensitive = ["booking_link", "consultation_link", "discovery_call_link", "warranty_link", "warranty_terms", "licence_number", "regulatory_statement", "payment_terms", "quote_terms",
    "refund_policy", "fees_page_link", "intake_form_link", "document_upload_link", "learner_portal_link"];

  it("never fills a link, a licence, a regulatory statement or a payment, warranty or refund term, whatever the client wrote", () => {
    const rich: Answers = { ...answers, "a.territories": "https://example.test/book", "a.location": "Licence 12345", "d.appt_cancellation": "Pay in full", "a.business_name": "Warranty Co" };
    expect(planConfigValuePrefill(rich, sensitive.map((k) => value(k)))).toEqual([]);
    expect(planConfigValuePrefill(rich, sensitive.map((k) => value(k, { type: "url" })))).toEqual([]);
  });

  it("never fills a value that is not plain text, even for a listed key", () => {
    for (const type of ["url", "phone", "email", "number", "color"]) {
      expect(planConfigValuePrefill(answers, [value("service_area", { type })]), type).toEqual([]);
    }
  });

  it("never fills a key that a starter calls a link, a licence or a term, which the real starters prove", () => {
    const configKeys = STARTER_BLUEPRINTS.flatMap((s) => s.assets.customValues.map((v) => ({ key: v.key, type: v.type })));
    expect(configKeys.length).toBeGreaterThan(20);
    const plan = planConfigValuePrefill(answers, configKeys.map((k) => value(k.key, { type: k.type })));
    for (const item of plan) {
      expect(PREFILLABLE_KEYS).toContain(item.key);
      expect(item.key).not.toMatch(/link|licen|regulat|payment|warranty|terms|refund/);
    }
  });

  it("keeps a value that already has text, so what the client edited is never overwritten", () => {
    const plan = planConfigValuePrefill(answers, [
      value("service_area", { value: "Only Austin, please" }),
      value("opening_hours", { value: "By appointment" }),
      value("business_address", { value: "  " }),
    ]);
    expect(plan.map((p) => p.key)).toEqual(["business_address"]);
  });
});

describe("what the answers must look like", () => {
  it("fills nothing when the client gave no answer, or an answer that is empty or unusable", () => {
    const keys = PREFILLABLE_KEYS.map((k) => value(k));
    expect(planConfigValuePrefill({}, keys)).toEqual([]);
    expect(planConfigValuePrefill({ "a.territories": "   ", "a.location": "", "a.business_name": null, "a.hours": {} }, keys)).toEqual([]);
    expect(planConfigValuePrefill({ "a.hours": { mon: [["17:00", "09:00"]] } }, [value("opening_hours")])).toEqual([]);
    expect(planConfigValuePrefill({ "a.territories": ["not", "text"], "a.location": true }, keys)).toEqual([]);
  });

  it("never copies template tokens or control characters into a value, and trims long text to the value limit", () => {
    expect(planConfigValuePrefill({ "a.territories": "Austin {{contact.first_name}}" }, [value("service_area")])).toEqual([]);
    expect(planConfigValuePrefill({ "a.territories": "Aus\u0000tin\u0007" }, [value("service_area")])[0].value).toBe("Austin");
    const long = planConfigValuePrefill({ "d.appt_cancellation": "x".repeat(CUSTOM_VALUE_LIMITS.value + 500) }, [value("cancellation_policy")])[0].value;
    expect(long).toHaveLength(CUSTOM_VALUE_LIMITS.value);
  });

  it("plans each key once and is safe to run again on its own plan", () => {
    const first = planConfigValuePrefill(answers, [value("service_area"), value("opening_hours")]);
    expect(first).toHaveLength(2);
    const filled = first.map((p) => value(p.key, { value: p.value }));
    expect(planConfigValuePrefill(answers, filled)).toEqual([]);
  });
});
