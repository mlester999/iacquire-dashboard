import { describe, expect, it } from "vitest";
import {
  PROFILE_ANSWERS, PROFILE_KEYS, answerPatchesFor, buildSnapshot, deriveProfile, fieldsToWrite, legacyBaseline, parseProfileSnapshot, snapshotAfterSettings, type ProfileValues,
} from "@/lib/onboarding/business-profile";
import { QUESTION_BY_ID } from "@/lib/onboarding/definitions";
import type { Answers } from "@/lib/onboarding/types";

// The pure side of "one source of truth for the business profile": what the answers say, which of it a re-submission may write, and what a Settings edit means for the answers.

const answers = (over: Answers = {}): Answers => ({
  "a.business_name": "Brightside Roofing",
  "a.industry": "home_services",
  "a.website": "https://brightside.test",
  "a.territories": "Austin and Round Rock",
  "a.location": "Austin, Texas",
  "a.timezone": "America/Chicago",
  "a.description": "We repair roofs.",
  "b.services": "Roof repair",
  "b.ideal_customer": "Homeowners with storm damage",
  "a.target_customers": "Older houses",
  "e.brand_colors": { primary: "#2C5BFF", accent: "#12c9a5" },
  ...over,
});

describe("what the answers say about the business", () => {
  it("derives the nine facts Settings and onboarding share, the way the questionnaire always has", () => {
    expect(deriveProfile(answers())).toEqual({
      name: "Brightside Roofing",
      industry: "Home services",
      website: "https://brightside.test",
      region: "Austin and Round Rock · Austin, Texas",
      timezone: "America/Chicago",
      description: "We repair roofs.",
      services: "Roof repair",
      idealCustomers: "Homeowners with storm damage\nOlder houses",
      brandColor: "#2C5BFF",
    });
  });

  it("derives an empty value for what was not answered, never a guess", () => {
    const d = deriveProfile({ "a.business_name": "Only Name" });
    expect(d.name).toBe("Only Name");
    for (const key of PROFILE_KEYS.filter((k) => k !== "name")) expect(d[key]).toBe("");
  });

  it("names the answers each fact depends on, and every one is a real question", () => {
    for (const key of PROFILE_KEYS) for (const id of PROFILE_ANSWERS[key]) expect(QUESTION_BY_ID[id], `${key} -> ${id}`).toBeDefined();
  });
});

describe("which facts a re-submission may write", () => {
  const derived = deriveProfile(answers());

  it("writes everything on the first submission, except a blank time zone or colour, which keep what is there", () => {
    expect(Object.keys(fieldsToWrite(derived, null)).sort()).toEqual([...PROFILE_KEYS].sort());
    const blanks = fieldsToWrite({ ...derived, timezone: "", brandColor: "", website: "" }, null);
    expect(blanks).not.toHaveProperty("timezone");
    expect(blanks).not.toHaveProperty("brandColor");
    expect(blanks.website).toBe("");
  });

  it("writes only the facts whose derived value differs from the last submission", () => {
    const last = buildSnapshot(derived, new Date("2026-10-20T10:00:00Z"));
    expect(fieldsToWrite(derived, last.fields)).toEqual({});
    const next = deriveProfile(answers({ "b.services": "Roof repair and gutters", "a.location": "Dallas" }));
    expect(fieldsToWrite(next, last.fields)).toEqual({ services: "Roof repair and gutters", region: "Austin and Round Rock · Dallas" });
  });

  it("writes a fact the owner cleared since, but never blanks a time zone or colour", () => {
    const last = buildSnapshot(derived, new Date());
    const cleared = deriveProfile(answers({ "a.website": "", "e.brand_colors": { primary: "", accent: "" } }));
    expect(fieldsToWrite(cleared, last.fields)).toEqual({ website: "" });
  });

  it("treats a fact the snapshot does not know as changed", () => {
    const last = buildSnapshot(derived, new Date());
    const { description: _description, ...partial } = last.fields;
    expect(fieldsToWrite(derived, partial)).toEqual({ description: "We repair roofs." });
  });
});

describe("a submission made before snapshots existed", () => {
  it("counts a fact as unchanged unless one of its answers was edited after the submission", () => {
    const d = deriveProfile(answers());
    const submittedAt = Date.parse("2026-10-20T10:00:00Z");
    const times: Record<string, number> = {};
    for (const id of Object.values(PROFILE_ANSWERS).flat()) times[id] = submittedAt - 60_000;
    times["a.location"] = submittedAt + 60_000; // edited after: the region is "changed"
    times["b.services"] = submittedAt; // at the same instant: not after
    const base = legacyBaseline(d, times, submittedAt);
    expect(base).not.toHaveProperty("region");
    expect(base.services).toBe(d.services);
    expect(base.name).toBe(d.name);
    expect(fieldsToWrite(d, base)).toEqual({ region: d.region });
  });
});

