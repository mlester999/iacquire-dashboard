"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, ImageIcon, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/overlays";
import { Input, Select, Textarea } from "@/components/ui/primitives";
import { safeHref } from "@/lib/website/schema";
import { addListRow, moveRow, removeRow } from "@/lib/website/edit";
import type { FieldSpec } from "@/lib/website/sections";
import type { AssetView } from "@/server/assets/service";
import { cn } from "@/lib/utils";

export interface EditorEnv {
  assets: AssetView[];
  pages: Array<{ slug: string; title: string }>;
  /** Opens the image library. `apply` receives the chosen asset id, or null to clear. */
  pickImage: (current: string | null, apply: (id: string | null) => void) => void;
}

type Value = Record<string, unknown>;
const text = (v: unknown) => (typeof v === "string" ? v : "");

function Label({ htmlFor, children, hint, count, max }: { htmlFor: string; children: React.ReactNode; hint?: string; count?: number; max?: number }) {
  const near = max !== undefined && count !== undefined && count > max * 0.8;
  return (
    <div className="mb-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink-2">
          {children}
        </label>
        {near && (
          <span className={cn("text-[11.5px] tabular-nums", count! >= max! ? "text-danger-ink" : "text-muted")} aria-live="polite">
            {count}/{max}
          </span>
        )}
      </div>
      {hint && <p className="mt-0.5 text-[12px] leading-snug text-muted">{hint}</p>}
    </div>
  );
}

export function FieldForm({ fields, value, onChange, env, idPrefix }: { fields: FieldSpec[]; value: Value; onChange: (next: Value) => void; env: EditorEnv; idPrefix: string }) {
  const set = (key: string, v: unknown) => onChange({ ...value, [key]: v });
  return (
    <div className="space-y-4">
      {fields.map((f) => (
        <FieldEditor key={f.key} spec={f} value={value[f.key]} onChange={(v) => set(f.key, v)} env={env} id={`${idPrefix}-${f.key}`} />
      ))}
    </div>
  );
}

function FieldEditor({ spec, value, onChange, env, id }: { spec: FieldSpec; value: unknown; onChange: (v: unknown) => void; env: EditorEnv; id: string }) {
  switch (spec.type) {
    case "text":
      return (
        <div>
          <Label htmlFor={id} hint={spec.hint} count={text(value).length} max={spec.max}>{spec.label}</Label>
          <Input id={id} value={text(value)} maxLength={spec.max} placeholder={spec.placeholder} onChange={(e) => onChange(e.target.value)} />
        </div>
      );
    case "longtext":
      return (
        <div>
          <Label htmlFor={id} hint={spec.hint} count={text(value).length} max={spec.max}>{spec.label}</Label>
          <Textarea id={id} rows={spec.max > 600 ? 7 : 4} value={text(value)} maxLength={spec.max} placeholder={spec.placeholder} onChange={(e) => onChange(e.target.value)} />
        </div>
      );
    case "select":
      return (
        <div>
          <Label htmlFor={id} hint={spec.hint}>{spec.label}</Label>
          <Select id={id} value={text(value)} onChange={(e) => onChange(e.target.value)}>
            {spec.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
      );
    case "toggle":
      return (
        <div className="flex items-start justify-between gap-4 rounded-xl border border-line bg-surface-2/50 px-3.5 py-3">
          <div className="min-w-0">
            <label htmlFor={id} className="text-[13px] font-medium text-ink-2">{spec.label}</label>
            {spec.hint && <p className="mt-0.5 text-[12px] leading-snug text-muted">{spec.hint}</p>}
          </div>
          <Switch id={id} checked={value === true} onCheckedChange={onChange} aria-label={spec.label} />
        </div>
      );
    case "color":
      return (
        <div>
          <Label htmlFor={id} hint={spec.hint}>{spec.label}</Label>
          <div className="flex items-center gap-3">
            <input aria-label={`${spec.label} picker`} type="color" value={/^#[0-9a-f]{6}$/i.test(text(value)) ? text(value) : "#2c5bff"} onChange={(e) => onChange(e.target.value)} className="size-11 shrink-0 cursor-pointer rounded-xl border border-line-strong bg-surface p-1" />
            <Input id={id} value={text(value)} maxLength={7} placeholder="#2c5bff" onChange={(e) => onChange(e.target.value.trim())} />
          </div>
        </div>
      );
    case "link":
      return <LinkEditor spec={spec} value={(value as { label?: string; href?: string }) ?? {}} onChange={onChange} env={env} id={id} />;
    case "image":
      return <ImageEditor spec={spec} value={typeof value === "string" ? value : null} onChange={onChange} env={env} id={id} />;
    case "textlist":
      return <TextListEditor spec={spec} value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} id={id} />;
    case "list":
      return <ListEditor spec={spec} value={Array.isArray(value) ? (value as Value[]) : []} onChange={onChange} env={env} id={id} />;
  }
}

function LinkEditor({ spec, value, onChange, env, id }: { spec: Extract<FieldSpec, { type: "link" }>; value: { label?: string; href?: string }; onChange: (v: unknown) => void; env: EditorEnv; id: string }) {
  const href = value.href ?? "";
  const bad = href !== "" && safeHref(href) === null;
  const set = (patch: Partial<{ label: string; href: string }>) => onChange({ label: value.label ?? "", href, ...patch });
  return (
    <fieldset className="space-y-2 rounded-xl border border-line p-3">
      <legend className="px-1 text-[13px] font-medium text-ink-2">{spec.label}</legend>
      <div>
        <Label htmlFor={`${id}-label`}>Button text</Label>
        <Input id={`${id}-label`} value={value.label ?? ""} maxLength={60} onChange={(e) => set({ label: e.target.value })} />
      </div>
      <div>
        <Label htmlFor={`${id}-href`}>Goes to</Label>
        <Input id={`${id}-href`} value={href} maxLength={300} placeholder="/contact, tel:+15125550100 or https://…" aria-invalid={bad || undefined} aria-describedby={bad ? `${id}-err` : undefined} onChange={(e) => set({ href: e.target.value.trim() })} />
        {bad && (
          <p id={`${id}-err`} role="alert" className="mt-1 text-[12px] text-danger-ink">
            Use a page (/contact), a phone (tel:+1…), an email (mailto:…) or a web address (https://…).
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {env.pages.map((p) => (
            <button key={p.slug} type="button" onClick={() => set({ href: p.slug === "home" ? "/" : `/${p.slug}` })} className="rounded-full border border-line px-2.5 py-1 text-[12px] text-ink-2 hover:border-primary/40 hover:text-ink">
              {p.title}
            </button>
          ))}
        </div>
      </div>
      {(value.label || href) && (
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ label: "", href: "" })}>
          <X className="size-3.5" /> Remove button
        </Button>
      )}
    </fieldset>
  );
}

function ImageEditor({ spec, value, onChange, env, id }: { spec: Extract<FieldSpec, { type: "image" }>; value: string | null; onChange: (v: unknown) => void; env: EditorEnv; id: string }) {
  const asset = value ? env.assets.find((a) => a.id.toLowerCase() === value.toLowerCase()) : undefined;
  return (
    <div>
      <Label htmlFor={id} hint={spec.hint}>{spec.label}</Label>
      <div className="flex items-center gap-3">
        <div className="checkerboard flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-line">
          {asset ? (
            // eslint-disable-next-line @next/next/no-img-element -- private, authenticated image route
            <img src={asset.url} alt={asset.altText || "Selected image"} className="max-h-full max-w-full object-contain" />
          ) : (
            <ImageIcon className="size-6 text-muted" aria-hidden />
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button id={id} type="button" variant="secondary" size="sm" onClick={() => env.pickImage(value, (picked) => onChange(picked))}>
            {asset ? "Change image" : "Choose image"}
          </Button>
          {asset && (
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
              Remove
            </Button>
          )}
        </div>
      </div>
      {value && !asset && <p className="mt-1.5 text-[12px] text-danger-ink">This image is no longer in your library.</p>}
    </div>
  );
}

function TextListEditor({ spec, value, onChange, id }: { spec: Extract<FieldSpec, { type: "textlist" }>; value: string[]; onChange: (v: unknown) => void; id: string }) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-[13px] font-medium text-ink-2">{spec.label}</legend>
      {spec.hint && <p className="-mt-1 text-[12px] text-muted">{spec.hint}</p>}
      {value.map((item, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input aria-label={`${spec.itemLabel} ${i + 1}`} id={`${id}-${i}`} value={item} maxLength={spec.itemMax} onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))} />
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move ${spec.itemLabel} ${i + 1} up`} disabled={i === 0} onClick={() => onChange(moveRow(value, i, -1))}>
            <ArrowUp className="size-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move ${spec.itemLabel} ${i + 1} down`} disabled={i === value.length - 1} onClick={() => onChange(moveRow(value, i, 1))}>
            <ArrowDown className="size-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${spec.itemLabel} ${i + 1}`} onClick={() => onChange(removeRow(value, i))}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      {value.length < spec.max && (
        <Button type="button" variant="secondary" size="sm" onClick={() => onChange([...value, ""])}>
          <Plus className="size-3.5" /> Add {spec.itemLabel}
        </Button>
      )}
    </fieldset>
  );
}

