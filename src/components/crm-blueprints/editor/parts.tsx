"use client";

import * as React from "react";
import { AlertCircle, AlertTriangle, ArrowDown, ArrowUp, Hash, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { FIELD_ENTITIES, type FieldEntity } from "@/lib/crm/types";
import type { ValidationIssue } from "@/lib/crm/blueprints/validate";
import {
  ASSET_TYPE_LABELS, BLUEPRINT_FOLDER_KINDS, SECTION_LABELS, SECTION_TYPE, SLOT_KIND_LABELS, refId, toRef, typeOfId,
  type AssetSection, type BlueprintContent, type BlueprintFolderKind, type SlotKind,
} from "@/lib/crm/blueprints/types";
import { validateContent } from "@/lib/crm/blueprints/validate";
import {
  addAsset, issueLocation, keyFromName, keysIn, newAsset, newLogicalId, newSlot, removeAsset, saveBlockers, type AssetReference, type EditorSection, type IssueIndex,
} from "@/components/crm-blueprints/editor/model";

// Pieces every section of the Blueprint editor shares: the editor's context, the list-and-detail layout, issue notes, the add and remove
// dialogs, folder and role pickers, and number inputs that accept typing.

export interface EditorApi {
  content: BlueprintContent;
  /** Applies a change to the working draft (nothing is saved until "Save draft"). */
  edit: (update: (c: BlueprintContent) => BlueprintContent) => void;
  readOnly: boolean;
  issues: IssueIndex;
  /** Opens a section, optionally with one asset selected. */
  open: (section: EditorSection, assetId?: string | null) => void;
  /** The asset selected in each section. */
  selected: Partial<Record<EditorSection, string | null>>;
  select: (section: EditorSection, id: string | null) => void;
  /** Asks before removing an asset (or a stage, appointment type or role), listing what refers to it. */
  remove: (id: string, label: string, after?: () => void) => void;
  /**
   * The editor's own address. The CRM's builders link to CRM screens relative to a base ("<base>/tags"); with this base those links open the
   * matching section of the editor instead.
   */
  linkBase: string;
}

export const EditorContext = React.createContext<EditorApi | null>(null);

export function useEditor(): EditorApi {
  const api = React.useContext(EditorContext);
  if (!api) throw new Error("useEditor outside the Blueprint editor");
  return api;
}

export const FOLDER_KIND_LABELS: Record<BlueprintFolderKind, string> = {
  smart_list: "Smart Lists", tag: "Tags", template: "Message templates", workflow: "Workflows", form: "Forms", calendar: "Calendars", report: "Reports",
};

export const ENTITY_LABELS: Record<FieldEntity, string> = { contact: "Contacts", company: "Companies", opportunity: "Deals" };

/** "" → null for optional texts (kept as typed otherwise, so spaces don't vanish while typing). */
export const orNull = (v: string): string | null => (v === "" ? null : v);

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export function issuesOf(issues: IssueIndex, id: string | null | undefined): ValidationIssue[] {
  return id ? issues.byAsset.get(id) ?? [] : [];
}

/** Issues about a pipeline or calendar itself, without those about its stages or appointment types (shown next to each of them). */
export function ownIssues(issues: IssueIndex, id: string): ValidationIssue[] {
  return issues.located.filter((i) => i.assetId === id && !i.nestedId);
}

/** The problems validation found for one asset, errors first. */
export function IssueNotes({ issues, className }: { issues: readonly ValidationIssue[]; className?: string }) {
  if (!issues.length) return null;
  const sorted = [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  return (
    <ul className={cn("space-y-1.5 rounded-xl border border-line bg-surface-2 p-3", className)} aria-label="Problems with this item">
      {sorted.slice(0, 12).map((i, n) => (
        <li key={`${i.code}-${i.path}-${n}`} className={cn("flex gap-2 text-[12.5px] leading-relaxed", i.severity === "error" ? "text-danger-ink" : "text-warning-ink")}>
          {i.severity === "error" ? <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
          <span><span className="sr-only">{i.severity === "error" ? "Must fix: " : "Check: "}</span>{i.message}</span>
        </li>
      ))}
      {sorted.length > 12 && <li className="text-[12px] text-muted">and {sorted.length - 12} more</li>}
    </ul>
  );
}

export function IssueDot({ issues }: { issues: readonly ValidationIssue[] }) {
  const errors = issues.filter((i) => i.severity === "error").length;
  if (errors) return <span role="img" className="size-2 shrink-0 rounded-full bg-danger" aria-label={`${errors} ${errors === 1 ? "problem" : "problems"} to fix`} />;
  if (issues.length) return <span role="img" className="size-2 shrink-0 rounded-full bg-warning" aria-label={`${issues.length} to check`} />;
  return null;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface WorkspaceItem {
  id: string;
  name: string;
  detail?: React.ReactNode;
  badges?: React.ReactNode;
}

/** A section's assets in a list, the selected one's settings beside it (below it on phones), and the section's own notes on top. */
export function AssetWorkspace({
  section, title, intro, items, addLabel, onAdd, emptyText, children, canReorder, onMove,
}: {
  section: AssetSection | "slots";
  title: string;
  intro: React.ReactNode;
  items: WorkspaceItem[];
  addLabel: string;
  onAdd: () => void;
  emptyText: string;
  children: (id: string) => React.ReactNode;
  canReorder?: boolean;
  onMove?: (index: number, delta: -1 | 1) => void;
}) {
  const { readOnly, issues, selected, select } = useEditor();
  const current = selected[section] && items.some((i) => i.id === selected[section]) ? selected[section]! : items[0]?.id ?? null;
  const detailRef = React.useRef<HTMLDivElement>(null);
  const choose = (id: string) => {
    select(section, id);
    // On phones the settings sit below the list: bring them into view.
    if (window.matchMedia("(max-width: 1023px)").matches) requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-ink">{title}</h2>
          <div className="mt-1 max-w-3xl text-[13px] leading-relaxed text-muted">{intro}</div>
        </div>
        {!readOnly && <Button variant="secondary" onClick={onAdd}><Plus className="size-4" aria-hidden />{addLabel}</Button>}
      </div>
      {!items.length ? (
        <Card className="border-dashed">
          <EmptyState compact title={`No ${title.toLowerCase()} yet`} description={emptyText} action={!readOnly ? <Button onClick={onAdd}><Plus className="size-4" aria-hidden />{addLabel}</Button> : undefined} />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
          <Card className="self-start p-2">
            <ul className="space-y-1" aria-label={title}>
              {items.map((item, i) => {
                const active = item.id === current;
                return (
                  <li key={item.id} className={cn("group flex items-center gap-1 rounded-xl border pr-1 transition-colors", active ? "border-primary/40 bg-primary-soft/40" : "border-transparent hover:border-line")}>
                    <button type="button" onClick={() => choose(item.id)} aria-current={active ? "true" : undefined} className="flex min-h-12 min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-ink">{item.name || <span className="text-faint">Untitled</span>}</span>
                        {item.detail && <span className="block truncate text-[11.5px] text-muted">{item.detail}</span>}
                      </span>
                      {item.badges}
                      <IssueDot issues={issuesOf(issues, item.id)} />
                    </button>
                    {canReorder && onMove && !readOnly && (
                      <span className="flex shrink-0 flex-col">
                        <button type="button" onClick={() => onMove(i, -1)} disabled={i === 0} aria-label={`Move “${item.name}” up`} className="inline-flex size-6 items-center justify-center rounded-md text-muted hover:bg-surface-2 disabled:opacity-30"><ArrowUp className="size-3.5" /></button>
                        <button type="button" onClick={() => onMove(i, 1)} disabled={i === items.length - 1} aria-label={`Move “${item.name}” down`} className="inline-flex size-6 items-center justify-center rounded-md text-muted hover:bg-surface-2 disabled:opacity-30"><ArrowDown className="size-3.5" /></button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
          <div ref={detailRef} className="min-w-0 scroll-mt-24">
            {/* Keyed by the asset, so switching assets starts every input of the settings afresh. */}
            {current ? <React.Fragment key={current}>{children(current)}</React.Fragment> : null}
          </div>
        </div>
      )}
    </div>
  );
}

/** The header of an asset's settings: its name, its logical ID (never changes), and its remove button. */
export function DetailHeader({ id, title, kind, onRemove, children }: { id: string; title: string; kind: string; onRemove?: () => void; children?: React.ReactNode }) {
  const { readOnly } = useEditor();
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4">
      <div className="min-w-0">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-muted">{kind}</p>
        <h3 className="mt-0.5 break-words text-[16px] font-semibold text-ink">{title || "Untitled"}</h3>
        <ReferenceId id={id} />
        {children}
      </div>
      {!readOnly && onRemove && (
        <Button variant="ghost" size="sm" onClick={onRemove}><Trash2 className="size-4" aria-hidden />Remove</Button>
      )}
    </div>
  );
}

/** A logical ID, with why it doesn't follow renames. */
export function ReferenceId({ id }: { id: string }) {
  return (
    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
      <Hash className="size-3.5" aria-hidden />
      <span>Reference</span>
      <code className="break-all rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11.5px] text-ink-2">{id}</code>
      <span className="text-faint">· stays the same when renamed, so everything that uses it keeps working</span>
    </p>
  );
}

export function DetailCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return <Card className={cn("space-y-5 p-4 sm:p-5", className)}>{children}</Card>;
}

export function FieldGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("grid gap-4 sm:grid-cols-2", className)}>{children}</div>;
}

/** A fixed explanation shown at the top of a section (what applying does with it). */
export function SectionNote({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "warning" }) {
  return (
    <p className={cn("rounded-xl border px-3.5 py-2.5 text-[12.5px] leading-relaxed", tone === "warning" ? "border-warning/30 bg-warning-soft text-warning-ink" : "border-line bg-surface-2 text-ink-2")}>
      {children}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * A whole-number input that lets people type freely and only commits a valid number (or null, when `nullable` and cleared). An invalid
 * entry is shown as such and the last valid number stays in the Blueprint.
 */
export function NumberInput({
  id, value, onChange, min, max, nullable, disabled, suffix, ariaLabel, describedBy,
}: {
  id: string;
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  nullable?: boolean;
  disabled?: boolean;
  suffix?: string;
  ariaLabel?: string;
  describedBy?: string;
}) {
  const [text, setText] = React.useState(value === null ? "" : String(value));
  const [last, setLast] = React.useState(value);
  if (value !== last) {
    setLast(value);
    setText(value === null ? "" : String(value));
  }
  const n = Number(text);
  const invalid = text.trim() === "" ? !nullable : !Number.isInteger(n) || (min !== undefined && n < min) || (max !== undefined && n > max);
  return (
    <div className="flex items-center gap-2">
      <Input
        id={id}
        inputMode="numeric"
        value={text}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          if (t.trim() === "") {
            if (nullable) {
              setLast(null);
              onChange(null);
            }
            return;
          }
          const v = Number(t);
          if (Number.isInteger(v) && (min === undefined || v >= min) && (max === undefined || v <= max)) {
            setLast(v);
            onChange(v);
          }
        }}
        className="w-28"
      />
      {suffix && <span className="text-[13px] text-muted">{suffix}</span>}
      {invalid && <span className="text-[12px] text-danger-ink" role="status">{min !== undefined && max !== undefined ? `${min} to ${max}` : "A whole number"}{nullable ? ", or empty" : ""}</span>}
    </div>
  );
}

/** A folder of the right kind, or none. Folders are created in the Folders section. */
export function FolderSelect({ id, kind, value, onChange }: { id: string; kind: BlueprintFolderKind; value: string | null; onChange: (v: string | null) => void }) {
  const { content, readOnly } = useEditor();
  const folders = content.assets.folders.filter((f) => f.kind === kind);
  const missing = value && !folders.some((f) => toRef(f.id) === value);
  return (
    <Field label="Folder" htmlFor={id} optional hint={folders.length ? undefined : `There are no ${FOLDER_KIND_LABELS[kind].toLowerCase()} folders yet. Add one in Folders.`}>
      <Select id={id} value={value ?? ""} disabled={readOnly} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">No folder</option>
        {folders.map((f) => <option key={f.id} value={toRef(f.id)}>{f.name}</option>)}
        {missing && <option value={value!}>{value} (not in this Blueprint)</option>}
      </Select>
    </Field>
  );
}

/** Roles of one kind (people, n8n automations, webhook endpoints), with a way to add a new role on the spot. */
export function SlotSelect({
  id, kind, value, onChange, label, hint, allowNone = true, noneLabel = "Nobody",
}: {
  id: string;
  kind: SlotKind;
  value: string | null;
  onChange: (v: string | null) => void;
  label: string;
  hint?: React.ReactNode;
  allowNone?: boolean;
  noneLabel?: string;
}) {
  const { content, readOnly, edit } = useEditor();
  const slots = content.slots.filter((s) => typeOfId(s.id) === kind);
  const [adding, setAdding] = React.useState(false);
  const missing = value && !slots.some((s) => toRef(s.id) === value);
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <Select id={id} value={value ?? ""} disabled={readOnly} onChange={(e) => onChange(e.target.value || null)}>
            {allowNone && <option value="">{noneLabel}</option>}
            {!allowNone && !value && <option value="">Choose a role…</option>}
            {slots.map((s) => <option key={s.id} value={toRef(s.id)}>{s.label}</option>)}
            {missing && <option value={value!}>{value} (not a role of this Blueprint)</option>}
          </Select>
        </div>
        {!readOnly && <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(true)}><Plus className="size-3.5" aria-hidden />New role</Button>}
      </div>
      <NewSlotDialog open={adding} kind={kind} onClose={() => setAdding(false)} onCreated={(slotId) => onChange(toRef(slotId))} edit={edit} content={content} />
    </Field>
  );
}

/** Several people roles (calendar hosts, notify lists), as removable chips plus a picker. */
export function SlotChips({ id, value, onChange, label, hint, max }: { id: string; value: string[]; onChange: (v: string[]) => void; label: string; hint?: React.ReactNode; max?: number }) {
  const { content, readOnly, edit } = useEditor();
  const slots = content.slots.filter((s) => typeOfId(s.id) === "member");
  const name = (ref: string) => slots.find((s) => toRef(s.id) === ref)?.label ?? `${ref} (not a role of this Blueprint)`;
  const rest = slots.filter((s) => !value.includes(toRef(s.id)));
  const [adding, setAdding] = React.useState(false);
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <div className="space-y-2">
        {value.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label={label}>
            {value.map((ref) => (
              <li key={ref}>
                <Badge tone="outline" className="h-8 gap-1 pr-1">
                  {name(ref)}
                  {!readOnly && (
                    <button type="button" onClick={() => onChange(value.filter((v) => v !== ref))} aria-label={`Remove ${name(ref)}`} className="inline-flex size-6 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink">
                      <Trash2 className="size-3" />
                    </button>
                  )}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        {!readOnly && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <Select id={id} value="" disabled={(max !== undefined && value.length >= max) || !rest.length} onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
                <option value="">{rest.length ? "Add a role…" : slots.length ? "Every role is added" : "No people roles yet"}</option>
                {rest.map((s) => <option key={s.id} value={toRef(s.id)}>{s.label}</option>)}
              </Select>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(true)} disabled={max !== undefined && value.length >= max}><Plus className="size-3.5" aria-hidden />New role</Button>
          </div>
        )}
      </div>
      <NewSlotDialog open={adding} kind="member" onClose={() => setAdding(false)} onCreated={(slotId) => onChange([...value, toRef(slotId)])} edit={edit} content={content} />
    </Field>
  );
}

function NewSlotDialog({ open, kind, onClose, onCreated, edit, content }: { open: boolean; kind: SlotKind; onClose: () => void; onCreated: (id: string) => void; edit: EditorApi["edit"]; content: BlueprintContent }) {
  const [label, setLabel] = React.useState("");
  const [description, setDescription] = React.useState("");
  const idPreview = label.trim() ? newLogicalId(content, kind, { name: label, label }) : null;
  const create = () => {
    if (!label.trim()) return;
    const slot = newSlot(content, kind, label, description.trim() || null);
    edit((c) => ({ ...c, slots: [...c.slots, slot] }));
    onCreated(slot.id);
    setLabel("");
    setDescription("");
    onClose();
  };
  const info = SLOT_KIND_LABELS[kind];
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={`New ${info.label.toLowerCase()} role`}
      description={`${info.description} Each client maps this role to its own after applying.`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={create} disabled={!label.trim()}>Add role</Button></>}
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create(); }}>
        <Field label="Role name" htmlFor={`slot-${kind}-label`} hint={idPreview ? <>Reference <code className="font-mono">{idPreview}</code></> : "For example Closer, Dispatcher or Office manager."}>
          <Input id={`slot-${kind}-label`} value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} autoFocus />
        </Field>
        <Field label="What this role does" htmlFor={`slot-${kind}-desc`} optional>
          <Textarea id={`slot-${kind}-desc`} rows={2} maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Adding an asset
// ---------------------------------------------------------------------------

const UNDERSCORE_KEY = /^[a-z][a-z0-9_]{0,47}$/;
const HYPHEN_KEY = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const MIXED_KEY = /^[a-z0-9](?:[a-z0-9_-]{0,46}[a-z0-9])?$/;
const KEYED: Partial<Record<AssetSection, { label: string; hint: string; pattern: RegExp }>> = {
  customFields: { label: "Field key", hint: "Lower-case letters, numbers and _, starting with a letter. Forms and imports name the field by it.", pattern: UNDERSCORE_KEY },
  customValues: { label: "Value key", hint: "Used in texts as {{custom_values.<key>}}. Lower-case letters, numbers and _, starting with a letter.", pattern: UNDERSCORE_KEY },
  forms: { label: "Form key", hint: "The hosted page's address. Lower-case letters, numbers and hyphens inside.", pattern: HYPHEN_KEY },
  messageTemplates: { label: "Template key", hint: "Lower-case letters, numbers, - and _.", pattern: MIXED_KEY },
  workflows: { label: "Workflow key", hint: "Lower-case letters, numbers, - and _.", pattern: MIXED_KEY },
  reports: { label: "Report key", hint: "Lower-case letters, numbers and hyphens inside.", pattern: HYPHEN_KEY },
};

export interface AddRequest {
  section: AssetSection;
  /** Fixed for the section (folders: none, so a kind is chosen). */
  entities?: Array<"contact" | "company" | "opportunity">;
}

/** Asks for the name (and key, record type or folder kind where the type has one) and shows the reference it will get. */
export function AddAssetDialog({ request, onClose, onCreate }: {
  request: AddRequest | null;
  onClose: () => void;
  onCreate: (input: { name: string; key?: string; entity?: FieldEntity; kind?: BlueprintFolderKind }) => void;
}) {
  const { content } = useEditor();
  const section = request?.section ?? "tags";
  const type = SECTION_TYPE[section];
  const keyed = KEYED[section];
  const [name, setName] = React.useState("");
  const [key, setKey] = React.useState("");
  const [keyTouched, setKeyTouched] = React.useState(false);
  const [entity, setEntity] = React.useState<FieldEntity>("contact");
  const [kind, setKind] = React.useState<BlueprintFolderKind>("tag");
  const [shownFor, setShownFor] = React.useState<AddRequest | null>(null);
  if (request !== shownFor) {
    setShownFor(request);
    setName("");
    setKey("");
    setKeyTouched(false);
    setEntity(request?.entities?.[0] ?? "contact");
    setKind("tag");
  }
  const autoKey = keyed && name.trim() ? keyFromName(type, name, keysIn(content, section, entity)) : "";
  const effectiveKey = keyTouched ? key : autoKey;
  const keyProblem = !keyed || !effectiveKey ? null
    : !keyed.pattern.test(effectiveKey) ? "That key uses characters it can't have."
    : keysIn(content, section, entity).includes(effectiveKey) ? `Another ${ASSET_TYPE_LABELS[SECTION_TYPE[section]]} already uses this key.`
    : null;
  const idPreview = name.trim() ? newLogicalId(content, type, { name, key: effectiveKey || undefined, entity, kind, label: name }) : null;
  const submit = () => {
    if (!name.trim() || keyProblem) return;
    onCreate({ name, key: keyed ? effectiveKey : undefined, entity: request?.entities ? entity : undefined, kind: section === "folders" ? kind : undefined });
  };
  const label = ASSET_TYPE_LABELS[type];
  return (
    <Dialog
      open={!!request}
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={`New ${label}`}
      description={`Added to ${SECTION_LABELS[section]}. Its reference is made from the name once, and stays the same if you rename it later.`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} disabled={!name.trim() || (keyed !== undefined && !effectiveKey.trim()) || !!keyProblem}>Add {label}</Button></>}
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {section === "folders" && (
          <Field label="Holds" htmlFor="add-kind">
            <Select id="add-kind" value={kind} onChange={(e) => setKind(e.target.value as BlueprintFolderKind)}>
              {BLUEPRINT_FOLDER_KINDS.map((k) => <option key={k} value={k}>{FOLDER_KIND_LABELS[k]}</option>)}
            </Select>
          </Field>
        )}
        {request?.entities && (
          <Field label="Record type" htmlFor="add-entity">
            <Select id="add-entity" value={entity} onChange={(e) => setEntity(e.target.value as FieldEntity)}>
              {request.entities.filter((x) => (FIELD_ENTITIES as readonly string[]).includes(x)).map((x) => <option key={x} value={x}>{ENTITY_LABELS[x]}</option>)}
            </Select>
          </Field>
        )}
        <Field label={section === "customFields" || section === "customValues" ? "Label" : "Name"} htmlFor="add-name">
          <Input id="add-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        {keyed && (
          <Field label={keyed.label} htmlFor="add-key" hint={keyed.hint} error={keyProblem}>
            <Input id="add-key" value={effectiveKey} maxLength={48} aria-invalid={keyProblem ? true : undefined} onChange={(e) => { setKeyTouched(true); setKey(e.target.value.toLowerCase()); }} className="font-mono" />
          </Field>
        )}
        <p className="text-[12.5px] text-muted" aria-live="polite">
          {idPreview ? <>Reference: <code className="break-all rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11.5px] text-ink-2">{idPreview}</code></> : "Type a name to see its reference."}
        </p>
      </form>
    </Dialog>
  );
}

