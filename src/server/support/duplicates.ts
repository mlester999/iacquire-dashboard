import "server-only";
import { withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import type { OrgContext } from "@/server/tenancy/context";
import type { SessionUser } from "@/server/auth/service";
import { cleanLine } from "@/lib/support/content";
import { rankSimilar } from "@/lib/support/suggest";
import type { RequestType, TicketStatus } from "@/lib/support/lifecycle";
import { loadTicketForAgency } from "@/server/support/access";

export interface SimilarRequest {
  id: string;
  ref: string;
  subject: string;
  status: TicketStatus;
  requestType: RequestType;
  createdAt: string;
  score: number;
}

interface Row { id: string; ref: string; subject: string; status: TicketStatus; request_type: RequestType; created_at: Date }

const toSimilar = (r: Row & { score: number }): SimilarRequest => ({ id: r.id, ref: r.ref, subject: r.subject, status: r.status, requestType: r.request_type, createdAt: new Date(r.created_at).toISOString(), score: r.score });

/**
 * Requests the person can already see that sound like what they are typing, so they can follow one up instead of opening another.
 * Only their own view is searched (row-level security applies), nothing from other people or other clients is ever suggested, and
 * nothing is merged: it is a suggestion beside the form.
 */
export async function findSimilarRequests(ctx: OrgContext, input: { subject: string; type?: RequestType }): Promise<SimilarRequest[]> {
  if (!ctx.can("support.use")) throw new AppError("forbidden", "Your role can't open support requests.");
  const subject = cleanLine(input.subject, 160);
  if (subject.length < 8) return [];
  const limit = await consumeRateLimit(RATE_LIMITS.supportSimilarByUser, ctx.user.id);
  if (!limit.allowed) return [];
  const seesAll = ctx.can("support.view_all");
  const rows = await withUser(ctx.user.id, async (db) =>
    (await db.query<Row>(
      `select id, ref, subject, status, request_type, created_at from support_tickets
       where org_id = $1 and ($3 or created_by = $2) and ($4::text is null or request_type = $4)
         and (status in ('new', 'open', 'in_progress', 'waiting_for_client') or (status = 'resolved' and resolved_at > now() - interval '14 days'))
       order by created_at desc limit 200`,
      [ctx.org.orgId, ctx.user.id, seesAll, input.type ?? null],
    )).rows,
  );
  return rankSimilar(subject, rows).map(toSimilar);
}

/** For the team: other requests from the same client that may be the same problem. The team decides whether to link or merge them. */
export async function findSimilarForAgency(user: SessionUser, ticketId: string): Promise<SimilarRequest[]> {
  const t = await loadTicketForAgency(user, ticketId);
  const rows = await withUser(user.id, async (db) =>
    (await db.query<Row>(
      `select id, ref, subject, status, request_type, created_at from support_tickets
       where org_id = $1 and id <> $2 and status in ('new', 'open', 'in_progress', 'waiting_for_client', 'resolved')
         and not exists (select 1 from support_ticket_links l where (l.ticket_id = $2 and l.related_ticket_id = support_tickets.id) or (l.related_ticket_id = $2 and l.ticket_id = support_tickets.id))
       order by created_at desc limit 200`,
      [t.org_id, ticketId],
    )).rows,
  );
  return rankSimilar(t.subject, rows, { min: 0.45 }).map(toSimilar);
}
