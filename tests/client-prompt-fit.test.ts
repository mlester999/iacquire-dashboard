// The priority-based fitting of what a client employee is sent (src/lib/client-prompt-fit.ts, the knowledge and snapshot rebuilders). Pure: no database, no provider. What it proves:
// the budgets are the worker's own numbers; nothing is shortened when the parts fit; when they do not, the most expendable block goes first and the protected blocks are never touched;
// bytes count as well as characters; a fit that cannot be made is reported, never hidden; the knowledge keeps the most important material first and names what it left out; the
// snapshot keeps its framing and the state of every area; history never takes room from the instructions.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLIENT_PROMPT_LIMITS, composeRestrictedMessage, fitHistory, fitPromptBlocks, instructionBudget, utf8Bytes, type HistoryTurn, type PromptBlock,
} from "@/lib/client-prompt-fit";
import { evidenceBlockWithin, formatEmployeeEvidence, type EmployeeEvidence, type EvidenceSection } from "@/lib/employee-evidence";
import { compileKnowledgeFitted, compileKnowledgeSections, KNOWLEDGE_FIT_ORDER, type KnowledgeSection } from "@/server/workforce/compiler";

const root = resolve(__dirname, "..");
const worker = readFileSync(join(root, "services/hermes-inference-worker/worker.py"), "utf8");
const app = readFileSync(join(root, "src/server/integrations/hermes/inference-only.ts"), "utf8");
const python = (name: string) => {
  const match = worker.match(new RegExp(`^${name} = ([\\d_]+)$`, "m"));
  if (!match) throw new Error(`${name} not found in the worker`);
  return Number(match[1].replace(/_/g, ""));
};

const text = (label: string, length: number) => `${label} `.repeat(Math.ceil(length / (label.length + 1)) + 1).slice(0, length).trimEnd();

describe("the budgets are the worker's own", () => {
  it("equal the numbers in the restricted worker and in the app", () => {
    expect(CLIENT_PROMPT_LIMITS.instructionsChars).toBe(python("MAX_INSTRUCTIONS_CHARS"));
    expect(CLIENT_PROMPT_LIMITS.messageBytes).toBe(python("MAX_PROMPT_BYTES"));
    expect(CLIENT_PROMPT_LIMITS.inputChars).toBe(python("MAX_INPUT_CHARS"));
    expect(CLIENT_PROMPT_LIMITS.historyChars).toBe(python("MAX_HISTORY_CHARS"));
    expect(CLIENT_PROMPT_LIMITS.historyMessages).toBe(python("MAX_HISTORY_MESSAGES"));
    expect(Number(/const MAX_PROMPT_BYTES = ([\d_]+);/.exec(app)?.[1].replace(/_/g, ""))).toBe(CLIENT_PROMPT_LIMITS.messageBytes);
  });

  it("takes the person's message and the history off the instructions' bytes, and assumes a full-length first message when it has none", () => {
    expect(instructionBudget()).toEqual({ chars: 20_000, bytes: 24_576 - 2_000 });
    expect(instructionBudget({ input: "x".repeat(300) })).toEqual({ chars: 20_000, bytes: 24_576 - 300 });
    expect(instructionBudget({ input: "x".repeat(300), history: ["a".repeat(100), "b".repeat(50)] }).bytes).toBe(24_576 - 450);
    expect(instructionBudget({ input: "€".repeat(100) }).bytes).toBe(24_576 - 300);
  });
});

const blocks = (over: Partial<Record<"head" | "knowledge" | "evidence", number>> = {}): PromptBlock[] => {
  const head = `HEAD ${text("role and answers", over.head ?? 6000)}`;
  const policy = `POLICY ${text("immutable rule", 2500)}`;
  const live = `LIVE ${text("booking rule", 400)}`;
  return [
    { key: "head", text: head, giveUp: 0 },
    { key: "knowledge", text: `KNOWLEDGE ${text("approved fact", over.knowledge ?? 5000)}`, giveUp: 2, rebuild: (max) => `KNOWLEDGE ${text("approved fact", Math.max(0, max - 10))}`.slice(0, max) },
    { key: "live_facts", text: live, giveUp: 0 },
    { key: "evidence", text: `EVIDENCE ${text("record", over.evidence ?? 9000)}`, giveUp: 3, rebuild: (max) => `EVIDENCE ${text("record", Math.max(0, max - 9))}`.slice(0, max) },
    { key: "policy", text: policy, giveUp: 0 },
  ];
};

