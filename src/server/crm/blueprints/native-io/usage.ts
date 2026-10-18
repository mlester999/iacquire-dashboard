import "server-only";
import type { Queryable } from "@/server/db";
import type { NativeEntry } from "@/server/crm/blueprints/native-io/types";
import type { NativeTypeMap } from "@/lib/crm/blueprints/types";

// Whether a record a Blueprint created is in use, so a rollback keeps it. "In use" means the client's data or the client's own
// configuration depends on it: a tag on records, a field with values, a pipeline or stage with deals or history, a calendar or type with
// appointments (or hosts, or already activated), a folder with something filed in it, a form with submissions or a published version, a
// template that was approved or is used by a campaign, a workflow that was published or ran, or anything another record still refers to.
// Read-only; every query names the workspace.

const n = async (db: Queryable, sql: string, params: unknown[]): Promise<number> => Number((await db.query<{ n: string }>(sql, params)).rows[0]?.n ?? 0);
const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

/**
 * The first configuration record (other than `exceptIds`) whose saved definition still mentions `needle`, as a phrase ("the workflow
 * “Follow-up”"), or null. Covers what can hold a reference: form drafts and published versions, workflow drafts and versions, Smart List
 * filters and columns, assignment rule conditions and saved report filters. `regex` matches a pattern instead of a plain substring.
 */
export async function referencedBy(db: Queryable, orgId: string, needle: string, exceptIds: readonly string[] = [], opts: { regex?: boolean } = {}): Promise<string | null> {
  const match = (col: string) => (opts.regex ? `${col}::text ~ $2` : `position($2 in ${col}::text) > 0`);
  const except = [...exceptIds];
  const checks: Array<{ sql: string; what: string }> = [
    { what: "form", sql: `select f.name from crm_forms f where f.org_id = $1 and f.archived_at is null and not (f.id = any($3::uuid[])) and ${match("f.draft")} limit 1` },
    {
      what: "form",
      sql: `select f.name from crm_form_versions v join crm_forms f on f.id = v.form_id and f.org_id = v.org_id where v.org_id = $1 and f.archived_at is null
            and not (f.id = any($3::uuid[])) and (${match("v.fields")} or ${match("v.actions")}) limit 1`,
    },
    { what: "workflow", sql: `select w.name from crm_workflows w where w.org_id = $1 and w.archived_at is null and not (w.id = any($3::uuid[])) and ${match("w.draft")} limit 1` },
    {
      what: "workflow",
      sql: `select w.name from crm_workflow_versions v join crm_workflows w on w.id = v.workflow_id and w.org_id = v.org_id where v.org_id = $1 and w.archived_at is null
            and not (w.id = any($3::uuid[])) and (${match("v.trigger_config")} or ${match("v.steps")}) limit 1`,
    },
    { what: "Smart List", sql: `select l.name from crm_smart_lists l where l.org_id = $1 and l.archived_at is null and not (l.id = any($3::uuid[])) and (${match("l.filter")} or ${match("to_jsonb(l.columns)")}) limit 1` },
    { what: "assignment rule", sql: `select r.name from crm_assignment_rules r where r.org_id = $1 and not (r.id = any($3::uuid[])) and ${match("r.conditions")} limit 1` },
    { what: "saved report", sql: `select d.name from crm_report_definitions d where d.org_id = $1 and d.archived_at is null and not (d.id = any($3::uuid[])) and ${match("d.config")} limit 1` },
  ];
  for (const c of checks) {
    const { rows } = await db.query<{ name: string }>(c.sql, [orgId, needle, except]);
    if (rows[0]) return `the ${c.what} “${rows[0].name}”`;
  }
  return null;
}

