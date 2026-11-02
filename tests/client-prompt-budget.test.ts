// What a CLIENT employee is actually sent, held to the restricted inference path's pinned budgets. The numbers are never retyped here: the instruction cap, the effective-message byte
// budget and the input and history limits are READ from the worker and the app (the way tests/hermes-prompt-budget.test.ts does), so a change to either side is measured, not assumed.
// The instructions are the product's own: three differently shaped synthetic clients answer every free-text question at the longest length the questionnaire accepts, the employees are
// built from those answers by the shared per-employee build, the company knowledge is stored at its database limit, the client's booking types fill the live-facts block (padded to its
// cap), and chat adds the verified workspace snapshot the real chat adds. Test database only; nothing calls a provider.
//
// TWO FINDINGS WERE RECORDED HERE AS BREACHES (docs/client-role-texts-review-2026-11-01.md, section 5) and are now FIXED by priority-based fitting (src/lib/client-prompt-fit.ts):
//   1. With the longest answers the Lead Hunter's per-run instructions were over the worker's instruction cap.
//   2. A chat message (run instructions plus the verified workspace snapshot) was over the cap for every role.
// The unfitted sizes are still measured below, so this test cannot pass because the fixture got smaller: it asserts that the breaches exist without the fit and that, with it, every role
// fits both budgets at its ceiling, that nothing protected was shortened, and that what was shortened says so.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { QUESTIONS } from "@/lib/onboarding/definitions";
import { insertEvidenceBlock, snapshotWording } from "@/lib/employee-evidence";
import { CLIENT_PROMPT_LIMITS, instructionBudget, utf8Bytes, type HistoryTurn } from "@/lib/client-prompt-fit";
import { HEAD_SHORTENED_NOTE, PROTECTED_CONTEXT_FIELDS } from "@/lib/client-head-fit";
import { KNOWLEDGE_NONE_BLOCK } from "@/server/workforce/compiler";
import { createAppointmentType } from "@/server/calendars/setup";
import { buildRunInstructions } from "@/server/workforce/service";
import { prepareEmployeeEvidence } from "@/server/workforce/employee-evidence";
import { fitClientChatInstructions, fitClientRunInstructions, type ClientChatResult, type ClientPromptParts, type ClientPromptResult } from "@/server/workforce/client-prompt";
import { LIVE_FACTS_MAX_CHARS, liveFactsBlock, roleReadsLiveFacts } from "@/server/workforce/live-facts";
import { agentId } from "./support/fixtures";
import { readyClient } from "./support/launch";

const root = resolve(__dirname, "..");
const worker = readFileSync(join(root, "services/hermes-inference-worker/worker.py"), "utf8");
const app = readFileSync(join(root, "src/server/integrations/hermes/inference-only.ts"), "utf8");
const python = (name: string) => {
  const match = worker.match(new RegExp(`^${name} = ([\\d_]+)$`, "m"));
  if (!match) throw new Error(`${name} not found in the worker`);
  return Number(match[1].replace(/_/g, ""));
};
const typescript = (name: string) => {
  const match = app.match(new RegExp(`const ${name} = ([\\d_]+);`));
  if (!match) throw new Error(`${name} not found in the app`);
  return Number(match[1].replace(/_/g, ""));
};

const MAX_INSTRUCTIONS_CHARS = python("MAX_INSTRUCTIONS_CHARS");
const MAX_INPUT_CHARS = python("MAX_INPUT_CHARS");
const MAX_PROMPT_BYTES = typescript("MAX_PROMPT_BYTES");
const KNOWLEDGE_SECTIONS = ["business_description", "products_services", "faq", "approved_pricing", "business_hours", "policies", "customer_service", "brand_voice", "escalation"];

/** Text of exactly `length` characters made of ordinary words (the questionnaire trims, so it never ends on a space). */
const filler = (sentence: string, length: number) => sentence.repeat(Math.ceil(length / sentence.length) + 1).slice(0, length).trimEnd();

/** Every free-text question answered at the longest length the questionnaire itself accepts. Choices, lists and hours keep the client's real defaults. */
function longestAnswers(sentence: string): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const q of QUESTIONS) {
    if (q.kind.type === "text" || q.kind.type === "longtext") answers[q.id] = filler(sentence, q.kind.max);
  }
  return answers;
}

interface Shape {
  label: string;
  name: string;
  timezone: string;
  sentence: string;
  roles: readonly AgentRoleKey[];
}

