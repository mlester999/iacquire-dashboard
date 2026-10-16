import { listSmartLists } from "@/server/crm/smart-lists";
import { listTags } from "@/server/crm/tags";
import { listCustomFields } from "@/server/crm/fields";
import { listAssignableMembers } from "@/server/crm/contacts";
import { listPipelines } from "@/server/crm/pipelines";
import { countContacts } from "@/server/crm/directory";
import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import { AppError } from "@/server/errors";
import type { CrmScope } from "@/server/crm/page";
import { SmartListsManager } from "@/components/crm/smart-lists-manager";
import { TagsManager } from "@/components/crm/tags-manager";
import { FieldsManager } from "@/components/crm/fields-manager";
import type { FieldEntity } from "@/lib/crm/types";

export async function SmartListsView({ actor, scope }: { actor: CrmActor; scope: CrmScope }) {
  const [lists, tags, fields, members, pipelines] = await Promise.all([
    listSmartLists(actor, "contact"),
    listTags(actor),
    listCustomFields(actor, "contact"),
    listAssignableMembers(actor),
    actor.can("sales.view") ? listPipelines(actor) : Promise.resolve([]),
  ]);
  // Live counts, one query per list. A list that no longer compiles (a field it used was archived) shows no count instead of failing the page.
  const counts: Record<string, number | null> = {};
  await Promise.all(lists.slice(0, 60).map(async (l) => {
    try {
      counts[l.id] = await countContacts(actor, { smartListId: l.id });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      counts[l.id] = null;
    }
  }));
  await auditSupportView(actor, "smart_lists");
  return (
    <SmartListsManager
      scope={scope}
      lists={JSON.parse(JSON.stringify(lists))}
      counts={counts}
      options={{
        tags: tags.map((t) => ({ id: t.id, name: t.name, color: t.color })),
        members,
        pipelines: pipelines.map((p) => ({ id: p.id, name: p.name, stages: p.stages.map((s) => ({ id: s.id, name: s.name })) })),
        customFields: fields.map((f) => ({ id: f.id, label: f.label, type: f.type, options: f.options })),
      }}
    />
  );
}

export async function TagsView({ actor, scope }: { actor: CrmActor; scope: CrmScope }) {
  const tags = await listTags(actor);
  await auditSupportView(actor, "tags");
  return <TagsManager scope={scope} tags={tags} />;
}

export async function FieldsView({ actor, scope, entityParam }: { actor: CrmActor; scope: CrmScope; entityParam: string | undefined }) {
  const entities: FieldEntity[] = ["contact", ...(actor.can("companies.view") ? (["company"] as const) : []), ...(actor.can("sales.view") ? (["opportunity"] as const) : [])];
  const entity = entities.find((e) => e === entityParam) ?? "contact";
  const fields = await listCustomFields(actor, entity);
  await auditSupportView(actor, "custom_fields");
  return <FieldsManager scope={scope} entity={entity} entities={entities} fields={JSON.parse(JSON.stringify(fields))} />;
}
