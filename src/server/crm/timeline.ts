import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { assertCan, crmRead, type CrmActor } from "@/server/crm/actor";
import { maskCustomerLinks } from "@/server/messaging/redact";

/**
 * A record's timeline, assembled from rows that were written when something happened: CRM activity, notes, messages, appointments,
 * tasks and deal stage changes. Nothing is inferred or back-filled. Each source respects the reader's own permissions (and, for a
 * client member, row-level security), so a teammate who cannot see a conversation does not see its messages here either.
 */
export interface TimelineItem {
  id: string;
  at: string;
  kind: string;
  source: "activity" | "note" | "message" | "appointment" | "task" | "deal";
  title: string;
  detail: string | null;
  actor: string | null;
  link: string | null;
}

const iso = (d: Date) => new Date(d).toISOString();

/** The contact plus every contact that was merged into it, so merged history stays visible where it now belongs. */
async function contactLineage(db: Queryable, orgId: string, contactId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `with recursive lineage(id) as (
       select $2::uuid
       union select m.merged_contact_id from contact_merges m join lineage l on m.kept_contact_id = l.id where m.org_id = $1
     ) select id from lineage limit 50`,
    [orgId, contactId],
  );
  return rows.map((r) => r.id);
}

export async function getTimeline(actor: CrmActor, target: { contactId?: string; companyId?: string; opportunityId?: string }, opts: { before?: string; limit?: number } = {}): Promise<{ items: TimelineItem[]; nextBefore: string | null }> {
  const limit = Math.min(100, Math.max(5, opts.limit ?? 40));
  const before = opts.before && !Number.isNaN(Date.parse(opts.before)) ? new Date(opts.before) : new Date(Date.now() + 60_000);
  if (target.contactId) assertCan(actor, "contacts.view");
  else if (target.companyId) assertCan(actor, "companies.view");
  else if (target.opportunityId) assertCan(actor, "sales.view");
  else throw new AppError("invalid_input", "Choose a record.");
  return crmRead(actor, async (db) => {
    const items: TimelineItem[] = [];
    const orgId = actor.orgId;
    if (target.contactId) {
      const exists = await db.query("select 1 from contacts where id = $1 and org_id = $2 and deleted_at is null", [target.contactId, orgId]);
      if (!exists.rows.length) throw new AppError("not_found", "Contact not found.");
      const ids = await contactLineage(db, orgId, target.contactId);
      const act = await db.query<{ id: string; kind: string; summary: string; occurred_at: Date; actor_kind: string; actor_name: string | null; agent_name: string | null }>(
        `select a.id::text, a.kind, a.summary, a.occurred_at, a.actor_kind, nullif(u.full_name, '') as actor_name, ai.display_name as agent_name
         from crm_activities a left join users u on u.id = a.actor_user_id left join agent_instances ai on ai.id = a.agent_id
         where a.org_id = $1 and a.contact_id = any($2::uuid[]) and a.occurred_at < $3 and a.kind <> 'note.added' order by a.occurred_at desc limit $4`,
        [orgId, ids, before, limit],
      );
      for (const r of act.rows) items.push({ id: `a${r.id}`, at: iso(r.occurred_at), kind: r.kind, source: "activity", title: r.summary, detail: null, actor: r.actor_name ?? r.agent_name ?? (r.actor_kind === "system" ? "iAcquire" : r.actor_kind === "contact" ? "Contact" : null), link: null });
      const notes = await db.query<{ id: string; body: string; created_at: Date; author: string | null }>(
        `select n.id, n.body, n.created_at, nullif(u.full_name, '') as author from record_notes n left join users u on u.id = n.author_id
         where n.org_id = $1 and n.record_type = 'contact' and n.record_id = any($2::text[]) and n.deleted_at is null and n.created_at < $3 order by n.created_at desc limit $4`,
        [orgId, ids, before, limit],
      );
      for (const r of notes.rows) items.push({ id: `n${r.id}`, at: iso(r.created_at), kind: "note", source: "note", title: "Note", detail: r.body.slice(0, 600), actor: r.author, link: null });
      if (actor.can("inbox.view")) {
        const msgs = await db.query<{ id: string; direction: string; channel: string; body: string; status: string; created_at: Date; author_kind: string; conversation_id: string }>(
          `select m.id, m.direction, cv.channel, m.body, m.status, m.created_at, m.author_kind, m.conversation_id from conversation_messages m join conversations cv on cv.id = m.conversation_id
           where m.org_id = $1 and cv.contact_id = any($2::uuid[]) and m.created_at < $3 and m.status not in ('draft') order by m.created_at desc limit $4`,
          [orgId, ids, before, limit],
        );
        for (const r of msgs.rows) {
          const ch = r.channel === "sms" ? "SMS" : r.channel === "whatsapp" ? "WhatsApp" : "Email";
          const title = r.direction === "inbound" ? `${ch} received` : r.direction === "internal" ? "Internal note in conversation" : `${ch} ${r.status === "blocked" ? "held back" : r.status === "failed" ? "failed" : "sent"}${r.author_kind === "ai" ? " by AI" : ""}`;
          items.push({ id: `m${r.id}`, at: iso(r.created_at), kind: `message.${r.direction}`, source: "message", title, detail: maskCustomerLinks(r.body).slice(0, 280), actor: null, link: `/inbox?c=${r.conversation_id}` });
        }
      }
      if (actor.can("appointments.view")) {
        const appts = await db.query<{ id: string; title: string; status: string; start_at: Date; created_at: Date }>(
          `select id, title, status, start_at, coalesce(synced_at, start_at) as created_at from appointment_refs where org_id = $1 and contact_id = any($2::uuid[]) and start_at < $3 order by start_at desc limit $4`,
          [orgId, ids, before, limit],
        );
        for (const r of appts.rows) items.push({ id: `p${r.id}`, at: iso(r.start_at), kind: `appointment.${r.status}`, source: "appointment", title: `${r.title} (${r.status === "noshow" ? "no-show" : r.status})`, detail: null, actor: null, link: null });
      }
      const tasks = await db.query<{ id: string; title: string; status: string; completed_at: Date | null; created_at: Date }>(
        `select id, title, status, completed_at, created_at from tasks where org_id = $1 and contact_id = any($2::uuid[]) and status = 'done' and completed_at < $3 order by completed_at desc limit $4`,
        [orgId, ids, before, limit],
      );
      for (const r of tasks.rows) items.push({ id: `t${r.id}`, at: iso(r.completed_at!), kind: "task.completed", source: "task", title: `Task completed: ${r.title}`, detail: null, actor: null, link: null });
      if (actor.can("sales.view")) await dealHistory(db, orgId, "o.contact_id = any($2::uuid[])", ids, before, limit, items);
    } else if (target.companyId) {
      const act = await db.query<{ id: string; kind: string; summary: string; occurred_at: Date; actor_name: string | null }>(
        `select a.id::text, a.kind, a.summary, a.occurred_at, nullif(u.full_name, '') as actor_name from crm_activities a left join users u on u.id = a.actor_user_id
         where a.org_id = $1 and a.company_id = $2 and a.occurred_at < $3 and a.kind <> 'note.added' order by a.occurred_at desc limit $4`,
        [orgId, target.companyId, before, limit],
      );
      for (const r of act.rows) items.push({ id: `a${r.id}`, at: iso(r.occurred_at), kind: r.kind, source: "activity", title: r.summary, detail: null, actor: r.actor_name, link: null });
      const notes = await db.query<{ id: string; body: string; created_at: Date; author: string | null }>(
        `select n.id, n.body, n.created_at, nullif(u.full_name, '') as author from record_notes n left join users u on u.id = n.author_id
         where n.org_id = $1 and n.record_type = 'company' and n.record_id = $2 and n.deleted_at is null and n.created_at < $3 order by n.created_at desc limit $4`,
        [orgId, target.companyId, before, limit],
      );
      for (const r of notes.rows) items.push({ id: `n${r.id}`, at: iso(r.created_at), kind: "note", source: "note", title: "Note", detail: r.body.slice(0, 600), actor: r.author, link: null });
      if (actor.can("sales.view")) await dealHistory(db, orgId, "o.company_id = $2", target.companyId, before, limit, items);
    } else if (target.opportunityId) {
      const act = await db.query<{ id: string; kind: string; summary: string; occurred_at: Date; actor_name: string | null }>(
        `select a.id::text, a.kind, a.summary, a.occurred_at, nullif(u.full_name, '') as actor_name from crm_activities a left join users u on u.id = a.actor_user_id
         where a.org_id = $1 and a.opportunity_id = $2 and a.occurred_at < $3 and a.kind <> 'note.added' order by a.occurred_at desc limit $4`,
        [orgId, target.opportunityId, before, limit],
      );
      for (const r of act.rows) items.push({ id: `a${r.id}`, at: iso(r.occurred_at), kind: r.kind, source: "activity", title: r.summary, detail: null, actor: r.actor_name, link: null });
      const notes = await db.query<{ id: string; body: string; created_at: Date; author: string | null }>(
        `select n.id, n.body, n.created_at, nullif(u.full_name, '') as author from record_notes n left join users u on u.id = n.author_id
         where n.org_id = $1 and n.record_type = 'opportunity' and n.record_id = $2 and n.deleted_at is null and n.created_at < $3 order by n.created_at desc limit $4`,
        [orgId, target.opportunityId, before, limit],
      );
      for (const r of notes.rows) items.push({ id: `n${r.id}`, at: iso(r.created_at), kind: "note", source: "note", title: "Note", detail: r.body.slice(0, 600), actor: r.author, link: null });
    }
    items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
    const page = items.slice(0, limit);
    return { items: page, nextBefore: items.length > limit ? page[page.length - 1].at : null };
  });
}