// Three clients that differ in answers, language (the second uses multi-byte characters, so bytes and characters differ) and plan.
const SHAPES: Shape[] = [
  { label: "a Chicago roofing client with all six roles", name: "Brightside Roofing Chicago", timezone: "America/Chicago", sentence: "We repair and replace residential roofs after storm damage, with a written estimate and a call within one business day. ", roles: AGENT_ROLE_KEYS },
  { label: "a Manila dental client with five roles", name: "Ngiti Dental Manila", timezone: "Asia/Manila", sentence: "Nag-aalok kami ng malinis na ngipin, braces at pasta; ang bawat pasyente ay tinatawag na “kaibigan” at ang presyo ay ₱1,500 pataas. ", roles: AGENT_ROLE_KEYS.filter((r) => r !== "performance_analyst") },
  { label: "a two-role client of a different shape", name: "Northwind Freight Partners", timezone: "Europe/London", sentence: "Contract freight forwarding for mid-sized manufacturers, quoted per pallet and booked through a named account manager. ", roles: ["lead_hunter", "crm_manager"] },
];

const TYPICAL_QUESTION = "How many leads came in this week, and which one should I follow up on first?";
/** A full-length message in ordinary text, and one of the same length in a script that takes three bytes a character. */
const FULL_INPUT = filler("Please look at my last estimate and tell me what is still open and what I should do next. ", MAX_INPUT_CHARS);
const WIDE_INPUT = "€".repeat(MAX_INPUT_CHARS);
/** A full conversation: as many turns as the worker accepts, as long as its history limit allows. */
const FULL_HISTORY: HistoryTurn[] = Array.from({ length: CLIENT_PROMPT_LIMITS.historyMessages }, (_, i) => ({
  role: i % 2 ? "assistant" : "user",
  content: `turn ${i}: ${filler("an earlier question or answer in this conversation ", Math.floor(CLIENT_PROMPT_LIMITS.historyChars / CLIENT_PROMPT_LIMITS.historyMessages) - 10)}`,
}));

interface Measured {
  role: AgentRoleKey;
  /** The pieces at their ceiling: the live facts padded to their own cap. */
  parts: ClientPromptParts;
  snapshot: Awaited<ReturnType<typeof prepareEmployeeEvidence>>;
  /** What was sent before the fit existed, in characters. */
  unfitted: { run: number; runBytes: number; chat: number };
  /** The real build (no padding), which must already be fitted. */
  built: { instructions: string; fitted: ClientPromptResult };
  run: ClientPromptResult;
  chat: ClientChatResult;
  chatFull: ClientChatResult;
  chatWide: ClientChatResult;
  knowledgeTruncatedByDefault: boolean;
}

async function measure(shape: Shape): Promise<Measured[]> {
  const client = await readyClient({ name: shape.name, timezone: shape.timezone, extraAnswers: longestAnswers(shape.sentence) });
  const orgId = client.org.id;
  await withSystem(async (db) => {
    for (const section of KNOWLEDGE_SECTIONS) {
      // 12,000 characters is the database limit of one section; the prompt keeps only what its own character budget allows.
      await db.query(
        "insert into company_knowledge (org_id, section, content) values ($1, $2, $3) on conflict (org_id, section) do update set content = excluded.content",
        [orgId, section, filler(shape.sentence, 12_000)],
      );
    }
    await db.query("update agent_instances set enabled = (role_key = any($2::text[])) where org_id = $1", [orgId, [...shape.roles]]);
  });
  // Enough booking types that the live-facts block reaches its own size cap.
  for (let i = 0; i < 14; i += 1) {
    await createAppointmentType(client.actor("owner"), client.calendarId, { name: `${shape.name.split(" ")[0]} appointment type number ${i + 1}`, durationMinutes: 30, minNoticeMinutes: 60, maxDaysAhead: 30 });
  }
  const out: Measured[] = [];
  for (const role of shape.roles) {
    const id = await agentId(orgId, role);
    const built = await withSystem((db) => buildRunInstructions(db, orgId, id));
    const snapshot = await prepareEmployeeEvidence(client.ctx, { agentId: id, roleKey: role });
    const live = await withSystem((db) => liveFactsBlock(db, { orgId, orgKind: "client", role }));
    const headroom = roleReadsLiveFacts(role) ? Math.max(0, LIVE_FACTS_MAX_CHARS - live.block.length) : 0;
    const base = built.clientParts;
    if (!base) throw new Error(`${role}: a client employee's instructions carry their parts`);
    // Whatever room the live-facts block has left under its own cap is added (ordinary ASCII text), so every size below is the most the block can ever add.
    const parts: ClientPromptParts = { ...base, live: headroom > 0 ? `${base.live}\n${"x".repeat(headroom - 1)}` : base.live };
    const unfittedRun = [parts.head, parts.knowledge.block, parts.live, parts.policy].filter(Boolean).join("\n\n");
    out.push({
      role,
      parts,
      snapshot,
      unfitted: { run: unfittedRun.length, runBytes: utf8Bytes(unfittedRun), chat: insertEvidenceBlock(unfittedRun, snapshot.block).length },
      built: { instructions: built.instructions, fitted: fitClientRunInstructions(base) },
      run: fitClientRunInstructions(parts),
      chat: fitClientChatInstructions(parts, snapshot, TYPICAL_QUESTION),
      chatFull: fitClientChatInstructions(parts, snapshot, FULL_INPUT, FULL_HISTORY),
      chatWide: fitClientChatInstructions(parts, snapshot, WIDE_INPUT, FULL_HISTORY),
      knowledgeTruncatedByDefault: built.knowledgeTruncated,
    });
  }
  return out;
}

