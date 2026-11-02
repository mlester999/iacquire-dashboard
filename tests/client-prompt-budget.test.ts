// What a CLIENT employee is actually sent per run, measured against the restricted inference path's pinned budgets. The numbers are never retyped here: the instruction cap, the
// effective-message byte budget and the input and history limits are READ from the worker and the app (the way tests/hermes-prompt-budget.test.ts does), so a change to either side is
// measured, not assumed. The instructions are the product's own: three differently shaped synthetic clients answer every free-text question at the longest length the questionnaire
// accepts, the employees are built from those answers by the shared per-employee build, the company knowledge is stored at its database limit (the prompt keeps what its character
// budget allows), the client's booking types fill the live-facts block, and chat adds the verified workspace snapshot the real chat adds. Test database only; nothing calls a provider.
//
// TWO FINDINGS ARE RECORDED HERE AS BREACHES, NOT HIDDEN (details and options: docs/client-role-texts-review-2026-11-01.md, section 5):
//   1. With the longest answers the Lead Hunter's per-run instructions are over the worker's instruction cap.
//   2. A chat message (run instructions plus the verified workspace snapshot) is over the cap for every role.
// The budget is not raised and nothing is shortened to hide either. Each breach is asserted as a breach with its measured size, so the test cannot be masked by a setup error and turns
// red the day someone fixes it: delete the breach entry and the role is then held to the budget like the others.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { QUESTIONS } from "@/lib/onboarding/definitions";
import { insertEvidenceBlock } from "@/lib/employee-evidence";
import { createAppointmentType } from "@/server/calendars/setup";
import { buildRunInstructions } from "@/server/workforce/service";
import { prepareEmployeeEvidence } from "@/server/workforce/employee-evidence";
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
const MAX_HISTORY_CHARS = python("MAX_HISTORY_CHARS");
const MAX_PROMPT_BYTES = typescript("MAX_PROMPT_BYTES");
const KNOWLEDGE_SECTIONS = ["business_description", "products_services", "faq", "approved_pricing", "business_hours", "policies", "customer_service", "brand_voice", "escalation"];

/** Roles whose per-run instructions are over the instruction cap with the longest answers (finding 1). */
const RUN_OVER_CHARACTER_CAP: ReadonlySet<AgentRoleKey> = new Set<AgentRoleKey>(["lead_hunter"]);
/** Finding 2: with the verified workspace snapshot added, EVERY role is over the instruction cap. */
const CHAT_OVER_CHARACTER_CAP_FOR_EVERY_ROLE = true;

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
  { label: "a Manila dental client with five roles", name: "Ngiti Dental Manila", timezone: "Asia/Manila", sentence: "Nag-aalok kami ng malinis na ngipin, braces at pasta; ang bawat pasyente ay tinatawag na “kaibigan” at ang presyo ay ₱1,500 pataas. ", roles: AGENT_ROLE_KEYS.filter((r) => r !== "sales_assistant") },
  { label: "a two-role client of a different shape", name: "Northwind Freight Partners", timezone: "Europe/London", sentence: "Contract freight forwarding for mid-sized manufacturers, quoted per pallet and booked through a named account manager. ", roles: ["lead_hunter", "sales_assistant"] },
];

interface Measured {
  role: AgentRoleKey;
  run: { chars: number; bytes: number };
  chat: { chars: number; bytes: number };
  knowledgeTruncated: boolean;
  /** Characters the live-facts block could still grow by (zero for a role that does not read it); already added to the sizes above, so they are a ceiling. */
  liveFactsHeadroom: number;
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
    const run = await withSystem((db) => buildRunInstructions(db, orgId, id));
    const prepared = await prepareEmployeeEvidence(client.ctx, { agentId: id, roleKey: role });
    const chat = insertEvidenceBlock(run.instructions, prepared.block);
    // The fixture fills the booking types, which is what the Appointment Setter and Sales Assistant read; the CRM Manager reads pipeline stages. Whatever room a block has left under
    // its own cap is added (ordinary ASCII text, so characters and bytes alike), so every size below is the most the block can ever add, not what this fixture happened to build.
    const live = await withSystem((db) => liveFactsBlock(db, { orgId, orgKind: "client", role }));
    const liveFactsHeadroom = roleReadsLiveFacts(role) ? Math.max(0, LIVE_FACTS_MAX_CHARS - live.block.length) : 0;
    out.push({
      role,
      run: { chars: run.instructions.length + liveFactsHeadroom, bytes: Buffer.byteLength(run.instructions, "utf8") + liveFactsHeadroom },
      chat: { chars: chat.length + liveFactsHeadroom, bytes: Buffer.byteLength(chat, "utf8") + liveFactsHeadroom },
      knowledgeTruncated: run.knowledgeTruncated,
      liveFactsHeadroom,
    });
  }
  return out;
}

