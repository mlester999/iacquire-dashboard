import { describe, expect, it } from "vitest";
import { parseResearchAssignment, researchClarification } from "@/lib/research-intent";

describe("Lead Hunter research intent", () => {
  it("recognises the canonical real-estate assignment", () => {
    const assignment = parseResearchAssignment(
      "Find 20 qualified real estate agencies in Miami that could benefit from our AI automation services. Research them, check duplicates and prepare them for my review.",
    );
    expect(assignment).toMatchObject({ quantity: 20, target: "real estate agencies", location: "Miami", missing: [] });
  });

  it("keeps a full location with a comma", () => {
    expect(parseResearchAssignment("Find 10 dental clinics near Austin, Texas with online booking")).toMatchObject({
      quantity: 10,
      target: "dental clinics",
      location: "Austin, Texas",
      missing: [],
    });
  });

  it("reports only the fields that are genuinely missing", () => {
    const noQuantity = parseResearchAssignment("Research dental clinics in Miami");
    expect(noQuantity).toMatchObject({ quantity: null, target: "dental clinics", location: "Miami", missing: ["quantity"] });
    expect(researchClarification(noQuantity!)).toMatch(/number of qualified leads/i);
    expect(researchClarification(noQuantity!)).not.toMatch(/city or area/i);

    const noLocation = parseResearchAssignment("Find 20 dental clinics");
    expect(noLocation).toMatchObject({ quantity: 20, target: "dental clinics", location: "", missing: ["location"] });

    const vagueLocation = parseResearchAssignment("Find 20 dental clinics near me");
    expect(vagueLocation?.missing).toEqual(["location"]);

    const noTarget = parseResearchAssignment("Find 20 leads in Miami");
    expect(noTarget).toMatchObject({ quantity: 20, target: "", location: "Miami", missing: ["target"] });
  });

  it("asks a focused clarification rather than inventing missing details", () => {
    const assignment = parseResearchAssignment("Find dental practices near me");
    expect(assignment?.missing).toEqual(expect.arrayContaining(["location", "quantity"]));
    expect(assignment?.missing).toHaveLength(2);
    const question = researchClarification(assignment!);
    expect(question).toMatch(/city or area/i);
    expect(question).toMatch(/number of qualified leads/i);
    expect(question).not.toMatch(/industry/i);
  });

  it("leaves ordinary conversation to the normal chat flow", () => {
    expect(parseResearchAssignment("How do you score leads?")).toBeNull();
    expect(parseResearchAssignment("Find out what happened yesterday")).toBeNull();
    expect(parseResearchAssignment("Can you explain your research process?")).toBeNull();
    expect(parseResearchAssignment("Review our recent lead research and explain which candidates need review")).toBeNull();
    expect(parseResearchAssignment("Explain how you evaluate lead fit using approved public evidence. Do not research, create records, or contact anyone.")).toBeNull();
  });

  it("caps an unreasonable quantity instead of promising unlimited work", () => {
    expect(parseResearchAssignment("Find 500 dental clinics in Miami")?.quantity).toBe(50);
  });
});
