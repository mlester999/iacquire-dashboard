"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { FIELD_TYPE_LABELS, FIELD_TYPES, type FieldType } from "@/lib/crm/types";
import {
  BLUEPRINT_INDUSTRIES, BLUEPRINT_INDUSTRY_LABELS, CUSTOM_VALUE_TYPES, SLOT_KINDS, SLOT_KIND_LABELS, toRef, typeOfId,
  type BlueprintIndustry, type CustomFieldAsset, type CustomValueType, type SlotKind,
} from "@/lib/crm/blueprints/types";
import { modulesOf, totalAssets } from "@/lib/crm/blueprints/requirements";
import { slotUsage } from "@/lib/crm/blueprints/refs";
import { keysIn, moveItem, newLogicalId, newSlot, renameValueKey, updateAsset } from "@/components/crm-blueprints/editor/model";
import {
  AssetWorkspace, DetailCard, DetailHeader, ENTITY_LABELS, FOLDER_KIND_LABELS, FieldGrid, FolderSelect, IssueNotes, issuesOf, orNull, refName, useAdder, useEditor,
} from "@/components/crm-blueprints/editor/parts";
import { ColorPicker, KeyInput, ToggleRow } from "@/components/crm-blueprints/editor/inputs";

const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,47}$/;
const CUSTOM_VALUE_TYPE_LABELS: Record<CustomValueType, string> = { text: "Text", url: "Web address", phone: "Phone number", email: "Email address", number: "Number", color: "Colour" };

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

