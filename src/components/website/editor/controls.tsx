"use client";

import * as React from "react";
import { Check, ChevronDown, RotateCcw } from "lucide-react";
import { Tooltip } from "@/components/ui/overlays";
import { COLOR_TOKENS, type ColorRef, type ColorToken, type Design } from "@/lib/website/doc";
import { cn } from "@/lib/utils";
import { useDraft } from "./hooks";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** A titled, collapsible group of controls. */
export function Group({ title, children, defaultOpen = true, action, hint }: { title: string; children: React.ReactNode; defaultOpen?: boolean; action?: React.ReactNode; hint?: string }) {
  const [open, setOpen] = React.useState(defaultOpen);
  const id = React.useId();
  return (
    <section className="border-b border-line last:border-b-0">
      <div className="flex items-center justify-between gap-2 px-4 pt-3">
        <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)} className="group flex min-h-8 flex-1 items-center gap-1.5 text-left text-[11px] font-semibold uppercase tracking-[.1em] text-muted hover:text-ink">
          <ChevronDown className={cn("size-3 transition-transform", !open && "-rotate-90")} aria-hidden />
          {title}
        </button>
        {action}
      </div>
      {open && (
        <div id={id} className="space-y-3 px-4 pb-4 pt-2">
          {hint && <p className="text-[11.5px] leading-relaxed text-muted">{hint}</p>}
          {children}
        </div>
      )}
    </section>
  );
}

/** A label above a control, with a reset when the value has been customised. */
export function Row({ label, hint, children, onReset, tag, htmlFor }: { label: string; hint?: string; children: React.ReactNode; onReset?: () => void; tag?: string; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={htmlFor} className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium text-ink-2">
          <span className="truncate">{label}</span>
          {tag && <span className="shrink-0 rounded-full bg-surface-3 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide text-muted">{tag}</span>}
        </label>
        {onReset && (
          <Tooltip content="Reset to the design's default">
            <button type="button" onClick={onReset} aria-label={`Reset ${label}`} className="flex size-5 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink"><RotateCcw className="size-3" /></button>
          </Tooltip>
        )}
      </div>
      {children}
      {hint && <p className="text-[11px] leading-relaxed text-muted">{hint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const input = "h-8 w-full rounded-lg border border-line bg-surface px-2.5 text-[12.5px] text-ink placeholder:text-faint focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-primary/30";

export const TextControl = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function TextControl({ className, ...p }, ref) {
  return <input ref={ref} {...p} className={cn(input, className)} />;
});

export const AreaControl = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function AreaControl({ className, rows = 3, ...p }, ref) {
  return <textarea ref={ref} rows={rows} {...p} className={cn("w-full resize-y rounded-lg border border-line bg-surface px-2.5 py-2 text-[12.5px] leading-relaxed text-ink placeholder:text-faint focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-primary/30", className)} />;
});

export function SelectControl<T extends string>({ value, options, onChange, id, label, placeholder }: { value: T | undefined; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; id?: string; label?: string; placeholder?: string }) {
  return (
    <div className="relative">
      <select id={id} aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value as T)} className={cn(input, "appearance-none pr-7", value === undefined && "text-muted")}>
        {value === undefined && <option value="">{placeholder ?? "Default"}</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted" aria-hidden />
    </div>
  );
}

/** A compact row of choices. A choice may be an icon with a text label for screen readers. */
export function Seg<T extends string>({ value, options, onChange, label, size = "md" }: { value: T | undefined; options: Array<{ value: T; label: string; icon?: React.ReactNode }>; onChange: (v: T) => void; label: string; size?: "sm" | "md" }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-lg bg-surface-3 p-0.5" onKeyDown={(e) => {
      const at = options.findIndex((o) => o.value === value);
      const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? (at + 1) % options.length : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (at - 1 + options.length) % options.length : e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : -1;
      if (next < 0) return;
      e.preventDefault();
      onChange(options[next].value);
      e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
    }}>
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value} type="button" role="radio" aria-checked={on} tabIndex={on || (value === undefined && i === 0) ? 0 : -1} aria-label={o.icon ? o.label : undefined} title={o.icon ? o.label : undefined} onClick={() => onChange(o.value)}
            className={cn("flex min-w-0 flex-1 items-center justify-center rounded-md px-1.5 font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary", size === "sm" ? "h-6 text-[11px]" : "h-7 text-[12px]", on ? "bg-surface text-ink shadow-soft" : "text-ink-2 hover:text-ink")}
          >
            {o.icon ?? <span className="truncate">{o.label}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  const id = React.useId();
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <label htmlFor={id} className="text-[12px] font-medium text-ink-2">{label}</label>
        {hint && <p className="text-[11px] leading-relaxed text-muted">{hint}</p>}
      </div>
      <button id={id} type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={cn("relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary", checked ? "bg-primary" : "bg-line-strong")}>
        <span className={cn("absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow transition-transform", checked && "translate-x-4")} />
      </button>
    </div>
  );
}

