import "server-only";
import { onboardingSchema } from "@/lib/agent-settings";
import { QUESTION_BY_ID } from "@/lib/onboarding/definitions";
import { legacyToAnswers } from "@/lib/onboarding/engine";
import type { StoredAnswers } from "@/lib/onboarding/types";
import { AppError } from "@/server/errors";
import { withUser } from "@/server/db";
import { toStored, type AnswerRow } from "@/server/onboarding/answers";
import type { OrgContext } from "@/server/tenancy/context";

export interface SubmittedBrainSource {
  answers: StoredAnswers;
  questionnaireVersion: number;
  submittedAt: Date;
  answerCount: number;
}

/**
 * Reads only the last submitted onboarding snapshot. Later unsent edits are excluded, and
 * version-one tenants fall back to the saved legacy onboarding response as historical facts.
 */
export async function getSubmittedBrainSource(ctx: OrgContext): Promise<SubmittedBrainSource | null> {
  if (!ctx.can("agents.configure")) {
    throw new AppError("forbidden", "Only workspace owners and admins can prepare the AI Growth Partner.");
  }

  return withUser(ctx.user.id, async (db) => {
    const { rows: responseRows } = await db.query<{
      questionnaire_version: number;
      status: "draft" | "submitted";
      submitted_at: Date | string | null;
      data: unknown;
    }>(
      "select questionnaire_version, status, submitted_at, data from onboarding_responses where org_id = $1",
      [ctx.org.orgId],
    );
    const response = responseRows[0];
    if (response?.status !== "submitted" || !response.submitted_at) return null;

    const submittedAt = response.submitted_at instanceof Date ? response.submitted_at : new Date(response.submitted_at);
    if (!Number.isFinite(submittedAt.getTime())) return null;

    const { rows: answerRows } = await db.query<AnswerRow>(
      `select question_id, value, skipped, source, needs_confirmation, updated_at
       from onboarding_answers where org_id = $1 and updated_at <= $2`,
      [ctx.org.orgId, submittedAt],
    );
    let answers = toStored(answerRows);

    // Old tenants may have only the nested questionnaire JSON. Treat those facts as historical,
    // never as freshly client-confirmed information.
    if (!Object.keys(answers).length && Number(response.questionnaire_version) === 1) {
      const legacy = onboardingSchema.safeParse(response.data ?? {});
      if (legacy.success) {
        const values = legacyToAnswers(legacy.data);
        const updatedAt = submittedAt.toISOString();
        answers = Object.fromEntries(Object.entries(values).flatMap(([questionId, value]) => {
          if (!QUESTION_BY_ID[questionId] || value === undefined) return [];
          return [[questionId, {
            value,
            skipped: false,
            source: "prefill" as const,
            needsConfirmation: false,
            updatedAt,
          }]];
        }));
      }
    }

    if (!Object.keys(answers).length) return null;
    return {
      answers,
      questionnaireVersion: Number(response.questionnaire_version),
      submittedAt,
      answerCount: Object.values(answers).filter((answer) => !answer.skipped && answer.value != null).length,
    };
  });
}
