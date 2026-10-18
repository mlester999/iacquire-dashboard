"use client";

import * as React from "react";
import { Check } from "lucide-react";
import { Input } from "@/components/ui/primitives";
import { Switch } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { TAG_COLORS } from "@/lib/crm/types";

// Small inputs the Blueprint editor's sections share.

/**
 * A key that is committed when the field is left (or Enter is pressed) and only when it is valid, so a half-typed key never reaches the
 * Blueprint (renaming a configuration value's key rewrites the texts that use it, which must happen once, with the final key).
 */
export function KeyInput({ id, value, pattern, onCommit, disabled, describedBy, invalidText, taken = [] }: {
  id: string;
  value: string;
  pattern: RegExp;
  onCommit: (v: string) => void;
  disabled?: boolean;
  describedBy?: string;
  invalidText: string;
  taken?: readonly string[];
}) {
  const [text, setText] = React.useState(value);
  const [last, setLast] = React.useState(value);
  if (value !== last) {
    setLast(value);
    setText(value);
  }
  const clash = text !== value && taken.includes(text);
  const invalid = !pattern.test(text) || clash;
  const commit = () => {
    if (text === value) return;
    if (invalid) return;
    onCommit(text);
  };
  return (
    <div className="space-y-1">
      <Input
        id={id}
        value={text}
        disabled={disabled}
        maxLength={48}
        className="font-mono"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(e) => setText(e.target.value.toLowerCase())}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") setText(value);
        }}
      />
      {invalid && text !== value && <p className="text-[12px] text-danger-ink" role="status">{clash ? "Another item already uses this key." : invalidText} The previous key is kept until this one is valid.</p>}
    </div>
  );
}

const HEX = /^#[0-9a-f]{6}$/;

/** The CRM's tag colours as swatches, plus any other lower-case #rrggbb. `nullable` adds "No colour". */
export function ColorPicker({ id, value, onChange, nullable, disabled, label }: { id: string; value: string | null; onChange: (v: string | null) => void; nullable?: boolean; disabled?: boolean; label: string }) {
  const [text, setText] = React.useState(value ?? "");
  const [last, setLast] = React.useState(value);
  if (value !== last) {
    setLast(value);
    setText(value ?? "");
  }
  return (
    <div className="space-y-2">
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
        {nullable && (
          <button type="button" role="radio" aria-checked={value === null} disabled={disabled} onClick={() => onChange(null)}
            className={cn("inline-flex h-9 items-center rounded-full border px-3 text-[12.5px] sm:h-8", value === null ? "border-primary bg-primary-soft text-primary-ink" : "border-line text-ink-2 hover:bg-surface-2")}>
            No colour
          </button>
        )}
        {TAG_COLORS.map((c) => (
          <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={c} disabled={disabled} onClick={() => onChange(c)}
            className={cn("inline-flex size-9 items-center justify-center rounded-full border-2 sm:size-8", value === c ? "border-ink" : "border-transparent")} style={{ background: c }}>
            {value === c && <Check className="size-4 text-white" aria-hidden />}
          </button>
        ))}
      </div>
      <Input
        id={id}
        value={text}
        disabled={disabled}
        placeholder="#rrggbb"
        maxLength={7}
        className="w-32 font-mono"
        aria-label={`${label} (hex)`}
        aria-invalid={text !== "" && !HEX.test(text) ? true : undefined}
        onChange={(e) => {
          const t = e.target.value.trim().toLowerCase();
          setText(t);
          if (HEX.test(t)) onChange(t);
          else if (t === "" && nullable) onChange(null);
        }}
      />
    </div>
  );
}

/** A labelled on/off setting. */
export function ToggleRow({ id, label, hint, checked, onChange, disabled }: { id: string; label: React.ReactNode; hint?: React.ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-line px-3.5 py-3">
      <div className="min-w-0">
        <label htmlFor={id} className="text-[13.5px] font-medium text-ink">{label}</label>
        {hint && <p id={`${id}-hint`} className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{hint}</p>}
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} aria-describedby={hint ? `${id}-hint` : undefined} />
    </div>
  );
}

/** "09:00" ↔ 540. */
export const minutesToClock = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export const clockToMinutes = (s: string): number | null => {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
};
