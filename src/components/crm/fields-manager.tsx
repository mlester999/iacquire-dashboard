"use client";

import * as React from "react";
import Link from "next/link";
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Pencil, Plus, TextCursorInput } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog, Switch } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { archiveFieldAction, createFieldAction, reorderFieldsAction, updateFieldAction } from "@/app/actions/crm";
import { PageTitle, useCrmAction } from "@/components/crm/ui";
import { FIELD_TYPE_LABELS, FIELD_TYPES, type FieldEntity, type FieldType } from "@/lib/crm/types";
import type { CustomFieldView } from "@/server/crm/fields";
import type { CrmScope } from "@/server/crm/page";

const ENTITY_LABEL: Record<FieldEntity, string> = { contact: "Contacts", company: "Companies", opportunity: "Opportunities" };

export function FieldsManager({ scope, entity, fields, entities }: { scope: CrmScope; entity: FieldEntity; fields: CustomFieldView[]; entities: FieldEntity[] }) {
  const { run, busy } = useCrmAction();
  const [editing, setEditing] = React.useState<CustomFieldView | "new" | null>(null);
  const [showArchived, setShowArchived] = React.useState(false);
  const canManage = !!scope.can["fields.manage"] && !scope.readOnly;
  const active = fields.filter((f) => !f.archived);
  const archived = fields.filter((f) => f.archived);

  async function move(index: number, delta: -1 | 1) {
    const ids = active.map((f) => f.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    await run("reorder", () => reorderFieldsAction(scope.orgId, entity, ids));
  }

  return (
    <div>
      <PageTitle
        title="Custom Fields"
        description="Extra details your business tracks, like property type or budget. Values are checked against each field's type, so a date is always a date."
        actions={canManage ? <Button onClick={() => setEditing("new")}><Plus className="size-4" />New field</Button> : undefined}
      />
      <nav aria-label="Record type" className="mb-4 flex gap-1">
        {entities.map((e) => (
          <Link key={e} href={`${scope.base}/fields${e === "contact" ? "" : `?entity=${e}`}`} aria-current={e === entity ? "page" : undefined}
            className={cn("inline-flex min-h-11 items-center rounded-xl px-3.5 text-[13.5px] font-medium sm:min-h-9", e === entity ? "bg-surface text-ink shadow-soft ring-1 ring-line" : "text-muted hover:text-ink")}>
            {ENTITY_LABEL[e]}
          </Link>
        ))}
      </nav>

      {!active.length ? (
        <Card><EmptyState icon={<TextCursorInput className="size-5" />} title={`No custom fields for ${ENTITY_LABEL[entity].toLowerCase()} yet`} description="Add the details you want to capture on every record. They show on record pages, forms, imports, filters and exports." action={canManage ? <Button variant="secondary" onClick={() => setEditing("new")}><Plus className="size-4" />Add a field</Button> : undefined} /></Card>
      ) : (
        <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
          {active.map((f, i) => (
            <li key={f.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-medium text-ink">
                  {f.label}
                  <Badge tone="neutral">{FIELD_TYPE_LABELS[f.type]}</Badge>
                  {f.required && <Badge tone="warning">Required</Badge>}
                  {f.groupName && <span className="text-[12px] font-normal text-muted">in {f.groupName}</span>}
                </p>
                <p className="mt-0.5 truncate text-[12px] text-muted">
                  <code className="rounded bg-surface-2 px-1 py-0.5 text-[12px]">{f.key}</code>
                  {f.options.length ? ` · ${f.options.map((o) => o.label).join(", ")}` : ""}
                  {` · ${f.valueCount.toLocaleString("en-US")} ${f.valueCount === 1 ? "record has" : "records have"} a value`}
                </p>
              </div>
              {canManage && (
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon-sm" aria-label={`Move ${f.label} up`} disabled={i === 0 || busy("reorder")} onClick={() => move(i, -1)}><ArrowUp className="size-4" /></Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Move ${f.label} down`} disabled={i === active.length - 1 || busy("reorder")} onClick={() => move(i, 1)}><ArrowDown className="size-4" /></Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Edit ${f.label}`} onClick={() => setEditing(f)}><Pencil className="size-4" /></Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Archive ${f.label}`} onClick={() => run(`arch-${f.id}`, () => archiveFieldAction(scope.orgId, f.id, true), "Field archived. Its values are kept.")}><Archive className="size-4" /></Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {archived.length > 0 && (
        <div className="mt-5">
          <button type="button" className="text-[13px] font-medium text-muted hover:text-ink" onClick={() => setShowArchived((v) => !v)} aria-expanded={showArchived}>
            {showArchived ? "Hide" : "Show"} {archived.length} archived {archived.length === 1 ? "field" : "fields"}
          </button>
          {showArchived && (
            <ul className="mt-2 divide-y divide-line rounded-2xl border border-dashed border-line">
              {archived.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
                  <span className="text-muted">{f.label} · {FIELD_TYPE_LABELS[f.type]} · {f.valueCount} values kept</span>
                  {canManage && <Button size="sm" variant="ghost" onClick={() => run(`arch-${f.id}`, () => archiveFieldAction(scope.orgId, f.id, false), "Field restored.")}><ArchiveRestore className="size-4" />Restore</Button>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {editing && <FieldDialog scope={scope} entity={entity} field={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function FieldDialog({ scope, entity, field, onClose }: { scope: CrmScope; entity: FieldEntity; field: CustomFieldView | null; onClose: () => void }) {
  const { run, busy } = useCrmAction();
  const [label, setLabel] = React.useState(field?.label ?? "");
  const [type, setType] = React.useState<FieldType>(field?.type ?? "text");
  const [options, setOptions] = React.useState((field?.options ?? []).map((o) => o.label).join("\n"));
  const [required, setRequired] = React.useState(field?.required ?? false);
  const [helpText, setHelpText] = React.useState(field?.helpText ?? "");
  const [groupName, setGroupName] = React.useState(field?.groupName ?? "");
  const choice = type === "select" || type === "multiselect";
  const optionList = options.split("\n").map((o) => o.trim()).filter(Boolean);
  const typeLocked = Boolean(field && field.valueCount > 0);
  // Keep existing option values stable when their labels are unchanged, so stored values still match.
  const optionPayload = optionList.map((l) => field?.options.find((o) => o.label === l) ?? l);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={field ? `Edit ${field.label}` : `New ${ENTITY_LABEL[entity].toLowerCase().replace(/s$/, "").replace(/ie$/, "y")} field`} size="md"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy("save")} disabled={!label.trim() || (choice && !optionList.length)} onClick={async () => {
        const base = { label: label.trim(), required, helpText: helpText.trim() || null, groupName: groupName.trim() || null, options: choice ? optionPayload : undefined };
        const ok = await run("save", () => (field ? updateFieldAction(scope.orgId, field.id, { ...base, type: typeLocked ? undefined : type }) : createFieldAction(scope.orgId, { ...base, entity, type })), field ? "Field saved." : "Field created.");
        if (ok) onClose();
      }}>{field ? "Save" : "Create field"}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="cf-label" className="sm:col-span-2"><Input id="cf-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="Property type" autoFocus /></Field>
        <Field label="Type" htmlFor="cf-type" hint={typeLocked ? "Records already have values, so the type is fixed. Create a new field to change it." : undefined}>
          <Select id="cf-type" value={type} onChange={(e) => setType(e.target.value as FieldType)} disabled={typeLocked}>
            {FIELD_TYPES.map((t) => <option key={t} value={t}>{FIELD_TYPE_LABELS[t]}</option>)}
          </Select>
        </Field>
        <Field label="Section" htmlFor="cf-group" optional hint="Groups fields together on record pages"><Input id="cf-group" value={groupName} onChange={(e) => setGroupName(e.target.value)} maxLength={60} placeholder="Property" /></Field>
        {choice && (
          <Field label="Choices" htmlFor="cf-options" className="sm:col-span-2" hint="One per line. A choice still used by records can't be removed.">
            <Textarea id="cf-options" rows={5} value={options} onChange={(e) => setOptions(e.target.value)} placeholder={"Condo\nSingle family\nTownhouse"} />
          </Field>
        )}
        <Field label="Help text" htmlFor="cf-help" optional className="sm:col-span-2"><Input id="cf-help" value={helpText} onChange={(e) => setHelpText(e.target.value)} maxLength={200} /></Field>
        <label className="flex items-center gap-2.5 text-[13px] text-ink-2 sm:col-span-2">
          <Switch checked={required} onCheckedChange={setRequired} aria-label="Required" />
          Required when someone adds or edits a record by hand (imports and automations may leave it empty)
        </label>
      </div>
    </Dialog>
  );
}