// One client per shape, built once and measured for both the run and the chat.
const measured = new Map<string, Promise<Measured[]>>();
const measureOnce = (shape: Shape) => {
  if (!measured.has(shape.label)) measured.set(shape.label, measure(shape));
  return measured.get(shape.label)!;
};

/** Characters left under the worker's instruction cap (negative = over), and bytes left under the effective-message budget once a full-length input is added. */
const characterRoom = (size: { chars: number }) => MAX_INSTRUCTIONS_CHARS - size.chars;
const firstMessageRoom = (size: { bytes: number }) => MAX_PROMPT_BYTES - (size.bytes + MAX_INPUT_CHARS);
/** What is left for a full conversation history as well (the worker accepts up to its history limit). Reported in every message, never asserted: it depends on the history. */
const historyRoom = (size: { bytes: number }) => MAX_PROMPT_BYTES - (size.bytes + MAX_INPUT_CHARS + MAX_HISTORY_CHARS);

describe("client employees and the restricted inference path's prompt budget", () => {
  it("reads its budgets from the worker and the app, and they agree", () => {
    expect(MAX_INSTRUCTIONS_CHARS).toBeGreaterThan(0);
    expect(MAX_PROMPT_BYTES).toBe(python("MAX_PROMPT_BYTES"));
    expect(MAX_PROMPT_BYTES).toBeGreaterThan(MAX_INSTRUCTIONS_CHARS);
  });

  for (const shape of SHAPES) {
    describe(shape.label, () => {
      it("is measured at its ceiling: every free-text answer at its longest, the knowledge budget spent, the live facts at their cap", async () => {
        const rows = await measureOnce(shape);
        expect(rows.map((m) => m.role).sort()).toEqual([...shape.roles].sort());
        for (const m of rows) {
          expect(m.knowledgeTruncated, `${m.role}: the knowledge budget was not reached, so the size is not a ceiling`).toBe(true);
          expect(m.liveFactsHeadroom, `${m.role}: a live-facts block cannot exceed its own cap`).toBeLessThanOrEqual(LIVE_FACTS_MAX_CHARS);
        }
      }, 180_000);

      it("per-run instructions fit the instruction cap and a full-length first message, except the recorded Lead Hunter breach", async () => {
        const rows = await measureOnce(shape);
        for (const m of rows) {
          const where = `${m.role}: ${m.run.chars} of ${MAX_INSTRUCTIONS_CHARS} characters (${characterRoom(m.run)} to spare), ${m.run.bytes} bytes (${firstMessageRoom(m.run)} to spare for a full first message under ${MAX_PROMPT_BYTES}; ${historyRoom(m.run)} with a full history too)`;
          if (RUN_OVER_CHARACTER_CAP.has(m.role)) {
            expect(characterRoom(m.run), `RECORDED BREACH FIXED? ${where}. Remove ${m.role} from RUN_OVER_CHARACTER_CAP.`).toBeLessThan(0);
          } else {
            expect(characterRoom(m.run), where).toBeGreaterThanOrEqual(0);
          }
          // The byte budget (instructions + input + history) is the worker's own rule; a first message must fit for every role.
          expect(firstMessageRoom(m.run), where).toBeGreaterThanOrEqual(0);
        }
      }, 180_000);

      it("a chat message with the verified workspace snapshot added is over the instruction cap for every role (recorded breach)", async () => {
        const rows = await measureOnce(shape);
        for (const m of rows) {
          const where = `${m.role}: chat instructions ${m.chat.chars} of ${MAX_INSTRUCTIONS_CHARS} characters (${characterRoom(m.chat)} to spare), ${m.chat.bytes} bytes`;
          if (CHAT_OVER_CHARACTER_CAP_FOR_EVERY_ROLE) expect(characterRoom(m.chat), `RECORDED BREACH FIXED? ${where}. Set CHAT_OVER_CHARACTER_CAP_FOR_EVERY_ROLE to false and assert the budget.`).toBeLessThan(0);
          else expect(characterRoom(m.chat), where).toBeGreaterThanOrEqual(0);
        }
      }, 180_000);
    });
  }
});
