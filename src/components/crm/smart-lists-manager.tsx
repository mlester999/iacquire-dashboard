"use client";

import * as React from "react";
import Link from "next/link";
import { Copy, ListFilter, MoreHorizontal, Pencil, Pin, PinOff, Star, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/overlays";
import { deleteSmartListAction, duplicateSmartListAction, pinSmartListAction, setDefaultSmartListAction, updateSmartListAction } from "@/app/actions/crm";
import { ConfirmDialog, PageTitle, useCrmAction } from "@/components/crm/ui";
import { describeFilter, useFilterFields, type FilterOptions } from "@/components/crm/filter-builder";
import type { SmartListView } from "@/server/crm/smart-lists";
import type { CrmScope } from "@/server/crm/page";
import { RelativeTime } from "@/components/crm/relative-time";

export function SmartListsManager({ scope, lists, counts, options }: { scope: CrmScope; lists: SmartListView[]; counts: Record<string, number | null>; options: FilterOptions }) {
  const { run, busy } = useCrmAction();
  const catalog = useFilterFields("contact", options);
  const [editing, setEditing] = React.useState<SmartListView | null>(null);
  const [deleting, setDeleting] = React.useState<SmartListView | null>(null);
  const canShare = !!scope.can["smartlists.share"] && !scope.readOnly;
  const editable = (l: SmartListView) => !scope.readOnly && (l.mine || (l.visibility === "team" && canShare));
  const groups: Array<{ title: string; items: SmartListView[] }> = [
    { title: "Pinned", items: lists.filter((l) => l.pinned) },
    { title: "Shared with the team", items: lists.filter((l) => !l.pinned && l.visibility === "team") },
    { title: "Only you", items: lists.filter((l) => !l.pinned && l.visibility === "private") },
  ].filter((g) => g.items.length);

  return (
    <div>
      <PageTitle
        title="Smart Lists"
        description="Saved, always-current views of your contacts. A list keeps its filter, not a frozen copy: anyone who matches later shows up automatically."
        actions={<Link href={`${scope.base}/contacts`} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-4 text-[13.5px] font-medium text-primary-on hover:bg-primary/90 sm:min-h-10"><ListFilter className="size-4" />Build a list</Link>}
      />
      {!lists.length ? (
        <Card>
          <EmptyState icon={<ListFilter className="size-5" />} title="No saved lists yet" description="Open Contacts, add a filter (for example: tagged VIP and no reply in 7 days), then choose Save as list." />
        </Card>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.title}>
              <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">{g.title}</h3>
              <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
                {g.items.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={`${scope.base}/contacts?list=${l.id}`} className="font-medium text-ink hover:text-primary">{l.name}</Link>
                        {l.isDefault && <Badge tone="primary"><Star className="size-3" />Default view</Badge>}
                        {l.visibility === "team" ? <Badge tone="neutral"><Users className="size-3" />Team</Badge> : null}
                      </div>
                      <p className="mt-0.5 truncate text-[12.5px] text-muted">{describeFilter(l.filter, catalog, options) || "Everyone"}</p>
                      <p className="mt-0.5 text-[11.5px] text-faint">{l.mine ? "Yours" : `By ${l.ownerName ?? "a teammate"}`} · updated <RelativeTime iso={l.updatedAt} timezone={scope.timezone} />{l.lastUsedAt ? <> · you opened it <RelativeTime iso={l.lastUsedAt} timezone={scope.timezone} /></> : ""}</p>
                    </div>
                    <span className="text-[13px] font-medium tabular-nums text-ink-2">{counts[l.id] === null || counts[l.id] === undefined ? "—" : `${counts[l.id]!.toLocaleString("en-US")} ${counts[l.id] === 1 ? "contact" : "contacts"}`}</span>
                    {!scope.readOnly && (
                      <Menu>
                        <MenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${l.name}`}><MoreHorizontal className="size-4" /></Button></MenuTrigger>
                        <MenuContent>
                          <MenuItem onSelect={() => run("pin", () => pinSmartListAction(scope.orgId, l.id, !l.pinned))}>{l.pinned ? <><PinOff className="size-4" />Unpin</> : <><Pin className="size-4" />Pin to the top</>}</MenuItem>
                          <MenuItem onSelect={() => run("dup", () => duplicateSmartListAction(scope.orgId, l.id), "Copied. The copy is private to you.")}><Copy className="size-4" />Duplicate</MenuItem>
                          {editable(l) && <MenuItem onSelect={() => setEditing(l)}><Pencil className="size-4" />Rename and share</MenuItem>}
                          {canShare && l.visibility === "team" && (
                            <MenuItem onSelect={() => run("default", () => setDefaultSmartListAction(scope.orgId, l.isDefault ? null : l.id), l.isDefault ? "Default view cleared." : "Everyone now opens Contacts on this list.")}>
                              <Star className="size-4" />{l.isDefault ? "Stop using as default" : "Make the default view"}
                            </MenuItem>
                          )}
                          {editable(l) && (
                            <>
                              <MenuSeparator />
                              <MenuItem destructive onSelect={() => setDeleting(l)}><Trash2 className="size-4" />Delete</MenuItem>
                            </>
                          )}
                        </MenuContent>
                      </Menu>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {editing && <EditListDialog scope={scope} list={editing} canShare={canShare} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete "${deleting?.name}"?`} description="Only the saved view is removed. No contacts are changed." confirmLabel="Delete list" danger loading={busy("delete")}
        onConfirm={async () => { if (deleting && (await run("delete", () => deleteSmartListAction(scope.orgId, deleting.id), "List deleted."))) setDeleting(null); }} />
    </div>
  );
}

function EditListDialog({ scope, list, canShare, onClose }: { scope: CrmScope; list: SmartListView; canShare: boolean; onClose: () => void }) {
  const { run, busy } = useCrmAction();
  const [name, setName] = React.useState(list.name);
  const [description, setDescription] = React.useState(list.description ?? "");
  const [visibility, setVisibility] = React.useState(list.visibility);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Edit list" size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy("save")} disabled={!name.trim()} onClick={async () => { if (await run("save", () => updateSmartListAction(scope.orgId, list.id, { name, description: description || null, visibility, filter: list.filter }), "List saved.")) onClose(); }}>Save</Button></>}>
      <div className="space-y-3">
        <Field label="Name" htmlFor="sl-name"><Input id="sl-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
        <Field label="Description" htmlFor="sl-desc" optional><Textarea id="sl-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} /></Field>
        <Field label="Who can see it" htmlFor="sl-vis" hint={!canShare ? "Sharing with the team needs the share permission." : undefined}>
          <Select id="sl-vis" value={visibility} onChange={(e) => setVisibility(e.target.value as "private" | "team")} disabled={!canShare && list.visibility === "private"}>
            <option value="private">Only me</option>
            <option value="team">Everyone on the team</option>
          </Select>
        </Field>
        <p className="text-[12.5px] text-muted">To change the filter, open the list in Contacts, adjust it, and save.</p>
      </div>
    </Dialog>
  );
}
