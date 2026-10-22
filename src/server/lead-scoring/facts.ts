import "server-only";
import type { Queryable } from "@/server/db";
import { readFieldValues } from "@/server/crm/fields";
import { contactAddress, getConsent, isSuppressed } from "@/server/messaging/contacts";
import { detectOptKeyword } from "@/lib/messaging";
import type { CustomFieldValue, LeadFacts } from "@/lib/lead-scoring/types";

// What the scoring engine may know about a contact, read as of one moment: the contact's own record, their custom fields, tags, conversations,
// calls, appointments and deals. Only counts, times and ids are collected; the words of a message are read in one place only (recentInbound),
// for the optional signal extraction, and are never stored.

const asDate = (v: Date | string | null | undefined) => (v ? new Date(v) : null);

export async function loadLeadFacts(db: Queryable, orgId: string, contactId: string, asOf: Date): Promise<LeadFacts | null> {
  const c = (await db.query<{
    created_at: Date; created_via: string; source: string; lead_status: string; display_name: string; first_name: string | null; last_name: string | null; phone: string | null;
    email: string | null; city: string | null; region: string | null; country: string | null; postal_code: string | null; preferred_channel: string | null;
  }>(
    `select created_at, created_via, source, lead_status, display_name, first_name, last_name, phone, email::text as email, city, region, country, postal_code, preferred_channel
     from contacts where id = $1 and org_id = $2 and deleted_at is null`,
    [contactId, orgId],
  )).rows[0];
  if (!c) return null;

  const tags = (await db.query<{ name: string }>(
    "select lower(t.name::text) as name from crm_contact_tags ct join crm_tags t on t.id = ct.tag_id and t.org_id = ct.org_id where ct.contact_id = $1 and ct.org_id = $2",
    [contactId, orgId],
  )).rows.map((r) => r.name);

  const fields: Record<string, CustomFieldValue> = {};
  for (const f of await readFieldValues(db, orgId, "contact", contactId)) if (f.value !== null && f.value !== undefined && f.value !== "") fields[f.key] = f.value as CustomFieldValue;

  let reachable = false;
  for (const channel of ["sms", "email"] as const) {
    const address = await contactAddress(db, orgId, contactId, channel);
    if (!address) continue;
    if ((await getConsent(db, orgId, contactId, channel, "service")) === "revoked") continue;
    if (await isSuppressed(db, orgId, channel, address)) continue;
    reachable = true;
    break;
  }

  const msg = (await db.query<{ inbound: string; outbound: string; last_inbound: Date | null; last_inbound_id: string | null; unanswered: string; replied: boolean }>(
    `with m as (
       select m.id, m.direction, m.created_at, m.conversation_id from conversation_messages m join conversations v on v.id = m.conversation_id and v.org_id = m.org_id
       where m.org_id = $1 and v.contact_id = $2 and m.created_at <= $3 and ((m.direction = 'inbound' and m.author_kind = 'contact') or (m.direction = 'outbound' and m.status in ('sent', 'delivered', 'read')))
     ), last_in as (select id, created_at from m where direction = 'inbound' order by created_at desc, id desc limit 1)
     select count(*) filter (where m.direction = 'inbound')::text as inbound,
            count(*) filter (where m.direction = 'outbound')::text as outbound,
            (select created_at from last_in) as last_inbound,
            (select id::text from last_in) as last_inbound_id,
            count(*) filter (where m.direction = 'outbound' and m.created_at > coalesce((select created_at from last_in), 'epoch'))::text as unanswered,
            exists (select 1 from m o join m i on i.conversation_id = o.conversation_id and i.direction = 'inbound' and i.created_at > o.created_at and i.created_at <= o.created_at + interval '24 hours'
                    where o.direction = 'outbound') as replied
     from m`,
    [orgId, contactId, asOf],
  )).rows[0];

  const calls = (await db.query<{ inbound: string; last_at: Date | null; last_id: string | null; missed: string }>(
    `select count(*)::text as inbound, max(coalesce(r.started_at, r.created_at)) as last_at,
            (select id::text from crm_call_records x where x.org_id = $1 and x.contact_id = $2 and x.direction = 'inbound' and coalesce(x.started_at, x.created_at) <= $3 order by coalesce(x.started_at, x.created_at) desc limit 1) as last_id,
            (select count(*)::text from missed_call_case_calls l join missed_call_cases k on k.id = l.case_id and k.org_id = l.org_id where l.org_id = $1 and k.contact_id = $2 and l.counted and l.called_at <= $3) as missed
     from crm_call_records r where r.org_id = $1 and r.contact_id = $2 and r.direction = 'inbound' and coalesce(r.started_at, r.created_at) <= $3`,
    [orgId, contactId, asOf],
  )).rows[0];

  const appts = (await db.query<{ id: string; status: string; start_at: Date }>(
    "select id, status, start_at from appointment_refs where org_id = $1 and contact_id = $2 and status <> 'invalid' order by start_at",
    [orgId, contactId],
  )).rows;
  const upcoming = appts.filter((a) => (a.status === "new" || a.status === "confirmed") && new Date(a.start_at) > asOf);

  const opps = (await db.query<{ id: string; status: string; value: string | null; position: number | null; max_position: number | null }>(
    `select o.id, o.status, o.monetary_value::text as value, s.position,
            (select max(s2.position) from crm_pipeline_stages s2 where s2.pipeline_id = s.pipeline_id and s2.kind = 'open' and s2.archived_at is null) as max_position
     from crm_opportunities o left join crm_pipeline_stages s on s.id = o.stage_ref and s.org_id = o.org_id
     where o.org_id = $1 and o.contact_id = $2 and o.provider = 'native' and o.archived_at is null and o.created_at <= $3`,
    [orgId, contactId, asOf],
  )).rows;
  const open = opps.filter((o) => o.status === "open");
  const progress = open
    .map((o) => (o.position !== null && o.max_position ? Math.min(1, Math.max(0, o.position / o.max_position)) : null))
    .filter((p): p is number => p !== null);
  const values = open.map((o) => (o.value === null ? null : Number(o.value))).filter((v): v is number => v !== null && Number.isFinite(v));

  return {
    asOf,
    contact: {
      createdAt: new Date(c.created_at), createdVia: c.created_via, source: c.source, leadStatus: c.lead_status,
      hasName: Boolean(c.display_name?.trim() || c.first_name?.trim() || c.last_name?.trim()), hasPhone: Boolean(c.phone), hasEmail: Boolean(c.email),
      city: c.city, region: c.region, country: c.country, postalCode: c.postal_code, preferredChannel: c.preferred_channel,
    },
    tags,
    fields,
    reachable,
    conversations: {
      inboundCount: Number(msg.inbound), outboundCount: Number(msg.outbound), lastInboundAt: asDate(msg.last_inbound), repliedWithin24h: Boolean(msg.replied),
      unansweredOutbound: Number(msg.unanswered), lastInboundId: msg.last_inbound_id,
    },
    calls: { inboundCount: Number(calls.inbound), missedInboundCount: Number(calls.missed ?? 0), lastInboundAt: asDate(calls.last_at), lastInboundId: calls.last_id },
    appointments: {
      upcoming: upcoming.length, nextAt: upcoming[0] ? new Date(upcoming[0].start_at) : null, nextId: upcoming[0]?.id ?? null,
      showed: appts.filter((a) => a.status === "showed").length, noShow: appts.filter((a) => a.status === "noshow").length, cancelled: appts.filter((a) => a.status === "cancelled").length,
      booked: appts.length,
    },
    opportunities: {
      open: open.length, won: opps.filter((o) => o.status === "won").length, lost: opps.filter((o) => o.status === "lost").length,
      maxOpenValue: values.length ? Math.max(...values) : null, stageProgress: progress.length ? Math.max(...progress) : null, openId: open[0]?.id ?? null,
    },
    ai: null,
  };
}

/** The customer's own newest messages (oldest first), for signal extraction only. Opt-out keywords and empty messages are left out. */
export async function recentInbound(db: Queryable, orgId: string, contactId: string, asOf: Date, limit = 10): Promise<Array<{ id: string; text: string; at: Date }>> {
  const { rows } = await db.query<{ id: string; body: string; created_at: Date }>(
    `select m.id, m.body, m.created_at from conversation_messages m join conversations v on v.id = m.conversation_id and v.org_id = m.org_id
     where m.org_id = $1 and v.contact_id = $2 and m.direction = 'inbound' and m.author_kind = 'contact' and m.created_at <= $3 order by m.created_at desc limit $4`,
    [orgId, contactId, asOf, limit * 2],
  );
  return rows
    .filter((r) => r.body.trim().length >= 3 && !detectOptKeyword(r.body))
    .slice(0, limit)
    .reverse()
    .map((r) => ({ id: r.id, text: r.body, at: new Date(r.created_at) }));
}
