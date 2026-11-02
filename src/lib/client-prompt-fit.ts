/**
 * Priority-based fitting of what a CLIENT employee is sent.
 *
 * The restricted inference path pins two budgets: the instructions may be at most `instructionsChars` characters, and the whole effective message (instructions, the person's
 * message and the conversation history that travels with it) at most `messageBytes` bytes. A client can fill every free-text answer to its longest accepted length, store company
 * knowledge up to the database limit and hold a large workspace, so the sum of the parts can be larger than that. This module makes the sum fit BY CONSTRUCTION, and says what it did.
 *
 * What is kept, in order, and what is given up first:
 *   1. The protected agency policy, the employee's configuration (its role, the client's own answers, approval rules, what it may and may not do) and the live booking and pipeline
 *      facts are never shortened.
 *   2. The person's current message is never shortened (the worker caps it on its own).
 *   3. Approved company and employee knowledge is shortened next, most important material kept first (see KNOWLEDGE_FIT_ORDER in compiler.ts), and the block names what was left out so
 *      the employee does not guess it.
 *   4. The verified workspace snapshot keeps its framing and the state of every area; its record samples are shortened from the tail and the snapshot says how many exist.
 *   5. Older conversation history is dropped first of all, newest turns kept.
 * Nothing is shortened when the parts already fit, so a typical client's prompt is byte for byte what it always was.
 *
 * Pure and import-safe from the server and from tests. The numbers are the worker's own; tests/client-prompt-fit.test.ts reads them from the worker and the app so they cannot drift.
 */

export const CLIENT_PROMPT_LIMITS = {
  /** MAX_INSTRUCTIONS_CHARS in services/hermes-inference-worker/worker.py. */
  instructionsChars: 20_000,
  /** MAX_PROMPT_BYTES in the worker and in src/server/integrations/hermes/inference-only.ts: instructions + input + history. */
  messageBytes: 24_576,
  /** MAX_INPUT_CHARS in the worker. */
  inputChars: 2_000,
  /** MAX_HISTORY_CHARS and MAX_HISTORY_MESSAGES in the worker. */
  historyChars: 5_000,
  historyMessages: 8,
} as const;

const encoder = new TextEncoder();
export const utf8Bytes = (text: string): number => encoder.encode(text).length;

export interface PromptBudget {
  chars: number;
  bytes: number;
}

/**
 * What the instructions may use once the person's message and the history are counted (their bytes come off the message budget). Without a message, the largest message the worker
 * accepts is assumed (2,000 characters, counted as one byte each), so instructions built before the message is known still leave room for a full-length first message.
 */
export function instructionBudget(rest: { input?: string; history?: readonly string[] } = {}): PromptBudget {
  const input = rest.input === undefined ? CLIENT_PROMPT_LIMITS.inputChars : utf8Bytes(rest.input);
  const history = (rest.history ?? []).reduce((total, turn) => total + utf8Bytes(turn), 0);
  return { chars: CLIENT_PROMPT_LIMITS.instructionsChars, bytes: Math.max(0, CLIENT_PROMPT_LIMITS.messageBytes - input - history) };
}

export type PromptBlockKey = "head" | "knowledge" | "live_facts" | "evidence" | "policy";

export interface PromptBlock {
  key: PromptBlockKey;
  text: string;
  /** 0 = never shortened. Otherwise the higher the number, the sooner the block is shortened. */
  giveUp: number;
  /**
   * Rebuilds the block at no more than `maxChars` characters. It may return a block that is longer than `maxChars` when that is the least it can honestly be (a floor), or an empty
   * string to drop the block. It must be deterministic. Without it the block is never shortened.
   */
  rebuild?: (maxChars: number) => string;
}

export interface PromptFitStep {
  key: PromptBlockKey;
  before: number;
  after: number;
}

export interface PromptFit {
  /** The blocks that are left, joined by a blank line. */
  text: string;
  chars: number;
  bytes: number;
  /** Within both limits. False only when the blocks that are never shortened are already too large for the budget. */
  fits: boolean;
  /** One entry per block that was shortened, with its size before and after. Empty when nothing had to be. */
  steps: PromptFitStep[];
  /** The final text of every block, for callers that need to know what one of them became. */
  texts: Record<PromptBlockKey, string>;
}

