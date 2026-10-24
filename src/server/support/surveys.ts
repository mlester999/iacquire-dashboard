import "server-only";
import type { Queryable } from "@/server/db";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { SessionUser } from "@/server/auth/service";
import { loadSupportSettings } from "@/server/support/settings";
import type { SurveyView } from "@/lib/support/surveys";

// Satisfaction surveys are a record of what the person who opened a request said, once. The request is resolved, the team waits the
// configured delay so a reply can arrive first, and the question then appears inside that client's own request. Nothing is emailed or
// texted, no other person can answer it, and an answered survey never changes. The table and its guard are migration 0098.

const SURVEY_OPEN_DAYS = 14;

const toView = (r: { id: string; rating: number | null; helpful: boolean | null; comment: string | null; requested_at: Date; expires_at: Date | null }): SurveyView => ({
  id: r.id,
  rating: r.rating,
  helpful: r.helpful,
  comment: r.comment,
  requestedAt: new Date(r.requested_at).toISOString(),
  expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
});

/**
 * Schedules the one survey for a request that just became resolved. Called inside the status-change transaction; if surveys are off,
 * the request has no opener, or a survey already exists, this does nothing. A future requested_at is a scheduled question, not a sent one:
 * the client page only reads it once that moment has passed.
 */
export async function scheduleResolutionSurvey(db: Queryable, ticket: { id: string; org_id: string; created_by: string | null }, now = new Date()): Promise<void> {
  if (!ticket.created_by) return;
  const settings = await loadSupportSettings(db);
  if (!settings.surveysEnabled) return;
  const requestedAt = new Date(now.getTime() + settings.surveyDelayHours * 3_600_000);
  const expiresAt = new Date(requestedAt.getTime() + SURVEY_OPEN_DAYS * 86_400_000);
  await db.query(
    `insert into support_surveys (org_id, kind, ticket_id, requested_for_user_id, requested_at, expires_at)
     values ($1, 'ticket_resolution', $2, $3, $4, $5)
     on conflict do nothing`,
    [ticket.org_id, ticket.id, ticket.created_by, requestedAt.toISOString(), expiresAt.toISOString()],
  );
}

/** A request that is reopened is no longer resolved; an unanswered question about it is withdrawn. An answered survey stays a record. */
export async function skipOpenSurveyForTicket(db: Queryable, ticketId: string): Promise<void> {
  await db.query("update support_surveys set status = 'skipped' where ticket_id = $1 and status = 'requested'", [ticketId]);
}

const OPEN_SQL = `select id, rating, helpful, comment, requested_at, expires_at from support_surveys
  where ticket_id = $1 and requested_for_user_id = $2 and status = 'requested'
    and requested_at <= $3 and (expires_at is null or expires_at > $3)
  order by requested_at desc limit 1`;

/** The open survey for this person on this request, if it is due. Read as trusted code because it is scoped to the person and the request. */
export async function getSurveyForTicket(userId: string, ticketId: string, now = new Date()): Promise<SurveyView | null> {
  return withSystem(async (db) => {
    const row = (await db.query<Parameters<typeof toView>[0]>(OPEN_SQL, [ticketId, userId, now.toISOString()])).rows[0];
    return row ? toView(row) : null;
  });
}

export interface SurveyAnswer {
  rating: number;
  helpful: boolean;
  comment?: string | null;
}

/** The opener answers once. The row's own guards and this status check make a second answer impossible. */
export async function answerSupportSurvey(user: Pick<SessionUser, "id">, surveyId: string, input: SurveyAnswer, now = new Date()): Promise<SurveyView> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(surveyId)) throw new AppError("not_found", "That survey was not found.");
  const rating = Math.trunc(input.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new AppError("invalid_input", "Choose a rating from one to five.");
  if (typeof input.helpful !== "boolean") throw new AppError("invalid_input", "Tell us whether the reply helped.");
  const comment = (input.comment ?? "").trim().slice(0, 1000) || null;
  const answered = await withSystem(async (db) => {
    const row = (await db.query<Parameters<typeof toView>[0] & { org_id: string; kind: string }>(
      `update support_surveys set status = 'answered', rating = $2, helpful = $3, comment = $4, answered_by = $5, answered_at = $6
       where id = $1 and requested_for_user_id = $5 and status = 'requested' and requested_at <= $6 and (expires_at is null or expires_at > $6)
       returning id, org_id, kind, rating, helpful, comment, requested_at, expires_at`,
      [surveyId, rating, input.helpful, comment, user.id, now.toISOString()],
    )).rows[0];
    if (!row) throw new AppError("conflict", "This survey is no longer open. It may already be answered, or the request was reopened.");
    await recordAudit({ orgId: row.org_id, actorUserId: user.id, actorKind: "user", action: "support.survey_answered", targetType: "support_survey", targetId: surveyId, result: "success", metadata: { kind: row.kind, rating } }, db);
    return toView(row);
  });
  return answered;
}

