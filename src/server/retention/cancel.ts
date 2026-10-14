import "server-only";
import type { Queryable } from "@/server/db";
import { releaseReservation } from "@/server/billing/ledger";

/**
 * Stops a customer's program messages that have not gone out yet: the steps still waiting, and any message already queued or held
 * for approval. Called from the same place that stops sales follow-ups, so one stop condition (the customer replied, opted out, a
 * person took over, messaging was paused) ends both.
 *
 * A booking only ends re-engagement ("we haven't heard from you"); a welcome or a feedback request is still welcome after someone books.
 */
export async function cancelRetention(db: Queryable, orgId: string, contactId: string, reason: string): Promise<{ enrollments: number; messages: number }> {
  const onlyReengagement = reason === "customer_booked";
  const enrollments = await db.query<{ id: string }>(
    `update retention_enrollments e set status = 'cancelled', cancel_reason = $3, closed_at = now()
     from retention_programs p where p.id = e.program_id and e.org_id = $1 and e.contact_id = $2 and e.status = 'active' and ($4 = false or p.kind = 'reengagement')
     returning e.id`,
    [orgId, contactId, reason.slice(0, 120), onlyReengagement],
  );
  if (!enrollments.rows.length) return { enrollments: 0, messages: 0 };
  const ids = enrollments.rows.map((r) => r.id);
  await db.query("update retention_steps set status = 'cancelled', reason = $3 where org_id = $1 and enrollment_id = any($2::uuid[]) and status = 'scheduled'", [orgId, ids, reason.slice(0, 200)]);
  const pending = await db.query<{ id: string; message_id: string; reservation_id: string | null }>(
    `update conversation_messages m set status = 'blocked', blocked_reason = $3, status_detail = 'Stopped before sending.'
     from retention_steps s where s.message_id = m.id and s.org_id = $1 and s.enrollment_id = any($2::uuid[]) and s.status = 'queued' and m.status in ('draft', 'queued')
     returning m.id, m.id as message_id, m.reservation_id`,
    [orgId, ids, reason.slice(0, 60)],
  );
  for (const m of pending.rows) if (m.reservation_id) await releaseReservation(db, { orgId, reservationId: m.reservation_id, reason: `Stopped: ${reason}` });
  await db.query("update retention_steps set status = 'cancelled', reason = $3 where org_id = $1 and enrollment_id = any($2::uuid[]) and status = 'queued' and message_id = any($4::uuid[])", [orgId, ids, reason.slice(0, 200), pending.rows.map((m) => m.id)]);
  return { enrollments: ids.length, messages: pending.rows.length };
}
