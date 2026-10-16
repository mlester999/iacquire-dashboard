import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmRead, type CrmActor } from "@/server/crm/actor";
import { iterateContacts, parseFilterOrThrow, type ContactListQuery } from "@/server/crm/directory";
import { loadFieldDefinitions } from "@/server/crm/fields";
import { csvLine } from "@/lib/crm/csv";
import { formatFieldValue, readStoredValue } from "@/lib/crm/fields";
import type { FieldType } from "@/lib/crm/types";

export const MAX_EXPORT_ROWS = 100_000;

const BASE_COLUMNS: Array<[string, string]> = [
  ["id", "ID"], ["display_name", "Name"], ["first_name", "First name"], ["last_name", "Last name"], ["email", "Email"], ["phone", "Phone"],
  ["company", "Company"], ["owner", "Owner"], ["lead_status", "Lead status"], ["lead_score", "Lead score"], ["source", "Lead source"], ["created_via", "Created via"],
  ["address_line1", "Address"], ["address_line2", "Address line 2"], ["city", "City"], ["region", "State / province"], ["postal_code", "Postal code"], ["country", "Country"],
  ["timezone", "Time zone"], ["preferred_language", "Language"], ["preferred_channel", "Preferred channel"], ["tags", "Tags"], ["created_at", "Created"], ["last_activity_at", "Last activity"],
];

/**
 * Streams matching contacts as CSV. Needs the export permission; every export is recorded (who, which list, how many rows). Contacts are
 * read in id order in short batches, each in its own transaction, so a large export never holds a database connection for long.
 */
export async function* exportContactsCsv(actor: CrmActor, q: Pick<ContactListQuery, "smartListId" | "filter" | "search" | "archived">): AsyncGenerator<string> {
  assertCan(actor, "contacts.export", "Exporting contacts needs the export permission.");
  if (q.filter) parseFilterOrThrow(q.filter);
  const job = await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      "insert into crm_export_jobs (org_id, entity, smart_list_id, filter, requested_by, requested_by_kind) values ($1, 'contact', $2, $3, $4, $5) returning id",
      [actor.orgId, q.smartListId ?? null, JSON.stringify({ filter: q.filter ?? null, search: q.search ?? null, archived: q.archived ?? "exclude" }), actor.userId, actor.kind === "agency" ? "agency" : actor.kind === "api" ? "api" : "user"],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.contacts_export_started", targetType: "crm_export_job", targetId: rows[0].id, result: "success", metadata: { smartListId: q.smartListId ?? null } }, db);
    return rows[0];
  });
  const fields = await crmRead(actor, (db) => loadFieldDefinitions(db, actor.orgId, "contact"));
  yield csvLine([...BASE_COLUMNS.map(([, label]) => label), ...fields.map((f) => f.label)]);
  let count = 0;
  try {
    for await (const ids of iterateContacts(actor, q, { batch: 500, max: MAX_EXPORT_ROWS })) {
      const lines = await crmRead(actor, async (db) => {
        const base = await db.query<Record<string, unknown> & { id: string }>(
          `select c.id, c.display_name, c.first_name, c.last_name, c.email::text as email, c.phone, c.lead_status, c.lead_score, c.source, c.created_via, c.address_line1, c.address_line2,
                  c.city, c.region, c.postal_code, c.country, c.timezone, c.preferred_language, c.preferred_channel, c.created_at, c.last_activity_at, nullif(u.full_name, '') as owner,
                  (select co.name from crm_contact_companies cc join crm_companies co on co.id = cc.company_id and co.deleted_at is null where cc.contact_id = c.id order by cc.is_primary desc limit 1) as company,
                  (select string_agg(t.name::text, '; ' order by lower(t.name::text)) from crm_contact_tags ct join crm_tags t on t.id = ct.tag_id where ct.contact_id = c.id) as tags
           from contacts c left join users u on u.id = c.assigned_user_id where c.org_id = $1 and c.id = any($2::uuid[]) order by c.id`,
          [actor.orgId, ids],
        );
        const values = fields.length
          ? await db.query<{ entity_id: string; field_id: string; type: FieldType; value_text: string | null; value_number: string | null; value_date: string | null; value_ts: Date | null; value_bool: boolean | null; value_list: string[] | null }>(
              `select v.entity_id, v.field_id, f.type, v.value_text, v.value_number::text as value_number, v.value_date::text as value_date, v.value_ts, v.value_bool, v.value_list
               from crm_field_values v join crm_custom_fields f on f.id = v.field_id where v.org_id = $1 and v.entity_id = any($2::uuid[])`,
              [actor.orgId, ids],
            )
          : { rows: [] };
        const byContact = new Map<string, Map<string, string>>();
        for (const v of values.rows) {
          const def = fields.find((f) => f.id === v.field_id);
          if (!def) continue;
          const m = byContact.get(v.entity_id) ?? new Map<string, string>();
          m.set(v.field_id, formatFieldValue(def, readStoredValue(v.type, { ...v, value_ts: v.value_ts ? new Date(v.value_ts).toISOString() : null })));
          byContact.set(v.entity_id, m);
        }
        return base.rows.map((r) => csvLine([...BASE_COLUMNS.map(([key]) => r[key]), ...fields.map((f) => byContact.get(r.id)?.get(f.id) ?? "")]));
      });
      count += lines.length;
      yield lines.join("");
    }
    await withSystem(async (db) => {
      await db.query("update crm_export_jobs set status = 'completed', row_count = $2, completed_at = now() where id = $1", [job.id, count]);
      await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.contacts_exported", targetType: "crm_export_job", targetId: job.id, result: "success", metadata: { rows: count } }, db);
    });
  } catch (err) {
    await withSystem((db) => db.query("update crm_export_jobs set status = 'failed', row_count = $2, error = $3, completed_at = now() where id = $1", [job.id, count, err instanceof AppError ? err.message.slice(0, 300) : "Export stopped"]));
    throw err;
  }
}

export interface ExportJobView {
  id: string;
  entity: string;
  status: "running" | "completed" | "failed";
  rowCount: number;
  requestedBy: string | null;
  requestedByKind: string;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}

/** Who exported what and when, so an owner can see every copy of their data that left the CRM. */
export async function listExportJobs(actor: CrmActor, limit = 20): Promise<ExportJobView[]> {
  assertCan(actor, "contacts.export");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<{ id: string; entity: string; status: ExportJobView["status"]; row_count: number; requested_by: string | null; requested_by_kind: string; created_at: Date; completed_at: Date | null; error: string | null }>(
      `select j.id, j.entity, j.status, j.row_count, nullif(u.full_name, '') as requested_by, j.requested_by_kind, j.created_at, j.completed_at, j.error
       from crm_export_jobs j left join users u on u.id = j.requested_by where j.org_id = $1 order by j.created_at desc limit $2`,
      [actor.orgId, Math.min(100, limit)],
    );
    return rows.map((r) => ({
      id: r.id, entity: r.entity, status: r.status, rowCount: r.row_count, requestedBy: r.requested_by, requestedByKind: r.requested_by_kind,
      createdAt: new Date(r.created_at).toISOString(), completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null, error: r.error,
    }));
  });
}
