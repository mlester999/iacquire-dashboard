import "server-only";
import { recordAudit } from "@/server/audit";
import type { Queryable } from "@/server/db";
import { DEMO_EVENT_TEXT_KEYS, type DemoActor } from "@/lib/demo/events";
import { addEvent, lockProspect } from "@/server/demo/core";

// Erasing a prospect: the details they gave and everything they said are removed, and the row stays as a plain record that a demo was asked for and what became of it (the
// dates, the counts, the status), so the funnel's numbers and the fact that an erasure happened survive. Used by an erasure on request (a Super Admin, after the person asked) and by
// the retention job when the retention period has passed.
//
// Removed: name, address, business name, the keyed hash of their address, campaign tags, the whole conversation, every session and link, the copies of their emails still in the
// outbox, and the words a team member typed about them in the timeline (notes and reasons). On a request (not on the retention clock) the same address's requests on /get-started
// are redacted too, because they are the same person's details and the pipeline joins the two. Kept: dates, counts and statuses, the timeline's lines (without their words), the
// assignment, and the audit trail, which holds ids and numbers only.

export interface ErasureCounts {
  messages: number;
  sessions: number;
  links: number;
  emails: number;
  /** /get-started requests of the same address, redacted. */
  accessRequests: number;
  /** Timeline lines that lost the words a team member typed. */
  eventsRedacted: number;
}

export type ErasureReason = "request" | "retention";

/** Erases inside the caller's transaction. Returns null when the prospect is not there or was erased already. */
export async function eraseProspectInTx(db: Queryable, prospectId: string, actor: DemoActor, why: ErasureReason, now: Date): Promise<ErasureCounts | null> {
  const p = await lockProspect(db, prospectId);
  if (!p || p.erased_at) return null;
  // The timeline refuses edits except while this is on for the transaction (migration 0100); it is never on for anything else.
  await db.query("select set_config('iaq.demo_erase', 'on', true)");
  const address = p.work_email;
  const messages = await db.query("delete from demo_messages where prospect_id = $1", [p.id]);
  const sessions = await db.query("delete from demo_sessions where prospect_id = $1", [p.id]);
  const links = await db.query("delete from demo_verifications where prospect_id = $1", [p.id]);
  const emails = address ? await db.query("delete from email_outbox where template = 'demo_link' and to_email = $1", [address]) : { rowCount: 0 };
  let accessRequests = 0;
  if (why === "request" && address) {
    const redacted = await db.query(
      `update access_requests set company_name = 'Erased', contact_name = 'Erased', email = ('erased-' || substr(id::text, 1, 8) || '@erased.invalid'), website = null, message = null
       where email = $1 or id = $2`,
      [address, p.access_request_id],
    );
    accessRequests = redacted.rowCount;
  }
  const redactedEvents = await db.query("update demo_events set detail = detail - $2::text[] where prospect_id = $1 and detail ?| $2::text[]", [p.id, [...DEMO_EVENT_TEXT_KEYS]]);
  await db.query(
    `update demo_prospects set name = null, work_email = null, email_normalized = null, business_name = null, ip_hash = null, utm = '{}'::jsonb, marketing_opt_in = false,
       access_request_id = null, erased_at = $2::timestamptz where id = $1`,
    [p.id, now.toISOString()],
  );
  const counts: ErasureCounts = {
    messages: messages.rowCount, sessions: sessions.rowCount, links: links.rowCount, emails: emails.rowCount, accessRequests, eventsRedacted: redactedEvents.rowCount,
  };
  await addEvent(db, p.id, "erased", actor, { why, messages: counts.messages, accessRequests }, now);
  await recordAudit(
    {
      actorUserId: actor.kind === "user" ? actor.id : null, actorKind: actor.kind === "user" ? "agency" : "system", action: "demo.erased", targetType: "demo_prospect", targetId: p.id,
      result: "success", metadata: { why, ...counts },
    },
    db,
  );
  return counts;
}

/** Removes the row of someone who never confirmed their address, with their pending links and the outbox copy of the email sent to them. Nothing was ever shown to them. */
export async function deleteUnconfirmedInTx(db: Queryable, prospectId: string): Promise<boolean> {
  const p = await lockProspect(db, prospectId);
  if (!p || p.verified_at) return false;
  if (p.work_email) await db.query("delete from email_outbox where template = 'demo_link' and to_email = $1", [p.work_email]);
  await db.query("delete from demo_prospects where id = $1 and verified_at is null", [p.id]);
  await recordAudit({ actorKind: "system", action: "demo.unconfirmed_deleted", targetType: "demo_prospect", targetId: p.id, result: "success", metadata: {} }, db);
  return true;
}
