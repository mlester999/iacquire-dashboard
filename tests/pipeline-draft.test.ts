// Turning the client's sales-process answer into stages: only a clean list becomes a plan, anything that reads like prose returns null. Pure rules, no database.
import { describe, expect, it } from "vitest";
import { planPipelineStages } from "@/lib/onboarding/pipeline-draft";

const plan = (text: unknown) => planPipelineStages({ "d.sales_process": text as string });
const names = (text: unknown) => plan(text)?.stages.map((s) => s.name);
const kinds = (text: unknown) => plan(text)?.stages.map((s) => s.kind);

describe("planPipelineStages: lists it reads", () => {
  it("reads the questionnaire's own example, a numbered list on one line", () => {
    const result = plan("1. Enquiry. 2. Qualify. 3. Free inspection. 4. Quote. 5. Book the job.");
    expect(result?.stages.map((s) => s.name)).toEqual(["Enquiry", "Qualify", "Free inspection", "Quote", "Book the job", "Won", "Lost"]);
    expect(result?.stages.map((s) => s.kind)).toEqual(["open", "open", "open", "open", "open", "won", "lost"]);
    expect(result?.from).toEqual(["d.sales_process"]);
  });

  it("reads a numbered list with one step per line, with either kind of bracket", () => {
    expect(names("1. Enquiry\n2. Qualify\n3. Quote")).toEqual(["Enquiry", "Qualify", "Quote", "Won", "Lost"]);
    expect(names("1) Enquiry\n2) Qualify\n3) Quote")).toEqual(["Enquiry", "Qualify", "Quote", "Won", "Lost"]);
  });

  it("reads one step per line, with or without bullets and trailing full stops", () => {
    expect(names("Enquiry\nQualify\nSend quote.")).toEqual(["Enquiry", "Qualify", "Send quote", "Won", "Lost"]);
    expect(names("- Enquiry\n* Qualify\n• Send quote\n\n")).toEqual(["Enquiry", "Qualify", "Send quote", "Won", "Lost"]);
  });

  it("reads semicolons and arrows", () => {
    expect(names("Enquiry; Qualify; Quote;")).toEqual(["Enquiry", "Qualify", "Quote", "Won", "Lost"]);
    expect(names("Enquiry -> Qualify -> Quote")).toEqual(["Enquiry", "Qualify", "Quote", "Won", "Lost"]);
    expect(names("Enquiry → Qualify → Quote")).toEqual(["Enquiry", "Qualify", "Quote", "Won", "Lost"]);
  });

  it("collapses extra spaces inside a step", () => {
    expect(names("Enquiry;  Free   inspection ; Quote")).toEqual(["Enquiry", "Free inspection", "Quote", "Won", "Lost"]);
  });

  it("accepts the smallest and the largest list", () => {
    expect(plan("A; B; C")?.stages).toHaveLength(5);
    expect(plan("A; B; C; D; E; F; G; H")?.stages).toHaveLength(10);
  });

  it("accepts a step of exactly 60 characters", () => {
    const step = "x".repeat(60);
    expect(names(`Enquiry; ${step}; Quote`)).toContain(step);
  });
});

describe("planPipelineStages: lists it refuses", () => {
  it.each([
    ["free-form prose", "We get a call from the customer, then we send somebody out to look at the roof and give a price."],
    ["prose over several lines", "First we talk to them.\nThen we visit the property and measure everything carefully for the quote.\nFinally we confirm the job and the date."],
    ["a single step", "Enquiry"],
    ["two steps", "Enquiry; Quote"],
    ["nine steps", "A; B; C; D; E; F; G; H; I"],
    ["commas only", "Enquiry, Qualify, Quote"],
    ["an empty answer", ""],
    ["spaces only", "   \n  "],
    ["a numbered list that skips a number", "1. Enquiry. 2. Qualify. 4. Quote."],
    ["a numbered list that does not start at one", "2. Enquiry. 3. Qualify. 4. Quote."],
    ["a step that is several sentences", "Enquiry; Qualify the lead. Then call them back; Quote"],
  ])("returns null for %s", (_label, text) => {
    expect(plan(text)).toBeNull();
  });

  it("returns null when a step is over 60 characters", () => {
    expect(plan(`Enquiry; ${"x".repeat(61)}; Quote`)).toBeNull();
  });

  it("returns null for the same step twice, ignoring capitals and spacing", () => {
    expect(plan("Enquiry; Quote; enquiry")).toBeNull();
    expect(plan("1. Quote. 2. Qualify. 3. QUOTE.")).toBeNull();
    expect(plan("Quote\nQualify\nQuote  ")).toBeNull();
  });

  it("returns null when the answer is missing or not text", () => {
    expect(planPipelineStages({})).toBeNull();
    expect(planPipelineStages({ "d.sales_process": undefined })).toBeNull();
    expect(plan(42)).toBeNull();
    expect(plan(["Enquiry", "Qualify", "Quote"])).toBeNull();
  });

  it("only reads d.sales_process", () => {
    expect(planPipelineStages({ "d.pricing_info": "Enquiry; Qualify; Quote", "b.sales_model": "Enquiry; Qualify; Quote" })).toBeNull();
  });
});

