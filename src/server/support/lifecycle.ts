import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import {
  FEEDBACK_STAGE_LABELS, FEEDBACK_STAGE_STATUS, canTransition, isActiveStatus, isDoneStatus, isReopen, statusLabelForAgency,
  type FeedbackStage, type RequestType, type TicketStatus,
} from "@/lib/support/lifecycle";
import type { TicketCore } from "@/server/support/access";
import { recordTicketEvent } from "@/server/support/events";
import { clearResponseClock, ensureResponseClock } from "@/server/support/response-clock";
import { agencyHandlers, clientParticipants, dispatchSupportNotice } from "@/server/support/notify";
import { scheduleResolutionSurvey, skipOpenSurveyForTicket } from "@/server/support/surveys";

export interface Actor { userId: string | null; kind: "client" | "agency" | "system" }

export interface StatusChangeOptions {
  /** Automatic acknowledgements (for example "new" -> "open" on first touch) produce no thread line and no notification. */
  silent?: boolean;
  /** A short human note recorded on the timeline and shown in the notification body. */
  note?: string;
  /** Text for the thread line; defaults to "Status changed to …". */
  threadLine?: string;
  /** For feedback: the stage the team picked, which decides the status. */
  stage?: FeedbackStage;
}

export interface StatusChangeResult {
  changed: boolean;
  from: TicketStatus;
  to: TicketStatus;
  reopened: boolean;
  eventId: string | null;
}

/** The feedback stage a request ends up in after a status change. Feedback that was completed stays "completed" when it is later closed. */
export function stageAfter(type: RequestType, current: FeedbackStage | null, from: TicketStatus, to: TicketStatus, explicit?: FeedbackStage): FeedbackStage | null {
  if (type !== "feedback") return null;
  if (explicit) return explicit;
  if (to === "closed" && (current === "completed" || from === "resolved")) return "completed";
  if (to === "waiting_for_client") return current ?? "under_review";
  if (isReopen(from, to)) return "under_review";
  const entry = (Object.entries(FEEDBACK_STAGE_STATUS) as Array<[FeedbackStage, TicketStatus]>).find(([, status]) => status === to);
  return entry?.[0] ?? current;
}

/**
 * The one place a request changes status. Checks the move against the lifecycle, updates the request and its timestamps, writes the
 * timeline and (unless silent) the thread line, keeps the response clock right, notifies the right people and writes the audit entry.
 * Callers have already decided the actor is allowed to do this; this function refuses only impossible moves.
 */
