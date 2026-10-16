"use client";

import * as React from "react";
import { Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import {
  CONTACT_FILTER_FIELDS, COMPANY_FILTER_FIELDS, customFieldOps, isGroup, kindForFieldType, OP_LABELS, OPS_BY_KIND, opNeedsValue,
  type CatalogField, type FieldKind, type FilterCondition, type FilterGroup,
} from "@/lib/crm/filters";
import type { FieldType } from "@/lib/crm/types";

export interface FilterOptions {
  tags: Array<{ id: string; name: string; color: string }>;
  members: Array<{ id: string; name: string }>;
  pipelines: Array<{ id: string; name: string; stages: Array<{ id: string; name: string }> }>;
  customFields: Array<{ id: string; label: string; type: FieldType; options: Array<{ value: string; label: string }> }>;
}

type Field = CatalogField & { ops: string[] };

function catalog(entity: "contact" | "company", opts: FilterOptions): Field[] {
  // "Company is any of" is applied from a company's own page (its People link), so the builder offers presence checks only.
  const base = (entity === "company" ? COMPANY_FILTER_FIELDS : CONTACT_FILTER_FIELDS).map((f) => ({ ...f, ops: [...OPS_BY_KIND[f.kind]].filter((op) => !(f.kind === "company" && op === "is_any_of")) }));
  const custom = opts.customFields.map<Field>((f) => ({ key: `cf:${f.id}`, label: f.label, kind: kindForFieldType(f.type), group: "Custom fields", options: f.options, ops: customFieldOps(f.type) }));
  return [...base, ...custom];
}

function defaultValue(kind: FieldKind, op: string): unknown {
  if (!opNeedsValue(kind, op)) return undefined;
  if (op === "between") return kind === "date" ? { from: "", to: "" } : { from: "", to: "" };
  if (["within_last_days", "more_than_days_ago", "within_next_days", "no_reply_in_days", "replied_within_days"].includes(op)) return 7;
  if (kind === "consent") return { channel: "email", purpose: "marketing", status: "granted" };
  if (["enum", "tags", "owner", "company", "opportunity"].includes(kind)) return [];
  return "";
}

/** A condition that is missing its value is left out of the count until it is complete, instead of failing. */
export function completeFilter(group: FilterGroup, fields: Field[]): FilterGroup {
  return {
    op: group.op,
    conditions: group.conditions
      .map((c) => (isGroup(c) ? completeFilter(c, fields) : c))
      .filter((c) => {
        if (isGroup(c)) return c.conditions.length > 0;
        const f = fields.find((x) => x.key === c.field);
        if (!f) return false;
        if (!opNeedsValue(f.kind, c.op)) return true;
        const v = c.value;
        if (v === undefined || v === null || v === "") return false;
        if (Array.isArray(v)) return v.length > 0;
        if (typeof v === "object") return Object.values(v as Record<string, unknown>).every((x) => x !== "" && x !== null && x !== undefined);
        return true;
      }),
  };
}

export function useFilterFields(entity: "contact" | "company", opts: FilterOptions) {
  return React.useMemo(() => catalog(entity, opts), [entity, opts]);
}

export function FilterBuilder({ entity = "contact", value, onChange, options }: { entity?: "contact" | "company"; value: FilterGroup; onChange: (g: FilterGroup) => void; options: FilterOptions }) {
  const fields = useFilterFields(entity, options);
  return <GroupEditor group={value} onChange={onChange} fields={fields} options={options} depth={1} />;
}

function GroupEditor({ group, onChange, fields, options, depth, onRemove }: { group: FilterGroup; onChange: (g: FilterGroup) => void; fields: Field[]; options: FilterOptions; depth: number; onRemove?: () => void }) {
  const update = (i: number, next: FilterCondition | FilterGroup | null) => {
    const conditions = [...group.conditions];
    if (next === null) conditions.splice(i, 1);
    else conditions[i] = next;
    onChange({ ...group, conditions });
  };
  const addCondition = () => {
    const f = fields[0];
    onChange({ ...group, conditions: [...group.conditions, { field: f.key, op: f.ops[0], value: defaultValue(f.kind, f.ops[0]) }] });
  };
  const addGroup = () => onChange({ ...group, conditions: [...group.conditions, { op: group.op === "and" ? "or" : "and", conditions: [{ field: fields[0].key, op: fields[0].ops[0], value: defaultValue(fields[0].kind, fields[0].ops[0]) }] }] });
  const groupId = React.useId();
  return (
    <div className={cn("space-y-2.5", depth > 1 && "rounded-2xl border border-dashed border-line-strong bg-surface-2/50 p-3")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[13px] text-ink-2">
          <span>Match</span>
          <Segmented id={`match-${groupId}`} size="sm" ariaLabel="Match all or any" value={group.op} onChange={(op) => onChange({ ...group, op })} options={[{ value: "and", label: "all" }, { value: "or", label: "any" }]} />
          <span>of these conditions</span>
        </div>
        {onRemove && (
          <Button variant="ghost" size="sm" onClick={onRemove}>
            <X className="size-3.5" />Remove group
          </Button>
        )}
      </div>
      {!group.conditions.length && <p className="rounded-xl border border-line bg-surface px-3 py-3 text-[13px] text-muted">No conditions yet. Everyone matches.</p>}
      {group.conditions.map((c, i) =>
        isGroup(c) ? (
          <GroupEditor key={i} group={c} onChange={(g) => update(i, g)} fields={fields} options={options} depth={depth + 1} onRemove={() => update(i, null)} />
        ) : (
          <ConditionRow key={i} condition={c} fields={fields} options={options} onChange={(n) => update(i, n)} onRemove={() => update(i, null)} />
        ),
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={addCondition}>
          <Plus className="size-3.5" />Add condition
        </Button>
        {depth < 2 && (
          <Button variant="ghost" size="sm" onClick={addGroup}>
            <Plus className="size-3.5" />Add group
          </Button>
        )}
      </div>
    </div>
  );
}

function ConditionRow({ condition, fields, options, onChange, onRemove }: { condition: FilterCondition; fields: Field[]; options: FilterOptions; onChange: (c: FilterCondition) => void; onRemove: () => void }) {
  const field = fields.find((f) => f.key === condition.field) ?? fields[0];
  const id = React.useId();
  const groups = [...new Set(fields.map((f) => f.group))];
  return (
    <div className="grid gap-2 rounded-2xl border border-line bg-surface p-2.5 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto] sm:items-start">
      <label className="sr-only" htmlFor={`${id}-f`}>Field</label>
      <Select
        id={`${id}-f`}
        value={field.key}
        onChange={(e) => {
          const f = fields.find((x) => x.key === e.target.value)!;
          onChange({ field: f.key, op: f.ops[0], value: defaultValue(f.kind, f.ops[0]) });
        }}
      >
        {groups.map((g) => (
          <optgroup key={g} label={g}>
            {fields.filter((f) => f.group === g).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </optgroup>
        ))}
      </Select>
      <label className="sr-only" htmlFor={`${id}-o`}>Condition</label>
      <Select id={`${id}-o`} value={condition.op} onChange={(e) => onChange({ field: field.key, op: e.target.value, value: defaultValue(field.kind, e.target.value) })}>
        {field.ops.map((op) => <option key={op} value={op}>{OP_LABELS[op] ?? op}</option>)}
      </Select>
      <div className="min-w-0">
        <ValueEditor field={field} op={condition.op} value={condition.value} options={options} onChange={(value) => onChange({ ...condition, value })} id={id} />
      </div>
      <Button variant="ghost" size="icon-sm" onClick={onRemove} aria-label="Remove condition">
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}

function MultiChoice({ choices, value, onChange, label }: { choices: Array<{ value: string; label: string; color?: string }>; value: string[]; onChange: (v: string[]) => void; label: string }) {
  if (!choices.length) return <p className="py-2 text-[12.5px] text-muted">Nothing to choose from yet.</p>;
  return (
    <div role="group" aria-label={label} className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
      {choices.map((c) => {
        const on = value.includes(c.value);
        return (
          <button
            key={c.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((v) => v !== c.value) : [...value, c.value])}
            className={cn("inline-flex min-h-9 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] font-medium transition-colors sm:min-h-7", on ? "border-primary/40 bg-primary-soft text-primary-ink" : "border-line bg-surface text-ink-2 hover:bg-surface-2")}
          >
            {c.color && <i className="size-2 rounded-full" style={{ background: c.color }} aria-hidden />}
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

function ValueEditor({ field, op, value, options, onChange, id }: { field: Field; op: string; value: unknown; options: FilterOptions; onChange: (v: unknown) => void; id: string }) {
  if (!opNeedsValue(field.kind, op)) return <p className="py-2.5 text-[12.5px] text-muted">No value needed.</p>;
  const arr = Array.isArray(value) ? (value as string[]) : [];
  const days = ["within_last_days", "more_than_days_ago", "within_next_days", "no_reply_in_days", "replied_within_days"].includes(op);
  if (days) {
    return (
      <div className="flex items-center gap-2">
        <Input aria-label="Number of days" type="number" min={0} max={3650} value={String(value ?? "")} onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} className="w-24" />
        <span className="text-[13px] text-muted">days</span>
      </div>
    );
  }
  if (op === "between") {
    const v = (value ?? {}) as { from?: string | number; to?: string | number };
    const type = field.kind === "date" ? "date" : "number";
    return (
      <div className="flex items-center gap-2">
        <Input aria-label="From" type={type} value={String(v.from ?? "")} onChange={(e) => onChange({ ...v, from: type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value })} />
        <span className="text-[13px] text-muted">and</span>
        <Input aria-label="To" type={type} value={String(v.to ?? "")} onChange={(e) => onChange({ ...v, to: type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value })} />
      </div>
    );
  }
  switch (field.kind) {
    case "date":
      return <Input aria-label="Date" type="date" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
    case "number":
      return <Input aria-label="Number" type="number" value={String(value ?? "")} onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} />;
    case "enum":
      return <MultiChoice label={field.label} choices={field.options ?? []} value={arr} onChange={onChange} />;
    case "tags":
      return <MultiChoice label="Tags" choices={options.tags.map((t) => ({ value: t.id, label: t.name, color: t.color }))} value={arr} onChange={onChange} />;
    case "owner":
      return <MultiChoice label="Owners" choices={options.members.map((m) => ({ value: m.id, label: m.name }))} value={arr} onChange={onChange} />;
    case "opportunity": {
      const choices = op === "in_pipeline" ? options.pipelines.map((p) => ({ value: p.id, label: p.name })) : options.pipelines.flatMap((p) => p.stages.map((s) => ({ value: s.id, label: options.pipelines.length > 1 ? `${p.name}: ${s.name}` : s.name })));
      return <MultiChoice label={op === "in_pipeline" ? "Pipelines" : "Stages"} choices={choices} value={arr} onChange={onChange} />;
    }
    case "consent": {
      const v = (value ?? {}) as { channel?: string; purpose?: string; status?: string };
      return (
        <div className="grid grid-cols-3 gap-1.5">
          <Select aria-label="Channel" value={v.channel ?? "email"} onChange={(e) => onChange({ ...v, channel: e.target.value })}>
            <option value="email">Email</option><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option>
          </Select>
          <Select aria-label="Purpose" value={v.purpose ?? "marketing"} onChange={(e) => onChange({ ...v, purpose: e.target.value })}>
            <option value="marketing">Marketing</option><option value="service">Service</option>
          </Select>
          <Select aria-label="Status" value={v.status ?? "granted"} onChange={(e) => onChange({ ...v, status: e.target.value })}>
            <option value="granted">Granted</option><option value="revoked">Withdrawn</option><option value="unknown">Not recorded</option>
          </Select>
        </div>
      );
    }
    default:
      return <Input id={`${id}-v`} aria-label="Value" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} placeholder="Type a value" />;
  }
}

export function describeFilter(group: FilterGroup, fields: Field[]): string {
  const parts = group.conditions.map((c) => {
    if (isGroup(c)) return `(${describeFilter(c, fields)})`;
    const f = fields.find((x) => x.key === c.field);
    return `${f?.label ?? "Field"} ${OP_LABELS[c.op] ?? c.op}`;
  });
  return parts.join(group.op === "and" ? " and " : " or ") || "Everyone";
}
