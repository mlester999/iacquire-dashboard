// A "{{" followed by thousands of spaces and no closing braces used to take minutes to scan: the placeholder pattern had two quantifiers that both match a space, so its cost grew with
// the cube of the run. One saved proposal could freeze the server. Every copy of that pattern is held to the same budget here (the old one took 12 seconds at 3,200 spaces).
import { describe, expect, it } from "vitest";
import { convertGhlTokens } from "@/lib/crm/blueprints/ghl/text";
import { renderDealName } from "@/lib/crm/forms/logic";
import { unknownNameTokens } from "@/lib/crm/forms/spec";
import { extractTokens, renderTemplate, validateTemplate } from "@/lib/messaging/tokens";
import { freeze, type FreezeInput } from "@/lib/proposals/snapshot";
import { findTokens, hasStrayBraces, renderProposalText } from "@/lib/proposals/tokens";
import { emptyDoc } from "@/lib/proposals/doc";

const SPACES = 20_000;
const BUDGET_MS = 250;
const TRAPS = {
  "a run of spaces then a letter": `{{${" ".repeat(SPACES)}x`,
  "a run of spaces and nothing else": `{{${" ".repeat(SPACES)}`,
  "a run of spaces then a line break": `{{${" ".repeat(SPACES)}\n`,
  "many openings each followed by spaces": `${"{{ ".repeat(SPACES / 3)}x`,
};

function within<T>(run: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = run();
  return { value, ms: performance.now() - start };
}

describe("proposal placeholders", () => {
  for (const [name, text] of Object.entries(TRAPS)) {
    it(`scan ${name} in milliseconds`, () => {
      const found = within(() => findTokens(text));
      const stray = within(() => hasStrayBraces(text));
      const filled = within(() => renderProposalText(text, { "client.name": "Maria" }));
      expect(found.ms).toBeLessThan(BUDGET_MS);
      expect(stray.ms).toBeLessThan(BUDGET_MS);
      expect(filled.ms).toBeLessThan(BUDGET_MS);
      expect(found.value).toEqual([]);
      expect(stray.value).toBe(true);
      expect(filled.value.text).not.toMatch(/\{\{|\}\}/);
    });
  }

  it("still reads a placeholder with spaces and line breaks around its key", () => {
    expect(findTokens("{{ client.name }} {{\n  proposal.number\t}}").map((t) => [t.key, t.known])).toEqual([["client.name", true], ["proposal.number", true]]);
    expect(renderProposalText("{{   client.name   }}", { "client.name": "Maria" }).text).toBe("Maria");
    expect(findTokens("{{   }}").map((t) => t.key)).toEqual([""]);
    expect(hasStrayBraces("{{ a }} {{ b")).toBe(true);
    expect(hasStrayBraces("{{ a }} {{ b }}")).toBe(false);
  });

  it("freezes a proposal with such wording in milliseconds and reports it instead of hanging", () => {
    const input: FreezeInput = {
      number: "P-0001", title: "Website proposal", currency: "USD", validUntil: null, requiresSignature: false, client: { name: "Maria", company: "", email: null },
      business: { name: "Harbor", website: null }, sender: { name: null }, dealName: null,
      doc: { ...emptyDoc(), sections: [{ id: "intro-01", heading: "About", body: TRAPS["a run of spaces then a letter"] }], terms: TRAPS["a run of spaces then a letter"] },
    };
    const r = within(() => freeze(input));
    expect(r.ms).toBeLessThan(BUDGET_MS);
    expect(r.value.snapshot.terms).not.toContain("{{");
  });
});

describe("the same pattern elsewhere", () => {
  for (const [name, text] of Object.entries(TRAPS)) {
    it(`message templates handle ${name}`, () => {
      const found = within(() => extractTokens(text));
      const filled = within(() => renderTemplate(text, {}));
      const checked = within(() => validateTemplate(text, null, "sms"));
      expect(found.ms).toBeLessThan(BUDGET_MS);
      expect(filled.ms).toBeLessThan(BUDGET_MS);
      expect(checked.ms).toBeLessThan(BUDGET_MS);
      expect(found.value).toEqual([]);
    });

    it(`form deal-name templates handle ${name}`, () => {
      const unknown = within(() => unknownNameTokens(text, new Set()));
      const named = within(() => renderDealName(text, { formName: "Contact us", answers: {}, questions: [] }));
      expect(unknown.ms).toBeLessThan(BUDGET_MS);
      expect(named.ms).toBeLessThan(BUDGET_MS);
    });

    it(`imported GoHighLevel text handles ${name}`, () => {
      const r = within(() => convertGhlTokens(text, { values: new Map(), fields: new Map() }));
      expect(r.ms).toBeLessThan(BUDGET_MS);
      expect(r.value.text).not.toContain("{{");
    });
  }

  it("keep reading keys with spaces around them", () => {
    expect(extractTokens("{{ contact.first_name }}").map((t) => [t.key, t.known])).toEqual([["contact.first_name", true]]);
    expect(renderTemplate("Hi {{  contact.first_name  }}", { "contact.first_name": "Maria" }).text).toBe("Hi Maria");
    expect(unknownNameTokens("{{ contact.first_name }} {{ nope }} {{answer.size}}", new Set(["size"]))).toEqual(["{{ nope }}"]);
    expect(renderDealName("{{ contact.first_name }} - {{ form.name }}", { firstName: "Maria", formName: "Quote", answers: {}, questions: [] })).toBe("Maria - Quote");
    expect(convertGhlTokens("Hi {{ contact.first_name }}", { values: new Map(), fields: new Map() }).text).toBe("Hi {{contact.first_name}}");
  });
});
