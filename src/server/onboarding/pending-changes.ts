import "server-only";
import type { Queryable } from "@/server/db";
import { QUESTION_BY_ID } from "@/lib/onboarding/definitions";
import { confirmedAnswers } from "@/lib/onboarding/engine";
import { parseProfileSnapshot } from "@/lib/onboarding/business-profile";
import type { Answers } from "@/lib/onboarding/types";
import { appliedThrough } from "@/server/onboarding/profile-sync";
import { loadAnswerRows, toStored, type AnswerRow } from "@/server/onboarding/answers";

// Whether the client has saved answer edits that nobody approved. The same rule the questionnaire uses for "unsubmitted changes" (getOnboardingSession in service.ts): once a
// workspace has been submitted, any answer saved after the later of the last submission and the last Settings edit that left nothing waiting is an edit the live setup does not
// know about yet. The launch judge uses it twice: it blocks 100% while an edit waits, and it keeps reading the LAST APPROVED answers for the two facts that decide what is required
// (are appointments wanted, which channels are wanted), so a draft edit cannot turn a requirement off before anyone approved it.
//
// Answers are overwritten in place, so the value an edited answer had at the last approval is not kept. What is kept is WHEN each answer was last saved. So the approved answers are
// every answer not saved since the approval, and for an answer that was edited since, the caller falls back to the state that was actually applied (a calendar that exists, a channel
// that has a credential or a registration), which is what the last approval produced.

export interface PendingAnswerChanges {
  /** At least one answer was saved after the last approval. Always false for a workspace that was never submitted. */
  pending: boolean;
  /** The question ids saved after the last approval, in the questionnaire's own ids. */
  editedIds: string[];
  /** The moment up to which answer edits are known to be in the live setup (milliseconds), 0 when never submitted. */
  appliedAt: number;
}

/** The rule itself, on rows already read. Pure. */
export function pendingChangesOf(rows: AnswerRow[], onboarding: { submittedAt: Date | string | null; snapshot: unknown } | null): PendingAnswerChanges {
  const submittedAt = onboarding?.submittedAt ? new Date(onboarding.submittedAt) : null;
  if (!submittedAt || !Number.isFinite(submittedAt.getTime())) return { pending: false, editedIds: [], appliedAt: 0 };
  const appliedAt = appliedThrough({ snapshot: parseProfileSnapshot(onboarding?.snapshot), submittedAt });
  const editedIds = rows.filter((r) => QUESTION_BY_ID[r.question_id] && new Date(r.updated_at).getTime() > appliedAt).map((r) => r.question_id);
  return { pending: editedIds.length > 0, editedIds, appliedAt };
}

/** The workspace's answer rows and whether any were saved after the last approval. Trusted code: names the workspace in every query. */
export async function readPendingAnswerChanges(db: Queryable, orgId: string, rows?: AnswerRow[]): Promise<PendingAnswerChanges & { rows: AnswerRow[] }> {
  const answerRows = rows ?? await loadAnswerRows(db, orgId);
  const { rows: onboarding } = await db.query<{ submitted_at: Date | null; submitted_snapshot: unknown }>("select submitted_at, submitted_snapshot from onboarding_responses where org_id = $1", [orgId]);
  const state = pendingChangesOf(answerRows, onboarding[0] ? { submittedAt: onboarding[0].submitted_at, snapshot: onboarding[0].submitted_snapshot } : null);
  return { ...state, rows: answerRows };
}

const SENDER_QUESTION = { sms: "c.sms_sender", whatsapp: "c.whatsapp_number", email: "c.email_sender" } as const;

/**
 * The channels the client had already given a sender for, from answers not saved since the last approval. A sender is only asked for a channel that was picked, so a sender
 * answer that has not changed is evidence the channel was wanted when it was approved, even after the list of channels itself was edited (and its approved value lost).
 * A channel picked without a sender (a text number can be left blank) leaves no such evidence.
 */
export function channelsWithApprovedSender(rows: AnswerRow[], state: PendingAnswerChanges): Array<keyof typeof SENDER_QUESTION> {
  const edited = new Set(state.editedIds);
  const given = new Set(rows.filter((r) => !r.skipped && !r.needs_confirmation && !edited.has(r.question_id) && typeof r.value === "string" && r.value.trim() !== "").map((r) => r.question_id));
  return (Object.keys(SENDER_QUESTION) as Array<keyof typeof SENDER_QUESTION>).filter((channel) => given.has(SENDER_QUESTION[channel]));
}

/** The confirmed answers as of the last approval: every answer that was not saved since. An edited answer is absent (its approved value was not kept). */
export function approvedAnswersOf(rows: AnswerRow[], state: PendingAnswerChanges): Answers {
  const edited = new Set(state.editedIds);
  return confirmedAnswers(toStored(rows.filter((r) => !edited.has(r.question_id))));
}
