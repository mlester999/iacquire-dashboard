"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Archive, ArrowDownUp, Columns3, Download, Filter, Pin, Plus, Save, Search, Star, Tag, UserCheck, Users, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Field, Input, Select } from "@/components/ui/primitives";
import { Dialog, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Sheet } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { archiveContactsAction, assignContactsAction, countContactsAction, createSmartListAction, pinSmartListAction, tagContactsAction, updateSmartListAction } from "@/app/actions/crm";
import { FilterBuilder, completeFilter, describeFilter, useFilterFields, type FilterOptions } from "@/components/crm/filter-builder";
import { ContactFormDialog } from "@/components/crm/contact-form-dialog";
import { displayFieldValue, type FieldDef } from "@/components/crm/field-input";
import { Avatar, ConfirmDialog, LeadStatusBadge, Pagination, TagChip, useCrmAction } from "@/components/crm/ui";
import { useUrlSearch } from "@/components/crm/url-search";
import { CONTACT_COLUMN_LABELS, CONTACT_COLUMNS, CONTACT_SORT_LABELS, CONTACT_SORTS, EMPTY_FILTER, type FilterGroup } from "@/lib/crm/filters";
import { CREATED_VIA_LABELS, formatPhone } from "@/lib/crm/types";
import { encodeFilter } from "@/lib/crm/filter-codec";
import type { ContactPage } from "@/server/crm/directory";
import type { SmartListView } from "@/server/crm/smart-lists";
import type { CrmScope } from "@/server/crm/page";
import { RelativeTime } from "@/components/crm/relative-time";

interface State {
  list: string | null;
  filter: FilterGroup | null;
  q: string;
  archived: "exclude" | "only" | "include";
  sort: string | null;
  dir: "asc" | "desc";
  page: number;
  columns: string[];
  /** The raw column list from the URL, if the person chose columns. */
  cols: string | null;
}

const encode = encodeFilter;

const BUILT_IN: Array<{ key: string; label: string; filter: FilterGroup | null; archived?: "only"; icon: React.ComponentType<{ className?: string }> }> = [
  { key: "all", label: "All contacts", filter: null, icon: Users },
  { key: "mine", label: "My contacts", filter: { op: "and", conditions: [{ field: "owner", op: "is_me" }] }, icon: UserCheck },
  { key: "unassigned", label: "Unassigned", filter: { op: "and", conditions: [{ field: "owner", op: "is_unassigned" }] }, icon: Users },
  { key: "new", label: "New this week", filter: { op: "and", conditions: [{ field: "created_at", op: "within_last_days", value: 7 }] }, icon: Star },
  { key: "archived", label: "Archived", filter: null, archived: "only", icon: Archive },
];

