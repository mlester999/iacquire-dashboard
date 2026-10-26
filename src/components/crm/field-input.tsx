"use client";

import * as React from "react";
import { Input, Select, Textarea } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import type { FieldType } from "@/lib/crm/types";

export interface FieldDef {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  options: Array<{ value: string; label: string }>;
  required?: boolean;
  helpText?: string | null;
}

/** Converts a stored ISO timestamp to the value a datetime-local input shows (in the browser's time zone). */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** One input for a custom field, by type. Values go to the server as typed text; the server validates them against the field definition. */
export function FieldInput({ def, value, onChange, id, invalid }: { def: FieldDef; value: unknown; onChange: (v: unknown) => void; id: string; invalid?: boolean }) {
  const common = { id, "aria-invalid": invalid || undefined, "aria-required": def.required || undefined } as const;
  switch (def.type) {
    case "textarea":
      return <Textarea {...common} rows={3} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
    case "number":
    case "currency":
      return <Input {...common} type="number" inputMode="decimal" step={def.type === "currency" ? "0.01" : "any"} value={value === null || value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value)} />;
    case "date":
      return <Input {...common} type="date" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
    case "datetime":
      return (
        <Input
          {...common}
          type="datetime-local"
          value={value ? toLocalInput(String(value)) : ""}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : "")}
        />
      );
    case "boolean":
      return (
        <div className="flex min-h-10 items-center gap-3">
          <Switch id={id} checked={value === true} onCheckedChange={(c) => onChange(c)} aria-label={def.label} />
          <span className="text-[14px] text-muted">{value === true ? "Yes" : value === false ? "No" : "Not set"}</span>
          {value !== null && value !== undefined && value !== "" && (
            <button type="button" className="text-[12px] text-muted underline-offset-2 hover:underline" onClick={() => onChange("")}>Clear</button>
          )}
        </div>
      );
    case "select":
      return (
        <Select {...common} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          <option value="">Not set</option>
          {def.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      );
    case "multiselect": {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div role="group" aria-label={def.label} className="flex flex-wrap gap-1.5">
          {def.options.map((o) => {
            const on = arr.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={on}
                onClick={() => onChange(on ? arr.filter((v) => v !== o.value) : [...arr, o.value])}
                className={cn("inline-flex min-h-9 items-center rounded-full border px-3 text-[13px] font-medium", on ? "border-primary/40 bg-primary-soft text-primary-ink" : "border-line bg-surface text-ink-2 hover:bg-surface-2")}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      );
    }
    case "email":
      return <Input {...common} type="email" autoComplete="off" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
    case "phone":
      return <Input {...common} type="tel" placeholder="+63 917 123 4567" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
    case "url":
      return <Input {...common} type="url" placeholder="https://" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
    default:
      return <Input {...common} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
  }
}

export function displayFieldValue(def: Pick<FieldDef, "type" | "options">, value: unknown, currency = "USD"): string {
  if (value === null || value === undefined || value === "") return "—";
  const label = (v: string) => def.options.find((o) => o.value === v)?.label ?? v;
  switch (def.type) {
    case "boolean":
      return value ? "Yes" : "No";
    case "select":
      return label(String(value));
    case "multiselect":
      return Array.isArray(value) ? value.map((v) => label(String(v))).join(", ") : String(value);
    case "currency":
      try {
        return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(value));
      } catch {
        return String(value);
      }
    case "datetime":
      return new Date(String(value)).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    case "date":
      return new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" });
    default:
      return String(value);
  }
}