const SEPARATOR = "\n\n";
const EMPTY_TEXTS = (): Record<PromptBlockKey, string> => ({ head: "", knowledge: "", live_facts: "", evidence: "", policy: "" });

/** Shortens the most expendable block, then the next, until the joined text is within the budget in characters AND bytes (multi-byte text weighs more than its length). */
export function fitPromptBlocks(blocks: readonly PromptBlock[], budget: PromptBudget): PromptFit {
  const current = blocks.map((block) => ({ ...block, original: block.text }));
  const exhausted = new Set<number>();
  const join = () => current.map((block) => block.text).filter(Boolean).join(SEPARATOR);
  const finish = (text: string): PromptFit => {
    const steps: PromptFitStep[] = [];
    const texts = EMPTY_TEXTS();
    for (const block of current) {
      texts[block.key] = block.text;
      if (block.text.length !== block.original.length) steps.push({ key: block.key, before: block.original.length, after: block.text.length });
    }
    const bytes = utf8Bytes(text);
    return { text, chars: text.length, bytes, fits: text.length <= budget.chars && bytes <= budget.bytes, steps, texts };
  };
  for (let guard = 0; guard < 200; guard += 1) {
    const text = join();
    const overChars = text.length - budget.chars;
    const overBytes = utf8Bytes(text) - budget.bytes;
    if (overChars <= 0 && overBytes <= 0) return finish(text);
    let pick = -1;
    for (let i = 0; i < current.length; i += 1) {
      const block = current[i];
      if (block.giveUp <= 0 || !block.rebuild || !block.text || exhausted.has(i)) continue;
      if (pick < 0 || block.giveUp > current[pick].giveUp) pick = i;
    }
    if (pick < 0) return finish(text);
    const block = current[pick];
    const bytesPerChar = Math.max(1, utf8Bytes(block.text) / Math.max(1, block.text.length));
    const needed = Math.max(overChars, Math.ceil(overBytes / bytesPerChar), 1);
    const next = block.rebuild!(Math.max(0, block.text.length - needed));
    // Every accepted step is strictly shorter, so the loop ends; a block that cannot get any shorter is set aside and the next one is tried.
    if (next.length < block.text.length) block.text = next;
    else exhausted.add(pick);
  }
  return finish(join());
}

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

/** The newest turns that fit in `maxBytes` and in the worker's own history limits, in their original order. Older turns are dropped first. */
export function fitHistory<T extends HistoryTurn>(turns: readonly T[], maxBytes: number): { kept: T[]; dropped: number } {
  const kept: T[] = [];
  let bytes = 0;
  let chars = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    const turnBytes = utf8Bytes(turn.content);
    if (kept.length >= CLIENT_PROMPT_LIMITS.historyMessages || chars + turn.content.length > CLIENT_PROMPT_LIMITS.historyChars || bytes + turnBytes > maxBytes) break;
    kept.unshift(turn);
    bytes += turnBytes;
    chars += turn.content.length;
  }
  return { kept, dropped: turns.length - kept.length };
}

export interface RestrictedMessage {
  instructions: string;
  history: HistoryTurn[];
  historyDropped: number;
  fit: PromptFit;
  /** Instructions, input and history together are within both budgets. */
  withinBudget: boolean;
}

/**
 * The whole effective message for the restricted path. The instructions are fitted first, against the room the person's message leaves (history is the least important thing in the
 * message, so it never takes room from the instructions); whatever room remains goes to the newest turns of history.
 */
export function composeRestrictedMessage(args: { blocks: readonly PromptBlock[]; input: string; history?: readonly HistoryTurn[] }): RestrictedMessage {
  const fit = fitPromptBlocks(args.blocks, instructionBudget({ input: args.input }));
  const room = Math.max(0, CLIENT_PROMPT_LIMITS.messageBytes - fit.bytes - utf8Bytes(args.input));
  const { kept, dropped } = fitHistory(args.history ?? [], room);
  const total = fit.bytes + utf8Bytes(args.input) + kept.reduce((sum, turn) => sum + utf8Bytes(turn.content), 0);
  return { instructions: fit.text, history: kept, historyDropped: dropped, fit, withinBudget: fit.fits && total <= CLIENT_PROMPT_LIMITS.messageBytes };
}