async function dealHistory(db: Queryable, orgId: string, where: string, arg: unknown, before: Date, limit: number, items: TimelineItem[]) {
  const { rows } = await db.query<{ id: string; opp_name: string; opp_id: string; to_status: string; to_stage: string | null; from_stage: string | null; changed_at: Date; actor_name: string | null }>(
    `select h.id::text, o.name as opp_name, o.id as opp_id, h.to_status, ts.name as to_stage, fs.name as from_stage, h.changed_at, nullif(u.full_name, '') as actor_name
     from crm_opportunity_history h join crm_opportunities o on o.id = h.opportunity_id
     left join crm_pipeline_stages ts on ts.id = h.to_stage left join crm_pipeline_stages fs on fs.id = h.from_stage left join users u on u.id = h.actor_user_id
     where h.org_id = $1 and ${where} and h.changed_at < $3 order by h.changed_at desc limit $4`,
    [orgId, arg, before, limit],
  );
  for (const r of rows) {
    const title = !r.from_stage && r.to_status === "open" ? `Deal created: ${r.opp_name}` : r.to_status === "won" ? `Deal won: ${r.opp_name}` : r.to_status === "lost" ? `Deal lost: ${r.opp_name}` : `${r.opp_name} moved to ${r.to_stage ?? "a new stage"}`;
    items.push({ id: `d${r.id}`, at: iso(r.changed_at), kind: `deal.${r.to_status}`, source: "deal", title, detail: r.from_stage && r.to_stage ? `${r.from_stage} → ${r.to_stage}` : null, actor: r.actor_name, link: `/crm/opportunities/${r.opp_id}` });
  }
}
