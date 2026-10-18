import "server-only";
import { crmRead } from "@/server/crm/actor";
import { num, ownerNote, type ReportScope } from "@/server/crm/reports/scope";
import { CREATED_VIA_LABELS, LEAD_STATUS_LABELS, LEAD_STATUSES, type CreatedVia, type LeadStatus } from "@/lib/crm/types";
import type { FilterKey } from "@/components/crm/reports/spec";
import type { LeadsReport, SectionResult } from "@/components/crm/reports/types";

const PURPOSE_LABELS: Record<string, string> = { contact: "Contact", consultation: "Consultation", lead: "Lead", appointment: "Appointment request" };
const viaLabel = (v: string) => CREATED_VIA_LABELS[v as CreatedVia] ?? v.replace(/_/g, " ");

/**
 * Leads & sources: contacts created in the period (by how they arrived, their free-text lead source and their current lead status), and
 * form submissions from native forms and the built-in website form. Contacts honour the team member (contact owner) and lead source
 * (created via) filters; form submissions are counted for the whole workspace and say so.
 */
export async function leadsSection(scope: ReportScope): Promise<SectionResult<"leads">> {
  const { actor, filters: f } = scope;
  const data = await crmRead(actor, async (db) => {
    // $1 org, $2 start, $3 end, $4 member, $5 source, $6 time zone
    const p = [actor.orgId, scope.startsAt, scope.endsAt, f.member ?? null, f.source ?? null];
    const where = `c.org_id = $1 and c.deleted_at is null and c.created_at >= $2 and c.created_at < $3
      and ($4::uuid is null or c.assigned_user_id = $4) and ($5::text is null or c.created_via = $5)`;
    const total = await db.query<{ n: string; qualified: string }>(
      `select count(*)::text as n, count(*) filter (where c.lead_status in ('qualified', 'customer'))::text as qualified from contacts c where ${where}`,
      p,
    );
    const byDay = await db.query<{ day: string; n: string }>(
      `select to_char((c.created_at at time zone $6)::date, 'YYYY-MM-DD') as day, count(*)::text as n from contacts c where ${where} group by 1 order by 1`,
      [...p, scope.timezone],
    );
    const via = await db.query<{ via: string; n: string; qualified: string }>(
      `select c.created_via as via, count(*)::text as n, count(*) filter (where c.lead_status in ('qualified', 'customer'))::text as qualified
       from contacts c where ${where} group by 1 order by count(*) desc, 1`,
      p,
    );
    const source = await db.query<{ source: string; n: string }>(
      `select coalesce(nullif(btrim(c.source), ''), '') as source, count(*)::text as n from contacts c where ${where} group by 1 order by count(*) desc, 1 limit 15`,
      p,
    );
    const status = await db.query<{ status: LeadStatus; n: string }>(`select c.lead_status as status, count(*)::text as n from contacts c where ${where} group by 1`, p);

    // Form submissions: native forms by form, the built-in website form by purpose. Same period; not narrowed by contact filters.
    const native = await db.query<{ id: string; name: string; total: string; processed: string; spam: string; failed: string; pending: string; contacts: string; opps: string }>(
      `select f.id, f.name, count(*)::text as total,
              count(*) filter (where s.status = 'processed')::text as processed, count(*) filter (where s.status = 'spam')::text as spam,
              count(*) filter (where s.status = 'failed')::text as failed, count(*) filter (where s.status = 'received')::text as pending,
              count(distinct s.contact_id)::text as contacts, count(s.opportunity_id)::text as opps
       from crm_form_submissions s join crm_forms f on f.id = s.form_id and f.org_id = s.org_id
       where s.org_id = $1 and s.created_at >= $2 and s.created_at < $3 group by f.id, f.name order by count(*) desc, f.name`,
      [actor.orgId, scope.startsAt, scope.endsAt],
    );
    const site = await db.query<{ purpose: string; total: string; processed: string; spam: string; failed: string; pending: string; contacts: string }>(
      `select coalesce(w.purpose, 'contact') as purpose, count(*)::text as total,
              count(*) filter (where w.status = 'processed')::text as processed, count(*) filter (where w.status = 'spam')::text as spam,
              count(*) filter (where w.status = 'failed')::text as failed, count(*) filter (where w.status = 'received')::text as pending,
              count(distinct w.contact_id)::text as contacts
       from website_form_submissions w where w.org_id = $1 and w.created_at >= $2 and w.created_at < $3 group by 1 order by count(*) desc`,
      [actor.orgId, scope.startsAt, scope.endsAt],
    );
    // UTM values exactly as they arrived with the submission; nothing is inferred from a referrer.
    const utm = await db.query<{ source: string; medium: string; campaign: string; n: string }>(
      `select coalesce(source, '') as source, coalesce(medium, '') as medium, coalesce(campaign, '') as campaign, count(*)::text as n from (
         select coalesce(s.attribution->>'utm_source', s.attribution->'utm'->>'source', s.attribution->'utm'->>'utm_source') as source,
                coalesce(s.attribution->>'utm_medium', s.attribution->'utm'->>'medium', s.attribution->'utm'->>'utm_medium') as medium,
                coalesce(s.attribution->>'utm_campaign', s.attribution->'utm'->>'campaign', s.attribution->'utm'->>'utm_campaign') as campaign
         from crm_form_submissions s where s.org_id = $1 and s.created_at >= $2 and s.created_at < $3 and s.status <> 'spam'
         union all
         select w.utm->>'utm_source', w.utm->>'utm_medium', w.utm->>'utm_campaign'
         from website_form_submissions w where w.org_id = $1 and w.created_at >= $2 and w.created_at < $3 and w.status <> 'spam'
       ) x group by 1, 2, 3 order by count(*) desc, 1 limit 20`,
      [actor.orgId, scope.startsAt, scope.endsAt],
    );

    const unfiltered: FilterKey[] = (["member", "source"] as const).filter((k) => f[k]);
    const forms: LeadsReport["forms"]["rows"] = [
      ...native.rows.map((r) => ({
        key: `form:${r.id}`, name: r.name, kind: "native" as const, total: num(r.total), processed: num(r.processed), spam: num(r.spam), failed: num(r.failed), pending: num(r.pending),
        contacts: num(r.contacts), opportunities: num(r.opps),
      })),
      ...site.rows.map((r) => ({
        key: `website:${r.purpose}`, name: `Website form · ${PURPOSE_LABELS[r.purpose] ?? r.purpose}`, kind: "website" as const, total: num(r.total), processed: num(r.processed), spam: num(r.spam),
        failed: num(r.failed), pending: num(r.pending), contacts: num(r.contacts), opportunities: null,
      })),
    ];
    const statusCounts = new Map(status.rows.map((r) => [r.status, num(r.n)]));
    return {
      newContacts: num(total.rows[0]?.n),
      qualifiedNow: num(total.rows[0]?.qualified),
      byDay: byDay.rows.map((r) => ({ day: r.day, n: num(r.n) })),
      byCreatedVia: via.rows.map((r) => ({ key: r.via, label: viaLabel(r.via), count: num(r.n), qualified: num(r.qualified) })),
      bySource: source.rows.map((r) => ({ key: r.source || "(none)", label: r.source ? (CREATED_VIA_LABELS[r.source as CreatedVia] ?? r.source) : "No source recorded", count: num(r.n) })),
      byStatus: LEAD_STATUSES.filter((s) => statusCounts.get(s)).map((s) => ({ key: s, label: LEAD_STATUS_LABELS[s], count: statusCounts.get(s) ?? 0 })),
      forms: {
        total: forms.reduce((n, r) => n + r.total, 0),
        rows: forms,
        utm: utm.rows.map((r) => ({ source: r.source, medium: r.medium, campaign: r.campaign, count: num(r.n) })),
        unfiltered,
      },
    } satisfies LeadsReport;
  });
  return {
    section: "leads",
    data,
    empty: data.newContacts === 0 && data.forms.total === 0,
    ignored: [],
    notes: ownerNote(scope, "contacts", "contacts"),
  };
}