/** Why a record created by a Blueprint must be kept, or null when nothing uses it. `exceptIds`: records this rollback is also removing. */
export async function inUseReason(db: Queryable, orgId: string, entry: NativeEntry, exceptIds: readonly string[] = []): Promise<string | null> {
  const id = entry.id;
  const ref = async (needle: string, regex = false) => {
    const by = await referencedBy(db, orgId, needle, [id, ...exceptIds], { regex });
    return by ? `It is used by ${by}.` : null;
  };
  switch (entry.type) {
    case "folder": {
      const k = await n(db,
        `select ((select count(*) from crm_tags where org_id = $1 and folder_id = $2) + (select count(*) from crm_smart_lists where org_id = $1 and folder_id = $2)
          + (select count(*) from crm_message_templates where org_id = $1 and folder_id = $2) + (select count(*) from crm_workflows where org_id = $1 and folder_id = $2)
          + (select count(*) from crm_forms where org_id = $1 and folder_id = $2) + (select count(*) from crm_calendars where org_id = $1 and folder_id = $2)
          + (select count(*) from crm_report_definitions where org_id = $1 and folder_id = $2))::text as n`,
        [orgId, id]);
      return k ? `${plural(k, "item")} ${k === 1 ? "is" : "are"} filed in it.` : null;
    }
    case "tag": {
      const k = await n(db,
        `select ((select count(*) from crm_contact_tags where org_id = $1 and tag_id = $2) + (select count(*) from crm_company_tags where org_id = $1 and tag_id = $2)
          + (select count(*) from crm_opportunity_tags where org_id = $1 and tag_id = $2))::text as n`,
        [orgId, id]);
      if (k) return `It is on ${plural(k, "record")}.`;
      return ref(id);
    }
    case "customField": {
      const k = await n(db, "select count(*)::text as n from crm_field_values where org_id = $1 and field_id = $2", [orgId, id]);
      if (k) return `${plural(k, "record has", "records have")} a value in it.`;
      const key = (entry.record as NativeTypeMap["customField"]).key;
      return (await ref(id)) ?? (await ref(`"custom:${key}"`)) ?? (await ref(`"cf:${key}"`));
    }
    case "customValue": {
      const key = (entry.record as NativeTypeMap["customValue"]).key;
      const pattern = `custom_values\\.${key}\\s*\\}\\}`;
      const t = await db.query<{ name: string }>(
        `select t.name from crm_message_templates t join crm_message_template_versions v on v.template_id = t.id and v.org_id = t.org_id
         where t.org_id = $1 and t.archived_at is null and not (t.id = any($3::uuid[])) and (v.body ~ $2 or coalesce(v.subject, '') ~ $2) limit 1`,
        [orgId, pattern, [...exceptIds]],
      );
      if (t.rows[0]) return `It is used by the template “${t.rows[0].name}”.`;
      return ref(pattern, true);
    }
    case "pipeline": {
      const k = await n(db, "select count(*)::text as n from crm_opportunities where org_id = $1 and pipeline_ref = $2", [orgId, id]);
      if (k) return `${plural(k, "deal")} ${k === 1 ? "is" : "are"} in it.`;
      return ref(id);
    }
    case "stage": {
      const k = await n(db, "select count(*)::text as n from crm_opportunities where org_id = $1 and stage_ref = $2", [orgId, id]);
      if (k) return `${plural(k, "deal")} ${k === 1 ? "is" : "are"} in it.`;
      const h = await n(db, "select count(*)::text as n from crm_opportunity_history where org_id = $1 and (from_stage = $2 or to_stage = $2)", [orgId, id]);
      if (h) return "Deals have moved through it, so it is kept for their history.";
      return ref(id);
    }
    case "calendar": {
      const k = await n(db, "select count(*)::text as n from appointment_refs where org_id = $1 and calendar_ref = $2", [orgId, id]);
      if (k) return `${plural(k, "appointment")} ${k === 1 ? "was" : "were"} booked on it.`;
      if (entry.meta.status === "active") return "It was verified and activated in this workspace.";
      if ((entry.meta.memberCount ?? 0) > 0) return "Hosts were assigned to it in this workspace.";
      return ref(id);
    }
    case "appointmentType": {
      const k = await n(db, "select count(*)::text as n from appointment_refs where org_id = $1 and appointment_type_id = $2", [orgId, id]);
      if (k) return `${plural(k, "appointment")} ${k === 1 ? "was" : "were"} booked with it.`;
      return ref(id);
    }
    case "smartList": {
      const k = await n(db, "select count(*)::text as n from crm_campaigns where org_id = $1 and smart_list_id = $2", [orgId, id]);
      if (k) return `${plural(k, "campaign")} ${k === 1 ? "uses" : "use"} it.`;
      return null;
    }
    case "assignmentRule": {
      const k = await n(db, "select count(*)::text as n from crm_assignment_history where org_id = $1 and rule_id = $2", [orgId, id]);
      if (k) return "It has already assigned records, so it is kept for the history.";
      return ref(id);
    }
    case "form": {
      const v = await n(db, "select count(*)::text as n from crm_form_versions where org_id = $1 and form_id = $2", [orgId, id]);
      if (v) return "It was published in this workspace.";
      const s = await n(db, "select count(*)::text as n from crm_form_submissions where org_id = $1 and form_id = $2", [orgId, id]);
      if (s) return `${plural(s, "submission")} came in through it.`;
      const key = (entry.record as NativeTypeMap["form"]).key;
      const site = await n(db, `select count(*)::text as n from websites w where w.org_id = $1 and position($2 in w.draft_content::text) > 0`, [orgId, `"formKey":"${key}"`]);
      if (site) return "The website uses it.";
      return ref(id);
    }
    case "messageTemplate": {
      if (entry.meta.status === "approved") return "It was approved in this workspace.";
      const k = await n(db,
        "select ((select count(*) from crm_campaigns where org_id = $1 and template_id = $2) + (select count(*) from crm_review_requests where org_id = $1 and template_id = $2))::text as n",
        [orgId, id]);
      if (k) return "Campaigns or review requests used it.";
      return ref(id);
    }
    case "workflow": {
      if (entry.meta.status && entry.meta.status !== "draft") return "It was published in this workspace.";
      const v = await n(db, "select ((select count(*) from crm_workflow_versions where org_id = $1 and workflow_id = $2) + (select count(*) from crm_workflow_runs where org_id = $1 and workflow_id = $2))::text as n", [orgId, id]);
      if (v) return "It was published or has run in this workspace.";
      return null;
    }
    case "report":
      return null;
  }
  return null;
}
