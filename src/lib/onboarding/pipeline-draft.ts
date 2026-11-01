// Pure rules that turn the client's own sales-process answer into a draft of pipeline stages. Nothing is guessed: the answer must already be a clean list of steps, and anything that
// reads like a paragraph returns null (the client then builds the stages in the CRM, as before). The result is only a plan. src/server/onboarding/workspace-drafts.ts adds it as a
// new pipeline when the client asks for that; it never edits the pipelines a workspace already has.
import type { Answers } from "./types";

export const PIPELINE_DRAFT_NAME = "Your sales process";
export const PIPELINE_DRAFT_DESCRIPTION = "Drafted from the sales steps in your onboarding answers.";

/** A list of fewer than three steps is not a process, and more than eight is more likely a paragraph than a pipeline. */
export const PIPELINE_DRAFT_MIN_STEPS = 3;
export const PIPELINE_DRAFT_MAX_STEPS = 8;
/** The longest stage name the CRM accepts. */
export const PIPELINE_DRAFT_MAX_STEP_LENGTH = 60;

export type DraftStageKind = "open" | "won" | "lost";

export interface PipelineStagePlan {
  stages: Array<{ name: string; kind: DraftStageKind }>;
  /** The answers the stages came from, for the audit trail and for saying so to the client. */
  from: ["d.sales_process"];
}

// Whole-step matches only: a step such as "Book the job" is an ordinary step, and marking a stage Won changes the client's revenue reports, so only a step that says nothing but
// "won", "signed" and the like closes a deal.
const WON_STEPS: ReadonlySet<string> = new Set(["won", "closed won", "deal won", "sale won", "closed", "sale closed", "deal closed", "signed", "contract signed", "booked", "job booked", "sold"]);
const LOST_STEPS: ReadonlySet<string> = new Set(["lost", "closed lost", "deal lost", "lost deal"]);

const closingKind = (step: string): "won" | "lost" | null => {
  const key = step.toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
  return WON_STEPS.has(key) ? "won" : LOST_STEPS.has(key) ? "lost" : null;
};

/** One step as written: single spaces, no bullet in front, no closing full stop, semicolon or comma behind. */
const tidy = (raw: string): string => raw.replace(/\s+/g, " ").replace(/^[\s\-*•]+/, "").replace(/[\s.;,:]+$/, "").trim();

/** "1. Enquiry. 2. Qualify. 3. Quote" (on one line or several): the numbers must start at 1 and count up by one, otherwise it is not a list we can read. */
function splitNumbered(text: string): string[] | null {
  const markers = [...text.matchAll(/(?:^|\s)(\d{1,2})[.)]\s+/g)];
  if (!markers.every((m, i) => Number(m[1]) === i + 1)) return null;
  return markers.map((m, i) => text.slice((m.index ?? 0) + m[0].length, markers[i + 1]?.index ?? text.length));
}

function splitSteps(text: string): string[] | null {
  if (/^\d{1,2}[.)]\s/.test(text)) return splitNumbered(text);
  if (text.includes("\n")) return text.split(/\n+/);
  if (text.includes(";")) return text.split(";");
  if (/→|->/.test(text)) return text.split(/\s*(?:→|->)\s*/);
  return null;
}

/**
 * The stages a clean sales-process list supports, or null. A clean list is a numbered list, one step per line, steps separated by semicolons, or steps joined by arrows: 3 to 8 steps,
 * each at most 60 characters, no step twice, and no step that is itself several sentences. Steps that say won, closed, booked or signed (or lost) become the Won and Lost stages, and only
 * as the last steps of the list; a closing word anywhere else, or more than one of a kind, makes the list unclear and returns null. A list with no Won or no Lost step gets a final
 * "Won" or "Lost" added, so the pipeline always ends the way the CRM expects (open stages, then Won, then Lost).
 */
export function planPipelineStages(answers: Answers): PipelineStagePlan | null {
  const raw = answers["d.sales_process"];
  if (typeof raw !== "string") return null;
  const parts = splitSteps(raw.trim());
  if (!parts) return null;
  const steps = parts.map(tidy).filter(Boolean);
  if (steps.length < PIPELINE_DRAFT_MIN_STEPS || steps.length > PIPELINE_DRAFT_MAX_STEPS) return null;
  const seen = new Set<string>();
  for (const step of steps) {
    if (step.length > PIPELINE_DRAFT_MAX_STEP_LENGTH || /[.!?]\s+\S/.test(step)) return null;
    const key = step.toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
  }

  const kinds = steps.map(closingKind);
  const firstClosing = kinds.findIndex((k) => k !== null);
  if (firstClosing >= 0 && kinds.slice(firstClosing).some((k) => k === null)) return null;
  const wonAt = kinds.flatMap((k, i) => (k === "won" ? [i] : []));
  const lostAt = kinds.flatMap((k, i) => (k === "lost" ? [i] : []));
  if (wonAt.length > 1 || lostAt.length > 1) return null;

  const open = (firstClosing >= 0 ? steps.slice(0, firstClosing) : steps).map((name) => ({ name, kind: "open" as const }));
  if (!open.length) return null;
  const won = { name: wonAt.length ? steps[wonAt[0]] : "Won", kind: "won" as const };
  const lost = { name: lostAt.length ? steps[lostAt[0]] : "Lost", kind: "lost" as const };
  return { stages: [...open, won, lost], from: ["d.sales_process"] };
}