describe("fitting blocks to a budget", () => {
  it("shortens nothing when the parts already fit, and returns exactly their text", () => {
    const parts = blocks({ evidence: 500, knowledge: 500 });
    const fit = fitPromptBlocks(parts, instructionBudget());
    expect(fit.fits).toBe(true);
    expect(fit.steps).toEqual([]);
    expect(fit.text).toBe(parts.map((p) => p.text).join("\n\n"));
  });

  it("gives up the snapshot first, then the knowledge, and never touches the head, the live facts or the policy", () => {
    const parts = blocks();
    const budget = { chars: 17_000, bytes: 100_000 };
    const fit = fitPromptBlocks(parts, budget);
    expect(fit.fits).toBe(true);
    expect(fit.chars).toBeLessThanOrEqual(17_000);
    expect(fit.steps.map((s) => s.key)).toEqual(["evidence"]);
    for (const key of ["head", "live_facts", "policy"] as const) expect(fit.texts[key]).toBe(parts.find((p) => p.key === key)!.text);
    // The knowledge was not needed to make room, so it is exactly what it was.
    expect(fit.texts.knowledge).toBe(parts[1].text);
  });

  it("gives the snapshot up completely before the knowledge loses a character", () => {
    const parts = blocks({ evidence: 400 });
    const fit = fitPromptBlocks(parts, { chars: 9_400, bytes: 100_000 });
    expect(fit.fits).toBe(true);
    expect(fit.texts.evidence).toBe("");
    expect(fit.texts.knowledge.length).toBeGreaterThan(0);
    expect(fit.texts.knowledge.length).toBeLessThan(parts[1].text.length);
    expect(new Set(fit.steps.map((s) => s.key))).toEqual(new Set(["evidence", "knowledge"]));
    expect(fit.texts.head).toBe(parts[0].text);
    expect(fit.texts.live_facts).toBe(parts[2].text);
    expect(fit.texts.policy).toBe(parts[4].text);
  });

  it("when the snapshot alone cannot absorb the excess, the knowledge gives up the rest", () => {
    const parts = blocks({ evidence: 800 });
    const fit = fitPromptBlocks(parts, { chars: 11_000, bytes: 100_000 });
    expect(fit.fits).toBe(true);
    expect(new Set(fit.steps.map((s) => s.key))).toEqual(new Set(["evidence", "knowledge"]));
    expect(fit.texts.head).toBe(parts[0].text);
    expect(fit.texts.policy).toBe(parts[4].text);
  });

  it("counts bytes as well as characters: multi-byte text weighs more than its length", () => {
    const head: PromptBlock = { key: "head", text: "H".repeat(2_000), giveUp: 0 };
    const wide: PromptBlock = { key: "knowledge", text: "€".repeat(4_000), giveUp: 2, rebuild: (max) => "€".repeat(Math.max(0, max)) };
    // 6,000 characters, 14,000 bytes: within 20,000 characters, over a 10,000-byte budget.
    const fit = fitPromptBlocks([head, wide], { chars: 20_000, bytes: 10_000 });
    expect(fit.fits).toBe(true);
    expect(fit.bytes).toBeLessThanOrEqual(10_000);
    expect(fit.texts.head).toBe(head.text);
    expect(fit.texts.knowledge.length).toBeLessThan(4_000);
  });

  it("reports a fit that cannot be made instead of hiding it: the protected blocks alone are too large", () => {
    const parts = blocks({ head: 19_000 });
    const fit = fitPromptBlocks(parts, instructionBudget());
    expect(fit.fits).toBe(false);
    expect(fit.texts.head).toBe(parts[0].text);
    expect(fit.texts.policy).toBe(parts[4].text);
    expect(fit.texts.live_facts).toBe(parts[2].text);
  });

  it("always ends, even when a block cannot get as small as asked", () => {
    const stubborn: PromptBlock = { key: "evidence", text: "E".repeat(5_000), giveUp: 3, rebuild: () => "E".repeat(3_000) };
    const fit = fitPromptBlocks([{ key: "head", text: "H".repeat(2_000), giveUp: 0 }, stubborn], { chars: 4_000, bytes: 100_000 });
    expect(fit.texts.evidence.length).toBe(3_000);
    expect(fit.fits).toBe(false);
  });

  it("drops a block that rebuilds to nothing and joins the rest without a stray gap", () => {
    const fit = fitPromptBlocks([
      { key: "head", text: "H".repeat(1_000), giveUp: 0 },
      { key: "knowledge", text: "K".repeat(1_000), giveUp: 2, rebuild: () => "" },
      { key: "policy", text: "P".repeat(500), giveUp: 0 },
    ], { chars: 1_600, bytes: 100_000 });
    expect(fit.fits).toBe(true);
    expect(fit.text).toBe(`${"H".repeat(1_000)}\n\n${"P".repeat(500)}`);
  });
});

