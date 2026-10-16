import { listCompanies } from "@/server/crm/directory";
import { listTags } from "@/server/crm/tags";
import { listCustomFields } from "@/server/crm/fields";
import { listAssignableMembers } from "@/server/crm/contacts";
import { getWorkspace } from "@/server/crm/workspace";
import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import { AppError } from "@/server/errors";
import type { CrmScope } from "@/server/crm/page";
import { CompaniesWorkspace } from "@/components/crm/companies-workspace";
import { GhlOwnedNotice } from "@/components/crm/ghl-owned";
import { decodeFilter } from "@/lib/crm/filter-codec";

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export async function CompaniesView({ actor, scope, searchParams }: { actor: CrmActor; scope: CrmScope; searchParams: SP }) {
  const ws = await getWorkspace(actor);
  if (ws.capabilities.companies === "ghl") return <GhlOwnedNotice what="Companies" agency={scope.agency} href="/leads" />;
  const filter = decodeFilter(one(searchParams.f));
  const archivedRaw = one(searchParams.archived);
  const archived = archivedRaw === "only" || archivedRaw === "include" ? archivedRaw : "exclude";
  const sortRaw = one(searchParams.sort);
  const sort = sortRaw === "created_at" || sortRaw === "updated_at" || sortRaw === "name" ? sortRaw : null;
  const dir = one(searchParams.dir) === "desc" ? "desc" : "asc";
  const page = Math.max(1, Number(one(searchParams.page)) || 1);
  const q = one(searchParams.q)?.slice(0, 120) ?? "";
  let error: string | null = null;
  let data;
  try {
    data = await listCompanies(actor, { filter: filter ?? undefined, search: q, archived, sort: sort ? { by: sort, dir } : undefined, page, pageSize: 25 });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    error = err.message;
    data = await listCompanies(actor, { archived, page: 1, pageSize: 25 });
  }
  const [tags, fields, members] = await Promise.all([listTags(actor), listCustomFields(actor, "company"), listAssignableMembers(actor)]);
  await auditSupportView(actor, "companies");
  return (
    <CompaniesWorkspace
      scope={scope}
      rows={data.rows}
      total={data.total}
      page={data.page}
      pageSize={data.pageSize}
      error={error}
      tags={tags.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
      members={members}
      fields={fields.filter((f) => !f.archived).map((f) => ({ id: f.id, label: f.label, type: f.type, options: f.options }))}
      state={{ q, filter: error ? null : filter, archived, sort, dir }}
    />
  );
}
