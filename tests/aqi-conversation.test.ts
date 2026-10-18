import { describe, expect, it } from "vitest";
import { classifyAqiIntent } from "@/lib/aqi/intent";
import { buildAqiSystemPrompt, DEFAULT_AQI_CONFIG, normalizeAqiLinks, type AqiKnowledgeResult } from "@/server/aqi/service";
import type { AqiViewer } from "@/server/aqi/access";

const client = { can: (permission: string) => permission === "agents.use" || permission === "knowledge.view", agencyRole: null } as unknown as AqiViewer;
const emptyKnowledge: AqiKnowledgeResult = { entries: [], sources: [] };

describe("AQi conversational intent", () => {
  it("recognizes greetings without turning them into research questions", () => {
    for (const greeting of ["hey", "hi", "hello", "yo", "good morning", "what's up", "hi AQi", "hey there"]) {
      const intent = classifyAqiIntent(greeting);
      expect(intent.kind, greeting).toBe("greeting");
      expect(intent.needsKnowledge, greeting).toBe(false);
      expect(intent.usePageContext, greeting).toBe(false);
      expect(intent.maxWords, greeting).toBeLessThanOrEqual(20);
    }
  });

  it("does not swallow a real question that begins with a greeting", () => {
    expect(classifyAqiIntent("Hey, how do I add a new employee?").kind).toBe("how_to");
    expect(classifyAqiIntent("hello, where are integrations?").kind).toBe("navigation");
  });

  it("adapts navigation, troubleshooting, complex and follow-up requests", () => {
    expect(classifyAqiIntent("Where are integrations?").kind).toBe("navigation");
    expect(classifyAqiIntent("My integration is not working").kind).toBe("troubleshooting");
    expect(classifyAqiIntent("Explain everything about our CRM in detail").kind).toBe("complex");
    expect(classifyAqiIntent("what about that?", { hasHistory: true }).kind).toBe("follow_up");
    expect(classifyAqiIntent("I'm confused").kind).toBe("clarify");
  });
});

describe("AQi prompt behavior", () => {
  it("does not inject page context, knowledge or route lists into a greeting", () => {
    const prompt = buildAqiSystemPrompt(client, DEFAULT_AQI_CONFIG, { path: "/settings/integrations", label: "Integrations", description: "Connected services" }, emptyKnowledge, classifyAqiIntent("hey"));
    expect(prompt).toContain("Detected intent: greeting");
    expect(prompt).toContain("One short sentence");
    expect(prompt).not.toContain("Approved knowledge");
    expect(prompt).not.toContain("Current page");
    expect(prompt).not.toContain("/settings/integrations");
  });

  it("only includes page context when the request refers to the page", () => {
    const page = { path: "/knowledge", label: "Knowledge Center", description: "Company knowledge" };
    const greeting = buildAqiSystemPrompt(client, DEFAULT_AQI_CONFIG, page, emptyKnowledge, classifyAqiIntent("hey"));
    const pageQuestion = buildAqiSystemPrompt(client, DEFAULT_AQI_CONFIG, page, emptyKnowledge, classifyAqiIntent("What can I do on this page?"));
    expect(greeting).not.toContain("Knowledge Center");
    expect(pageQuestion).toContain("Knowledge Center");
  });

  it("adds authorized routes and link rules only when navigation is relevant", () => {
    const knowledge: AqiKnowledgeResult = { entries: [{ id: "k", title: "Integrations", category: "Integrations", body: "Manage integrations.", route_prefix: "/settings/integrations", roles: [] }], sources: [{ id: "k", title: "Integrations", category: "Integrations" }] };
    const navigation = buildAqiSystemPrompt(client, DEFAULT_AQI_CONFIG, null, knowledge, classifyAqiIntent("Where are integrations?"));
    const greeting = buildAqiSystemPrompt(client, DEFAULT_AQI_CONFIG, null, emptyKnowledge, classifyAqiIntent("hey"));
    expect(navigation).toContain("Authorized navigation");
    expect(navigation).toContain("never write a raw route");
    expect(greeting).not.toContain("Authorized navigation");
  });
});

describe("AQi navigation normalization", () => {
  it("turns a raw authorized path into a human-labelled markdown link", () => {
    expect(normalizeAqiLinks("Open /knowledge to review company documents.", client)).toContain("[Knowledge Center](/knowledge)");
  });

  it("preserves a valid markdown link and rejects unauthorized routes and external links", () => {
    expect(normalizeAqiLinks("[Knowledge Center](/knowledge)", client)).toBe("[Knowledge Center](/knowledge)");
    expect(normalizeAqiLinks("[Admin](/admin/aqi)", client)).toBe("Admin");
    expect(normalizeAqiLinks("[Help](https://evil.example)", client)).toBe("Help");
    expect(normalizeAqiLinks("[Unsafe](javascript:alert(1))", client)).toBe("Unsafe");
    expect(normalizeAqiLinks("Go to /admin/aqi now", client)).not.toContain("/admin/aqi");
  });
});
