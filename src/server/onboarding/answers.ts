import "server-only";
import type { Queryable } from "@/server/db";
import { QUESTION_BY_ID } from "@/lib/onboarding/definitions";
import type { AnswerSource, AnswerValue, StoredAnswers } from "@/lib/onboarding/types";

// The stored answers of one workspace, read the same way by the questionnaire and by the code that keeps Settings in step with it.

export type AnswerRow = { question_id: string; value: unknown; skipped: boolean; source: AnswerSource; needs_confirmation: boolean; updated_at: Date };

/** The saved answers as the engine reads them. Internal rows (the website reading) are not answers. */
export function toStored(rows: AnswerRow[]): StoredAnswers {
  const out: StoredAnswers = {};
  for (const r of rows) {
    if (!QUESTION_BY_ID[r.question_id]) continue;
    out[r.question_id] = { value: r.value as AnswerValue, skipped: r.skipped, source: r.source, needsConfirmation: r.needs_confirmation, updatedAt: new Date(r.updated_at).toISOString() };
  }
  return out;
}

export async function loadAnswerRows(db: Queryable, orgId: string): Promise<AnswerRow[]> {
  const { rows } = await db.query<AnswerRow>("select question_id, value, skipped, source, needs_confirmation, updated_at from onboarding_answers where org_id = $1", [orgId]);
  return rows;
}

/** When each answer was last saved, in milliseconds, for the answers that are questions. */
export function answerTimes(rows: AnswerRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) if (QUESTION_BY_ID[r.question_id]) out[r.question_id] = new Date(r.updated_at).getTime();
  return out;
}