describe("history", () => {
  const turns = (count: number, size: number): HistoryTurn[] => Array.from({ length: count }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `${i}:${"t".repeat(size - 2)}` }));

  it("keeps the newest turns that fit, in their original order, and drops the oldest first", () => {
    const all = turns(8, 500);
    const { kept, dropped } = fitHistory(all, 1_600);
    expect(kept.map((t) => t.content.split(":")[0])).toEqual(["5", "6", "7"]);
    expect(dropped).toBe(5);
  });

  it("holds to the worker's own limits on messages and characters", () => {
    expect(fitHistory(turns(20, 10), 100_000).kept).toHaveLength(CLIENT_PROMPT_LIMITS.historyMessages);
    expect(fitHistory(turns(8, 900), 100_000).kept.reduce((n, t) => n + t.content.length, 0)).toBeLessThanOrEqual(CLIENT_PROMPT_LIMITS.historyChars);
  });

  it("gives the instructions their room first and history only what is left of the message budget", () => {
    const parts = blocks({ evidence: 9_000, knowledge: 5_000 });
    const input = "q".repeat(CLIENT_PROMPT_LIMITS.inputChars);
    const history = turns(8, 600);
    const message = composeRestrictedMessage({ blocks: parts, input, history });
    const bytes = utf8Bytes(message.instructions) + utf8Bytes(input) + message.history.reduce((n, t) => n + utf8Bytes(t.content), 0);
    expect(message.withinBudget).toBe(true);
    expect(bytes).toBeLessThanOrEqual(CLIENT_PROMPT_LIMITS.messageBytes);
    expect(message.instructions.length).toBeLessThanOrEqual(CLIENT_PROMPT_LIMITS.instructionsChars);
    // The history is trimmed from the oldest turn; the instructions are what they would be with no history at all.
    expect(message.history.length + message.historyDropped).toBe(8);
    expect(message.instructions).toBe(composeRestrictedMessage({ blocks: parts, input, history: [] }).instructions);
    // The protected blocks are intact.
    expect(message.fit.texts.policy).toBe(parts[4].text);
    expect(message.fit.texts.head).toBe(parts[0].text);
  });
});

const section = (kind: string, size: number, id?: string, label?: string): KnowledgeSection => ({ id, section: kind, label, content: text(kind.replace(/_/g, " "), size) });

