"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Building2, Filter, Plus, Search, Tag, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog, Sheet } from "@/components/ui/overlays";
import { cn, relativeTime } from "@/lib/utils";
import { archiveCompaniesAction, createCompanyAction, tagCompanyAction } from "@/app/actions/crm";
import { FilterBuilder, completeFilter, describeFilter, useFilterFields, type FilterOptions } from "@/components/crm/filter-builder";
import { Avatar, ConfirmDialog, Pagination, TagChip, useCrmAction } from "@/components/crm/ui";
import { encodeFilter } from "@/lib/crm/filter-codec";
import type { FilterGroup } from "@/lib/crm/filters";
import type { CompanyRow } from "@/server/crm/directory";
import type { CrmScope } from "@/server/crm/page";

const EMPTY: FilterGroup = { op: "and", conditions: [] };
type SortKey = "name" | "created_at" | "updated_at";

export function CompaniesWorkspace({
  scope, rows, total, page, pageSize, error, tags, members, fields, state,
}: {
  scope: CrmScope;
  rows: CompanyRow[];
  total: number;
  page: number;
  pageSize: number;
  error: string | null;
  tags: Array<{ id: string; name: string; color: string }>;
  members: Array<{ id: string; name: string }>;
  fields: FilterOptions["customFields"];
  state: { q: string; filter: FilterGroup | null; archived: "exclude" | "only" | "include"; sort: SortKey | null; dir: "asc" | "desc" };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { run, busy } = useCrmAction();
  const [q, setQ] = React.useState(state.q);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const key = `${page}|${state.q}|${state.archived}|${JSON.stringify(state.filter)}`;
  const [selectionFor, setSelectionFor] = React.useState(key);
  if (selectionFor !== key) {
    setSelectionFor(key);
    setSelected(new Set());
  }
  const [filterOpen, setFilterOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<FilterGroup>(state.filter ?? EMPTY);
  const [newOpen, setNewOpen] = React.useState(false);
  const [tagOpen, setTagOpen] = React.useState(false);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const options: FilterOptions = React.useMemo(() => ({ tags, members, pipelines: [], customFields: fields }), [tags, members, fields]);
  const catalog = useFilterFields("company", options);
  const canEdit = !!scope.can["companies.edit"] && !scope.readOnly;

  const hrefWith = React.useCallback(
    (changes: Partial<Record<"q" | "f" | "archived" | "sort" | "dir" | "page", string | null>>) => {
      const cur: Record<string, string | null> = {
        q: state.q || null, f: state.filter ? encodeFilter(state.filter) : null, archived: state.archived === "exclude" ? null : state.archived,
        sort: state.sort, dir: state.sort ? state.dir : null, page: page > 1 ? String(page) : null,
      };
      const next = { ...cur, ...changes };
      if (!("page" in changes)) next.page = null;
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(next)) if (v) params.set(k, v);
      const s = params.toString();
      return `${pathname}${s ? `?${s}` : ""}`;
    },
    [pathname, page, state],
  );

  React.useEffect(() => {
    if (q === state.q) return;
    const t = setTimeout(() => router.replace(hrefWith({ q: q.trim() || null })), 300);
    return () => clearTimeout(t);
  }, [q, state.q, router, hrefWith]);

  const sortHeader = (label: string, by: SortKey) => {
    const active = (state.sort ?? "name") === by;
    const dir = state.sort ? state.dir : "asc";
    const nextDir = active && dir === "asc" ? "desc" : "asc";
    return (
      <th scope="col" className="whitespace-nowrap px-3 py-2.5 text-left font-medium" aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}>
        <Link href={hrefWith({ sort: by, dir: nextDir })} className="inline-flex items-center gap-1 hover:text-ink">
          {label}
          {active && (dir === "asc" ? <ArrowUp className="size-3" aria-hidden /> : <ArrowDown className="size-3" aria-hidden />)}
        </Link>
      </th>
    );
  };
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const conditions = state.filter?.conditions.length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[20px] font-semibold tracking-[-0.03em] text-ink">Companies</h2>
          <p className="mt-1 text-[13px] text-muted">{total.toLocaleString("en-US")} {total === 1 ? "company" : "companies"}{state.archived === "only" ? " (archived)" : ""}</p>
        </div>
        {canEdit && <Button onClick={() => setNewOpen(true)}><Plus className="size-4" />New company</Button>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <Input aria-label="Search companies" placeholder="Search by name, domain or city" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Button variant="secondary" onClick={() => { setDraft(state.filter ?? EMPTY); setFilterOpen(true); }}>
          <Filter className="size-4" />Filter{conditions ? <Badge tone="primary" className="ml-0.5 h-5 px-1.5">{conditions}</Badge> : null}
        </Button>
        <label htmlFor="co-archived" className="sr-only">Archived companies</label>
        <Select id="co-archived" className="w-auto" value={state.archived} onChange={(e) => router.push(hrefWith({ archived: e.target.value === "exclude" ? null : e.target.value }))}>
          <option value="exclude">Active</option>
          <option value="only">Archived</option>
          <option value="include">Active and archived</option>
        </Select>
        {state.filter && (
          <span className="inline-flex min-h-9 max-w-full items-center gap-1 rounded-xl bg-surface-2 px-3 text-[12.5px] text-ink-2">
            <span className="truncate">{describeFilter(state.filter, catalog)}</span>
            <Link href={hrefWith({ f: null })} aria-label="Clear filter" className="-mr-1 inline-flex size-6 items-center justify-center rounded-md hover:bg-line/60"><X className="size-3.5" /></Link>
          </span>
        )}
      </div>

      {error && <p className="rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-[13px] text-warning-ink" role="alert">{error} Showing every company instead.</p>}

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-primary/25 bg-primary-soft/50 px-3 py-2" role="region" aria-label="Bulk actions">
          <span className="text-[13px] font-medium text-primary-ink">{selected.size} selected</span>
          {canEdit && <Button size="sm" variant="secondary" onClick={() => setTagOpen(true)}><Tag className="size-4" />Tag</Button>}
          {scope.can["contacts.delete"] && !scope.readOnly && (
            <Button size="sm" variant="secondary" onClick={() => setArchiveOpen(true)}>
              {state.archived === "only" ? <><ArchiveRestore className="size-4" />Restore</> : <><Archive className="size-4" />Archive</>}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear selection</Button>
        </div>
      )}

      {rows.length ? (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-[13px]">
              <thead className="border-b border-line bg-surface-2/60 text-[12px] text-muted">
                <tr>
                  <th scope="col" className="w-10 px-3 py-2.5"><input type="checkbox" aria-label="Select all on this page" checked={allOnPage} onChange={() => setSelected(allOnPage ? new Set() : new Set(rows.map((r) => r.id)))} className="size-4 accent-[var(--color-primary)]" /></th>
                  {sortHeader("Company", "name")}
                  <th scope="col" className="px-3 py-2.5 text-left font-medium">Location</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">People</th>
                  <th scope="col" className="whitespace-nowrap px-3 py-2.5 text-right font-medium">Open deals</th>
                  <th scope="col" className="px-3 py-2.5 text-left font-medium">Owner</th>
                  <th scope="col" className="px-3 py-2.5 text-left font-medium">Tags</th>
                  {sortHeader("Added", "created_at")}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id} className={cn("hover:bg-surface-2/50", selected.has(r.id) && "bg-primary-soft/30")}>
                    <td className="px-3 py-2.5"><input type="checkbox" aria-label={`Select ${r.name}`} checked={selected.has(r.id)} onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })} className="size-4 accent-[var(--color-primary)]" /></td>
                    <td className="max-w-[280px] px-3 py-2.5">
                      <Link href={`${scope.base}/companies/${r.id}`} className="flex items-center gap-2.5">
                        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted ring-1 ring-line"><Building2 className="size-4" aria-hidden /></span>
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-ink hover:text-primary">{r.name}{r.archived && <Badge tone="neutral" className="ml-2">Archived</Badge>}</span>
                          <span className="block truncate text-[12px] text-muted">{[r.domain, r.industry].filter(Boolean).join(" · ") || "—"}</span>
                        </span>
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-ink-2">{[r.city, r.country].filter(Boolean).join(", ") || <span className="text-faint">—</span>}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.contactCount}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.openOpportunities}</td>
                    <td className="max-w-[160px] px-3 py-2.5">{r.owner ? <span className="flex items-center gap-2"><Avatar name={r.owner.name} size="sm" /><span className="truncate">{r.owner.name}</span></span> : <span className="text-faint">Unassigned</span>}</td>
                    <td className="max-w-[200px] px-3 py-2.5"><span className="flex gap-1 overflow-hidden">{r.tags.slice(0, 2).map((t) => <TagChip key={t.id} name={t.name} color={t.color} />)}{r.tags.length > 2 && <span className="self-center text-[12px] text-muted">+{r.tags.length - 2}</span>}</span></td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-muted">{relativeTime(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <Card>
          <EmptyState icon={<Building2 className="size-5" />} title={state.q || state.filter ? "No companies match" : "No companies yet"}
            description={state.q || state.filter ? "Try a different search or clear the filter." : "Companies group the people you work with at the same business. Add one, or import a list."}
            action={canEdit && !state.q && !state.filter ? <Button variant="secondary" onClick={() => setNewOpen(true)}><Plus className="size-4" />Add a company</Button> : undefined} />
        </Card>
      )}

      <Pagination page={page} pageSize={pageSize} total={total} hrefFor={(p) => hrefWith({ page: String(p) })} />

      <Sheet open={filterOpen} onOpenChange={setFilterOpen} title="Filter companies" description="Combine conditions with all (AND) or any (OR).">
        <div className="space-y-4 p-5">
          <FilterBuilder entity="company" value={draft} onChange={setDraft} options={options} />
          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button variant="secondary" onClick={() => { setFilterOpen(false); router.push(hrefWith({ f: null })); }}>Clear</Button>
            <Button onClick={() => { const g = completeFilter(draft, catalog); setFilterOpen(false); router.push(hrefWith({ f: g.conditions.length ? encodeFilter(g) : null })); }}>Apply</Button>
          </div>
        </div>
      </Sheet>

      {newOpen && <CompanyFormDialog scope={scope} members={members} onClose={() => setNewOpen(false)} onCreated={(id) => router.push(`${scope.base}/companies/${id}`)} />}
      {tagOpen && (
        <BulkTagDialog tags={tags} count={selected.size} busy={busy("tag")} onClose={() => setTagOpen(false)}
          onApply={async (tagId) => {
            let ok = true;
            for (const id of selected) ok = Boolean(await run("tag", () => tagCompanyAction(scope.orgId, id, [tagId], []))) && ok;
            if (ok) { setTagOpen(false); setSelected(new Set()); }
          }} />
      )}
      <ConfirmDialog open={archiveOpen} onOpenChange={setArchiveOpen} title={state.archived === "only" ? `Restore ${selected.size} companies?` : `Archive ${selected.size} companies?`} confirmLabel={state.archived === "only" ? "Restore" : "Archive"} danger={state.archived !== "only"} loading={busy("archive")}
        description={state.archived === "only" ? undefined : "Archived companies are hidden from lists and pickers. Their people and deals are not changed."}
        onConfirm={async () => { if (await run("archive", () => archiveCompaniesAction(scope.orgId, [...selected], state.archived !== "only"), (r) => `${r.changed} updated.`)) { setArchiveOpen(false); setSelected(new Set()); } }} />
    </div>
  );
}

