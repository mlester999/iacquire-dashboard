import { describe, expect, it } from "vitest";
import { extractAqiNextSteps } from "@/lib/aqi/followups";

describe("AQi suggested next steps", () => {
  it("keeps three or four contextual prompts out of the saved answer", () => {
    const result = extractAqiNextSteps([
      "You can invite a teammate from Settings → Team.",
      '<aqi-next-steps>{"questions":["How do I choose their role?","How do I choose their role?","Can I remove access later?","What can a manager see?"],"support":false}</aqi-next-steps>',
    ].join("\n\n"));

    expect(result.content).toBe("You can invite a teammate from Settings → Team.");
    expect(result.questions).toEqual(["How do I choose their role?", "Can I remove access later?", "What can a manager see?"]);
    expect(result.suggestSupport).toBe(false);
  });

  it("offers a human when AQi says the user may need help", () => {
    const result = extractAqiNextSteps('That needs a member of our team.\n<aqi-next-steps>{"questions":[],"support":true}</aqi-next-steps>');
    expect(result).toEqual({ content: "That needs a member of our team.", questions: [], suggestSupport: true });
  });

  it("does not force a support card onto greetings or simple thanks", () => {
    const result = extractAqiNextSteps('You\'re welcome!\n<aqi-next-steps>{"questions":[],"support":false}</aqi-next-steps>');
    expect(result).toEqual({ content: "You're welcome!", questions: [], suggestSupport: false });
  });

  it("uses support as a safe fallback for missing or malformed provider metadata", () => {
    expect(extractAqiNextSteps("The answer without metadata.")).toEqual({
      content: "The answer without metadata.",
      questions: [],
      suggestSupport: true,
    });
    expect(extractAqiNextSteps('The answer.\n<aqi-next-steps>{not json}</aqi-next-steps>')).toEqual({
      content: "The answer.",
      questions: [],
      suggestSupport: true,
    });
    expect(extractAqiNextSteps("The answer.\n<aqi-next-ste")).toEqual({
      content: "The answer.",
      questions: [],
      suggestSupport: true,
    });
  });
});