// One client per shape, built once and used for every assertion.
const measured = new Map<string, Promise<Measured[]>>();
const measureOnce = (shape: Shape) => {
  if (!measured.has(shape.label)) measured.set(shape.label, measure(shape));
  return measured.get(shape.label)!;
};

const messageBytes = (m: ClientChatResult, input: string) => utf8Bytes(m.instructions) + utf8Bytes(input) + m.history.reduce((n, t) => n + utf8Bytes(t.content), 0);
const NEWLINE = String.fromCharCode(10);
/** The text of one context field as the compiler wrote it: its line and the indented lines under it. */
function contextField(head: string, label: string): string | null {
  const lines = head.split(NEWLINE);
  const start = lines.findIndex((l) => l.startsWith(`${label}: `));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && lines[end].startsWith("  ")) end += 1;
  return lines.slice(start, end).join(NEWLINE);
}

/**
 * The protected pieces are in the text exactly as they were built: the agency policy, the live facts, and the employee's configuration (with the snapshot wording a chat uses).
 * The configuration is whole unless the fit had to shorten the client's own longer answers as its very last step; then the role, the operating standard and every protected
 * business field and rule are still whole, and the one note saying so is there.
 */
function expectProtectedIntact(where: string, text: string, parts: ClientPromptParts, chat: boolean, headShortened: boolean) {
  expect(text, `${where}: the agency policy`).toContain(parts.policy);
  if (parts.live) expect(text, `${where}: the live facts`).toContain(parts.live);
  const head = chat ? snapshotWording(parts.head) : parts.head;
  if (!headShortened) {
    expect(text, `${where}: the employee's configuration`).toContain(head);
    expect(text, `${where}: nothing was shortened, so no note`).not.toContain(HEAD_SHORTENED_NOTE);
    return;
  }
  expect(text, `${where}: who the employee is and its operating standard`).toContain(head.slice(0, head.indexOf("## How to communicate")));
  for (const label of PROTECTED_CONTEXT_FIELDS) {
    const original = contextField(head, label);
    if (original) expect(text, `${where}: ${label}`).toContain(original);
  }
  expect(text.split(HEAD_SHORTENED_NOTE).length - 1, `${where}: the note appears once`).toBe(1);
}