function BulkTagDialog({ tags, count, busy, onClose, onApply }: { tags: Array<{ id: string; name: string }>; count: number; busy: boolean; onClose: () => void; onApply: (tagId: string) => void }) {
  const [tagId, setTagId] = React.useState(tags[0]?.id ?? "");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Tag ${count} ${count === 1 ? "company" : "companies"}`} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!tagId} loading={busy} onClick={() => onApply(tagId)}>Add tag</Button></>}>
      {tags.length ? (
        <Field label="Tag" htmlFor="bt-tag"><Select id="bt-tag" value={tagId} onChange={(e) => setTagId(e.target.value)}>{tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
      ) : <p className="text-[13px] text-muted">Create a tag first under Tags &amp; Segments.</p>}
    </Dialog>
  );
}

export function CompanyFormDialog({ scope, members, onClose, onCreated }: { scope: CrmScope; members: Array<{ id: string; name: string }>; onClose: () => void; onCreated: (id: string) => void }) {
  const { run, busy } = useCrmAction();
  const [form, setForm] = React.useState({ name: "", website: "", industry: "", phone: "", email: "", city: "", country: "", description: "", ownerId: scope.userId ?? "" });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="New company" description="If a company with the same domain already exists, you'll be pointed to it instead of creating a duplicate." size="md"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button form="co-form" type="submit" disabled={!form.name.trim()} loading={busy("create")}>Create company</Button></>}>
      <form id="co-form" className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
        e.preventDefault();
        const r = await run("create", () => createCompanyAction(scope.orgId, {
          name: form.name, website: form.website || null, industry: form.industry || null, phone: form.phone || null, email: form.email || null, city: form.city || null,
          country: form.country || null, description: form.description || null, ownerId: form.ownerId || null,
        }), "Company created.");
        if (r) { onClose(); onCreated(r.id); }
      }}>
        <Field label="Name" htmlFor="co-name" className="sm:col-span-2"><Input id="co-name" value={form.name} onChange={set("name")} maxLength={200} autoFocus /></Field>
        <Field label="Website" htmlFor="co-web" optional><Input id="co-web" value={form.website} onChange={set("website")} placeholder="example.com" /></Field>
        <Field label="Industry" htmlFor="co-ind" optional><Input id="co-ind" value={form.industry} onChange={set("industry")} /></Field>
        <Field label="Phone" htmlFor="co-phone" optional><Input id="co-phone" type="tel" value={form.phone} onChange={set("phone")} /></Field>
        <Field label="Email" htmlFor="co-email" optional><Input id="co-email" type="email" value={form.email} onChange={set("email")} /></Field>
        <Field label="City" htmlFor="co-city" optional><Input id="co-city" value={form.city} onChange={set("city")} /></Field>
        <Field label="Country code" htmlFor="co-country" optional hint="Two letters, like PH or US"><Input id="co-country" maxLength={2} value={form.country} onChange={(e) => setForm((f) => ({ ...f, country: e.target.value.toUpperCase() }))} /></Field>
        <Field label="Owner" htmlFor="co-owner" className="sm:col-span-2">
          <Select id="co-owner" value={form.ownerId} onChange={set("ownerId")}>
            <option value="">Unassigned</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </Field>
        <Field label="About" htmlFor="co-desc" optional className="sm:col-span-2"><Textarea id="co-desc" rows={2} value={form.description} onChange={set("description")} maxLength={2000} /></Field>
      </form>
    </Dialog>
  );
}