/** A slider with a number box beside it. */
export function NumberControl({ value, min, max, step = 1, unit, onChange, label }: { value: number | undefined; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void; label: string }) {
  const v = value ?? min;
  return (
    <div className="flex items-center gap-2">
      <input type="range" aria-label={label} min={min} max={max} step={step} value={v} onChange={(e) => onChange(Number(e.target.value))} className="h-1.5 flex-1 cursor-pointer accent-[var(--primary)]" />
      <div className="relative w-16 shrink-0">
        <input type="number" aria-label={`${label} value`} min={min} max={max} step={step} value={v} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n))); }} className={cn(input, "pr-5 text-right tabular-nums")} />
        {unit && <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted">{unit}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

const TOKEN_LABEL: Record<ColorToken, string> = {
  primary: "Main", accent: "Accent", bg: "Background", surface: "Surface", surface2: "Soft surface", ink: "Text", muted: "Muted text", line: "Line", dark: "Dark", light: "White",
  primarySoft: "Soft main", accentSoft: "Soft accent", onPrimary: "On main", onDark: "On dark",
};
const SHOWN: ColorToken[] = ["primary", "accent", "ink", "muted", "dark", "light", "bg", "surface2", "primarySoft", "accentSoft"];

export function tokenHex(design: Design, t: ColorToken): string {
  const c = design.colors;
  switch (t) {
    case "primary": return c.primary;
    case "accent": return c.accent;
    case "bg": return c.bg;
    case "surface": return c.surface;
    case "surface2": return c.surface2;
    case "ink": return c.ink;
    case "muted": return c.muted;
    case "line": return c.line;
    case "dark": return c.dark;
    case "light": return "#ffffff";
    case "onDark": return "#f4f5f7";
    case "onPrimary": return "#ffffff";
    case "primarySoft": return `color-mix(in srgb, ${c.primary} 14%, white)`;
    case "accentSoft": return `color-mix(in srgb, ${c.accent} 16%, white)`;
  }
}

const HEX = /^#[0-9a-fA-F]{6}$/;
export const isToken = (v: unknown): v is ColorToken => typeof v === "string" && (COLOR_TOKENS as readonly string[]).includes(v);

/** Brand colours first (so a site stays consistent), and any colour by hex for the rest. */
export function ColorControl({ value, onChange, design, label, allowNone = true }: { value: ColorRef | undefined; onChange: (v: ColorRef | undefined) => void; design: Design; label: string; allowNone?: boolean }) {
  const [hex, setHex] = useDraft(value && !isToken(value) ? value : "");
  const commit = (v: string) => {
    const t = v.startsWith("#") ? v : `#${v}`;
    if (HEX.test(t)) onChange(t.toLowerCase() as ColorRef);
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
        {allowNone && (
          <Tooltip content="Default">
            <button type="button" aria-label="Default colour" aria-pressed={value === undefined} onClick={() => onChange(undefined)} className={cn("relative flex size-6 items-center justify-center rounded-full border border-line-strong bg-surface text-[10px] text-muted", value === undefined && "ring-2 ring-primary ring-offset-1 ring-offset-surface")}>
              <span className="block h-px w-4 -rotate-45 bg-danger" />
            </button>
          </Tooltip>
        )}
        {SHOWN.map((t) => (
          <Tooltip key={t} content={TOKEN_LABEL[t]}>
            <button type="button" aria-label={TOKEN_LABEL[t]} aria-pressed={value === t} onClick={() => onChange(t)} style={{ background: tokenHex(design, t) }} className={cn("relative flex size-6 items-center justify-center rounded-full border border-black/10", value === t && "ring-2 ring-primary ring-offset-1 ring-offset-surface")}>
              {value === t && <Check className="size-3 text-white mix-blend-difference" aria-hidden />}
            </button>
          </Tooltip>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input type="color" aria-label={`${label}: pick a custom colour`} value={value && !isToken(value) ? value : tokenHexSafe(design, value)} onChange={(e) => onChange(e.target.value.toLowerCase() as ColorRef)} className="size-8 shrink-0 cursor-pointer rounded-lg border border-line bg-surface p-0.5" />
        <TextControl aria-label={`${label}: hex code`} value={hex} placeholder="#2c5bff" maxLength={7} onChange={(e) => { setHex(e.target.value); commit(e.target.value); }} className="font-mono" />
      </div>
    </div>
  );
}
const tokenHexSafe = (design: Design, v: ColorRef | undefined) => {
  const raw = v && isToken(v) ? tokenHex(design, v) : "#888888";
  return HEX.test(raw) ? raw : "#888888";
};

/** A plain hex picker for the design's own palette, where tokens make no sense. */
export function HexControl({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const [text, setText] = useDraft(value);
  return (
    <div className="flex items-center gap-2">
      <input type="color" aria-label={`${label}: pick a colour`} value={HEX.test(value) ? value : "#000000"} onChange={(e) => onChange(e.target.value.toLowerCase())} className="size-8 shrink-0 cursor-pointer rounded-lg border border-line bg-surface p-0.5" />
      <TextControl aria-label={`${label}: hex code`} value={text} maxLength={7} onChange={(e) => { setText(e.target.value); const t = e.target.value.startsWith("#") ? e.target.value : `#${e.target.value}`; if (HEX.test(t)) onChange(t.toLowerCase()); }} className="font-mono" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

export const IconButton = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; tip?: string; side?: "top" | "right" | "bottom" | "left" }>(function IconButton(
  { label, active, tip, className, children, side = "bottom", ...p }, ref,
) {
  const btn = (
    <button ref={ref} type="button" aria-label={label} aria-pressed={active} {...p} className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink focus-visible:outline-2 focus-visible:outline-primary disabled:pointer-events-none disabled:opacity-40", active && "bg-primary-soft text-primary-ink", className)}>
      {children}
    </button>
  );
  return <Tooltip content={tip ?? label} side={side}>{btn}</Tooltip>;
});

export function PillButton({ children, className, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...p} className={cn("inline-flex h-7 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[12px] font-medium text-ink-2 transition-colors hover:border-line-strong hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50", className)}>{children}</button>;
}