describe("client employees and the restricted inference path's prompt budget", () => {
  it("reads its budgets from the worker and the app, and they agree with the fit's own", () => {
    expect(MAX_INSTRUCTIONS_CHARS).toBe(CLIENT_PROMPT_LIMITS.instructionsChars);
    expect(MAX_PROMPT_BYTES).toBe(python("MAX_PROMPT_BYTES"));
    expect(MAX_PROMPT_BYTES).toBe(CLIENT_PROMPT_LIMITS.messageBytes);
    expect(MAX_INPUT_CHARS).toBe(CLIENT_PROMPT_LIMITS.inputChars);
    expect(MAX_PROMPT_BYTES).toBeGreaterThan(MAX_INSTRUCTIONS_CHARS);
  });

  for (const shape of SHAPES) {
    describe(shape.label, () => {
      it("is measured at its ceiling, and without the fit the two recorded breaches are real", async () => {
        const rows = await measureOnce(shape);
        expect(rows.map((m) => m.role).sort()).toEqual([...shape.roles].sort());
        for (const m of rows) {
          expect(m.knowledgeTruncatedByDefault, `${m.role}: the knowledge budget was not reached, so the size is not a ceiling`).toBe(true);
          // Finding 2: with the snapshot added, every role was over the instruction cap before the fit.
          expect(m.unfitted.chat, `${m.role}: ${m.unfitted.chat} characters unfitted`).toBeGreaterThan(MAX_INSTRUCTIONS_CHARS);
        }
        // Optional: write what was measured, for the review record (CLIENT_PROMPT_REPORT=<file>). Sizes only.
        if (process.env.CLIENT_PROMPT_REPORT) {
          const file = process.env.CLIENT_PROMPT_REPORT;
          const previous = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as unknown[]) : [];
          const rowsOut = rows.map((m) => ({
            client: shape.label, role: m.role, unfittedRun: m.unfitted.run, unfittedChat: m.unfitted.chat, run: m.run.instructions.length, chat: m.chat.instructions.length,
            chatFull: m.chatFull.instructions.length, chatWide: m.chatWide.instructions.length, wideFits: m.chatWide.withinBudget,
            runShortened: m.run.fit.steps.map((x) => x.key), chatShortened: m.chat.fit.steps.map((x) => x.key), fullShortened: m.chatFull.fit.steps.map((x) => x.key), historyKept: m.chatFull.history.length,
          }));
          writeFileSync(file, JSON.stringify([...previous, ...rowsOut], null, 1));
        }
        // Finding 1: the Lead Hunter's per-run instructions were over the cap with the longest answers.
        for (const m of rows.filter((r) => r.role === "lead_hunter")) expect(m.unfitted.run, "lead_hunter run, unfitted").toBeGreaterThan(MAX_INSTRUCTIONS_CHARS);
      }, 240_000);

      it("per-run instructions fit the cap and a full-length first message for every role, with nothing protected shortened", async () => {
        for (const m of await measureOnce(shape)) {
          const where = `${m.role}: ${m.run.instructions.length} of ${MAX_INSTRUCTIONS_CHARS} characters, ${utf8Bytes(m.run.instructions)} bytes + ${MAX_INPUT_CHARS} for a first message under ${MAX_PROMPT_BYTES}`;
          expect(m.run.fit.fits, where).toBe(true);
          expect(m.run.instructions.length, where).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS);
          expect(utf8Bytes(m.run.instructions) + MAX_INPUT_CHARS, where).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
          expectProtectedIntact(where, m.run.instructions, m.parts, false, m.run.fit.steps.some((x) => x.key === "head"));
          // Only the knowledge was shortened, and only when it had to be.
          expect(m.run.fit.steps.every((s) => s.key === "knowledge"), where).toBe(true);
          expect(m.run.knowledgeShortened, where).toBe(m.unfitted.run > MAX_INSTRUCTIONS_CHARS || m.unfitted.runBytes + MAX_INPUT_CHARS > MAX_PROMPT_BYTES);
        }
      }, 240_000);

      it("the real build is already fitted: what buildRunInstructions returns is what the fit makes of its parts", async () => {
        for (const m of await measureOnce(shape)) {
          expect(m.built.instructions, m.role).toBe(m.built.fitted.instructions);
          expect(m.built.instructions.length, m.role).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS);
        }
      }, 240_000);

      it("a shortened knowledge block says what it left out, keeps the most important material, and reports only the sources it still carries", async () => {
        for (const m of await measureOnce(shape)) {
          if (!m.run.knowledgeShortened) continue;
          expect(m.run.knowledgeBlock, m.role).toMatch(/\[Left out to fit this message: .*Do not guess what they said/);
          expect(m.run.knowledgeBlock.length, m.role).toBeLessThan(m.parts.knowledge.block.length);
          // The least important section goes first: if the approved prices are gone, so is the brand voice.
          const kept = m.run.knowledgeBlock.split("[Left out")[0];
          if (!kept.includes("Approved prices")) expect(kept, m.role).not.toContain("### Brand voice");
          for (const id of m.run.knowledgeEntryIds) expect(m.parts.knowledge.entryIds, m.role).toContain(id);
          for (const id of m.run.knowledgeDocumentIds) expect(m.parts.knowledge.documentIds, m.role).toContain(id);
        }
      }, 240_000);

      it("a chat message with the verified workspace snapshot fits for every role, the snapshot goes first and the protected parts stay whole", async () => {
        for (const m of await measureOnce(shape)) {
          const where = `${m.role}: chat ${m.chat.instructions.length} of ${MAX_INSTRUCTIONS_CHARS} characters, ${messageBytes(m.chat, TYPICAL_QUESTION)} of ${MAX_PROMPT_BYTES} bytes`;
          expect(m.chat.fit.fits, where).toBe(true);
          expect(m.chat.withinBudget, where).toBe(true);
          expect(m.chat.instructions.length, where).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS);
          expect(messageBytes(m.chat, TYPICAL_QUESTION), where).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
          expectProtectedIntact(where, m.chat.instructions, m.parts, true, m.chat.fit.steps.some((x) => x.key === "head"));
          // The snapshot keeps its framing and the state of every area it was built with.
          expect(m.chat.instructions, where).toContain("## Verified workspace snapshot");
          expect(m.chat.instructions, where).toContain("How to answer:");
          for (const section of m.snapshot.evidence.sections) expect(m.chat.instructions, `${where}: ${section.id}`).toContain(`"id":"${section.id}"`);
          // The order: the snapshot first, then the knowledge, and the client's own longer answers only after both have given all they can.
          const keys = m.chat.fit.steps.map((x) => x.key);
          if (keys.includes("knowledge")) expect(keys, where).toContain("evidence");
          if (keys.includes("head")) {
            expect(keys, where).toEqual(expect.arrayContaining(["knowledge", "evidence"]));
            expect(m.chat.knowledgeBlock, `${where}: the knowledge was already at its floor`).toBe(KNOWLEDGE_NONE_BLOCK);
          }
          expect(keys.every((k) => k === "head" || k === "knowledge" || k === "evidence"), where).toBe(true);
        }
      }, 240_000);

      it("a full-length message and a full conversation still fit, with the history trimmed from its oldest turn and the instructions given their room first", async () => {
        for (const m of await measureOnce(shape)) {
          const where = `${m.role}: ${messageBytes(m.chatFull, FULL_INPUT)} of ${MAX_PROMPT_BYTES} bytes, ${m.chatFull.history.length} of ${FULL_HISTORY.length} turns kept`;
          expect(m.chatFull.withinBudget, where).toBe(true);
          expect(messageBytes(m.chatFull, FULL_INPUT), where).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
          expect(m.chatFull.instructions.length, where).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS);
          expectProtectedIntact(where, m.chatFull.instructions, m.parts, true, m.chatFull.fit.steps.some((x) => x.key === "head"));
          expect(m.chatFull.history.length + m.chatFull.historyDropped, where).toBe(FULL_HISTORY.length);
          // What was kept is the newest of the conversation, in order.
          expect(m.chatFull.history, where).toEqual(FULL_HISTORY.slice(FULL_HISTORY.length - m.chatFull.history.length));
          // History never took room from the instructions: they are what they would be with no history at all.
          expect(m.chatFull.instructions, where).toBe(fitClientChatInstructions(m.parts, m.snapshot, FULL_INPUT, []).instructions);
        }
      }, 240_000);

      it("a full-length message in a script that takes three bytes a character is held to the same budget, or reported plainly when the protected parts alone cannot fit", async () => {
        for (const m of await measureOnce(shape)) {
          const where = `${m.role}: ${messageBytes(m.chatWide, WIDE_INPUT)} of ${MAX_PROMPT_BYTES} bytes`;
          expectProtectedIntact(where, m.chatWide.instructions, m.parts, true, m.chatWide.fit.steps.some((x) => x.key === "head"));
          expect(m.chatWide.instructions, where).toContain("How to answer:");
          if (m.chatWide.withinBudget) {
            expect(messageBytes(m.chatWide, WIDE_INPUT), where).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
          } else {
            // Never hidden: the fit says it did not fit, and by then every part that may be shortened is at its least: the knowledge is its one honest line, the history is gone.
            expect(m.chatWide.fit.fits, where).toBe(false);
            expect(m.chatWide.history, where).toEqual([]);
            expect(m.chatWide.knowledgeBlock, where).toBe(KNOWLEDGE_NONE_BLOCK);
          }
          const room = instructionBudget({ input: WIDE_INPUT }).bytes;
          expect(utf8Bytes(m.chatWide.instructions) <= room, where).toBe(m.chatWide.fit.fits);
        }
      }, 240_000);
    });
  }
});
