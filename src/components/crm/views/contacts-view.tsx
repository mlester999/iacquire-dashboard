import { listContacts } from "@/server/crm/directory";
import { listSmartLists, touchSmartList } from "@/server/crm/smart-lists";
import { listTags } from "@/server/crm/tags";
import { listCustomFields } from "@/server/crm/fields";
import { listAssignableMembers } from "@/server/crm/contacts";
import { listPipelines } from "@/server/crm/pipelines";
import { auditSupportView, crmRead, type CrmActor } from "@/server/crm/actor";
import { getWorkspace } from "@/server/crm/workspace";
import { AppError } from "@/server/errors";
import type { CrmScope } from "@/server/crm/page";
import { ContactsWorkspace } from "@/components/crm/contacts-workspace";
import { GhlOwnedNotice } from "@/components/crm/ghl-owned";
import { DEFAULT_CONTACT_COLUMNS } from "@/lib/crm/filters";
import { decodeFilter } from "@/lib/crm/filter-codec";

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export async function ContactsView({ actor, scope, searchParams }: { actor: CrmActor; scope: CrmScope; searchParams: SP }) {
  const ghlOwned = (await getWorkspace(actor)).capabilities.contacts === "ghl";
  const list = one(searchParams.list) ?? null;
  const filter = decodeFilter(one(searchParams.f));
  const archivedRaw = one(searchParams.archived);
  const archived = archivedRaw === "only" || archivedRaw === "include" ? archivedRaw : "exclude";
  const sortBy = one(searchParams.sort);
  const dir = one(searchParams.dir) === "asc" ? "asc" : "desc";
  const page = Math.max(1, Number(one(searchParams.page)) || 1);
  const q = one(searchParams.q)?.slice(0, 120) ?? "";
  const colsParam = one(searchParams.cols);
  // One member transaction for the directory and its supporting menus. Six separate transactions
  // used to mean six BEGIN/COMMIT pairs plus six identity setups on every hosted navigation.
  const loaded = await crmRead(actor, async (db) => {
    let error: string | null = null;
    let data: Awaited<ReturnType<typeof listContacts>> | null = null;
    try {
      data = await listContacts(actor, { smartListId: list, filter: filter ?? undefined, search: q, archived, sort: sortBy ? { by: sortBy, dir } : undefined, page, pageSize: 25, columns: colsParam ? colsParam.split(",") : undefined }, db);
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      error = err.message;
      data = await listContacts(actor, { archived, page: 1, pageSize: 25 }, db);
    }
    const [lists, tags, fields, members, pipelines] = await Promise.all([
      listSmartLists(actor, "contact", db),
      listTags(actor, {}, db),
      listCustomFields(actor, "contact", db),
      listAssignableMembers(actor, db),
      actor.can("sales.view") ? listPipelines(actor, {}, db) : Promise.resolve([]),
    ]);
    return { error, data, lists, tags, fields, members, pipelines };
  });
  const { error, data, lists, tags, fields, members, pipelines } = loaded;
  if (list && !error) await touchSmartList(actor, list);
  await auditSupportView(actor, "contacts");
  const columns = colsParam ? colsParam.split(",").filter(Boolean).slice(0, 20) : data.smartList?.columns.length ? data.smartList.columns : DEFAULT_CONTACT_COLUMNS;
  // GoHighLevel owns contacts here: no editing controls (every native write would be refused on the server). Contacts iAcquire still holds
  // (from before a switch to GoHighLevel, say) stay visible read-only rather than disappearing; with none, the notice alone.
  if (ghlOwned) {
    const notice = <GhlOwnedNotice what="Contacts" agency={scope.agency} href="/leads" />;
    if (!data.total && !list && !q && !filter && archived === "exclude") return notice;
    return (
      <div className="space-y-4">
        <p role="note" className="rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-[13px] text-warning-ink">
          Contacts are managed in GoHighLevel for this workspace, so these are shown read-only. {scope.agency ? "Moving them to iAcquire is done from the CRM provider settings." : "An owner can move them to iAcquire in Settings → CRM Provider."}
        </p>
        <ContactsWorkspace
          scope={{ ...scope, readOnly: true }}
          page={JSON.parse(JSON.stringify(data))}
          error={error}
          state={{ list, filter, q, archived, sort: sortBy ?? null, dir, page, columns, cols: colsParam ?? null }}
          lists={lists}
          tags={tags.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
          fields={fields.filter((f) => !f.archived).map((f) => ({ id: f.id, key: f.key, label: f.label, type: f.type, options: f.options }))}
          members={members}
          pipelines={pipelines.map((p) => ({ id: p.id, name: p.name, stages: p.stages.map((s) => ({ id: s.id, name: s.name })) }))}
        />
      </div>
    );
  }
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