/** The Blueprint's own details: what the library card and every client's application record show. */
export function DetailsSection({ blueprintKey }: { blueprintKey: string }) {
  const { content, edit, readOnly, issues } = useEditor();
  const b = content.blueprint;
  const setMeta = (patch: Partial<typeof b>) => edit((c) => ({ ...c, blueprint: { ...c.blueprint, ...patch } }));
  const modules = modulesOf(content);
  const detailIssues = issues.located.filter((i) => i.section === "details");
  const total = totalAssets(content);
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-ink">Details</h2>
        <p className="mt-1 max-w-3xl text-[14px] leading-relaxed text-muted">
          What this Blueprint is called and who it is for. A Blueprint holds configuration only: it never carries contacts, deals, messages,
          appointments, connected accounts, credentials or anyone&apos;s personal details.
        </p>
      </div>
      <DetailCard>
        <IssueNotes issues={detailIssues} />
        <FieldGrid>
          <Field label="Name" htmlFor="bp-name">
            <Input id="bp-name" value={b.name} maxLength={80} disabled={readOnly} onChange={(e) => setMeta({ name: e.target.value })} />
          </Field>
          <Field label="Industry" htmlFor="bp-industry">
            <Select id="bp-industry" value={b.industry} disabled={readOnly} onChange={(e) => setMeta({ industry: e.target.value as BlueprintIndustry })}>
              {BLUEPRINT_INDUSTRIES.map((i) => <option key={i} value={i}>{BLUEPRINT_INDUSTRY_LABELS[i]}</option>)}
            </Select>
          </Field>
        </FieldGrid>
        <Field label="Description" htmlFor="bp-description" optional hint="Shown on the library card and to the agency when choosing a Blueprint.">
          <Textarea id="bp-description" rows={3} maxLength={1000} value={b.description} disabled={readOnly} onChange={(e) => setMeta({ description: e.target.value })} />
        </Field>
        <FieldGrid>
          <Field label="Default currency for new deals" htmlFor="bp-currency" optional hint="A three-letter code such as USD. Empty keeps each client's own currency.">
            <Input
              id="bp-currency" value={content.settings.defaultCurrency ?? ""} maxLength={3} disabled={readOnly} className="w-28 uppercase"
              onChange={(e) => edit((c) => ({ ...c, settings: { ...c.settings, defaultCurrency: orNull(e.target.value.toUpperCase().replace(/[^A-Z]/g, "")) } }))}
            />
          </Field>
          <Field label="Library key" htmlFor="bp-key" hint="Identifies this Blueprint in exported packages and in each client's application history. It doesn't change.">
            <Input id="bp-key" value={blueprintKey} readOnly className="font-mono" />
          </Field>
        </FieldGrid>
      </DetailCard>
      <DetailCard>
        <h3 className="text-[14px] font-semibold text-ink">What it contains</h3>
        {modules.length ? (
          <ul className="flex flex-wrap gap-1.5" aria-label="Contents">
            {modules.map((m) => <li key={m.section}><Badge tone="outline">{m.label}: {m.count}</Badge></li>)}
          </ul>
        ) : (
          <p className="text-[14px] text-muted">Nothing yet. Add tags, fields, pipelines and the rest from the sections in the menu.</p>
        )}
        <p className="text-[13px] text-muted">{total} {total === 1 ? "item" : "items"} and {content.slots.length} {content.slots.length === 1 ? "role" : "roles"} in this draft.</p>
      </DetailCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Roles (mapping slots)
// ---------------------------------------------------------------------------

/** People and connections the Blueprint names as roles; each client maps them to its own people, n8n workflows and webhook endpoints. */
export function SlotsSection() {
  const { content, edit, readOnly, remove, select } = useEditor();
  const use = React.useMemo(() => slotUsage(content), [content]);
  const [adding, setAdding] = React.useState(false);
  const items = content.slots.map((s) => {
    const kind = typeOfId(s.id) as SlotKind;
    const n = (use[s.id] ?? []).length;
    return { id: s.id, name: s.label, detail: `${SLOT_KIND_LABELS[kind]?.label ?? "Role"} · ${n ? `used by ${n}` : "not used yet"}` };
  });
  return (
    <>
      <AssetWorkspace
        section="slots"
        title="Roles"
        intro={<>Blueprints never carry people or connected accounts. Where a setting names someone (a calendar host, an assignee, someone to notify) or a connection (an n8n automation, a webhook endpoint), it names a role, and each client maps the role to its own after applying.</>}
        items={items}
        addLabel="Add role"
        onAdd={() => setAdding(true)}
        emptyText="Add a role when a setting should name a person or a connection."
      >
        {(id) => {
          const s = content.slots.find((x) => x.id === id)!;
          const users = use[id] ?? [];
          const kind = typeOfId(s.id) as SlotKind;
          const set = (patch: Partial<typeof s>) => edit((c) => ({ ...c, slots: c.slots.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
          return (
            <DetailCard>
              <DetailHeader id={s.id} title={s.label} kind={SLOT_KIND_LABELS[kind]?.label ?? "Role"} onRemove={() => remove(s.id, s.label)} />
              <p className="text-[13px] text-muted">{SLOT_KIND_LABELS[kind]?.description}</p>
              <Field label="Role name" htmlFor="slot-label"><Input id="slot-label" value={s.label} maxLength={80} disabled={readOnly} onChange={(e) => set({ label: e.target.value })} /></Field>
              <Field label="What this role does" htmlFor="slot-desc" optional hint="Helps whoever maps it in a client's workspace pick the right person or connection.">
                <Textarea id="slot-desc" rows={2} maxLength={300} value={s.description ?? ""} disabled={readOnly} onChange={(e) => set({ description: orNull(e.target.value) })} />
              </Field>
              <div>
                <h4 className="text-[14px] font-semibold text-ink">Used by</h4>
                {users.length ? (
                  <ul className="mt-1.5 flex flex-wrap gap-1.5">{users.map((u) => <li key={u}><Badge tone="outline">{refName(content, toRef(u))}</Badge></li>)}</ul>
                ) : (
                  <p className="mt-1 text-[13px] text-muted">Nothing uses this role yet.</p>
                )}
              </div>
            </DetailCard>
          );
        }}
      </AssetWorkspace>
      <AddSlotDialog
        open={adding}
        onClose={() => setAdding(false)}
        onCreate={(kind, label, description) => {
          const slot = newSlot(content, kind, label, description);
          edit((c) => ({ ...c, slots: [...c.slots, slot] }));
          select("slots", slot.id);
          setAdding(false);
        }}
      />
    </>
  );
}

function AddSlotDialog({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (kind: SlotKind, label: string, description: string | null) => void }) {
  const { content } = useEditor();
  const [kind, setKind] = React.useState<SlotKind>("member");
  const [label, setLabel] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setKind("member");
      setLabel("");
      setDescription("");
    }
  }
  const preview = label.trim() ? newLogicalId(content, kind, { name: label, label }) : null;
  const submit = () => label.trim() && onCreate(kind, label, description.trim() || null);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title="New role"
      description="Each client maps a role to its own person or connection after applying. Nothing personal is stored in the Blueprint."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} disabled={!label.trim()}>Add role</Button></>}
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Field label="Kind" htmlFor="slot-kind" hint={SLOT_KIND_LABELS[kind].description}>
          <Select id="slot-kind" value={kind} onChange={(e) => setKind(e.target.value as SlotKind)}>
            {SLOT_KINDS.map((k) => <option key={k} value={k}>{SLOT_KIND_LABELS[k].label}</option>)}
          </Select>
        </Field>
        <Field label="Role name" htmlFor="slot-new-label" hint={preview ? <>Reference <code className="font-mono">{preview}</code></> : "For example Closer, Dispatcher, Lead sync or Accounting export."}>
          <Input id="slot-new-label" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} autoFocus />
        </Field>
        <Field label="What this role does" htmlFor="slot-new-desc" optional>
          <Textarea id="slot-new-desc" rows={2} maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export function FoldersSection() {
  const { content, edit, readOnly, remove, issues } = useEditor();
  const add = useAdder("folders");
  const items = content.assets.folders.map((f) => ({ id: f.id, name: f.name, detail: FOLDER_KIND_LABELS[f.kind] }));
  return (
    <>
      <AssetWorkspace
        section="folders"
        title="Folders"
        intro="Folders only organize a client's lists, tags, templates, forms, workflows, calendars and reports. They never change who can see anything."
        items={items}
        addLabel="Add folder"
        onAdd={add.open}
        emptyText="Add folders to keep a client's CRM tidy from the start."
      >
        {(id) => {
          const f = content.assets.folders.find((x) => x.id === id)!;
          const used = content.assets.tags.some((t) => t.folder === toRef(f.id)) || [...content.assets.smartLists, ...content.assets.forms, ...content.assets.messageTemplates, ...content.assets.workflows, ...content.assets.calendars, ...content.assets.reports].some((a) => a.folder === toRef(f.id));
          return (
            <DetailCard>
              <DetailHeader id={f.id} title={f.name} kind="Folder" onRemove={() => remove(f.id, f.name)} />
              <FieldGrid>
                <Field label="Name" htmlFor="folder-name"><Input id="folder-name" value={f.name} maxLength={80} disabled={readOnly} onChange={(e) => edit((c) => updateAsset(c, "folders", id, (x) => ({ ...x, name: e.target.value })))} /></Field>
                <Field label="Holds" htmlFor="folder-kind" hint={used ? "Items are filed in it, so what it holds can't change. Make a new folder instead." : undefined}>
                  <Select id="folder-kind" value={f.kind} disabled={readOnly || used} onChange={(e) => edit((c) => updateAsset(c, "folders", id, (x) => ({ ...x, kind: e.target.value as typeof f.kind })))}>
                    {Object.entries(FOLDER_KIND_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                  </Select>
                </Field>
              </FieldGrid>
              <IssueNotes issues={issuesOf(issues, f.id)} />
            </DetailCard>
          );
        }}
      </AssetWorkspace>
      {add.dialog}
    </>
  );
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export function TagsSection() {
  const { content, edit, readOnly, remove, issues } = useEditor();
  const add = useAdder("tags");
  const items = content.assets.tags.map((t) => ({ id: t.id, name: t.name, badges: <i className="size-2.5 shrink-0 rounded-full" style={{ background: t.color }} aria-hidden /> }));
  return (
    <>
      <AssetWorkspace section="tags" title="Tags" intro="Tags a client starts with. A tag that already exists in a client's CRM (same name) is reused, never duplicated." items={items} addLabel="Add tag" onAdd={add.open} emptyText="Add the tags this kind of business uses to sort its leads and customers.">
        {(id) => {
          const t = content.assets.tags.find((x) => x.id === id)!;
          const set = (patch: Partial<typeof t>) => edit((c) => updateAsset(c, "tags", id, (x) => ({ ...x, ...patch })));
          return (
            <DetailCard>
              <DetailHeader id={t.id} title={t.name} kind="Tag" onRemove={() => remove(t.id, t.name)} />
              <IssueNotes issues={issuesOf(issues, t.id)} />
              <FieldGrid>
                <Field label="Name" htmlFor="tag-name"><Input id="tag-name" value={t.name} maxLength={60} disabled={readOnly} onChange={(e) => set({ name: e.target.value })} /></Field>
                <FolderSelect id="tag-folder" kind="tag" value={t.folder} onChange={(folder) => set({ folder })} />
              </FieldGrid>
              <Field label="Colour" htmlFor="tag-color"><ColorPicker id="tag-color" label="Tag colour" value={t.color} disabled={readOnly} onChange={(v) => v && set({ color: v })} /></Field>
              <Field label="Description" htmlFor="tag-desc" optional><Textarea id="tag-desc" rows={2} maxLength={300} value={t.description ?? ""} disabled={readOnly} onChange={(e) => set({ description: orNull(e.target.value) })} /></Field>
            </DetailCard>
          );
        }}
      </AssetWorkspace>
      {add.dialog}
    </>
  );
}

// ---------------------------------------------------------------------------
// Custom fields
// ---------------------------------------------------------------------------

export function CustomFieldsSection() {
  const { content, edit, readOnly, remove, issues } = useEditor();
  const add = useAdder("customFields", ["contact", "company", "opportunity"]);
  const items = content.assets.customFields.map((f) => ({ id: f.id, name: f.label, detail: `${ENTITY_LABELS[f.entity]} · ${FIELD_TYPE_LABELS[f.type]}` }));
  return (
    <>
      <AssetWorkspace
        section="customFields"
        title="Custom fields"
        intro="Extra fields on contacts, companies and deals. A field with the same key already in a client's CRM is reused (an archived one is restored); a change of type is never made without a decision."
        items={items}
        addLabel="Add field"
        onAdd={add.open}
        emptyText="Add the details this kind of business records about its customers."
      >
        {(id) => {
          const f = content.assets.customFields.find((x) => x.id === id)!;
          const set = (patch: Partial<CustomFieldAsset>) => edit((c) => updateAsset(c, "customFields", id, (x) => ({ ...x, ...patch })));
          const choice = f.type === "select" || f.type === "multiselect";
          const setType = (type: FieldType) => {
            const nextChoice = type === "select" || type === "multiselect";
            set({ type, options: nextChoice ? (f.options.length ? f.options : [{ value: "option_1", label: "Option 1" }]) : [] });
          };
          const taken = keysIn(content, "customFields", f.entity).filter((k) => k !== f.key);
          return (
            <DetailCard>
              <DetailHeader id={f.id} title={f.label} kind={`${ENTITY_LABELS[f.entity]} field`} onRemove={() => remove(f.id, f.label)} />
              <IssueNotes issues={issuesOf(issues, f.id)} />
              <FieldGrid>
                <Field label="Label" htmlFor="cf-label"><Input id="cf-label" value={f.label} maxLength={80} disabled={readOnly} onChange={(e) => set({ label: e.target.value })} /></Field>
                <Field label="Key" htmlFor="cf-key" hint="How a client's CRM recognises this field. Forms and workflows in this Blueprint follow it automatically.">
                  <KeyInput id="cf-key" value={f.key} pattern={FIELD_KEY_RE} taken={taken} disabled={readOnly} invalidText="Lower-case letters, numbers and _, starting with a letter (48 at most)." onCommit={(key) => set({ key })} />
                </Field>
                <Field label="Type" htmlFor="cf-type">
                  <Select id="cf-type" value={f.type} disabled={readOnly} onChange={(e) => setType(e.target.value as FieldType)}>
                    {FIELD_TYPES.map((t) => <option key={t} value={t}>{FIELD_TYPE_LABELS[t]}</option>)}
                  </Select>
                </Field>
                <Field label="Group" htmlFor="cf-group" optional hint="Fields with the same group are shown together.">
                  <Input id="cf-group" value={f.groupName ?? ""} maxLength={60} disabled={readOnly} onChange={(e) => set({ groupName: orNull(e.target.value) })} />
                </Field>
              </FieldGrid>
              <Field label="Help text" htmlFor="cf-help" optional><Input id="cf-help" value={f.helpText ?? ""} maxLength={200} disabled={readOnly} onChange={(e) => set({ helpText: orNull(e.target.value) })} /></Field>
              <ToggleRow id="cf-required" label="Required" hint="People must fill it in when they edit a record by hand." checked={f.required} disabled={readOnly} onChange={(required) => set({ required })} />
              {choice && <OptionsEditor options={f.options} onChange={(options) => set({ options })} readOnly={readOnly} />}
            </DetailCard>
          );
        }}
      </AssetWorkspace>
      {add.dialog}
    </>
  );
}

function OptionsEditor({ options, onChange, readOnly }: { options: CustomFieldAsset["options"]; onChange: (o: CustomFieldAsset["options"]) => void; readOnly: boolean }) {
  const setAt = (i: number, patch: Partial<CustomFieldAsset["options"][number]>) => onChange(options.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  const addOption = () => {
    const taken = new Set(options.map((o) => o.value));
    let n = options.length + 1;
    while (taken.has(`option_${n}`)) n++;
    onChange([...options, { value: `option_${n}`, label: `Option ${n}` }]);
  };
  return (
    <fieldset className="space-y-2">
      <legend className="text-[14px] font-medium text-ink-2">Choices</legend>
      <p className="text-[13px] text-muted">The value is what is stored and what filters compare; the label is what people see. Adding choices later is a compatible update; removing or renaming a value is not.</p>
      <ol className="space-y-2">
        {options.map((o, i) => (
          <li key={i} className="grid gap-2 rounded-xl border border-line p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center">
            <Input aria-label={`Choice ${i + 1} label`} value={o.label} maxLength={80} disabled={readOnly} onChange={(e) => setAt(i, { label: e.target.value })} placeholder="Label" />
            <Input aria-label={`Choice ${i + 1} value`} value={o.value} maxLength={60} disabled={readOnly} onChange={(e) => setAt(i, { value: e.target.value })} placeholder="Stored value" className="font-mono" />
            {!readOnly && (
              <span className="flex items-center gap-1">
                <Button variant="ghost" size="icon-sm" onClick={() => onChange(moveItem(options, i, -1))} disabled={i === 0} aria-label={`Move choice ${o.label} up`}>↑</Button>
                <Button variant="ghost" size="icon-sm" onClick={() => onChange(moveItem(options, i, 1))} disabled={i === options.length - 1} aria-label={`Move choice ${o.label} down`}>↓</Button>
                <Button variant="ghost" size="icon-sm" onClick={() => onChange(options.filter((_, j) => j !== i))} disabled={options.length <= 1} aria-label={`Remove choice ${o.label}`}><Trash2 className="size-4" /></Button>
              </span>
            )}
          </li>
        ))}
      </ol>
      {!readOnly && <Button variant="secondary" size="sm" onClick={addOption} disabled={options.length >= 100}><Plus className="size-3.5" aria-hidden />Add choice</Button>}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Configuration values
// ---------------------------------------------------------------------------

export function CustomValuesSection() {
  const { content, edit, readOnly, remove, issues } = useEditor();
  const add = useAdder("customValues");
  const items = content.assets.customValues.map((v) => ({ id: v.id, name: v.label, detail: `{{custom_values.${v.key}}}`, badges: v.required && !v.value.trim() ? <Badge tone="warning" className="h-5 px-1.5 text-[12px]">to fill in</Badge> : undefined }));
  return (
    <>
      <AssetWorkspace
        section="customValues"
        title="Configuration values"
        intro={<>Business details texts use as <code className="font-mono">{"{{custom_values.<key>}}"}</code>: opening hours, an address, a booking link. Each client fills in its own. Never put a password, key or token here.</>}
        items={items}
        addLabel="Add value"
        onAdd={add.open}
        emptyText="Add the details message templates and workflows refer to, so each client fills them in once."
      >
        {(id) => {
          const v = content.assets.customValues.find((x) => x.id === id)!;
          const set = (patch: Partial<typeof v>) => edit((c) => updateAsset(c, "customValues", id, (x) => ({ ...x, ...patch })));
          const taken = keysIn(content, "customValues").filter((k) => k !== v.key);
          return (
            <DetailCard>
              <DetailHeader id={v.id} title={v.label} kind="Configuration value" onRemove={() => remove(v.id, v.label)} />
              <IssueNotes issues={issuesOf(issues, v.id)} />
              <FieldGrid>
                <Field label="Label" htmlFor="cv-label"><Input id="cv-label" value={v.label} maxLength={80} disabled={readOnly} onChange={(e) => set({ label: e.target.value })} /></Field>
                <Field label="Key" htmlFor="cv-key" hint="Changing it updates every template and workflow text in this Blueprint that uses it.">
                  <KeyInput id="cv-key" value={v.key} pattern={FIELD_KEY_RE} taken={taken} disabled={readOnly} invalidText="Lower-case letters, numbers and _, starting with a letter (48 at most)." onCommit={(key) => edit((c) => renameValueKey(c, id, key))} />
                </Field>
                <Field label="Type" htmlFor="cv-type">
                  <Select id="cv-type" value={v.type} disabled={readOnly} onChange={(e) => set({ type: e.target.value as CustomValueType })}>
                    {CUSTOM_VALUE_TYPES.map((t) => <option key={t} value={t}>{CUSTOM_VALUE_TYPE_LABELS[t]}</option>)}
                  </Select>
                </Field>
                <Field label="Group" htmlFor="cv-group" optional><Input id="cv-group" value={v.groupName ?? ""} maxLength={60} disabled={readOnly} onChange={(e) => set({ groupName: orNull(e.target.value) })} /></Field>
              </FieldGrid>
              <Field label="Starting value" htmlFor="cv-value" optional hint="An example or a default every client starts with. Leave it empty when each business must enter its own.">
                <Textarea id="cv-value" rows={2} maxLength={2000} value={v.value} disabled={readOnly} onChange={(e) => set({ value: e.target.value })} />
              </Field>
              <ToggleRow id="cv-required" label="Each client must fill this in" hint="Messages that use it are held until it has a value, and the client's setup checklist asks for it." checked={v.required} disabled={readOnly} onChange={(required) => set({ required })} />
            </DetailCard>
          );
        }}
      </AssetWorkspace>
      {add.dialog}
    </>
  );
}