function ListEditor({ spec, value, onChange, env, id }: { spec: Extract<FieldSpec, { type: "list" }>; value: Value[]; onChange: (v: unknown) => void; env: EditorEnv; id: string }) {
  const title = (row: Value, i: number) => {
    const key = ["title", "name", "question", "quote", "label", "value"].find((k) => typeof row[k] === "string" && row[k]);
    return key ? String(row[key]).slice(0, 48) : `${spec.itemLabel[0].toUpperCase()}${spec.itemLabel.slice(1)} ${i + 1}`;
  };
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-[13px] font-medium text-ink-2">{spec.label}</legend>
      {value.map((row, i) => (
        <details key={i} className="group overflow-hidden rounded-xl border border-line bg-surface" open={value.length <= 2 || undefined}>
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-[13.5px] font-medium focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
            <span className="min-w-0 truncate">{title(row, i)}</span>
            <span className="text-[12px] text-muted group-open:hidden">Edit</span>
          </summary>
          <div className="space-y-4 border-t border-line p-3">
            <FieldForm fields={spec.item} value={row} onChange={(next) => onChange(value.map((r, j) => (j === i ? next : r)))} env={env} idPrefix={`${id}-${i}`} />
            <div className="flex flex-wrap gap-1.5">
              <Button type="button" variant="ghost" size="sm" disabled={i === 0} onClick={() => onChange(moveRow(value, i, -1))}>
                <ArrowUp className="size-3.5" /> Move up
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={i === value.length - 1} onClick={() => onChange(moveRow(value, i, 1))}>
                <ArrowDown className="size-3.5" /> Move down
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => onChange(removeRow(value, i))}>
                <Trash2 className="size-3.5" /> Remove
              </Button>
            </div>
          </div>
        </details>
      ))}
      {value.length < spec.max ? (
        <Button type="button" variant="secondary" size="sm" onClick={() => onChange(addListRow(spec, value))}>
          <Plus className="size-3.5" /> Add {spec.itemLabel}
        </Button>
      ) : (
        <p className="text-[12px] text-muted">That&apos;s the most you can add here ({spec.max}).</p>
      )}
    </fieldset>
  );
}
