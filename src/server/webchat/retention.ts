import "server-only";
import { withSystem, type Queryable } from "@/server/db";

// How long website chats and what they carried are kept. Run once a day by the scheduler (job "webChatRetention"), bounded per run, oldest first.
//
//   A chat whose visitor never left details ("anonymous")   removed after the widget's anonymous retention (default 30 days of no activity): the chat,
//                                                           its messages, and the contact the chat created when nothing else was ever added to it.
//   Any other chat                                          removed after the widget's retention (default 90 days of no activity): the chat and its
//                                                           messages. The contact stays: it holds a person's details and a CRM history of its own.
//
// A contact is removed only when it is still exactly what the chat made: created through the website chat, with no identity (email or phone), no deal,
// task, appointment, note or call, and no other conversation. Nothing a person added to the CRM is ever deleted by a clock.

export interface WebChatRetentionResult {
  anonymousChats: number;
  expiredChats: number;
  contacts: number;
}

const LIMIT = 500;

/** A contact that is still only what an anonymous chat made. */
const EMPTY_CHAT_CONTACT = `
  c.created_via = 'website_chat' and c.email is null and c.phone is null
  and not exists (select 1 from contact_identities i where i.org_id = c.org_id and i.contact_id = c.id)
  and not exists (select 1 from crm_opportunities o where o.org_id = c.org_id and o.contact_id = c.id)
  and not exists (select 1 from tasks t where t.org_id = c.org_id and t.contact_id = c.id)
  and not exists (select 1 from appointment_refs a where a.org_id = c.org_id and a.contact_id = c.id)
  and not exists (select 1 from crm_activities n where n.org_id = c.org_id and n.contact_id = c.id and n.kind not in ('contact.created'))
  and not exists (select 1 from crm_contact_tags g where g.org_id = c.org_id and g.contact_id = c.id)
  and not exists (select 1 from contact_memories m where m.contact_id = c.id)
  and not exists (select 1 from crm_call_records r where r.org_id = c.org_id and r.contact_id = c.id)
  and not exists (select 1 from customer_invoices ci where ci.org_id = c.org_id and ci.contact_id = c.id)
  and not exists (select 1 from proposals pr where pr.org_id = c.org_id and pr.contact_id = c.id)
  and not exists (select 1 from signature_requests sr where sr.org_id = c.org_id and sr.signer_contact_id = c.id)
  and not exists (select 1 from conversations v where v.org_id = c.org_id and v.contact_id = c.id and v.channel <> 'web_chat')`;

async function removeChats(db: Queryable, where: string, params: unknown[]): Promise<{ chats: number; contacts: number }> {
  const sessions = await db.query<{ id: string; org_id: string; contact_id: string | null; conversation_id: string | null }>(
    `select s.id, s.org_id, s.contact_id, s.conversation_id from web_chat_sessions s join web_chat_widgets w on w.org_id = s.org_id where ${where} order by s.last_seen_at limit ${LIMIT}`,
    params,
  );
  let contacts = 0;
  for (const s of sessions.rows) {
    if (s.conversation_id) await db.query("delete from conversations where id = $1 and org_id = $2 and channel = 'web_chat'", [s.conversation_id, s.org_id]);
    await db.query("delete from web_chat_sessions where id = $1", [s.id]);
    if (s.contact_id) {
      const gone = await db.query(`delete from contacts c where c.id = $1 and c.org_id = $2 and ${EMPTY_CHAT_CONTACT} returning c.id`, [s.contact_id, s.org_id]);
      if (gone.rows[0]) contacts += 1;
    }
  }
  return { chats: sessions.rows.length, contacts };
}

export async function purgeExpiredWebChats(now = new Date()): Promise<WebChatRetentionResult> {
  return withSystem(async (db) => {
    const anonymous = await removeChats(
      db,
      "s.lead_captured_at is null and s.last_seen_at < $1::timestamptz - (w.anonymous_retention_days || ' days')::interval",
      [now.toISOString()],
    );
    const expired = await removeChats(db, "s.last_seen_at < $1::timestamptz - (w.retention_days || ' days')::interval", [now.toISOString()]);
    return { anonymousChats: anonymous.chats, expiredChats: expired.chats, contacts: anonymous.contacts + expired.contacts };
  });
}

/**
 * A privacy request for one contact reaches the website chat and its attribution here (called from redactContact in the same transaction). The visitor's
 * typed name, email and phone, their answers, the page and referrer they came from and the keyed address hash are cleared from every chat session of the
 * contact; the contact's source history is removed. The session shell (when it happened, how many messages) stays so the workspace's counts do.
 */
export async function eraseWebChatAndAttribution(db: Queryable, orgId: string, contactId: string): Promise<{ sessions: number; touches: number }> {
  const sessions = await db.query(
    `update web_chat_sessions set visitor_name = null, visitor_email = null, visitor_phone = null, qualification = '{}'::jsonb, landing_path = null, referrer = null,
       attribution = '{}'::jsonb, ip_hash = null, possible_match_contact_id = null, status = 'closed', closed_at = coalesce(closed_at, now())
     where org_id = $1 and (contact_id = $2 or possible_match_contact_id = $2) returning id`,
    [orgId, contactId],
  );
  const touches = await db.query("delete from lead_touches where org_id = $1 and contact_id = $2 returning id", [orgId, contactId]);
  await db.query("update contacts set first_touch_id = null, latest_touch_id = null where org_id = $1 and id = $2", [orgId, contactId]);
  return { sessions: sessions.rows.length, touches: touches.rows.length };
}
