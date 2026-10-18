"use client";

import * as React from "react";
import { Search } from "lucide-react";
import { Input, Select } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { CUSTOM_VALUES_GROUP_LABEL, customValueTokenKey, TEMPLATE_TOKENS, TOKEN_GROUP_LABELS, tokenText, type AnyTokenKey } from "@/lib/messaging/tokens";

// Small form controls shared by the step and trigger panels. Every control is a native input or button, so the panels work with a
// keyboard and a screen reader without anything to drag.

export interface PickOption {
  id: string;
  label: string;
  hint?: string;
  color?: string;
}

/** A checkbox list with a search box once it gets long. `value` keeps the order the options are listed in. */
export function MultiPick({ id, label, options, value, onChange, empty, max }: { id: string; label: string; options: PickOption[]; value: readonly string[]; onChange: (v: string[]) => void; empty: React.ReactNode; max?: number }) {
  const [q, setQ] = React.useState("");
  const term = q.trim().toLowerCase();
  const shown = term ? options.filter((o) => o.label.toLowerCase().includes(term)) : options;
  const chosen = new Set(value);
  const missing = value.filter((v) => !options.some((o) => o.id === v));
  const toggle = (oid: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(oid);
    else next.delete(oid);
    onChange([...options.map((o) => o.id).filter((x) => next.has(x)), ...missing.filter((x) => next.has(x))]);
  };
  if (!options.length) return <p className="rounded-xl border border-dashed border-line px-3 py-2.5 text-[12.5px] text-muted">{empty}</p>;
  return (
    <fieldset className="space-y-2">
      <legend className="sr-only">{label}</legend>
      {options.length > 8 && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <Input aria-label={`Search ${label.toLowerCase()}`} placeholder="Search" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      <div className="scrollbar-thin max-h-56 space-y-0.5 overflow-y-auto rounded-xl border border-line bg-surface p-1">
        {shown.map((o) => {
          const on = chosen.has(o.id);
          const atMax = !!max && !on && chosen.size >= max;
          return (
            <label key={o.id} htmlFor={`${id}-${o.id}`} className={cn("flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[13px] hover:bg-surface-2 sm:min-h-9", atMax && "cursor-not-allowed opacity-50")}>
              <input id={`${id}-${o.id}`} type="checkbox" className="size-4 accent-[var(--primary)]" checked={on} disabled={atMax} onChange={(e) => toggle(o.id, e.target.checked)} />
              {o.color && <i className="size-2.5 shrink-0 rounded-full" style={{ background: o.color }} aria-hidden />}
              <span className="min-w-0 flex-1 truncate text-ink-2">{o.label}</span>
              {o.hint && <span className="shrink-0 text-[11.5px] text-faint">{o.hint}</span>}
            </label>
          );
        })}
        {!shown.length && <p className="px-2.5 py-2 text-[12.5px] text-muted">No matches.</p>}
      </div>
      {missing.length > 0 && (
        <p className="text-[12px] text-danger-ink">
          {missing.length === 1 ? "One choice no longer exists." : `${missing.length} choices no longer exist.`}{" "}
          <button type="button" className="font-medium underline" onClick={() => onChange(value.filter((v) => !missing.includes(v)))}>Remove {missing.length === 1 ? "it" : "them"}</button>
        </p>
      )}
    </fieldset>
  );
}

/**
 * A select with an empty first choice. A value that isn't among the options (it was deleted) stays visible as "no longer available". Give it
 * `label` when no <label for> names it (two selects under one legend, for example).
 */
export function SinglePick({ id, value, onChange, options, placeholder, groups, disabled, invalid, label, describedBy }: {
  id: string;
  value: string | null | undefined;
  onChange: (v: string | null) => void;
  options: PickOption[];
  placeholder: string;
  groups?: Array<{ label: string; ids: string[] }>;
  disabled?: boolean;
  invalid?: boolean;
  /** Its accessible name, when there is no visible label pointing at it. */
  label?: string;
  /** The id of a note about the current choice. */
  describedBy?: string;
}) {
  const known = !value || options.some((o) => o.id === value);
  const render = (o: PickOption) => <option key={o.id} value={o.id}>{o.label}{o.hint ? ` · ${o.hint}` : ""}</option>;
  return (
    <Select id={id} value={value ?? ""} disabled={disabled} aria-invalid={invalid || undefined} aria-label={label} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{placeholder}</option>
      {!known && <option value={value!}>No longer available</option>}
      {groups
        ? groups.map((g) => <optgroup key={g.label} label={g.label}>{options.filter((o) => g.ids.includes(o.id)).map(render)}</optgroup>)
        : options.map(render)}
    </Select>
  );
}

/** A labelled switch row. */
export function Toggle({ id, label, hint, checked, onChange, disabled }: { id: string; label: React.ReactNode; hint?: React.ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-[13px] font-medium text-ink-2">{label}</span>
        {hint && <span className="mt-0.5 block text-[12.5px] leading-relaxed text-muted">{hint}</span>}
      </label>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

/** Radio buttons as a row of pills; a native radio group, so arrow keys move between them. */
export function Choice<V extends string>({ name, label, value, onChange, options, disabled }: { name: string; label: string; value: V; onChange: (v: V) => void; options: Array<{ value: V; label: string; disabled?: boolean }>; disabled?: boolean }) {
  return (
    <fieldset>
      <legend className="sr-only">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              "inline-flex min-h-11 cursor-pointer items-center rounded-xl border px-3 text-[13px] font-medium transition-colors sm:min-h-9",
              "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary",
              value === o.value ? "border-primary/30 bg-primary-soft text-primary-ink" : "border-line bg-surface text-ink-2 hover:bg-surface-2",
              (disabled || o.disabled) && "cursor-not-allowed opacity-50",
            )}
          >
            <input type="radio" name={name} value={o.value} checked={value === o.value} disabled={disabled || o.disabled} onChange={() => onChange(o.value)} className="sr-only" />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const DURATION_UNITS = [
  { value: "minutes", label: "minutes" },
  { value: "hours", label: "hours" },
  { value: "days", label: "days" },
] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number]["value"];

/** A whole-number amount and a unit. Empty while typing; the validator reports it if it stays empty. */
export function DurationInput({ id, label, amount, unit, onChange, min = 1, disabled }: { id: string; label: string; amount: number | undefined; unit: DurationUnit | undefined; onChange: (v: { amount: number; unit: DurationUnit }) => void; min?: number; disabled?: boolean }) {
  // What's typed, while it's being typed (it may be empty or not a number yet); otherwise the value itself.
  const [draft, setDraft] = React.useState<string | null>(null);
  const text = draft ?? (amount === undefined || Number.isNaN(amount) ? "" : String(amount));
  return (
    <div className="flex items-center gap-2">
      <Input
        id={id}
        aria-label={`${label}: amount`}
        type="number"
        inputMode="numeric"
        min={min}
        step={1}
        className="w-28"
        value={text}
        disabled={disabled}
        onBlur={() => setDraft(null)}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value !== "" && Number.isFinite(n)) onChange({ amount: Math.trunc(n), unit: unit ?? "days" });
        }}
      />
      <Select aria-label={`${label}: unit`} value={unit ?? "days"} disabled={disabled} onChange={(e) => onChange({ amount: amount ?? min, unit: e.target.value as DurationUnit })} className="w-auto min-w-28">
        {DURATION_UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
      </Select>
    </div>
  );
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Toggle buttons for days of the week (0 = Sunday). */
export function WeekdayPick({ label, value, onChange, disabled }: { label: string; value: readonly number[]; onChange: (v: number[]) => void; disabled?: boolean }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {WEEKDAYS.map((d, i) => {
        const on = value.includes(i);
        return (
          <button
            key={d}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(on ? value.filter((x) => x !== i) : [...value, i].sort((a, b) => a - b))}
            className={cn("inline-flex size-11 items-center justify-center rounded-xl border text-[12.5px] font-medium sm:size-9", on ? "border-primary/30 bg-primary-soft text-primary-ink" : "border-line bg-surface text-ink-2 hover:bg-surface-2")}
          >
            {d}
          </button>
        );
      })}
    </div>
  );
}