/** The add dialog for one section, wired to create the asset (with its new reference) and select it. */
export function useAdder(section: AssetSection, entities?: AddRequest["entities"]) {
  const { content, edit, select } = useEditor();
  const [request, setRequest] = React.useState<AddRequest | null>(null);
  const dialog = (
    <AddAssetDialog
      request={request}
      onClose={() => setRequest(null)}
      onCreate={(input) => {
        const asset = newAsset(content, section, input);
        edit((c) => addAsset(c, section, asset));
        select(section, asset.id);
        setRequest(null);
      }}
    />
  );
  return { open: () => setRequest({ section, entities }), dialog };
}

// ---------------------------------------------------------------------------
// Removing an asset
// ---------------------------------------------------------------------------

export interface RemoveRequest {
  id: string;
  label: string;
  references: AssetReference[];
  after?: () => void;
}

/** Confirms a removal. When other assets use it, they are listed, and their references can be cleared with it. */
export function RemoveAssetDialog({ request, onClose, onRemove }: { request: RemoveRequest | null; onClose: () => void; onRemove: (stripRefs: boolean) => void }) {
  const refs = request?.references ?? [];
  const tokens = refs.filter((r) => r.kind === "token");
  const used = refs.length > 0;
  const { open, content } = useEditor();
  // What clearing the references would leave unsavable (a trigger with no tag left, a step with no template), said before it happens.
  const leftover = React.useMemo(() => {
    if (!request || !used) return [];
    try {
      const after = removeAsset(content, request.id, { stripRefs: true });
      return saveBlockers(validateContent(after).errors).map((i) => ({ ...i, where: issueLocation(i, after) }));
    } catch {
      return [];
    }
  }, [request, used, content]);
  return (
    <Dialog
      open={!!request}
      onOpenChange={(o) => !o && onClose()}
      size={used ? "md" : "sm"}
      title={`Remove “${request?.label ?? ""}”?`}
      description={used
        ? `${refs.length} ${refs.length === 1 ? "item uses" : "items use"} it. Removing it can clear those references too; anything that then needs a new choice is listed under Problems.`
        : "Nothing else in this Blueprint uses it. Nothing is saved until you save the draft."}
      footer={used ? (
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="outline" onClick={() => onRemove(false)}>Remove only</Button>
          <Button variant="danger" onClick={() => onRemove(true)}>Remove and clear references</Button>
        </>
      ) : (
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => onRemove(false)}>Remove</Button>
        </>
      )}
    >
      {used && (
        <div className="space-y-3">
          <ul className="space-y-2" aria-label="Used by">
            {refs.map((r) => (
              <li key={r.assetId} className="rounded-xl border border-line bg-surface-2 px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 text-[13px] font-medium text-ink">{r.name} <span className="font-normal text-muted">· {ASSET_TYPE_LABELS[r.assetType]}</span></span>
                  <button type="button" className="text-[12.5px] font-medium text-primary-ink hover:underline" onClick={() => { onClose(); open(r.section, r.assetId); }}>Open</button>
                </div>
                <p className="mt-0.5 break-words text-[12px] text-muted">{r.places.slice(0, 4).map(placeLabel).join(" · ")}{r.places.length > 4 ? ` · ${r.places.length - 4} more` : ""}</p>
              </li>
            ))}
          </ul>
          {tokens.length > 0 && (
            <p className="text-[12.5px] text-muted">Texts keep their {"{{custom_values…}}"} placeholders either way: a client applying this Blueprint then needs a configuration value with that key of its own.</p>
          )}
          {leftover.length > 0 && (
            <div className="rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-[12.5px] leading-relaxed text-warning-ink">
              <p className="font-medium">Clearing them leaves {leftover.length === 1 ? "a setting" : `${leftover.length} settings`} with nothing chosen, and the draft can&apos;t be saved until {leftover.length === 1 ? "it gets" : "they get"} a new choice:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {leftover.slice(0, 4).map((i, n) => <li key={n}>{refs.find((r) => r.assetId === i.where.assetId)?.name ?? "An item"}: {i.message}</li>)}
              </ul>
            </div>
          )}
          <p className="text-[12.5px] text-muted">“Remove only” leaves the references in place; they show as problems until they point at something again.</p>
        </div>
      )}
    </Dialog>
  );
}

/** "draft.actions.tagIds[0]" → "draft › actions › tag ids". */
function placeLabel(path: string): string {
  if (path.startsWith("{{")) return path;
  return path.replace(/\[\d+\]/g, "").split(".").map((p) => p.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()).join(" › ");
}

/** The name a reference stands for in this Blueprint, or the reference itself when it points at nothing. */
export function refName(content: BlueprintContent, ref: string | null | undefined): string {
  if (!ref) return "";
  const id = refId(ref);
  const slot = content.slots.find((s) => s.id === id);
  if (slot) return slot.label;
  for (const section of Object.keys(content.assets) as AssetSection[]) {
    for (const a of content.assets[section] as Array<{ id: string; name?: string; label?: string; key?: string; stages?: Array<{ id: string; name: string }>; types?: Array<{ id: string; name: string }> }>) {
      if (a.id === id) return a.name ?? a.label ?? a.key ?? id;
      const nested = a.stages?.find((s) => s.id === id) ?? a.types?.find((t) => t.id === id);
      if (nested) return `${a.name}: ${nested.name}`;
    }
  }
  return ref;
}