export async function applyStatusChange(db: Queryable, t: TicketCore, to: TicketStatus, actor: Actor, opts: StatusChangeOptions = {}): Promise<StatusChangeResult> {
  const from = t.status;
  const stage = stageAfter(t.request_type, t.feedback_stage, from, to, opts.stage);
  if (from === to && stage === t.feedback_stage) return { changed: false, from, to, reopened: false, eventId: null };
  if (!canTransition(from, to)) throw new AppError("conflict", `A ${statusLabelForAgency(from).toLowerCase()} request can't move to ${statusLabelForAgency(to).toLowerCase()}.`);
  const reopened = isReopen(from, to);

  const { rows } = await db.query<{ priority: string; first_responded_at: Date | null }>(
    `update support_tickets set status = $2, feedback_stage = $3,
       resolved_at = case when $2 = 'resolved' then now() when $2 = 'closed' then coalesce(resolved_at, now()) when $4 then null else resolved_at end,
       closed_at = case when $2 = 'closed' then now() when $4 then null else closed_at end,
       reopened_count = reopened_count + case when $4 then 1 else 0 end,
       last_reopened_at = case when $4 then now() else last_reopened_at end
     where id = $1 returning priority, first_responded_at`,
    [t.id, to, stage, reopened],
  );

  const kind = reopened ? "reopened" : to === "resolved" ? "resolved" : to === "closed" ? "closed" : stage !== t.feedback_stage && t.request_type === "feedback" ? "feedback_stage" : "status_changed";
  // A resolved request may ask its opener one question later; reopening it withdraws an unanswered question. An answered survey stays a record.
  if (to === "resolved") await scheduleResolutionSurvey(db, t);
  else if (from === "resolved") await skipOpenSurveyForTicket(db, t.id);
  const eventId = await recordTicketEvent(db, {
    ticketId: t.id, orgId: t.org_id, kind, actorUserId: actor.userId, actorKind: actor.kind,
    from: kind === "feedback_stage" ? t.feedback_stage : from, to: kind === "feedback_stage" ? stage : to, detail: opts.note ?? null,
  });
  if (stage !== t.feedback_stage && kind !== "feedback_stage") {
    await recordTicketEvent(db, { ticketId: t.id, orgId: t.org_id, kind: "feedback_stage", actorUserId: actor.userId, actorKind: actor.kind, from: t.feedback_stage, to: stage });
  }

  if (!opts.silent) {
    const line = opts.threadLine ?? (t.request_type === "feedback" && stage ? `Feedback status: ${FEEDBACK_STAGE_LABELS[stage].label}.` : reopened ? "This request was reopened." : `Status changed to ${statusLabelForAgency(to).toLowerCase()}.`);
    await db.query("insert into support_messages (ticket_id, org_id, author_kind, body) values ($1, $2, 'system', $3)", [t.id, t.org_id, line]);
  }

  const settled = rows[0];
  if (isActiveStatus(to) && to !== "waiting_for_client") {
    await ensureResponseClock(db, { id: t.id, org_id: t.org_id, priority: settled?.priority ?? t.priority, status: to, first_responded_at: settled?.first_responded_at ?? t.first_responded_at }, { startedAt: reopened ? new Date() : undefined });
  } else {
    await clearResponseClock(db, t);
  }

  if (!opts.silent) {
    const key = `ev:${eventId}`;
    const ticket = { id: t.id, org_id: t.org_id, ref: t.ref, subject: t.subject };
    if (reopened && actor.kind === "client") {
      await dispatchSupportNotice(db, { event: "reopened", ticket, eventKey: key, recipients: await agencyHandlers(db, t, actor.userId), title: `${t.ref} was reopened by the client`, body: t.subject, severity: "warning" });
    } else if (to === "resolved") {
      await dispatchSupportNotice(db, { event: "resolved", ticket, eventKey: key, recipients: await clientParticipants(db, t.id, t.org_id, actor.userId), title: `${t.ref} was marked resolved`, body: opts.note ?? "You can reopen it from the request if it isn't resolved.", severity: "success" });
    } else if (to === "closed") {
      await dispatchSupportNotice(db, { event: "closed", ticket, eventKey: key, recipients: await clientParticipants(db, t.id, t.org_id, actor.userId), title: `${t.ref} was closed`, body: opts.note });
    } else if (actor.kind !== "client") {
      const label = t.request_type === "feedback" && stage ? FEEDBACK_STAGE_LABELS[stage].label : reopened ? "reopened" : statusLabelForAgency(to).toLowerCase();
      await dispatchSupportNotice(db, { event: "status_changed", ticket, eventKey: key, recipients: await clientParticipants(db, t.id, t.org_id, actor.userId), title: `${t.ref} is now ${label}`, body: opts.note ?? t.subject });
    }
  }

  await recordAudit({
    orgId: t.org_id, actorUserId: actor.userId, actorKind: actor.kind === "client" ? "user" : actor.kind, action: reopened ? "support.reopened" : "support.status_changed",
    targetType: "support_ticket", targetId: t.id, result: "success", metadata: { ref: t.ref, from, to, ...(stage ? { stage } : {}) },
  }, db);
  return { changed: true, from, to, reopened, eventId };
}

/** First touch by the team: a "new" request becomes "open" without announcing it. Returns the (possibly updated) status. */
export async function acknowledgeIfNew(db: Queryable, t: TicketCore, actor: Actor): Promise<TicketStatus> {
  if (t.status !== "new") return t.status;
  await applyStatusChange(db, t, "open", actor, { silent: true });
  return "open";
}

export const isFinished = (status: string) => isDoneStatus(status);