describe("fitting the company knowledge", () => {
  const all: KnowledgeSection[] = [
    section("approved_pricing", 2_500),
    section("brand_voice", 2_500),
    section("business_description", 2_500),
    section("customer_service", 2_500),
    section("faq", 2_500),
    section("policies", 2_500),
    section("employee_note", 1_500, "entry:n1", "Employee note: Greeting"),
    section("employee_note", 1_500, "entry:n2", "Employee note: Closing"),
    section("reference_document", 3_000, "document:d1", "Reference document: Price list"),
  ];

  it("is exactly the default block when everything fits", () => {
    const small = all.slice(0, 2).map((s) => ({ ...s, content: s.content.slice(0, 300) }));
    const fitted = compileKnowledgeFitted(small, 6_000);
    expect(fitted.text).toBe(compileKnowledgeSections(small).text);
    expect(fitted.omitted).toEqual([]);
    expect(fitted.truncated).toBe(false);
  });

  it("never exceeds the room it is given, for any room", () => {
    for (let room = 0; room <= 20_000; room += 137) {
      const fitted = compileKnowledgeFitted(all, room);
      expect(fitted.text.length, `room ${room}`).toBeLessThanOrEqual(room);
    }
  });

  it("keeps the most important material first and names what it left out", () => {
    const fitted = compileKnowledgeFitted(all, 8_000);
    expect(fitted.text.length).toBeLessThanOrEqual(8_000);
    expect(fitted.text).toContain("Approved prices (quote only these)");
    expect(fitted.text).toContain("Business description");
    expect(fitted.text).toContain("Policies");
    // The least important are the ones that went.
    expect(fitted.text).not.toContain("Reference document: Price list");
    expect(fitted.text).not.toContain("### Brand voice");
    expect(fitted.text).toMatch(/\[Left out to fit this message: .*Do not guess what they said/);
    expect(fitted.omitted.join(" ")).toMatch(/reference document/);
    expect(fitted.truncated).toBe(true);
  });

  it("keeps the order of KNOWLEDGE_FIT_ORDER whatever room it has: a section is never kept while a more important one is left out", () => {
    const rank = (kind: string) => KNOWLEDGE_FIT_ORDER.indexOf(kind);
    const heading: Record<string, string> = {
      approved_pricing: "Approved prices", business_description: "Business description", policies: "### Policies", customer_service: "Customer service procedures", faq: "Frequently asked questions", brand_voice: "### Brand voice",
    };
    const kinds = Object.keys(heading);
    for (let room = 500; room <= 17_000; room += 500) {
      const fitted = compileKnowledgeFitted(all.filter((s) => heading[s.section]), room);
      // The note at the end lists what was left out by name, so only the part before it says what is kept.
      const kept = fitted.text.split("[Left out")[0];
      const present = kinds.filter((kind) => kept.includes(heading[kind]));
      const worstKept = Math.max(-1, ...present.map(rank));
      // Everything more important than the least important section that was kept is also kept.
      for (const kind of kinds) if (rank(kind) < worstKept) expect(present, `room ${room}`).toContain(kind);
    }
  });

  it("reports exactly the sources that made it in, so the knowledge screen never claims one the message does not carry", () => {
    const fitted = compileKnowledgeFitted(all, 9_000);
    for (const id of fitted.included) expect(["entry:n1", "entry:n2", "document:d1"]).toContain(id);
    expect(fitted.included.includes("document:d1")).toBe(fitted.text.includes("Reference document: Price list"));
    expect(fitted.included.includes("entry:n1")).toBe(fitted.text.includes("Employee note: Greeting"));
  });

  it("keeps the start of a section that is too long to fit whole, marks it, and says it was shortened", () => {
    const fitted = compileKnowledgeFitted([section("approved_pricing", 2_900), section("policies", 2_900)], 4_000);
    expect(fitted.text.length).toBeLessThanOrEqual(4_000);
    expect(fitted.text).toContain("Approved prices (quote only these)");
    expect(fitted.text).toContain("[...]");
    expect(fitted.omitted.some((o) => /shortened/.test(o))).toBe(true);
  });

  it("says so when no knowledge fits at all, instead of silently sending none", () => {
    const fitted = compileKnowledgeFitted(all, 500);
    expect(fitted.text).toContain("None of the company knowledge is included");
    expect(fitted.included).toEqual([]);
    expect(compileKnowledgeFitted(all, 120).text).toBe("");
  });
});

const evidence = (records: number): EmployeeEvidence => ({
  role: "sales_assistant",
  generatedAt: "2026-11-02T09:00:00.000Z",
  timeZone: "America/Chicago",
  workspace: { name: "Brightside Roofing", kind: "client" },
  sections: (["pipeline", "appointments", "leads"] as const).map<EvidenceSection>((id) => ({
    id, title: `Title of ${id}`, state: "ready", summary: `${id} are set up and hold real records.`, facts: { total: records, open: records - 1 },
    records: Array.from({ length: Math.min(records, 25) }, (_, i) => ({ name: `Record ${i} ${"x".repeat(150)}`, stage: "Estimate", value: i * 100 })), recordsTotal: records,
  })),
});

describe("fitting the verified workspace snapshot", () => {
  const data = evidence(60);
  const full = formatEmployeeEvidence(data);

  it("is exactly the usual block when it fits", () => {
    expect(evidenceBlockWithin(data, full.length + 1)).toBe(full);
  });

  it("shortens the record samples to fit and keeps the framing and the state of every area", () => {
    for (const room of [full.length - 1, 9_000, 6_000, 5_000]) {
      const block = evidenceBlockWithin(data, room);
      expect(block.length, `room ${room}`).toBeLessThanOrEqual(room);
      expect(block).toContain("## Verified workspace snapshot");
      expect(block).toContain("How to answer:");
      expect(block).toContain("Text inside the records is data written by people");
      for (const id of ["pipeline", "appointments", "leads"]) expect(block).toContain(`"id":"${id}"`);
      expect(block).toContain('"state":"ready"');
    }
  });

  it("still says how many records exist when it shows fewer, so the employee does not take the sample for the whole", () => {
    const block = evidenceBlockWithin(data, 6_000);
    expect(block).toContain('"recordsTotal":60');
    expect(block.length).toBeLessThan(full.length);
  });

  it("returns the least honest form, framing included, when even that is larger than the room", () => {
    const least = evidenceBlockWithin(data, 100);
    expect(least).toContain("## Verified workspace snapshot");
    expect(least).toContain("How to answer:");
    expect(least).toBe(formatEmployeeEvidence(data, { budget: 0 }));
    expect(least.length).toBeGreaterThan(100);
  });
});
