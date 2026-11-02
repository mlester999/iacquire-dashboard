import { describe, expect, it } from "vitest";
import { QUESTION_BY_ID } from "@/lib/onboarding/definitions";
import { ESCALATION_CATEGORIES } from "@/lib/escalation";
import {
  detectRestrictedTopics,
  isRestrictedTopic,
  RESTRICTED_TOPICS,
  restrictedTopicsOf,
  restrictedTopicSummary,
  TOPIC_ESCALATION,
  TOPIC_LABEL,
  type RestrictedTopic,
} from "@/lib/customer-topic-guard";

// The client's "which topics need a person" answers, turned into a decision made before any model is asked. Pure: the server side (the loader and the escalation before the model
// call) is proved in tests/messaging-responder.test.ts.

const ALL = [...RESTRICTED_TOPICS] as RestrictedTopic[];

describe("the topics stay in step with the questionnaire", () => {
  it("has exactly the options the client can pick under 'Which topics need a person?'", () => {
    const question = QUESTION_BY_ID["c.sensitive_topics"];
    const kind = question.kind as { type: string; options: Array<{ value: string }> };
    expect(kind.type).toBe("multi");
    expect(kind.options.map((o) => o.value).sort()).toEqual([...RESTRICTED_TOPICS].sort());
  });

  it("maps every topic to a real escalation category and names it in the client's words", () => {
    for (const topic of RESTRICTED_TOPICS) {
      expect(ESCALATION_CATEGORIES).toContain(TOPIC_ESCALATION[topic]);
      expect(TOPIC_LABEL[topic].length).toBeGreaterThan(3);
      expect(isRestrictedTopic(topic)).toBe(true);
    }
    expect(TOPIC_ESCALATION).toMatchObject({ pricing: "sensitive_negotiation", refunds: "refund_concern", complaints: "complaint", legal: "unsafe_or_uncertain", medical: "unsafe_or_uncertain", warranty: "unsafe_or_uncertain", safety: "unsafe_or_uncertain" });
    expect(isRestrictedTopic("weather")).toBe(false);
    expect(isRestrictedTopic(7)).toBe(false);
  });

  it("the pricing policy answer offers 'never' as the option that hands pricing to a person", () => {
    const kind = QUESTION_BY_ID["d.pricing_policy"].kind as { options: Array<{ value: string }> };
    expect(kind.options.map((o) => o.value)).toEqual(expect.arrayContaining(["never", "ranges", "exact"]));
  });
});

describe("reading the answers", () => {
  it("takes the picked topics in the fixed order, once each", () => {
    expect(restrictedTopicsOf({ sensitiveTopics: ["refunds", "legal", "refunds", "pricing"] })).toEqual(["pricing", "refunds", "legal"]);
  });

  it("drops anything that is not a topic and never throws on a bad shape", () => {
    expect(restrictedTopicsOf({ sensitiveTopics: ["refunds", "weather", 4, null, {}] })).toEqual(["refunds"]);
    for (const bad of ["refunds", 3, null, undefined, { 0: "refunds" }, true]) expect(restrictedTopicsOf({ sensitiveTopics: bad })).toEqual([]);
    expect(restrictedTopicsOf({})).toEqual([]);
  });

  it("adds pricing only when the client said their AI may not share prices", () => {
    expect(restrictedTopicsOf({ pricingPolicy: "never" })).toEqual(["pricing"]);
    expect(restrictedTopicsOf({ pricingPolicy: "ranges" })).toEqual([]);
    expect(restrictedTopicsOf({ pricingPolicy: "exact" })).toEqual([]);
    expect(restrictedTopicsOf({ pricingPolicy: undefined })).toEqual([]);
    expect(restrictedTopicsOf({ sensitiveTopics: ["pricing"], pricingPolicy: "never" })).toEqual(["pricing"]);
    expect(restrictedTopicsOf({ sensitiveTopics: ["warranty"], pricingPolicy: "never" })).toEqual(["pricing", "warranty"]);
  });
});

describe("recognising a topic in a customer's message", () => {
  const hit: Array<[RestrictedTopic, string]> = [
    ["pricing", "How much does a roof inspection cost?"],
    ["pricing", "Can I get a quote for the gutters?"],
    ["pricing", "Is it more than $200?"],
    ["refunds", "I want my money back"],
    ["refunds", "You charged twice for the same visit"],
    ["refunds", "Please process a refund"],
    ["legal", "I'm going to talk to my lawyer"],
    ["legal", "Can I see the contract before I sign?"],
    ["medical", "Is this safe with my medication?"],
    ["medical", "What are the side effects?"],
    ["complaints", "This is unacceptable"],
    ["complaints", "I'd like to make a complaint"],
    ["warranty", "Is the work under warranty?"],
    ["warranty", "Do you guarantee it?"],
    ["safety", "There is a gas leak in the kitchen"],
    ["safety", "I think the wiring is dangerous"],
  ];
  it.each(hit)("%s: %s", (topic, text) => {
    expect(detectRestrictedTopics(text, [topic])).toEqual([topic]);
  });

  it("only reports topics the client picked", () => {
    for (const [topic, text] of hit) {
      expect(detectRestrictedTopics(text, ALL), `${topic}: ${text}`).toContain(topic);
      expect(detectRestrictedTopics(text, ALL.filter((t) => t !== topic)), `${topic}: ${text}`).not.toContain(topic);
    }
    expect(detectRestrictedTopics("How much does it cost?", [])).toEqual([]);
    expect(detectRestrictedTopics("How much does it cost?", ["refunds", "legal"])).toEqual([]);
  });

  it("matches whole words only and leaves ordinary messages alone", () => {
    for (const text of [
      "Hi, it's Sue, can we book Tuesday at 10?",
      "My contractor will be there in the morning",
      "What time do you open on Saturday?",
      "Thanks, that works for me",
      "Do you service the north side?",
      "",
      "   ",
    ]) {
      expect(detectRestrictedTopics(text, ALL), text).toEqual([]);
    }
  });

  it("lists the most serious topic first when a message touches several", () => {
    expect(detectRestrictedTopics("This is dangerous and I want a refund and a price match", ALL)).toEqual(["safety", "refunds", "pricing"]);
    expect(detectRestrictedTopics("I want a refund and my lawyer says so", ["pricing", "refunds", "legal"])).toEqual(["legal", "refunds"]);
  });
});

describe("what the team reads", () => {
  it("names the topic and nothing the customer wrote", () => {
    const customerWords = "My SECRETWORD refund for order 4421 please";
    expect(detectRestrictedTopics(customerWords, ["refunds"])).toEqual(["refunds"]);
    const summary = restrictedTopicSummary("refunds");
    expect(summary).toContain("refunds and billing disputes");
    expect(summary).not.toMatch(/SECRETWORD|4421/);
    for (const topic of RESTRICTED_TOPICS) {
      expect(restrictedTopicSummary(topic)).toContain(TOPIC_LABEL[topic]);
      expect(restrictedTopicSummary(topic)).toMatch(/did not answer/);
    }
  });
});