describe("planPipelineStages: closing words", () => {
  it("maps a last step that says won or lost", () => {
    expect(kinds("Enquiry; Quote; Won")).toEqual(["open", "open", "won", "lost"]);
    expect(names("Enquiry; Quote; Won")).toEqual(["Enquiry", "Quote", "Won", "Lost"]);
    expect(kinds("Enquiry; Quote; Lost")).toEqual(["open", "open", "won", "lost"]);
    expect(names("Enquiry; Quote; Lost")).toEqual(["Enquiry", "Quote", "Won", "Lost"]);
  });

  it("maps both, keeping the client's own words, and puts Won before Lost", () => {
    expect(names("Enquiry; Quote; Closed lost; Closed won")).toEqual(["Enquiry", "Quote", "Closed won", "Closed lost"]);
    expect(kinds("Enquiry; Quote; Closed lost; Closed won")).toEqual(["open", "open", "won", "lost"]);
    expect(kinds("1. Enquiry. 2. Quote. 3. Signed. 4. Lost.")).toEqual(["open", "open", "won", "lost"]);
  });

  it.each(["won", "Closed won", "closed-won", "Closed", "Booked", "Signed", "Contract signed", "Sold", "Deal won"])("treats %j as the Won stage", (word) => {
    const result = plan(`Enquiry; Quote; ${word}`);
    expect(result?.stages.filter((s) => s.kind === "won").map((s) => s.name)).toEqual([word]);
    expect(result?.stages.at(-1)).toEqual({ name: "Lost", kind: "lost" });
  });

  it.each(["Lost", "Closed lost", "closed-lost", "Deal lost"])("treats %j as the Lost stage", (word) => {
    const result = plan(`Enquiry; Quote; ${word}`);
    expect(result?.stages.filter((s) => s.kind === "lost").map((s) => s.name)).toEqual([word]);
    expect(result?.stages.at(-2)).toEqual({ name: "Won", kind: "won" });
  });

  it("does not close a deal on a step that merely contains a closing word", () => {
    expect(kinds("Enquiry; Quote; Book the job")).toEqual(["open", "open", "open", "won", "lost"]);
    expect(kinds("Enquiry; Quote; Booked a site visit")).toEqual(["open", "open", "open", "won", "lost"]);
    expect(kinds("Enquiry; Quote; Won over by the price")).toEqual(["open", "open", "open", "won", "lost"]);
  });

  it("refuses a closing word that is not at the end, or two of the same kind", () => {
    expect(plan("Enquiry; Won; Quote; Follow up")).toBeNull();
    expect(plan("Enquiry; Lost; Quote")).toBeNull();
    expect(plan("Enquiry; Won; Signed")).toBeNull();
    expect(plan("Enquiry; Lost; Closed lost")).toBeNull();
  });

  it("needs at least one open stage", () => {
    expect(plan("Won; Lost; Signed")).toBeNull();
  });

  it("always gives the CRM a shape it accepts: open stages, at most one Won and one Lost, names within 60 characters", () => {
    for (const text of ["Enquiry; Quote; Won", "Enquiry; Quote; Lost", "Enquiry; Quote; Won; Lost", "A; B; C; D; E; F; G; H", "1. A. 2. B. 3. C. 4. Signed"]) {
      const stages = plan(text)?.stages ?? [];
      expect(stages.filter((s) => s.kind === "open").length).toBeGreaterThan(0);
      expect(stages.filter((s) => s.kind === "won")).toHaveLength(1);
      expect(stages.filter((s) => s.kind === "lost")).toHaveLength(1);
      expect(stages.every((s) => s.name.length >= 1 && s.name.length <= 60)).toBe(true);
      expect(new Set(stages.map((s) => s.name.toLowerCase())).size).toBe(stages.length);
      expect(stages.map((s) => s.kind).join(",")).toMatch(/^(open,)+won,lost$/);
    }
  });
});
