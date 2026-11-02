// The last step of the client prompt fit: shortening the client's own longer free-text answers inside the employee's configuration (src/lib/client-head-fit.ts). Built on the REAL
// compiled configuration of a Lead Hunter whose every answer is at its longest, because that is the employee whose configuration is largest. What it proves: nothing changes when the
// head fits; the style preferences go before any other answer; the role, the business and the rules the client set are never touched, whatever the target; every shortened answer
// is marked and keeps its floor; the employee is told once that something was shortened; the result is deterministic and a second pass changes nothing.
import { describe, expect, it } from "vitest";
import { AGENT_BY_KEY } from "@/lib/agents";
import { compressHead, HEAD_SHORTENED_NOTE, PROTECTED_CONTEXT_FIELDS } from "@/lib/client-head-fit";
import { compileAgentConfig, defaultSettings } from "@/server/workforce/compiler";

const sentences = (seed: string, length: number) => {
  const unit = `${seed} is written down first. A call follows within one business day. `;
  return unit.repeat(Math.ceil(length / unit.length) + 1).slice(0, length).trimEnd();
};

function maximalHead(): string {
  const role = "lead_hunter" as const;
  const settings = {
    ...defaultSettings(role),
    displayName: "Hunter",
    personality: sentences("Personality", 500), characterTraits: sentences("Traits", 400), communicationStyle: sentences("Style", 500), responseBehavior: sentences("Response", 700),
    operatingProcedures: sentences("Procedure", 1000), proactiveResponsibilities: sentences("Proactive", 700), reportingBehavior: sentences("Reporting", 700),
    responsibilities: sentences("Responsibility", 1000), goals: sentences("Goal", 1000), targetCustomers: sentences("Target", 1000),
    companyRules: sentences("Rule", 1500), neverPromise: sentences("Promise", 1000), escalateWhen: sentences("Escalation", 600), escalationContact: "Dana Brightside, 555 0100",
    customInstruction: sentences("Preference", 500),
    roleAnswers: Object.fromEntries(AGENT_BY_KEY[role].questions.map((q) => [q.id, sentences(q.id, 1000)])),
  };
  const compiled = compileAgentConfig({
    role, settings, version: 1, allowedTools: [],
    company: {
      companyName: "Brightside Roofing", orgKind: "client", description: sentences("Business", 1500), industry: "Roofing", website: "https://brightside.example",
      services: sentences("Service", 1500), idealCustomers: sentences("Customer", 1500), operatingArea: sentences("Area", 400), goals: ["Grow referrals", "Fill the spring calendar"],
    },
  });
  return compiled.instructions.slice(0, compiled.instructions.indexOf("## Agency policy")).trimEnd();
}

/** The text of one context field as the compiler wrote it: its line and the indented lines under it. */
function field(head: string, label: string): string | null {
  const lines = head.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${label}: `));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && lines[end].startsWith("  ")) end += 1;
  return lines.slice(start, end).join("\n");
}

const head = maximalHead();
const minimum = compressHead(head, 1);

describe("shortening the client's own longer answers, the last resort", () => {
  it("builds a head large enough to matter, with every protected field in it", () => {
    expect(head.length).toBeGreaterThan(9_000);
    for (const label of PROTECTED_CONTEXT_FIELDS) expect(field(head, label), label).not.toBeNull();
  });

  it("changes nothing when the head already fits", () => {
    expect(compressHead(head, head.length)).toBe(head);
    expect(compressHead(head, head.length + 5_000)).toBe(head);
  });

  it("shortens the style preferences before any other answer", () => {
    const target = head.length - 600;
    const result = compressHead(head, target);
    expect(result.length).toBeLessThanOrEqual(target);
    expect(result).toContain(HEAD_SHORTENED_NOTE);
    // The answers to the role's own questions and the client context were not touched yet.
    for (const q of AGENT_BY_KEY.lead_hunter.questions) expect(field(result, q.label), q.label).toBe(field(head, q.label));
    expect(field(result, "Ideal customers")).toBe(field(head, "Ideal customers"));
    expect(result).toMatch(/- (Operating procedures|Personality|Communication style|Response behavior|Proactive responsibilities|Reporting behavior|Character traits): .*\[\.\.\.\]/);
  });

  it("never touches the role, the business or the rules the client set, whatever the target", () => {
    for (let target = 0; target <= head.length; target += 211) {
      const result = compressHead(head, target);
      for (const label of PROTECTED_CONTEXT_FIELDS) expect(field(result, label), `${label} at ${target}`).toBe(field(head, label));
      // Everything before "How to communicate" (who the employee is, its role and its operating standard) is byte for byte what it was.
      const identity = head.slice(0, head.indexOf("## How to communicate"));
      expect(result.startsWith(identity), `identity at ${target}`).toBe(true);
      expect(result).toContain("## How you get information and make changes");
    }
  });

  it("meets any target above its least form, and goes no lower than its floors below that", () => {
    for (const target of [minimum.length, minimum.length + 1, minimum.length + 500, Math.floor((head.length + minimum.length) / 2), head.length - 1]) {
      expect(compressHead(head, target).length, `target ${target}`).toBeLessThanOrEqual(target);
    }
    expect(compressHead(head, 1)).toBe(minimum);
    expect(minimum.length).toBeLessThan(head.length);
    // At the floors every shortened answer still keeps its opening, and is marked.
    const answers = AGENT_BY_KEY.lead_hunter.questions.map((q) => field(minimum, q.label) as string);
    for (const answer of answers) {
      expect(answer.length).toBeGreaterThanOrEqual(300);
      expect(answer.endsWith("[...]")).toBe(true);
    }
  });

  it("tells the employee once that something was shortened, and not at all when nothing was", () => {
    expect(minimum.split(HEAD_SHORTENED_NOTE).length - 1).toBe(1);
    expect(compressHead(head, head.length).includes(HEAD_SHORTENED_NOTE)).toBe(false);
    // The note sits inside the client's context, so it reads as part of the data and cannot be mistaken for an instruction of ours.
    const note = minimum.indexOf(HEAD_SHORTENED_NOTE);
    expect(note).toBeGreaterThan(minimum.indexOf("<client_context>"));
    expect(note).toBeLessThan(minimum.indexOf("</client_context>"));
  });

  it("is deterministic and a second pass changes nothing", () => {
    for (const target of [1, 6_000, 9_000]) {
      const once = compressHead(head, target);
      expect(compressHead(head, target)).toBe(once);
      expect(compressHead(once, target)).toBe(once);
    }
  });

  it("leaves a head with nothing it may shorten exactly as it was", () => {
    const bare = "# configuration\n\n## Your role\nHelp.\n\n## Business context\n<client_context>\nWhat the business does: Roofs.\nCompany rules: Be kind.\n</client_context>";
    expect(compressHead(bare, 10)).toBe(bare);
  });
});
