"use client";

import * as React from "react";
import Link from "next/link";
import { GitMerge, MoreHorizontal, Pencil, Plus, Search, Tags, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { createTagAction, deleteTagAction, mergeTagsAction, updateTagAction } from "@/app/actions/crm";
import { ConfirmDialog, PageTitle, TagChip, useCrmAction } from "@/components/crm/ui";
import { encodeFilter } from "@/lib/crm/filter-codec";
import { TAG_COLORS } from "@/lib/crm/types";
import type { TagView } from "@/server/crm/tags";
import type { CrmScope } from "@/server/crm/page";

export function TagsManager({ scope, tags }: { scope: CrmScope; tags: TagView[] }) {
  const { run, busy } = useCrmAction();
  const [q, setQ] = React.useState("");
  const [editing, setEditing] = React.useState<TagView | "new" | null>(null);
  const [merging, setMerging] = React.useState<TagView | null>(null);
  const [deleting, setDeleting] = React.useState<TagView | null>(null);
  const canManage = !!scope.can["tags.manage"] && !scope.readOnly;
  const shown = tags.filter((t) => t.name.toLowerCase().includes(q.trim().toLowerCase()));
  const segmentHref = (t: TagView) => `${scope.base}/contacts?f=${encodeFilter({ op: "and", conditions: [{ field: "tags", op: "has_any", value: [t.id] }] })}`;

  return (
    <div>
      <PageTitle
        title="Tags & Segments"
        description="Tags label contacts and companies so you can segment them, trigger automations and build Smart Lists. Names are unique regardless of capitals, so “VIP” and “vip” are one tag."
        actions={canManage ? <Button onClick={() => setEditing("new")}><Plus className="size-4" />New tag</Button> : undefined}
      />
      {tags.length > 8 && (
        <div className="relative mb-3 max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <Input aria-label="Search tags" placeholder="Search tags" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      {!tags.length ? (
        <Card><EmptyState icon={<Tags className="size-5" />} title="No tags yet" description="Create tags here, or add them straight from a contact. Imports and forms can create tags too." action={canManage ? <Button variant="secondary" onClick={() => setEditing("new")}><Plus className="size-4" />Create a tag</Button> : undefined} /></Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-[13px]">
              <thead className="border-b border-line bg-surface-2/60 text-[12px] text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2.5 text-left font-medium">Tag</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Contacts</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Companies</th>
                  <th scope="col" className="w-12 px-3 py-2.5"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {shown.map((t) => (
                  <tr key={t.id} className="hover:bg-surface-2/50">
                    <td className="px-4 py-2.5">
                      <TagChip name={t.name} color={t.color} />
                      {t.description && <p className="mt-1 max-w-md truncate text-[12px] text-muted">{t.description}</p>}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {t.contactCount > 0 && scope.can["contacts.view"] ? <Link href={segmentHref(t)} className="font-medium text-primary hover:underline">{t.contactCount.toLocaleString("en-US")}</Link> : t.contactCount}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{t.companyCount}</td>
                    <td className="px-3 py-2.5 text-right">
                      {canManage && (
                        <Menu>
                          <MenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${t.name}`}><MoreHorizontal className="size-4" /></Button></MenuTrigger>
                          <MenuContent>
                            <MenuItem onSelect={() => setEditing(t)}><Pencil className="size-4" />Edit</MenuItem>
                            {tags.length > 1 && <MenuItem onSelect={() => setMerging(t)}><GitMerge className="size-4" />Merge into another tag</MenuItem>}
                            <MenuSeparator />
                            <MenuItem destructive onSelect={() => setDeleting(t)}><Trash2 className="size-4" />Delete</MenuItem>
                          </MenuContent>
                        </Menu>
                      )}
                    </td>
                  </tr>
                ))}
                {!shown.length && <tr><td colSpan={4} className="px-4 py-6 text-center text-muted">No tags match “{q}”.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {editing && <TagDialog scope={scope} tag={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {merging && <MergeTagDialog scope={scope} source={merging} tags={tags.filter((t) => t.id !== merging.id)} onClose={() => setMerging(null)} />}
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete "${deleting?.name}"?`} confirmLabel="Delete tag" danger loading={busy("delete")}
        description={deleting ? `It's removed from ${deleting.contactCount} ${deleting.contactCount === 1 ? "contact" : "contacts"} and ${deleting.companyCount} ${deleting.companyCount === 1 ? "company" : "companies"}. Smart Lists and automations that use it will no longer match on it.` : undefined}
        onConfirm={async () => { if (deleting && (await run("delete", () => deleteTagAction(scope.orgId, deleting.id), "Tag deleted."))) setDeleting(null); }} />
    </div>
  );
}

function TagDialog({ scope, tag, onClose }: { scope: CrmScope; tag: TagView | null; onClose: () => void }) {
  const { run, busy } = useCrmAction();
  const [name, setName] = React.useState(tag?.name ?? "");
  const [color, setColor] = React.useState<string>(tag?.color ?? TAG_COLORS[1]);
  const [description, setDescription] = React.useState(tag?.description ?? "");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={tag ? "Edit tag" : "New tag"} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy("save")} disabled={!name.trim()} onClick={async () => {
        const input = { name: name.trim(), color, description: description.trim() || null };
        const ok = tag ? await run("save", () => updateTagAction(scope.orgId, tag.id, input), "Tag saved.") : await run("save", () => createTagAction(scope.orgId, input), "Tag created.");
        if (ok) onClose();
      }}>{tag ? "Save" : "Create tag"}</Button></>}>
      <div className="space-y-3">
        <Field label="Name" htmlFor="tg-name"><Input id="tg-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus /></Field>
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-ink">Colour</p>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Colour">
            {TAG_COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} onClick={() => setColor(c)} className={cn("size-8 rounded-full sm:size-7", color === c && "ring-2 ring-primary ring-offset-2")} style={{ background: c }} />
            ))}
          </div>
        </div>
        <Field label="What it means" htmlFor="tg-desc" optional><Textarea id="tg-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} /></Field>
        {name.trim() && <p className="text-[12.5px] text-muted">Preview: <TagChip name={name.trim()} color={color} /></p>}
      </div>
    </Dialog>
  );
}

function MergeTagDialog({ scope, source, tags, onClose }: { scope: CrmScope; source: TagView; tags: TagView[]; onClose: () => void }) {
  const { run, busy } = useCrmAction();
  const [target, setTarget] = React.useState(tags[0]?.id ?? "");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Merge "${source.name}"`} description="Everyone tagged with it gets the tag you choose instead, and this tag is removed. This can't be undone." size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy("merge")} disabled={!target} onClick={async () => { if (await run("merge", () => mergeTagsAction(scope.orgId, target, [source.id]), (r) => `Merged. ${r.moved} records moved.`)) onClose(); }}>Merge</Button></>}>
      <Field label="Merge into" htmlFor="tm-target">
        <Select id="tm-target" value={target} onChange={(e) => setTarget(e.target.value)}>
          {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
      </Field>
    </Dialog>
  );
}
