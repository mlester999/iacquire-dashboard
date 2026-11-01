import { describe, expect, it } from "vitest";
import { INDUSTRY_OPTIONS, QUESTION_BY_ID } from "@/lib/onboarding/definitions";
import { MAPPED_INDUSTRY_VALUES, MAPPED_LOCAL_KINDS, starterKeyForIndustry } from "@/lib/crm/blueprints/industry-map";
import { getStarter, STARTER_BLUEPRINTS, STARTER_KEYS } from "@/lib/crm/blueprints/starters";

// Which starter Blueprint a questionnaire industry gets. The questionnaire and the starters are maintained separately, so these tests are what stops one drifting away from the other:
// a new industry option with no mapping, or a renamed starter, fails here instead of quietly sending a client to the wrong CRM.

/** Questionnaire values that have no row on purpose: "something else" is exactly the fallback. */
const FALLBACK_BY_DESIGN = ["other"];

describe("the industry map is total over the questionnaire", () => {
  it("gives every industry option a row of its own, except the ones that are the fallback by design", () => {
    const options = INDUSTRY_OPTIONS.map((o) => o.value);
    const missing = options.filter((v) => !MAPPED_INDUSTRY_VALUES.includes(v) && !FALLBACK_BY_DESIGN.includes(v));
    // A new option added to the questionnaire without a mapping lands here.
    expect(missing).toEqual([]);
    // And the table has no row for an industry the questionnaire no longer offers.
    expect(MAPPED_INDUSTRY_VALUES.filter((v) => !options.includes(v))).toEqual([]);
  });

  it("maps every option to a starter that exists, with a stated reason and a sentence for the client", () => {
    for (const option of INDUSTRY_OPTIONS) {
      const m = starterKeyForIndustry(option.value);
      expect(STARTER_KEYS, option.value).toContain(m.starterKey);
      expect(getStarter(m.starterKey), option.value).not.toBeNull();
      expect(["matched", "closest", "fallback"]).toContain(m.reason);
      expect(m.note.length).toBeGreaterThan(10);
      expect(m.industry).toBe(STARTER_BLUEPRINTS.find((s) => s.blueprint.key === m.starterKey)?.blueprint.industry);
    }
  });

  it("matches the industries that have a starter of their own and says so when it is only the closest fit", () => {
    const reasonOf = (v: string) => starterKeyForIndustry(v).reason;
    expect(starterKeyForIndustry("home_services")).toMatchObject({ industry: "home_services", reason: "matched" });
    expect(starterKeyForIndustry("real_estate")).toMatchObject({ industry: "real_estate", reason: "matched" });
    expect(starterKeyForIndustry("healthcare")).toMatchObject({ industry: "healthcare_wellness", reason: "matched" });
    expect(starterKeyForIndustry("consulting")).toMatchObject({ industry: "consulting", reason: "matched" });
    expect(starterKeyForIndustry("legal_finance")).toMatchObject({ industry: "professional_services", reason: "matched" });
    expect(starterKeyForIndustry("agency")).toMatchObject({ industry: "consulting", reason: "closest" });
    expect(starterKeyForIndustry("ecommerce")).toMatchObject({ industry: "general_services", reason: "closest" });
    expect(starterKeyForIndustry("local_services")).toMatchObject({ industry: "general_services", reason: "closest" });
    expect(reasonOf("other")).toBe("fallback");
  });
});

describe("a local service business is matched by what kind of business it is", () => {
  it.each([
    ["beauty", "beauty_salons"],
    ["auto", "automotive"],
    ["education", "education_coaching"],
    ["food", "restaurants"],
  ])("%s gets the %s starter", (localKind, industry) => {
    expect(starterKeyForIndustry("local_services", { localKind })).toMatchObject({ industry, reason: "matched" });
  });

  it("falls back to the closest general starter for another kind, a blank or a missing answer", () => {
    for (const localKind of ["other", "", "  ", null, undefined, "nonsense"]) {
      expect(starterKeyForIndustry("local_services", { localKind })).toMatchObject({ industry: "general_services", reason: "closest" });
    }
    expect(starterKeyForIndustry("local_services")).toMatchObject({ industry: "general_services", reason: "closest" });
  });

  it("ignores the follow-up answer for any other industry", () => {
    expect(starterKeyForIndustry("home_services", { localKind: "beauty" })).toMatchObject({ industry: "home_services" });
    expect(starterKeyForIndustry("other", { localKind: "beauty" })).toMatchObject({ industry: "general_services", reason: "fallback" });
  });

  it("is asked by the questionnaire, only of a local service business, and never required", () => {
    // The map reads `a.local_kind`; without a question that stores it, every local business would get the general starter and the note would point at nothing.
    const q = QUESTION_BY_ID["a.local_kind"];
    expect(q).toBeDefined();
    expect(q.kind.type).toBe("choice");
    expect(q.required).toBeFalsy();
    expect(q.show?.({ "a.industry": "local_services" })).toBe(true);
    for (const o of INDUSTRY_OPTIONS.filter((i) => i.value !== "local_services")) expect(q.show?.({ "a.industry": o.value }), o.value).toBe(false);
  });

  it("covers every option of the follow-up question", () => {
    const q = QUESTION_BY_ID["a.local_kind"];
    if (q.kind.type !== "choice") throw new Error("a.local_kind must be a choice question");
    const values = q.kind.options.map((o) => o.value).filter((v) => v !== "other");
    expect(values.filter((v) => !MAPPED_LOCAL_KINDS.includes(v))).toEqual([]);
    expect(MAPPED_LOCAL_KINDS.filter((k) => !values.includes(k))).toEqual([]);
  });

  it("can reach every starter the library has", () => {
    const reached = new Set([
      ...INDUSTRY_OPTIONS.map((o) => starterKeyForIndustry(o.value).starterKey),
      ...MAPPED_LOCAL_KINDS.map((k) => starterKeyForIndustry("local_services", { localKind: k }).starterKey),
    ]);
    expect([...reached].sort()).toEqual([...STARTER_KEYS].sort());
  });
});

describe("an answer nobody mapped is the fallback, never an error", () => {
  it.each([
    ["an unknown value", "plumber"],
    ["an empty value", ""],
    ["whitespace", "   "],
    ["a missing answer", null],
    ["an undefined answer", undefined],
    ["the label instead of the value", "Home services"],
    ["the wrong case", "HOME_SERVICES"],
    ["an object property name", "constructor"],
    ["a prototype key", "__proto__"],
  ])("%s maps to General Services with reason fallback", (_name, value) => {
    const m = starterKeyForIndustry(value);
    expect(m).toMatchObject({ industry: "general_services", reason: "fallback" });
    expect(STARTER_KEYS).toContain(m.starterKey);
  });

  it("matches on the stored value exactly, not on the label a person reads", () => {
    for (const o of INDUSTRY_OPTIONS) {
      if (o.value === "other") continue;
      expect(starterKeyForIndustry(o.label).reason, o.label).toBe("fallback");
    }
  });
});
