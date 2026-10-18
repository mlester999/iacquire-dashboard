import { auditSupportView, crmRead, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { listAssignmentHistory, listAssignmentRules, type AssignmentEntity } from "@/server/crm/assignment";
import { listAssignableMembers } from "@/server/crm/contacts";
import { listTags } from "@/server/crm/tags";
import { listCustomFields } from "@/server/crm/fields";
import { listPipelines } from "@/server/crm/pipelines";
import { AssignmentWorkspace } from "@/components/crm/assignment/assignment-workspace";

type SP = Record<string, string | string[] | undefined>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** `?record=contact:<id>` or `?record=opportunity:<id>`: the assignment history of one record. */
function parseRecord(raw: string | undefined): { entity: AssignmentEntity; id: string } | null {
  const m = /^(contact|opportunity):(.+)$/.exec(raw ?? "");
  return m && UUID.test(m[2]) ? { entity: m[1] as AssignmentEntity, id: m[2] } : null;
}

/**
 * Settings → Lead Assignment. Rules for new contacts and new deals (first match wins), their members and how each picks a person, and every
 * automatic decision with its reason. Managing rules needs the assign permission; an agency support session can look (a write session can
 * also change rules, as with other CRM settings).
 */
export async function AssignmentView({ actor, scope, searchParams = {} }: { actor: CrmActor; scope: CrmScope; searchParams?: SP }) {
  const record = parseRecord(one(searchParams.record));
  const entityParam = one(searchParams.entity);
  const seeDeals = actor.can("sales.view");
  const initialEntity: AssignmentEntity = entityParam === "opportunity" && seeDeals ? "opportunity" : record?.entity === "opportunity" && seeDeals ? "opportunity" : "contact";
  const [rules, recent, members, tags, fields, pipelines] = await Promise.all([
    listAssignmentRules(actor),
    listAssignmentHistory(actor, { limit: 50 }),
    listAssignableMembers(actor),
    listTags(actor),
    listCustomFields(actor, "contact"),
    seeDeals ? listPipelines(actor) : Promise.resolve([]),
  ]);
  let recordHistory: { entity: AssignmentEntity; id: string; label: string | null; decisions: Awaited<ReturnType<typeof listAssignmentHistory>> } | null = null;
  if (record && (record.entity === "contact" || seeDeals)) {
    const decisions = await listAssignmentHistory(actor, { entity: record.entity, entityId: record.id, limit: 100 });
    const label = await crmRead(actor, async (db) => {
      const { rows } = await db.query<{ label: string | null }>(
        record.entity === "contact"
          ? "select coalesce(nullif(display_name, ''), email::text, phone) as label from contacts where id = $1 and org_id = $2"
          : "select name as label from crm_opportunities where id = $1 and org_id = $2",
        [record.id, actor.orgId],
      );
      return rows[0]?.label ?? null;
    });
    recordHistory = { entity: record.entity, id: record.id, label, decisions };
  }
  await auditSupportView(actor, "lead-assignment");
  return (
    <AssignmentWorkspace
      scope={scope}
      rules={JSON.parse(JSON.stringify(rules))}
      recent={recent}
      recordHistory={recordHistory}
      initialEntity={initialEntity}
      canManage={actor.can("contacts.assign") && !scope.readOnly}
      canSeeDeals={seeDeals}
      members={members.map((m) => ({ id: m.id, name: m.name }))}
      options={{
        tags: tags.map((t) => ({ id: t.id, name: t.name, color: t.color })),
        members: members.map((m) => ({ id: m.id, name: m.name })),
        pipelines: pipelines.map((p) => ({ id: p.id, name: p.name, stages: p.stages.map((s) => ({ id: s.id, name: s.name })) })),
        customFields: fields.filter((f) => !f.archived).map((f) => ({ id: f.id, label: f.label, type: f.type, options: f.options })),
      }}
    />
  );
}