export function ContactsWorkspace({
  scope, page, error, state, lists, tags, fields, members, pipelines,
}: {
  scope: CrmScope;
  page: ContactPage;
  error: string | null;
  state: State;
  lists: SmartListView[];
  tags: Array<{ id: string; name: string; color: string }>;
  fields: FieldDef[];
  members: Array<{ id: string; name: string; role: string }>;
  pipelines: Array<{ id: string; name: string; stages: Array<{ id: string; name: string }> }>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { run, busy } = useCrmAction();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = React.useState(false);
  const [filterOpen, setFilterOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<FilterGroup>(state.filter ?? EMPTY_FILTER);
  const [draftCount, setDraftCount] = React.useState<number | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [saveOpen, setSaveOpen] = React.useState(false);
  const [tagOpen, setTagOpen] = React.useState(false);
  const [assignOpen, setAssignOpen] = React.useState(false);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const filterOptions: FilterOptions = React.useMemo(() => ({ tags, members, pipelines, customFields: fields }), [tags, members, pipelines, fields]);
  const catalog = useFilterFields("contact", filterOptions);
  // With a saved list open and no extra filter on top, the filter sheet edits that list's own conditions.
  const listMeta = state.list ? lists.find((l) => l.id === state.list) : undefined;
  const editingList = Boolean(page.smartList && !state.filter && listMeta && !scope.readOnly && (listMeta.mine || (listMeta.visibility === "team" && scope.can["smartlists.share"])));

  // A different page or view clears the selection.
  const selectionKey = `${page.page}|${state.list}|${state.q}|${state.archived}`;
  const [selectionFor, setSelectionFor] = React.useState(selectionKey);
  if (selectionFor !== selectionKey) {
    setSelectionFor(selectionKey);
    setSelected(new Set());
    setAllMatching(false);
  }

  const hrefWith = React.useCallback(
    (changes: Partial<Record<"list" | "f" | "q" | "archived" | "sort" | "dir" | "page" | "cols", string | null>>) => {
      const params = new URLSearchParams();
      const cur: Record<string, string | null> = {
        list: state.list, f: state.filter ? encode(state.filter) : null, q: state.q || null, archived: state.archived === "exclude" ? null : state.archived,
        sort: state.sort, dir: state.sort ? state.dir : null, page: state.page > 1 ? String(state.page) : null, cols: state.cols,
      };
      const next = { ...cur, ...changes };
      if (!("page" in changes)) next.page = null;
      for (const [k, v] of Object.entries(next)) if (v) params.set(k, v);
      const s = params.toString();
      return `${pathname}${s ? `?${s}` : ""}`;
    },
    [pathname, state],
  );

  // Typing replaces the address after a pause; a search changed elsewhere (Back, a link, a filter that clears it) replaces the box's text.
  const search = useUrlSearch(state.q, state, (q) => router.replace(hrefWith({ q: q || null })));

  // Live count while building a filter.
  React.useEffect(() => {
    if (!filterOpen) return;
    const t = setTimeout(async () => {
      const res = await countContactsAction(scope.orgId, { filter: completeFilter(draft, catalog), smartListId: editingList ? null : state.list, search: state.q || undefined, archived: state.archived });
      setDraftCount(res.ok ? res.data : null);
    }, 350);
    return () => clearTimeout(t);
  }, [draft, filterOpen, scope.orgId, catalog, state.list, state.q, state.archived, editingList]);

  const selection = allMatching
    ? { query: { smartListId: state.list, filter: state.filter ?? undefined, search: state.q || undefined, archived: state.archived } }
    : { ids: [...selected] };
  const selectionCount = allMatching ? page.total : selected.size;
  const visibleCols = state.columns.filter((c) => (CONTACT_COLUMNS as readonly string[]).includes(c) || c.startsWith("cf:"));
  const activeBuiltIn = !state.list ? BUILT_IN.find((b) => (b.archived ? state.archived === "only" : state.archived !== "only" && JSON.stringify(b.filter) === JSON.stringify(state.filter))) : undefined;
  const filterActive = Boolean(state.filter?.conditions.length) && !activeBuiltIn;
  const pinned = lists.filter((l) => l.pinned);
  const team = lists.filter((l) => !l.pinned && l.visibility === "team");
  const mine = lists.filter((l) => !l.pinned && l.visibility === "private");
  // The export covers exactly what this view shows: the same saved list, filter, search and archive setting.
  const exportHref = `/api/crm/export?${new URLSearchParams({ ...(state.list ? { list: state.list } : {}), ...(state.filter?.conditions.length ? { f: encode(state.filter) } : {}), ...(state.q ? { q: state.q } : {}), ...(state.archived !== "exclude" ? { archived: state.archived } : {}), ...(scope.orgId ? { org: scope.orgId } : {}) }).toString()}`;

  const toggleAll = () => {
    if (selected.size === page.rows.length) setSelected(new Set());
    else setSelected(new Set(page.rows.map((r) => r.id)));
    setAllMatching(false);
  };

  const fieldDef = (col: string) => fields.find((f) => `cf:${f.id}` === col);
  const cell = (row: ContactPage["rows"][number], col: string): React.ReactNode => {
    switch (col) {
      case "email": return row.email ?? <span className="text-faint">—</span>;
      case "phone": return row.phone ? formatPhone(row.phone) : <span className="text-faint">—</span>;
      case "company": return row.company ? <Link className="hover:underline" href={`${scope.base}/companies/${row.company.id}`} onClick={(e) => e.stopPropagation()}>{row.company.name}</Link> : <span className="text-faint">—</span>;
      case "owner": return row.owner?.name ?? <span className="text-faint">Unassigned</span>;
      case "lead_status": return <LeadStatusBadge status={row.leadStatus} />;
      case "source": return row.source || <span className="text-faint">—</span>;
      case "tags": return row.tags.length ? <div className="flex max-w-[240px] items-center gap-1 overflow-hidden">{row.tags.slice(0, 2).map((t) => <TagChip key={t.id} name={t.name} color={t.color} className="max-w-[110px]" />)}{row.tags.length > 2 && <span className="shrink-0 text-[12px] text-muted" title={row.tags.slice(2).map((t) => t.name).join(", ")}>+{row.tags.length - 2}</span>}</div> : <span className="text-faint">—</span>;
      case "lead_score": return row.leadScore ?? <span className="text-faint">—</span>;
      case "created_at": return <RelativeTime iso={row.createdAt} timezone={scope.timezone} />;
      case "last_activity_at": return row.lastActivityAt ? <RelativeTime iso={row.lastActivityAt} timezone={scope.timezone} /> : <span className="text-faint">—</span>;
      case "city": return row.city ?? <span className="text-faint">—</span>;
      case "country": return row.country ?? <span className="text-faint">—</span>;
      case "created_via": return CREATED_VIA_LABELS[row.createdVia] ?? row.createdVia;
      default: {
        const def = fieldDef(col);
        return def ? displayFieldValue(def, row.fields[def.id], scope.currency) : "";
      }
    }
  };
  const colLabel = (col: string) => (CONTACT_COLUMN_LABELS as Record<string, string>)[col] ?? fieldDef(col)?.label ?? col;

  return (
    <div className="grid min-w-0 gap-5 2xl:grid-cols-[230px_minmax(0,1fr)]">
      {/* Views */}
      <aside aria-label="Views" className="hidden min-w-0 2xl:sticky 2xl:top-24 2xl:block 2xl:self-start">
        <div className="hidden space-y-4 2xl:block">
          <ul className="space-y-0.5">
            {BUILT_IN.map((b) => {
              const active = activeBuiltIn?.key === b.key && !state.list;
              return (
                <li key={b.key}>
                  <Link href={hrefWith({ list: null, f: b.filter ? encode(b.filter) : null, archived: b.archived ?? null })} aria-current={active ? "page" : undefined}
                    className={cn("flex min-h-9 items-center gap-2 rounded-xl px-2.5 text-[13.5px] font-medium", active ? "bg-surface text-ink shadow-soft ring-1 ring-line" : "text-ink-2 hover:bg-surface-2")}>
                    <b.icon className="size-4 text-muted" />{b.label}
                  </Link>
                </li>
              );
            })}
          </ul>
          {[{ title: "Pinned", items: pinned }, { title: "Shared with the team", items: team }, { title: "My lists", items: mine }].filter((g) => g.items.length).map((g) => (
            <div key={g.title}>
              <p className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">{g.title}</p>
              <ul className="space-y-0.5">
                {g.items.map((l) => {
                  const active = state.list === l.id;
                  return (
                    <li key={l.id} className="group flex items-center">
                      <Link href={hrefWith({ list: l.id, f: null, archived: null })} aria-current={active ? "page" : undefined}
                        className={cn("flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-xl px-2.5 text-[13.5px] font-medium", active ? "bg-surface text-ink shadow-soft ring-1 ring-line" : "text-ink-2 hover:bg-surface-2")}>
                        <span className="truncate">{l.name}</span>
                        {l.isDefault && <Badge tone="primary" className="h-5 px-1.5 text-[10px]">Default</Badge>}
                      </Link>
                      <button type="button" onClick={() => run(`pin-${l.id}`, () => pinSmartListAction(scope.orgId, l.id, !l.pinned))} aria-label={l.pinned ? `Unpin ${l.name}` : `Pin ${l.name}`}
                        className="ml-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-faint opacity-0 hover:bg-surface-2 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100">
                        <Pin className={cn("size-3.5", l.pinned && "fill-current text-primary")} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          <Link href={`${scope.base}/smart-lists`} className="block px-2.5 text-[12.5px] font-medium text-primary-ink hover:underline">Manage Smart Lists</Link>
        </div>
      </aside>

      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-[20px] font-semibold tracking-[-0.03em] text-ink">{page.smartList?.name ?? activeBuiltIn?.label ?? "Filtered contacts"}</h2>
            <p className="mt-0.5 text-[13px] text-muted">{page.total.toLocaleString("en-US")} {page.total === 1 ? "contact" : "contacts"}{filterActive && ` · ${describeFilter(state.filter!, catalog, filterOptions)}`}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {scope.can["contacts.export"] && <a href={exportHref} className="inline-flex h-11 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink shadow-soft hover:bg-surface-2 sm:h-9"><Download className="size-4" />Export</a>}
            {scope.can["contacts.edit"] && !scope.readOnly && <Button size="sm" data-aqi-target="crm.contacts.new" onClick={() => setCreateOpen(true)}><Plus className="size-4" />New contact</Button>}
          </div>
        </div>

        {error && <p role="alert" className="rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-[13px] text-warning-ink">{error} Showing all contacts instead.</p>}

        <Card className="overflow-hidden" data-aqi-target="crm.contacts.table">
          <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
        <div className="w-full sm:w-52 2xl:hidden">
          <label htmlFor="view-select" className="sr-only">View</label>
          <Select
            id="view-select"
            value={state.list ? `list:${state.list}` : `builtin:${activeBuiltIn?.key ?? "all"}`}
            onChange={(e) => {
              const [kind, key] = e.target.value.split(":");
              if (kind === "list") router.push(hrefWith({ list: key, f: null, archived: null }));
              else {
                const b = BUILT_IN.find((x) => x.key === key)!;
                router.push(hrefWith({ list: null, f: b.filter ? encode(b.filter) : null, archived: b.archived ?? null }));
              }
            }}
          >
            <optgroup label="Views">{BUILT_IN.map((b) => <option key={b.key} value={`builtin:${b.key}`}>{b.label}</option>)}</optgroup>
            {lists.length > 0 && <optgroup label="Smart Lists">{lists.map((l) => <option key={l.id} value={`list:${l.id}`}>{l.name}</option>)}</optgroup>}
          </Select>
        </div>
            <div className="relative min-w-[200px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
              <Input aria-label="Search contacts" data-aqi-target="crm.contacts.search" placeholder="Search name, email, phone or city" value={search.text} onChange={(e) => search.setText(e.target.value)} className="pl-9" />
            </div>
            <Button variant={filterActive ? "soft" : "secondary"} size="sm" onClick={() => { setDraft(state.filter ?? (editingList ? page.smartList!.filter : EMPTY_FILTER)); setFilterOpen(true); }}>
              <Filter className="size-4" />Filter{filterActive ? ` (${state.filter!.conditions.length})` : ""}
            </Button>
            <Menu>
              <MenuTrigger asChild><Button variant="secondary" size="sm"><Columns3 className="size-4" />Columns</Button></MenuTrigger>
              <MenuContent className="max-h-80 overflow-y-auto">
                <MenuLabel>Show columns</MenuLabel>
                {[...CONTACT_COLUMNS, ...fields.map((f) => `cf:${f.id}`)].map((col) => {
                  const on = visibleCols.includes(col);
                  return (
                    <MenuItem key={col} onSelect={(e) => { e.preventDefault(); const next = on ? visibleCols.filter((c) => c !== col) : [...visibleCols, col]; router.replace(hrefWith({ cols: next.join(",") || "email" })); }}>
                      <span className={cn("mr-2 inline-flex size-4 items-center justify-center rounded border", on ? "border-primary bg-primary text-primary-on" : "border-line-strong")} aria-hidden>{on ? "✓" : ""}</span>
                      {colLabel(col)}
                    </MenuItem>
                  );
                })}
              </MenuContent>
            </Menu>
            <Menu>
              <MenuTrigger asChild><Button variant="secondary" size="sm"><ArrowDownUp className="size-4" />Sort</Button></MenuTrigger>
              <MenuContent>
                <MenuLabel>Sort by</MenuLabel>
                {CONTACT_SORTS.map((s) => (
                  <MenuItem key={s} onSelect={() => router.replace(hrefWith({ sort: s, dir: state.sort === s && state.dir === "desc" ? "asc" : "desc" }))}>
                    {CONTACT_SORT_LABELS[s]}{state.sort === s ? (state.dir === "asc" ? " ↑" : " ↓") : ""}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
            {(filterActive || state.q) && (
              <Button variant="ghost" size="sm" onClick={() => { search.reset(); router.replace(hrefWith({ f: null, q: null })); }}><X className="size-4" />Clear</Button>
            )}
          </div>

          {selectionCount > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-b border-line bg-primary-soft/50 px-3 py-2 text-[13px]" role="region" aria-label="Bulk actions">
              <strong className="font-semibold text-primary-ink">{selectionCount.toLocaleString("en-US")} selected</strong>
              {!allMatching && selected.size === page.rows.length && page.total > page.rows.length && (
                <button type="button" className="font-medium text-primary-ink underline" onClick={() => setAllMatching(true)}>Select all {page.total.toLocaleString("en-US")} matching</button>
              )}
              <div className="ml-auto flex flex-wrap gap-1.5">
                {scope.can["contacts.edit"] && !scope.readOnly && (selectionCount === 1 || scope.can["contacts.bulk"]) && <Button size="sm" variant="secondary" onClick={() => setTagOpen(true)}><Tag className="size-4" />Tags</Button>}
                {scope.can["contacts.assign"] && !scope.readOnly && <Button size="sm" variant="secondary" onClick={() => setAssignOpen(true)}><UserCheck className="size-4" />Assign</Button>}
                {scope.can["contacts.delete"] && !scope.readOnly && <Button size="sm" variant="secondary" onClick={() => setArchiveOpen(true)}><Archive className="size-4" />{state.archived === "only" ? "Restore" : "Archive"}</Button>}
                <Button size="sm" variant="ghost" onClick={() => { setSelected(new Set()); setAllMatching(false); }}>Cancel</Button>
              </div>
            </div>
          )}

          {page.rows.length === 0 ? (
            <EmptyState
              icon={<Users className="size-5" />}
              title={state.q || filterActive || state.list ? "No contacts match" : state.archived === "only" ? "Nothing archived" : "No contacts yet"}
              description={state.q || filterActive || state.list ? "Try a different search or loosen the filter." : "Contacts arrive from your website forms, inbound messages, bookings and imports, or you can add one by hand."}
              action={!state.q && !filterActive && !state.list && state.archived !== "only" && scope.can["contacts.edit"] && !scope.readOnly ? (
                <>
                  <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="size-4" />Add a contact</Button>
                  {scope.can["contacts.import"] && <Link href={`${scope.base}/settings/data`} className="text-[13px] font-medium text-primary-ink hover:underline">Import a spreadsheet</Link>}
                </>
              ) : undefined}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-[13px]">
                <thead className="bg-surface-2/60 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-muted">
                  <tr>
                    <th scope="col" className="w-10 px-3 py-2.5">
                      <input type="checkbox" aria-label="Select all on this page" className="size-4 accent-[var(--primary)]" checked={selected.size === page.rows.length && page.rows.length > 0} onChange={toggleAll} />
                    </th>
                    <th scope="col" className="px-3 py-2.5">Name</th>
                    {visibleCols.map((c) => <th key={c} scope="col" className="whitespace-nowrap px-3 py-2.5">{colLabel(c)}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {page.rows.map((row) => {
                    const on = allMatching || selected.has(row.id);
                    return (
                      <tr key={row.id} className={cn("group cursor-pointer transition-colors hover:bg-surface-2/60", on && "bg-primary-soft/30")} onClick={() => router.push(`${scope.base}/contacts/${row.id}`)}>
                        <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" aria-label={`Select ${row.displayName || row.email || "contact"}`} className="size-4 accent-[var(--primary)]" checked={on} disabled={allMatching}
                            onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(row.id)) n.delete(row.id); else n.add(row.id); return n; })} />
                        </td>
                        <td className="max-w-[260px] px-3 py-2.5">
                          <Link href={`${scope.base}/contacts/${row.id}`} className="flex min-w-0 items-center gap-2.5 font-medium text-ink" onClick={(e) => e.stopPropagation()}>
                            <Avatar name={row.displayName || row.email || "?"} size="sm" />
                            <span className="min-w-0">
                              <span className="block truncate group-hover:underline">{row.displayName || row.email || row.phone || "Unnamed contact"}</span>
                              <span className="block truncate text-[12px] font-normal text-muted">{row.archived ? "Archived · " : ""}{row.email ?? (row.displayName && row.phone ? formatPhone(row.phone) : null) ?? ""}</span>
                            </span>
                          </Link>
                        </td>
                        {visibleCols.map((c) => <td key={c} className="whitespace-nowrap px-3 py-2.5 text-ink-2">{cell(row, c)}</td>)}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="border-t border-line p-3">
            <Pagination page={page.page} pageSize={page.pageSize} total={page.total} hrefFor={(p) => hrefWith({ page: String(p) })} />
          </div>
        </Card>
      </div>

      {/* Filter builder */}
      <Sheet open={filterOpen} onOpenChange={setFilterOpen} title={editingList ? `Edit "${page.smartList!.name}"` : "Filter contacts"} description={editingList ? "Change the conditions, then save them to the list, or apply them just for now." : "Conditions are checked live against your contacts. Save the filter as a Smart List to reuse it."}>
        <div className="space-y-4 p-5">
          <FilterBuilder value={draft} onChange={setDraft} options={filterOptions} />
          <p className="rounded-xl bg-surface-2 px-3 py-2 text-[13px] text-ink-2" aria-live="polite">{draftCount === null ? "Counting…" : `${draftCount.toLocaleString("en-US")} ${draftCount === 1 ? "contact matches" : "contacts match"}`}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setDraft(EMPTY_FILTER)}>Reset</Button>
            <Button variant="secondary" onClick={() => { setFilterOpen(false); setSaveOpen(true); }}><Save className="size-4" />{editingList ? "Save as new list" : "Save as Smart List"}</Button>
            {editingList ? (
              <>
                <Button variant="secondary" onClick={() => { const c = completeFilter(draft, catalog); setFilterOpen(false); router.push(hrefWith({ f: c.conditions.length ? encode(c) : null, list: null })); }}>Apply without saving</Button>
                <Button loading={busy("update-list")} onClick={async () => {
                  const c = completeFilter(draft, catalog);
                  if (await run("update-list", () => updateSmartListAction(scope.orgId, state.list!, { filter: c }), "List updated.")) setFilterOpen(false);
                }}>Save to list</Button>
              </>
            ) : (
              <Button onClick={() => { const c = completeFilter(draft, catalog); setFilterOpen(false); router.push(hrefWith({ f: c.conditions.length ? encode(c) : null, list: state.list })); }}>Apply</Button>
            )}
          </div>
        </div>
      </Sheet>

      <SaveListDialog open={saveOpen} onOpenChange={setSaveOpen} scope={scope} filter={completeFilter(draft, catalog)} columns={visibleCols} onSaved={(id) => router.push(hrefWith({ list: id, f: null }))} />

      <BulkTagDialog open={tagOpen} onOpenChange={setTagOpen} tags={tags} count={selectionCount} onSubmit={async (add, remove) => {
        const r = await run("bulk-tag", () => tagContactsAction(scope.orgId, selection, add, remove), (d) => `Tags updated: ${d.added} added, ${d.removed} removed.`);
        if (r) { setTagOpen(false); setSelected(new Set()); setAllMatching(false); }
      }} loading={busy("bulk-tag")} />

      <Dialog open={assignOpen} onOpenChange={setAssignOpen} title={`Assign ${selectionCount.toLocaleString("en-US")} ${selectionCount === 1 ? "contact" : "contacts"}`} size="sm">
        <ul className="space-y-1">
          <li><Button variant="ghost" className="w-full justify-start" loading={busy("assign-none")} onClick={async () => { if (await run("assign-none", () => assignContactsAction(scope.orgId, selection, null), (d) => `${d.changed} unassigned.`)) setAssignOpen(false); }}>Unassigned</Button></li>
          {members.map((m) => (
            <li key={m.id}><Button variant="ghost" className="w-full justify-start" loading={busy(`assign-${m.id}`)} onClick={async () => { if (await run(`assign-${m.id}`, () => assignContactsAction(scope.orgId, selection, m.id), (d) => `${d.changed} assigned to ${m.name}.`)) { setAssignOpen(false); setSelected(new Set()); setAllMatching(false); } }}>{m.name}</Button></li>
          ))}
        </ul>
      </Dialog>

      <ConfirmDialog open={archiveOpen} onOpenChange={setArchiveOpen} title={state.archived === "only" ? "Restore contacts?" : "Archive contacts?"} confirmLabel={state.archived === "only" ? "Restore" : "Archive"}
        description={state.archived === "only" ? "They return to your lists and automations." : "Archived contacts leave your lists and automations but keep their full history. You can restore them any time."}
        loading={busy("archive")}
        onConfirm={async () => { if (await run("archive", () => archiveContactsAction(scope.orgId, selection, state.archived !== "only"), (d) => `${d.changed} ${state.archived === "only" ? "restored" : "archived"}.`)) { setArchiveOpen(false); setSelected(new Set()); setAllMatching(false); } }} />

      {createOpen && <ContactFormDialog open={createOpen} onOpenChange={setCreateOpen} scope={scope} members={members} tags={tags} fields={fields} />}
    </div>
  );
}

function SaveListDialog({ open, onOpenChange, scope, filter, columns, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; scope: CrmScope; filter: FilterGroup; columns: string[]; onSaved: (id: string) => void }) {
  const [name, setName] = React.useState("");
  const [team, setTeam] = React.useState(false);
  const { run, busy } = useCrmAction();
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Save as Smart List" description="The list stays live: people join and leave it as their details change." size="sm"
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button loading={busy("save")} disabled={!name.trim()} onClick={async () => { const r = await run("save", () => createSmartListAction(scope.orgId, { name, filter, columns, visibility: team ? "team" : "private" }), "Smart List saved."); if (r) { onOpenChange(false); setName(""); onSaved(r.id); } }}>Save</Button></>}>
      <div className="space-y-3">
        <Field label="Name" htmlFor="sl-name"><Input id="sl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="New leads without an appointment" autoFocus /></Field>
        {scope.can["smartlists.share"] && (
          <label className="flex items-center gap-2 text-[13px] text-ink-2"><input type="checkbox" className="size-4 accent-[var(--primary)]" checked={team} onChange={(e) => setTeam(e.target.checked)} />Share with the whole team</label>
        )}
      </div>
    </Dialog>
  );
}

function BulkTagDialog({ open, onOpenChange, tags, count, onSubmit, loading }: { open: boolean; onOpenChange: (o: boolean) => void; tags: Array<{ id: string; name: string; color: string }>; count: number; onSubmit: (add: string[], remove: string[]) => void; loading: boolean }) {
  const [state, setState] = React.useState<Record<string, "add" | "remove" | undefined>>({});
  const add = Object.entries(state).filter(([, v]) => v === "add").map(([k]) => k);
  const remove = Object.entries(state).filter(([, v]) => v === "remove").map(([k]) => k);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Tags for ${count.toLocaleString("en-US")} ${count === 1 ? "contact" : "contacts"}`} description="Click a tag once to add it, twice to remove it." size="sm"
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button loading={loading} disabled={!add.length && !remove.length} onClick={() => onSubmit(add, remove)}>Apply</Button></>}>
      {tags.length === 0 ? <p className="text-[13px] text-muted">There are no tags yet. Create them under Tags &amp; Segments.</p> : (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((t) => {
            const s = state[t.id];
            return (
              <button key={t.id} type="button" onClick={() => setState((x) => ({ ...x, [t.id]: s === undefined ? "add" : s === "add" ? "remove" : undefined }))} aria-label={`${t.name}: ${s === "add" ? "will be added" : s === "remove" ? "will be removed" : "unchanged"}`}
                className={cn("inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium", s === "add" ? "border-success/40 bg-success-soft text-success-ink" : s === "remove" ? "border-danger/40 bg-danger-soft text-danger-ink line-through" : "border-line bg-surface text-ink-2")}>
                <i className="size-2 rounded-full" style={{ background: t.color }} aria-hidden />{s === "add" ? "+ " : s === "remove" ? "− " : ""}{t.name}
              </button>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