describe("the stored snapshot", () => {
  it("round-trips, and anything malformed reads as no snapshot", () => {
    const s = buildSnapshot(deriveProfile(answers()), new Date("2026-10-20T10:00:00.000Z"));
    expect(parseProfileSnapshot(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(s.appliedThrough).toBe("2026-10-20T10:00:00.000Z");
    for (const bad of [null, undefined, "x", 3, [], {}, { version: 2, fields: {} }, { version: 1 }, { version: 1, fields: "x" }]) expect(parseProfileSnapshot(bad)).toBeNull();
  });

  it("drops what is not a known fact or not text, and an appliedThrough that is not a date", () => {
    const parsed = parseProfileSnapshot({ version: 1, fields: { name: "A", services: 7, secret: "x", region: null }, appliedThrough: "yesterday" });
    expect(parsed).toEqual({ version: 1, fields: { name: "A" }, appliedThrough: null });
  });
});

describe("a Settings edit and the answers", () => {
  const values = (over: Partial<ProfileValues> = {}): ProfileValues => ({ ...deriveProfile(answers()), ...over });

  it("maps a changed fact onto the answer it came from, validated like any answer", () => {
    const patches = answerPatchesFor(["name", "website", "timezone", "industry", "brandColor"], values({ name: "Bright Roofing", website: "bright.test", timezone: "America/Denver", industry: "real estate", brandColor: "#112233" }), answers());
    expect(Object.fromEntries(patches.map((p) => [p.id, p.value]))).toEqual({
      "a.business_name": "Bright Roofing",
      "a.website": "https://bright.test",
      "a.timezone": "America/Denver",
      "a.industry": "real_estate",
      "e.brand_colors": { primary: "#112233", accent: "#12c9a5" },
    });
  });

  it("maps the area onto the areas served and the ideal customers onto the ideal-customer answer", () => {
    const patches = Object.fromEntries(answerPatchesFor(["region", "idealCustomers"], values({ region: "All of Texas", idealCustomers: "Business owners" }), answers()).map((p) => [p.id, p.value]));
    expect(patches).toEqual({ "a.territories": "All of Texas", "b.ideal_customer": "Business owners" });
  });

  it("leaves an answer alone when the Settings text cannot be an answer", () => {
    const long = "x".repeat(2001);
    const patches = answerPatchesFor(["description", "services", "industry", "website", "timezone"], values({ description: long, services: long, industry: "Roofing", website: "not a site", timezone: "Mars/Olympus" }), answers());
    expect(patches).toEqual([]);
  });

  it("maps an emptied optional fact to an empty answer and keeps the accent colour when the primary goes", () => {
    const patches = Object.fromEntries(answerPatchesFor(["website", "brandColor"], values({ website: "", brandColor: "" }), answers()).map((p) => [p.id, p.value]));
    expect(patches).toEqual({ "a.website": "", "e.brand_colors": { primary: "", accent: "#12c9a5" } });
  });

  it("moves the snapshot to what the answers now say for exactly the facts Settings changed", () => {
    const before = answers();
    const last = buildSnapshot(deriveProfile(before), new Date("2026-10-20T10:00:00Z"));
    const patches = answerPatchesFor(["region"], values({ region: "All of Texas" }), before);
    const after: Answers = { ...before, ...Object.fromEntries(patches.map((p) => [p.id, p.value])) };
    const moved = snapshotAfterSettings(last, deriveProfile(after), ["region"], { advanceTo: null });
    expect(moved.fields.region).toBe("All of Texas · Austin, Texas");
    expect(moved.fields.name).toBe(last.fields.name);
    expect(moved.appliedThrough).toBe(last.appliedThrough);
    // Nothing is waiting in the questionnaire: the edit counts as applied.
    const advanced = snapshotAfterSettings(last, deriveProfile(after), ["region"], { advanceTo: new Date("2026-10-21T08:00:00Z") });
    expect(advanced.appliedThrough).toBe("2026-10-21T08:00:00.000Z");
    // A re-submission with the answers as they are now writes nothing: the Settings text survives.
    expect(fieldsToWrite(deriveProfile(after), moved.fields)).toEqual({});
  });
});
