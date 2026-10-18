import { describe, expect, it } from "vitest";
import {
  DEFAULT_AQI_CONVERSATION_TITLE,
  buildAqiTitlePrompt,
  fallbackAqiConversationTitle,
  firstMeaningfulUserMessage,
  isMeaningfulAqiMessage,
  sanitizeGeneratedTitle,
} from "@/lib/aqi/title";

describe("AQi conversation title heuristics", () => {
  it("treats greetings and thanks as non-topics", () => {
    for (const greeting of ["hey", "hi", "hello", "hey there", "thanks", "ok", "good morning"]) {
      expect(isMeaningfulAqiMessage(greeting), greeting).toBe(false);
      expect(fallbackAqiConversationTitle([greeting]), greeting).toBeNull();
    }
  });

  it("builds a readable title for the example topics", () => {
    expect(fallbackAqiConversationTitle(["How do I connect DeepSeek to AQi?"])).toBe("Connecting DeepSeek to AQi");
    expect(fallbackAqiConversationTitle(["Can you explain our native CRM?"])).toBe("Understanding the Native CRM");
    expect(fallbackAqiConversationTitle(["How can I manage my AI employees?"])).toBe("Managing AI Employees");
    expect(fallbackAqiConversationTitle(["My automation isn't running."])).toBe("Troubleshooting Automation Issues");
    expect(fallbackAqiConversationTitle(["How can I create an automation?"])).toBe("Creating an Automation");
  });

  it("uses the first meaningful topic after a greeting, not the greeting", () => {
    const messages = [
      { role: "user" as const, content: "hey" },
      { role: "assistant" as const, content: "Hey! How can I help?" },
      { role: "user" as const, content: "How can I create an automation?" },
      { role: "assistant" as const, content: "Open Automations and choose New." },
    ];
    expect(firstMeaningfulUserMessage(messages)).toBe("How can I create an automation?");
    expect(fallbackAqiConversationTitle(messages)).toBe("Creating an Automation");
  });

  it("keeps a title inside the product rules", () => {
    expect(sanitizeGeneratedTitle('"Connecting DeepSeek to AQi."')).toBe("Connecting DeepSeek to AQi");
    expect(sanitizeGeneratedTitle("**Understanding the Native CRM**")).toBe("Understanding the Native CRM");
    expect(sanitizeGeneratedTitle("Title: Managing AI Employees")).toBe("Managing AI Employees");
    expect(sanitizeGeneratedTitle("New conversation")).toBeNull();
    expect(sanitizeGeneratedTitle("Friendly Greeting")).toBeNull();
    expect(sanitizeGeneratedTitle("General Conversation")).toBeNull();
    expect(sanitizeGeneratedTitle("Open https://internal.example/secret")).toBeNull();
    expect(sanitizeGeneratedTitle("one")).toBeNull();
    expect(sanitizeGeneratedTitle("this title has far too many words to be a useful conversation name")).toBeNull();
  });

  it("redacts private contact details before a title is stored", () => {
    expect(sanitizeGeneratedTitle("Contact jane.doe@example.com about billing")).toBe("Contact About Billing");
    expect(sanitizeGeneratedTitle("Call 555 123 4567 about the CRM")).toBe("Call About the CRM");
  });

  it("keeps the neutral placeholder as the documented default", () => {
    expect(DEFAULT_AQI_CONVERSATION_TITLE).toBe("New conversation");
    const prompt = buildAqiTitlePrompt([{ role: "user", content: "How do I connect DeepSeek to AQi?" }]);
    expect(prompt.system).toContain("3 to 7 words");
    expect(prompt.user).toContain("How do I connect DeepSeek to AQi?");
    expect(prompt.user.length).toBeLessThan(1400);
  });
});
