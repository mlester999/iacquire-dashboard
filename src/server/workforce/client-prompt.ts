import "server-only";
import { compileKnowledgeFitted, KNOWLEDGE_NONE_BLOCK, type FittedKnowledge, type KnowledgeSection } from "@/server/workforce/compiler";
import { evidenceBlockWithin, snapshotWording, type EmployeeEvidence } from "@/lib/employee-evidence";
import { compressHead } from "@/lib/client-head-fit";
import {
  composeRestrictedMessage, fitPromptBlocks, instructionBudget, type HistoryTurn, type PromptBlock, type PromptBudget, type PromptFit, type PromptFitStep,
} from "@/lib/client-prompt-fit";

/**
 * Fits what a client employee is sent to the restricted path's budgets (src/lib/client-prompt-fit.ts has the rules and the reasons). This is the server half: it knows how to rebuild
 * the two blocks that can be shortened, the company knowledge and the verified workspace snapshot, at a smaller size. Nothing is shortened when the parts already fit.
 */

/** The pieces of a client employee's run instructions, kept so they can be fitted again for a chat message (which adds a snapshot and the person's own message). */
export interface ClientPromptParts {
  /**
   * The employee's configuration: its role, the client's own answers, approval rules and abilities. The role, the rules and the business itself are never shortened; the client's longer
   * free-text answers are the very last thing to be (src/lib/client-head-fit.ts).
   */
  head: string;
  /** The protected agency policy. Never shortened. */
  policy: string;
  /** The live booking and pipeline facts, read at run time. Never shortened (they are capped at 1,200 characters on their own). */
  live: string;
  /** Optional app-owned Growth Partner memory. It is contextual only and the first optional block shortened. */
  memory?: string;
  knowledge: { block: string; entryIds: string[]; documentIds: string[]; sections: KnowledgeSection[] };
}

export interface ClientPromptResult {
  instructions: string;
  knowledgeBlock: string;
  knowledgeEntryIds: string[];
  knowledgeDocumentIds: string[];
  /** The knowledge was shortened by THIS fit (it may also have been shortened by its own default budget). */
  knowledgeShortened: boolean;
  fit: PromptFit;
}

export interface ClientChatResult extends ClientPromptResult {
  history: HistoryTurn[];
  historyDropped: number;
  withinBudget: boolean;
}

/** What a fit did, as it is recorded (block names and sizes only: no text). */
export interface ClientPromptFitRecord {
  fits: boolean;
  chars: number;
  bytes: number;
  shortened: PromptFitStep[];
  historyDropped: number;
}

export const fitRecord = (fit: PromptFit, historyDropped = 0): ClientPromptFitRecord => ({ fits: fit.fits, chars: fit.chars, bytes: fit.bytes, shortened: fit.steps, historyDropped });

/** The configuration block: given up last of all, and only the client's longer answers in it. */
function headBlock(text: string): PromptBlock {
  return { key: "head", text, giveUp: 1, rebuild: (maxChars) => compressHead(text, maxChars) };
}

function knowledgeBlock(parts: ClientPromptParts, memo: Map<string, FittedKnowledge>): PromptBlock {
  return {
    key: "knowledge",
    text: parts.knowledge.block,
    giveUp: 2,
    rebuild: (maxChars) => {
      const fitted = compileKnowledgeFitted(parts.knowledge.sections, maxChars);
      // When even the least honest block does not fit, that block is still what is sent: the knowledge is never silently absent. It is the floor, so asking again gives nothing shorter.
      const text = fitted.text || KNOWLEDGE_NONE_BLOCK;
      memo.set(text, text === fitted.text ? fitted : { ...fitted, text, included: [] });
      return text;
    },
  };
}

function memoryBlock(text: string | undefined): PromptBlock {
  const memory = text ?? "";
  return {
    key: "memory",
    text: memory,
    giveUp: 4,
    rebuild: (maxChars) => maxChars <= 0 ? "" : memory.slice(0, Math.max(0, maxChars - 1)) + (memory.length > maxChars ? "…" : ""),
  };
}

function resultOf(parts: ClientPromptParts, fit: PromptFit, memo: Map<string, FittedKnowledge>): ClientPromptResult {
  const text = fit.texts.knowledge;
  const unchanged = text === parts.knowledge.block;
  const included = unchanged ? null : (memo.get(text)?.included ?? []);
  return {
    instructions: fit.text,
    knowledgeBlock: text,
    knowledgeEntryIds: included ? parts.knowledge.entryIds.filter((id) => included.includes(`entry:${id}`)) : parts.knowledge.entryIds,
    knowledgeDocumentIds: included ? parts.knowledge.documentIds.filter((id) => included.includes(`document:${id}`)) : parts.knowledge.documentIds,
    knowledgeShortened: !unchanged,
    fit,
  };
}

/** Run instructions (everything a job or an auto-reply is sent) within the instruction cap, leaving room for a full-length first message. Unchanged when they already fit. */
export function fitClientRunInstructions(parts: ClientPromptParts, budget: PromptBudget = instructionBudget()): ClientPromptResult {
  const memo = new Map<string, FittedKnowledge>();
  const fit = fitPromptBlocks([
    headBlock(parts.head),
    knowledgeBlock(parts, memo),
    { key: "live_facts", text: parts.live, giveUp: 0 },
    memoryBlock(parts.memory),
    { key: "policy", text: parts.policy, giveUp: 0 },
  ], budget);
  return resultOf(parts, fit, memo);
}

/**
 * Chat instructions: the run instructions plus the verified workspace snapshot, fitted against the room the person's message leaves. The snapshot is shortened first (its record
 * samples, never its framing or the state of an area), then the knowledge, and only then the client's own longer answers in the employee's configuration; the policy, the role, the
 * client's rules and the live facts are never shortened. History, when there is
 * any, only gets what the instructions and the message leave. Unchanged (byte for byte what insertEvidenceBlock builds) when everything already fits.
 */
export function fitClientChatInstructions(
  parts: ClientPromptParts,
  snapshot: { evidence: EmployeeEvidence; block: string },
  input: string,
  history: readonly HistoryTurn[] = [],
): ClientChatResult {
  const memo = new Map<string, FittedKnowledge>();
  const message = composeRestrictedMessage({
    blocks: [
      headBlock(snapshotWording(parts.head)),
      knowledgeBlock(parts, memo),
      { key: "live_facts", text: parts.live, giveUp: 0 },
      memoryBlock(parts.memory),
      { key: "evidence", text: snapshot.block, giveUp: 3, rebuild: (maxChars) => evidenceBlockWithin(snapshot.evidence, maxChars) },
      { key: "policy", text: parts.policy, giveUp: 0 },
    ],
    input,
    history,
  });
  return { ...resultOf(parts, message.fit, memo), history: message.history, historyDropped: message.historyDropped, withinBudget: message.withinBudget };
}
