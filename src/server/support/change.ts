import "server-only";
import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import type { SessionUser } from "@/server/auth/service";
import { freeTextProblem } from "@/lib/invoices/guards";
import { CHANGE_CLASSIFICATION_LABELS, isChangeClassification, type ChangeClassification, type ChangeTarget } from "@/lib/support/change";
import { loadTicketForAgency } from "@/server/support/access";
import { recordTicketEvent } from "@/server/support/events";

// Request a Change: what the team records about one, and how a client sees the change it was also filed as. The team's classification is an internal working label: it is
// never shown to the client, never a price and never a promise of a date.

// ---------------------------------------------------------------------------
// The client's view of one change request
// ---------------------------------------------------------------------------

export interface LinkedChange { id: string; ref: string; title: string; status: string; projectId: string; projectRef: string; projectTitle: string }

/** The entry on the project's change list that this request was also filed as, if any. Read as the person, so row-level security decides what they may see. */
export async function linkedChangeFor(userId: string, ticketId: string): Promise<LinkedChange | null> {
  const row = await withUser(userId, async (db) =>
    (await db.query<{ id: string; ref: string; title: string; status: string; request_id: string; project_ref: string; project_title: string }>(
      `select c.id, c.ref, c.title, c.status, c.request_id, r.ref as project_ref, r.title as project_title
       from project_change_orders c join client_project_requests r on r.id = c.request_id where c.ticket_id = $1`,
      [ticketId],
    )).rows[0],
  );
  return row ? { id: row.id, ref: row.ref, title: row.title, status: row.status, projectId: row.request_id, projectRef: row.project_ref, projectTitle: row.project_title } : null;
}

// ---------------------------------------------------------------------------
// The team's record
// ---------------------------------------------------------------------------

export interface AgencyChangeView {
  targetKind: ChangeTarget;
  project: { id: string; ref: string; title: string; status: string } | null;
  classification: ChangeClassification | null;
  classifiedByName: string | null;
  classifiedAt: string | null;
  resolutionNote: string | null;
  linked: LinkedChange | null;
}

export async function loadChangeForAgency(userId: string, ticketId: string): Promise<AgencyChangeView | null> {
  const row = await withUser(userId, async (db) =>
    (await db.query<{
      target_kind: ChangeTarget; project_id: string | null; classification: ChangeClassification | null; classified_at: Date | null; resolution_note: string | null; classified_by: string | null;
      project_ref: string | null; project_title: string | null; project_status: string | null;
    }>(
      `select c.target_kind, c.project_id, c.classification, c.classified_at, c.resolution_note, c.classified_by, r.ref as project_ref, r.title as project_title, r.status as project_status
       from support_ticket_change c left join client_project_requests r on r.id = c.project_id where c.ticket_id = $1`,
      [ticketId],
    )).rows[0],
  );
  if (!row) return null;
  // A colleague's name is read by the system: a person's own session cannot read another team member's account row.
  const classifiedByName = row.classified_by
    ? (await withSystem((db) => db.query<{ full_name: string | null }>("select full_name from users where id = $1", [row.classified_by]))).rows[0]?.full_name ?? null
    : null;
  return {
    targetKind: row.target_kind,
    project: row.project_id && row.project_ref ? { id: row.project_id, ref: row.project_ref, title: row.project_title ?? "", status: row.project_status ?? "" } : null,
    classification: row.classification,
    classifiedByName,
    classifiedAt: row.classified_at ? new Date(row.classified_at).toISOString() : null,
    resolutionNote: row.resolution_note,
    linked: await linkedChangeFor(userId, ticketId),
  };
}

/**
 * The team records what kind of change this is. Needs the standard right to work the request. It writes a line on the team's own timeline (the client never sees it) and
 * the audit log. Saying the same thing again changes nothing.
 */
export async function classifyChangeRequest(user: SessionUser, ticketId: string, input: { classification: string; note?: string | null }): Promise<{ changed: boolean }> {
  const t = await loadTicketForAgency(user, ticketId, "agency.support.manage");
  if (t.request_type !== "change") throw new AppError("invalid_input", "Only a change request is classified.");
  if (!isChangeClassification(input.classification)) throw new AppError("invalid_input", "Choose what kind of change this is.");
  const classification = input.classification;
  const note = (input.note ?? "").trim().slice(0, 1000) || null;
  const problem = freeTextProblem("The note", note);
  if (problem) throw new AppError("invalid_input", problem);
  const limit = await consumeRateLimit(RATE_LIMITS.supportAgencyActionByUser, user.id);
  if (!limit.allowed) throw new AppError("rate_limited", "You're making changes very quickly. Please wait a moment.");
  return withSystem(async (db) => {
    await db.query("select 1 from support_tickets where id = $1 for update", [ticketId]);
    const cur = (await db.query<{ classification: ChangeClassification | null; resolution_note: string | null }>("select classification, resolution_note from support_ticket_change where ticket_id = $1 for update", [ticketId])).rows[0];
    if (!cur) throw new AppError("not_found", "This request has no change record.");
    if (cur.classification === classification && (cur.resolution_note ?? null) === note) return { changed: false };
    await db.query("update support_ticket_change set classification = $2, classified_by = $3, classified_at = now(), resolution_note = $4 where ticket_id = $1", [ticketId, classification, user.id, note]);
    // The team's own timeline only; a classification is never a line the client reads.
    await recordTicketEvent(db, {
      ticketId, orgId: t.org_id, kind: "change_classified", visibility: "internal", actorUserId: user.id, actorKind: "agency",
      from: cur.classification, to: classification, detail: CHANGE_CLASSIFICATION_LABELS[classification].label,
    });
    await recordAudit({ orgId: t.org_id, actorUserId: user.id, actorKind: "agency", action: "support.change_classified", targetType: "support_ticket", targetId: ticketId, result: "success", metadata: { ref: t.ref, classification, from: cur.classification } }, db);
    return { changed: true };
  });
}
