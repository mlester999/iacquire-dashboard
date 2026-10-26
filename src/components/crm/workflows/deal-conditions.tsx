"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/overlays";
import { isGroup, OP_LABELS, OPS_BY_KIND, opNeedsValue, type FieldKind, type FilterCondition, type FilterGroup } from "@/lib/crm/filters";
import { OPPORTUNITY_CONDITION_FIELDS } from "@/lib/crm/workflow/spec";
import { MultiPick, type PickOption } from "@/components/crm/workflows/pickers";

// Conditions on a deal for an if / else step: a flat list joined by "all" or "any", over the fields the engine can test on a deal
// (OPPORTUNITY_CONDITION_FIELDS). Values use the same shapes as Smart List filters.

export interface DealConditionOptions {
  tags: PickOption[];
  members: PickOption[];
  pipelines: Array<{ id: string; name: string; stages: Array<{ id: string; name: string }> }>;
}

const opsFor = (kind: FieldKind) => OPS_BY_KIND[kind].filter((op) => op !== "is_me");

function defaultValue(kind: FieldKind, op: string): unknown {
  if (!opNeedsValue(kind, op)) return undefined;
  if (op === "between") return { from: "", to: "" };
  if (["within_last_days", "more_than_days_ago", "within_next_days"].includes(op)) return 7;
  if (["enum", "tags", "owner"].includes(kind)) return [];
  return "";
}

export function DealConditions({ id, value, onChange, options, disabled }: { id: string; value: FilterGroup; onChange: (g: FilterGroup) => void; options: DealConditionOptions; disabled?: boolean }) {
  // Nested groups aren't offered for deals; a definition that has them (built elsewhere) is shown flat-read-only rather than mangled.
  const nested = value.conditions.some((c) => isGroup(c));
  const rows = value.conditions.filter((c): c is FilterCondition => !isGroup(c));
  const update = (i: number, next: FilterCondition | null) => {
    const list = [...rows];
    if (next) list[i] = next;
    else list.splice(i, 1);
    onChange({ op: value.op, conditions: list });
  };
  const add = () => {
    const f = OPPORTUNITY_CONDITION_FIELDS[0];
    const op = opsFor(f.kind)[0];
    onChange({ op: value.op, conditions: [...rows, { field: f.key, op, value: defaultValue(f.kind, op) }] });
  };
  if (nested) return <p className="rounded-xl bg-warning-soft px-3 py-2 text-[13px] text-warning-ink">These deal conditions use nested groups, which this editor can&apos;t change. Remove the step and add it again to edit them here.</p>;
  return (
    <div className="space-y-2">
      {rows.length > 1 && (
        <Segmented<"and" | "or">
          id={`${id}-op`}
          ariaLabel="Match"
          size="sm"
          value={value.op}
          onChange={(op) => onChange({ ...value, op })}
          options={[{ value: "and", label: "All of these" }, { value: "or", label: "Any of these" }]}
        />
      )}
      {rows.map((c, i) => {
        const f = OPPORTUNITY_CONDITION_FIELDS.find((x) => x.key === c.field) ?? OPPORTUNITY_CONDITION_FIELDS[0];
        const ops = opsFor(f.kind);
        return (
          <div key={i} className="space-y-2 rounded-xl border border-line bg-surface-2/50 p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label={`Condition ${i + 1}: field`}
                value={f.key}
                disabled={disabled}
                className="w-auto min-w-36"
                onChange={(e) => {
                  const nf = OPPORTUNITY_CONDITION_FIELDS.find((x) => x.key === e.target.value)!;
                  const op = opsFor(nf.kind)[0];
                  update(i, { field: nf.key, op, value: defaultValue(nf.kind, op) });
                }}
              >
                {OPPORTUNITY_CONDITION_FIELDS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
              </Select>
              <Select aria-label={`Condition ${i + 1}: comparison`} value={c.op} disabled={disabled} className="w-auto min-w-36" onChange={(e) => update(i, { field: f.key, op: e.target.value, value: defaultValue(f.kind, e.target.value) })}>
                {ops.map((op) => <option key={op} value={op}>{OP_LABELS[op] ?? op}</option>)}
              </Select>
              <Button variant="ghost" size="icon-sm" className="ml-auto" disabled={disabled} aria-label={`Remove condition ${i + 1}`} onClick={() => update(i, null)}><Trash2 className="size-4" /></Button>
            </div>
            {opNeedsValue(f.kind, c.op) && <ValueInput id={`${id}-v${i}`} field={f} op={c.op} value={c.value} options={options} disabled={disabled} onChange={(v) => update(i, { ...c, value: v })} />}
          </div>
        );
      })}
      <Button variant="secondary" size="sm" onClick={add} disabled={disabled || rows.length >= 20}><Plus className="size-4" aria-hidden />Add condition</Button>
    </div>
  );
}

function ValueInput({ id, field, op, value, options, onChange, disabled }: { id: string; field: (typeof OPPORTUNITY_CONDITION_FIELDS)[number]; op: string; value: unknown; options: DealConditionOptions; onChange: (v: unknown) => void; disabled?: boolean }) {
  const arr = Array.isArray(value) ? value.map(String) : [];
  if (field.kind === "tags") return <MultiPick id={id} label="Tags" options={options.tags} value={arr} onChange={onChange} empty="There are no tags yet." />;
  if (field.kind === "owner") return <MultiPick id={id} label="People" options={options.members} value={arr} onChange={onChange} empty="There's nobody to choose." />;
  if (field.kind === "enum") {
    const opts: PickOption[] =
      field.key === "pipeline" ? options.pipelines.map((p) => ({ id: p.id, label: p.name }))
      : field.key === "stage" ? options.pipelines.flatMap((p) => p.stages.map((s) => ({ id: s.id, label: s.name, hint: p.name })))
      : (field.options ?? []).map((o) => ({ id: o.value, label: o.label }));
    return <MultiPick id={id} label={field.label} options={opts} value={arr} onChange={onChange} empty="Nothing to choose from yet." />;
  }
  if (op === "between") {
    const v = (value && typeof value === "object" ? value : { from: "", to: "" }) as { from: string | number; to: string | number };
    const type = field.kind === "date" ? "date" : "number";
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="From" type={type} className="w-40" value={String(v.from ?? "")} disabled={disabled} onChange={(e) => onChange({ ...v, from: type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value })} />
        <span className="text-[13px] text-muted">and</span>
        <Input aria-label="To" type={type} className="w-40" value={String(v.to ?? "")} disabled={disabled} onChange={(e) => onChange({ ...v, to: type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value })} />
      </div>
    );
  }
  if (["within_last_days", "more_than_days_ago", "within_next_days"].includes(op)) {
    return (
      <div className="flex items-center gap-2">
        <Input id={id} aria-label="Days" type="number" min={1} step={1} className="w-28" value={String(value ?? "")} disabled={disabled} onChange={(e) => onChange(e.target.value === "" ? "" : Math.trunc(Number(e.target.value)))} />
        <span className="text-[13px] text-muted">days</span>
      </div>
    );
  }
  if (field.kind === "date") return <Input id={id} aria-label={field.label} type="date" className="w-44" value={String(value ?? "")} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  if (field.kind === "number") return <Input id={id} aria-label={field.label} type="number" className="w-40" value={String(value ?? "")} disabled={disabled} onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} />;
  return <Input id={id} aria-label={field.label} value={String(value ?? "")} maxLength={200} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
}
