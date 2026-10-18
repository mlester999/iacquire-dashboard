"use client";

import * as React from "react";
import { FolderPlus, Pencil, Trash2 } from "lucide-react";
import { createLibraryFolderAction, deleteLibraryFolderAction, renameLibraryFolderAction, updateBlueprintDetailsAction } from "@/app/actions/crm-blueprints";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Field, Input, Select } from "@/components/ui/primitives";
import type { BlueprintFolderView, BlueprintSummary } from "@/lib/crm/blueprints/views";
import { useBlueprintAction, useResetOnOpen } from "@/components/crm-blueprints/shared";

const MAX = 60;

/** Library folders: create, rename, delete. Folders only organize the library; deleting one leaves its Blueprints unfiled. */
export function FoldersDialog({ open, onOpenChange, folders, preview }: { open: boolean; onOpenChange: (o: boolean) => void; folders: BlueprintFolderView[]; preview?: boolean }) {
  const { run, busy } = useBlueprintAction(preview);
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  const [confirming, setConfirming] = React.useState<string | null>(null);
  useResetOnOpen(open, () => {
    setName("");
    setError(null);
    setEditing(null);
    setConfirming(null);
  });
  const taken = (n: string, except?: string) => folders.some((f) => f.id !== except && f.name.trim().toLowerCase() === n.trim().toLowerCase());

  const create = async () => {
    const n = name.trim();
    if (!n) return setError("Give the folder a name.");
    if (taken(n)) return setError("A folder with that name already exists.");
    setError(null);
    if (await run("folder-new", () => createLibraryFolderAction(n), "Folder created.")) setName("");
  };
  const rename = async (id: string) => {
    const n = draft.trim();
    if (!n || taken(n, id)) return;
    if (await run(`folder-rename-${id}`, () => renameLibraryFolderAction(id, n), "Folder renamed.")) setEditing(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="md" title="Library folders" description="Folders organize the library for your team. They never change what a Blueprint contains or who can use it.">
      <div className="space-y-5">
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <Field label="New folder" htmlFor="bp-folder-new" error={error} className="flex-1">
            <Input id="bp-folder-new" value={name} maxLength={MAX} onChange={(e) => setName(e.target.value)} placeholder="e.g. Home services" aria-invalid={Boolean(error)} />
          </Field>
          <Button type="submit" variant="secondary" loading={busy("folder-new")}><FolderPlus className="size-4" /> Add</Button>
        </form>
        {folders.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-muted">No folders yet. Blueprints without a folder show as Unfiled.</p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line" aria-label="Folders">
            {folders.map((f) => (
              <li key={f.id} className="px-4 py-2.5">
                {editing === f.id ? (
                  <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void rename(f.id); }}>
                    <Input aria-label={`New name for ${f.name}`} autoFocus value={draft} maxLength={MAX} onChange={(e) => setDraft(e.target.value)} aria-invalid={taken(draft, f.id) || !draft.trim()} />
                    <Button type="submit" size="sm" loading={busy(`folder-rename-${f.id}`)} disabled={!draft.trim() || taken(draft, f.id)}>Save</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                  </form>
                ) : confirming === f.id ? (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[13px] text-ink">Delete “{f.name}”? {f.count ? `${f.count} ${f.count === 1 ? "Blueprint becomes" : "Blueprints become"} unfiled.` : "It is empty."}</p>
                    <div className="flex gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>Keep</Button>
                      <Button size="sm" variant="danger" loading={busy(`folder-delete-${f.id}`)} onClick={() => void run(`folder-delete-${f.id}`, () => deleteLibraryFolderAction(f.id), "Folder deleted.").then((r) => r && setConfirming(null))}>Delete folder</Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{f.name}</p>
                    <span className="text-[12px] tabular-nums text-muted">{f.count} {f.count === 1 ? "Blueprint" : "Blueprints"}</span>
                    <Button size="icon-sm" variant="ghost" aria-label={`Rename ${f.name}`} onClick={() => { setEditing(f.id); setDraft(f.name); setConfirming(null); }}><Pencil className="size-3.5" /></Button>
                    <Button size="icon-sm" variant="ghost" aria-label={`Delete ${f.name}`} onClick={() => { setConfirming(f.id); setEditing(null); }}><Trash2 className="size-3.5" /></Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

/** Moves one Blueprint to a folder (or out of every folder). */
export function MoveToFolderDialog({ blueprint, folders, onClose, preview }: { blueprint: BlueprintSummary | null; folders: BlueprintFolderView[]; onClose: () => void; preview?: boolean }) {
  const { run, busy } = useBlueprintAction(preview);
  const [folderId, setFolderId] = React.useState("");
  useResetOnOpen(Boolean(blueprint), () => setFolderId(blueprint?.folderId ?? ""));
  if (!blueprint) return null;
  const save = async () => {
    if (await run("move", () => updateBlueprintDetailsAction(blueprint.id, { folderId: folderId || null }), folderId ? "Moved to the folder." : "Moved out of its folder.")) onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="sm" title={`Move “${blueprint.name}”`} description="Only the library's organization changes."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy("move")} disabled={(blueprint.folderId ?? "") === folderId} onClick={() => void save()}>Move</Button></>}>
      <Field label="Folder" htmlFor="bp-move-folder">
        <Select id="bp-move-folder" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
          <option value="">Unfiled</option>
          {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </Select>
      </Field>
    </Dialog>
  );
}
