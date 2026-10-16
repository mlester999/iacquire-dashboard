import { listContacts } from "@/server/crm/directory";
import { listSmartLists, touchSmartList } from "@/server/crm/smart-lists";
import { listTags } from "@/server/crm/tags";
import { listCustomFields } from "@/server/crm/fields";
import { listAssignableMembers } from "@/server/crm/contacts";
import { listPipelines } from "@/server/crm/pipelines";
import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import { AppError } from "@/server/errors";
import type { CrmScope } from "@/server/crm/page";
import { ContactsWorkspace } from "@/components/crm/contacts-workspace";
import { DEFAULT_CONTACT_COLUMNS } from "@/lib/crm/filters";
import { decodeFilter } from "@/lib/crm/filter-codec";

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export async function ContactsView({ actor, scope, searchParams }: { actor: CrmActor; scope: CrmScope; searchParams: SP }) {
  const list = one(searchParams.list) ?? null;
  const filter = decodeFilter(one(searchParams.f));
  const archivedRaw = one(searchParams.archived);
  const archived = archivedRaw === "only" || archivedRaw === "include" ? archivedRaw : "exclude";
  const sortBy = one(searchParams.sort);
  const dir = one(searchParams.dir) === "asc" ? "asc" : "desc";
  const page = Math.max(1, Number(one(searchParams.page)) || 1);
  const q = one(searchParams.q)?.slice(0, 120) ?? "";
  const colsParam = one(searchParams.cols);
  let error: string | null = null;
  let data: Awaited<ReturnType<typeof listContacts>> | null = null;
  try {
    data = await listContacts(actor, { smartListId: list, filter: filter ?? undefined, search: q, archived, sort: sortBy ? { by: sortBy, dir } : undefined, page, pageSize: 25, columns: colsParam ? colsParam.split(",") : undefined });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    error = err.message;
    data = await listContacts(actor, { archived, page: 1, pageSize: 25 });
  }
  const [lists, tags, fields, members, pipelines] = await Promise.all([
    listSmartLists(actor, "contact"),
    listTags(actor),
    listCustomFields(actor, "contact"),
    listAssignableMembers(actor),
    actor.can("sales.view") ? listPipelines(actor) : Promise.resolve([]),
  ]);
  if (list && !error) await touchSmartList(actor, list);
  await auditSupportView(actor, "contacts");
  const columns = colsParam ? colsParam.split(",").filter(Boolean).slice(0, 20) : data.smartList?.columns.length ? data.smartList.columns : DEFAULT_CONTACT_COLUMNS;
  return (
    <ContactsWorkspace
      scope={scope}
      page={JSON.parse(JSON.stringify(data))}
      error={error}
      state={{ list, filter, q, archived, sort: sortBy ?? null, dir, page, columns, cols: colsParam ?? null }}
      lists={lists}
      tags={tags.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
      fields={fields.filter((f) => !f.archived).map((f) => ({ id: f.id, key: f.key, label: f.label, type: f.type, options: f.options }))}
      members={members}
      pipelines={pipelines.map((p) => ({ id: p.id, name: p.name, stages: p.stages.map((s) => ({ id: s.id, name: s.name })) }))}
    />
  );
}