/** Inserts a {{placeholder}} at the end of a text field: built-in tokens of the given groups, then the workspace's configuration values. */
export function TokenInsert({ id, onInsert, groups = ["contact", "business", "user", "appointment"], customValues = [], disabled }: { id: string; onInsert: (text: string) => void; groups?: Array<keyof typeof TOKEN_GROUP_LABELS>; customValues?: ReadonlyArray<{ key: string; label: string }>; disabled?: boolean }) {
  return (
    <Select
      id={id}
      aria-label="Insert a placeholder"
      value=""
      disabled={disabled}
      onChange={(e) => {
        if (e.target.value) onInsert(tokenText(e.target.value as AnyTokenKey));
      }}
      className="h-9 w-auto min-w-44 text-[12.5px] sm:h-8"
    >
      <option value="">Insert placeholder…</option>
      {groups.map((g) => (
        <optgroup key={g} label={TOKEN_GROUP_LABELS[g]}>
          {TEMPLATE_TOKENS.filter((t) => t.group === g).map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </optgroup>
      ))}
      {customValues.length > 0 && (
        <optgroup label={CUSTOM_VALUES_GROUP_LABEL}>
          {customValues.map((v) => <option key={v.key} value={customValueTokenKey(v.key)}>{v.label}</option>)}
        </optgroup>
      )}
    </Select>
  );
}
