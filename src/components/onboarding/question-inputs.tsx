"use client";

import * as React from "react";
import { toast } from "sonner";
import { Check, FileText, ImagePlus, Loader2, Plus, Trash2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/primitives";
import { useOnboardingApi } from "@/components/onboarding/onboarding-api";
import { questionOptions } from "@/lib/onboarding/definitions";
import type { AnswerValue, Answers, ListField, QuestionDef } from "@/lib/onboarding/types";
import type { AssetView } from "@/server/assets/service";
import { WEEKDAYS, type BusinessHours, type Weekday } from "@/lib/messaging";
import { cn } from "@/lib/utils";

export interface DocumentSummary {
  id: string;
  filename: string;
}

export interface InputProps {
  inputId?: string;
  q: QuestionDef;
  value: AnswerValue | undefined;
  answers: Answers;
  error: string | null;
  onChange: (value: AnswerValue) => void;
  assets: AssetView[];
  onAssetsChange: (next: AssetView[]) => void;
  documents: DocumentSummary[];
  onDocumentsChange: (next: DocumentSummary[]) => void;
  /** Called after an image or document is added or removed so the answer list stays in step. */
  onFilesChange: (ids: string[]) => void;
}

const INPUT_ID = "onboarding-input";
const subscribe = () => () => undefined;
function useIsClient() {
  return React.useSyncExternalStore(subscribe, () => true, () => false);
}

export function QuestionInput(props: InputProps) {
  const { q } = props;
  switch (q.kind.type) {
    case "text":
    case "email":
    case "phone":
    case "url":
      return <TextLike {...props} />;
    case "longtext":
      return (
        <Textarea
          id={props.inputId ?? INPUT_ID}
          aria-label={q.title}
          rows={q.kind.rows ?? 4}
          maxLength={q.kind.max}
          value={typeof props.value === "string" ? props.value : ""}
          placeholder={q.kind.placeholder}
          aria-invalid={Boolean(props.error) || undefined}
          aria-describedby={props.error ? `${props.inputId ?? INPUT_ID}-error` : undefined}
          onChange={(e) => props.onChange(e.target.value)}
        />
      );
    case "timezone":
      return <TimezoneInput {...props} />;
    case "choice":
      return <ChoiceInput {...props} />;
    case "multi":
      return <MultiInput {...props} />;
    case "yesno":
      return <YesNoInput {...props} />;
    case "hours":
      return <HoursInput {...props} />;
    case "list":
      return <ListInput {...props} />;
    case "color":
      return <ColorInput {...props} />;
    case "files":
      return <FilesInput {...props} />;
    default:
      return null;
  }
}

function TextLike({ q, value, error, onChange, inputId = INPUT_ID }: InputProps) {
  const t = q.kind.type;
  const max = q.kind.type === "text" ? q.kind.max : 320;
  const placeholder = q.kind.type === "text" ? q.kind.placeholder : q.example;
  return (
    <Input
      id={inputId}
      aria-label={q.title}
      type={t === "email" ? "email" : t === "phone" ? "tel" : "text"}
      inputMode={t === "url" ? "url" : t === "phone" ? "tel" : t === "email" ? "email" : undefined}
      autoComplete={t === "email" ? "email" : t === "phone" ? "tel" : "off"}
      maxLength={max}
      value={typeof value === "string" ? value : ""}
      placeholder={placeholder}
      aria-invalid={Boolean(error) || undefined}
      aria-describedby={error ? `${inputId}-error` : undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function TimezoneInput({ q, value, error, onChange, inputId = INPUT_ID }: InputProps) {
  const client = useIsClient();
  const zones = React.useMemo(() => {
    if (!client) return [];
    try {
      return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone");
    } catch {
      return [];
    }
  }, [client]);
  const current = typeof value === "string" ? value : "";
  const device = client ? Intl.DateTimeFormat().resolvedOptions().timeZone : "";
  return (
    <div className="space-y-3">
      <Select id={inputId} aria-label={q.title} value={current} aria-invalid={Boolean(error) || undefined} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose a time zone</option>
        {current && !zones.includes(current) && <option value={current}>{current}</option>}
        {zones.map((z) => (
          <option key={z} value={z}>
            {z.replace(/_/g, " ")}
          </option>
        ))}
      </Select>
      {device && device !== current && (
        <Button type="button" variant="soft" size="sm" onClick={() => onChange(device)}>
          Use my device&apos;s time zone ({device.replace(/_/g, " ")})
        </Button>
      )}
    </div>
  );
}

function OptionCard({ label, description, selected, onClick, role, disabled }: { label: string; description?: string; selected: boolean; onClick: () => void; role: "radio" | "checkbox"; disabled?: boolean }) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "group relative flex min-h-12 w-full items-start gap-3 rounded-xl border p-3.5 text-left transition-[border-color,background-color] duration-150 motion-reduce:transition-none",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50",
        selected ? "border-primary bg-primary-soft/60 ring-1 ring-primary/15" : "border-line bg-surface hover:border-line-strong",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center border-2 transition-colors",
          role === "radio" ? "rounded-full" : "rounded-md",
          selected ? "border-primary bg-primary text-white" : "border-line-strong",
        )}
      >
        {selected && <Check className="size-3" strokeWidth={3} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14.5px] font-medium leading-snug text-ink">{label}</span>
        {description && <span className="mt-1 block text-[14px] leading-relaxed text-muted">{description}</span>}
      </span>
    </button>
  );
}

function ChoiceInput({ q, value, answers, onChange }: InputProps) {
  const options = questionOptions(q, answers);
  return (
    <div role="radiogroup" aria-label={q.title} className={cn("grid gap-2.5", options.length > 4 && "sm:grid-cols-2")}>
      {options.map((o) => (
        <OptionCard key={o.value} role="radio" label={o.label} description={o.description} selected={value === o.value} onClick={() => onChange(o.value)} />
      ))}
    </div>
  );
}

function MultiInput({ q, value, answers, onChange }: InputProps) {
  const options = questionOptions(q, answers);
  const selected = Array.isArray(value) ? (value as string[]) : [];
  const max = q.kind.type === "multi" ? q.kind.max : undefined;
  return (
    <div>
      <div role="group" aria-label={q.title} className="grid gap-2.5 sm:grid-cols-2">
        {options.map((o) => {
          const on = selected.includes(o.value);
          return (
            <OptionCard
              key={o.value}
              role="checkbox"
              label={o.label}
              description={o.description}
              selected={on}
              disabled={!on && max !== undefined && selected.length >= max}
              onClick={() => onChange(on ? selected.filter((v) => v !== o.value) : [...selected, o.value])}
            />
          );
        })}
      </div>
      {max && <p className="mt-2 text-[13px] text-muted">Choose up to {max}.</p>}
    </div>
  );
}

function YesNoInput({ q, value, onChange }: InputProps) {
  return (
    <div role="radiogroup" aria-label={q.title} className="grid gap-2.5 sm:grid-cols-2">
      <OptionCard role="radio" label="Yes" selected={value === true} onClick={() => onChange(true)} />
      <OptionCard role="radio" label="No" selected={value === false} onClick={() => onChange(false)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Weekly hours
// ---------------------------------------------------------------------------

const DAY_LABEL: Record<Weekday, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const WEEK_ORDER: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function HoursInput({ value, onChange }: InputProps) {
  const hours = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as BusinessHours;
  const set = (next: BusinessHours) => onChange(next as unknown as AnswerValue);
  const setDay = (day: Weekday, ranges: Array<[string, string]>) => {
    const next = { ...hours };
    if (ranges.length) next[day] = ranges;
    else delete next[day];
    set(next);
  };
  const preset = (days: Weekday[], from: string, to: string) => set(Object.fromEntries(days.map((d) => [d, [[from, to]]])) as BusinessHours);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="soft" size="sm" onClick={() => preset(["mon", "tue", "wed", "thu", "fri"], "09:00", "17:00")}>
          Mon–Fri, 9 to 5
        </Button>
        <Button type="button" variant="soft" size="sm" onClick={() => preset([...WEEKDAYS], "00:00", "23:59")}>
          Open 24/7
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => set({})}>
          Clear
        </Button>
      </div>
      <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
        {WEEK_ORDER.map((day) => {
          const ranges = hours[day] ?? [];
          const open = ranges.length > 0;
          return (
            <li key={day} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <label className="flex min-h-11 w-36 cursor-pointer items-center gap-2.5 text-[14px] font-medium">
                <input
                  type="checkbox"
                  className="size-5 accent-[var(--primary)]"
                  checked={open}
                  onChange={(e) => setDay(day, e.target.checked ? [["09:00", "17:00"]] : [])}
                />
                {DAY_LABEL[day]}
              </label>
              {open ? (
                <div className="flex flex-1 flex-wrap items-center gap-2">
                  {ranges.map(([from, to], i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <Input aria-label={`${DAY_LABEL[day]} opens`} type="time" value={from} className="w-[7.5rem]" onChange={(e) => setDay(day, ranges.map((r, j) => (j === i ? [e.target.value, r[1]] : r)) as Array<[string, string]>)} />
                      <span aria-hidden className="text-muted">
                        –
                      </span>
                      <Input aria-label={`${DAY_LABEL[day]} closes`} type="time" value={to} className="w-[7.5rem]" onChange={(e) => setDay(day, ranges.map((r, j) => (j === i ? [r[0], e.target.value] : r)) as Array<[string, string]>)} />
                      {ranges.length > 1 && (
                        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${DAY_LABEL[day]} shift`} onClick={() => setDay(day, ranges.filter((_, j) => j !== i))}>
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                  {ranges.length < 2 && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setDay(day, [...ranges, ["13:00", "17:00"]])}>
                      <Plus className="size-3.5" /> Add a shift
                    </Button>
                  )}
                </div>
              ) : (
                <span className="text-[14px] text-muted">Closed</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Repeatable rows
// ---------------------------------------------------------------------------

function ListInput({ q, value, onChange, inputId = INPUT_ID }: InputProps) {
  if (q.kind.type !== "list") return null;
  const { fields, maxRows, addLabel } = q.kind;
  const rows = (Array.isArray(value) ? value : []) as Array<Record<string, string>>;
  const blank = () => Object.fromEntries(fields.map((f) => [f.key, ""]));
  const update = (i: number, key: string, v: string) => onChange(rows.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
  return (
    <div className="space-y-3">
      {rows.map((row, i) => (
        <div key={i} className="rounded-2xl border border-line bg-surface p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((f) => (
              <ListFieldInput key={f.key} field={f} value={row[f.key] ?? ""} id={`${inputId}-${i}-${f.key}`} wide={f.type === "longtext"} onChange={(v) => update(i, f.key, v)} />
            ))}
          </div>
          <div className="mt-3 flex justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              <Trash2 className="size-3.5" /> Remove
            </Button>
          </div>
        </div>
      ))}
      {rows.length < maxRows && (
        <Button type="button" variant="secondary" onClick={() => onChange([...rows, blank()])}>
          <Plus className="size-4" /> {addLabel}
        </Button>
      )}
    </div>
  );
}

function ListFieldInput({ field, value, id, wide, onChange }: { field: ListField; value: string; id: string; wide: boolean; onChange: (v: string) => void }) {
  return (
    <div className={cn("space-y-1.5", wide && "sm:col-span-2")}>
      <label htmlFor={id} className="text-[14px] font-medium text-ink-2">
        {field.label}
      </label>
      {field.type === "select" ? (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      ) : field.type === "longtext" ? (
        <Textarea id={id} rows={3} maxLength={field.max} value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input
          id={id}
          type={field.type === "email" ? "email" : field.type === "number" ? "number" : "text"}
          inputMode={field.type === "number" ? "numeric" : undefined}
          min={field.type === "number" ? 1 : undefined}
          maxLength={field.max}
          value={value}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

const SWATCHES = ["#2c5bff", "#7a5cff", "#12c9a5", "#e5484d", "#ff9500", "#0a0d14"];

function ColorInput({ value, error, onChange }: InputProps) {
  const v = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as { primary?: string; accent?: string };
  const set = (patch: { primary?: string; accent?: string }) => onChange({ primary: v.primary ?? "", accent: v.accent ?? "", ...patch });
  const row = (key: "primary" | "accent", label: string) => (
    <div className="space-y-2">
      <label htmlFor={`${INPUT_ID}-${key}`} className="text-[14px] font-medium text-ink-2">
        {label}
      </label>
      <div className="flex items-center gap-3">
        <input
          aria-label={`${label} colour picker`}
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(v[key] ?? "") ? v[key] : "#2c5bff"}
          onChange={(e) => set({ [key]: e.target.value })}
          className="size-11 shrink-0 cursor-pointer rounded-xl border border-line-strong bg-surface p-1"
        />
        <Input id={`${INPUT_ID}-${key}`} value={v[key] ?? ""} placeholder="#2c5bff" maxLength={7} aria-invalid={Boolean(error) || undefined} onChange={(e) => set({ [key]: e.target.value.trim() })} />
      </div>
      <div className="flex flex-wrap gap-2">
        {SWATCHES.map((s) => (
          <button key={s} type="button" aria-label={`${label}: ${s}`} onClick={() => set({ [key]: s })} className={cn("size-7 rounded-full border-2 transition-transform hover:scale-110", v[key] === s ? "border-ink" : "border-surface shadow-soft")} style={{ background: s }} />
        ))}
      </div>
    </div>
  );
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      {row("primary", "Main colour")}
      {row("accent", "Accent colour")}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

function FilesInput({ q, value, assets, onAssetsChange, documents, onDocumentsChange, onFilesChange }: InputProps) {
  const api = useOnboardingApi();
  const [busy, setBusy] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  if (q.kind.type !== "files") return null;
  const { assetKind, max } = q.kind;
  const ids = Array.isArray(value) ? (value as string[]) : [];
  const isDocument = assetKind === "document";

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    let nextIds = [...ids];
    let nextAssets = assets;
    let nextDocs = documents;
    for (const file of Array.from(files)) {
      if (nextIds.length >= max) {
        toast.error(`You can add up to ${max} file${max === 1 ? "" : "s"} here.`);
        break;
      }
      if (isDocument) {
        const res = await api.uploadDocument(file);
        if (!res.ok) {
          toast.error(res.error);
          continue;
        }
        nextDocs = [...nextDocs, res.data];
        nextIds = [...nextIds, res.data.id];
      } else {
        const res = await api.uploadImage(assetKind as "logo" | "image" | "reference", file);
        if (!res.ok) {
          toast.error(res.error);
          continue;
        }
        nextAssets = [...nextAssets.filter((a) => a.id !== res.data.id), res.data];
        nextIds = [...nextIds, res.data.id];
        if (assetKind === "logo" && res.data.processingNote) toast(res.data.processingNote);
      }
    }
    if (nextDocs !== documents) onDocumentsChange(nextDocs);
    if (nextAssets !== assets) onAssetsChange(nextAssets);
    if (nextIds.length !== ids.length) onFilesChange(nextIds);
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  const remove = async (id: string) => {
    if (!isDocument) {
      const res = await api.removeAsset(id);
      if (!res.ok) return void toast.error(res.error);
      onAssetsChange(assets.filter((a) => a.id !== id));
    }
    onFilesChange(ids.filter((x) => x !== id));
  };

  const accept = isDocument ? ".pdf,.docx,.txt,.md,.csv" : "image/png,image/jpeg,image/webp";
  return (
    <div className="space-y-4">
      {ids.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2">
          {ids.map((id) => {
            const asset = assets.find((a) => a.id === id);
            const doc = documents.find((d) => d.id === id);
            return (
              <li key={id} className="rounded-2xl border border-line bg-surface p-3">
                {asset ? <AssetCard asset={asset} onChange={(a) => onAssetsChange(assets.map((x) => (x.id === a.id ? a : x)))} /> : (
                  <div className="flex items-center gap-3">
                    <span className="flex size-10 items-center justify-center rounded-xl bg-surface-2 text-muted">
                      <FileText className="size-5" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{doc?.filename ?? "Document"}</span>
                  </div>
                )}
                <div className="mt-2 flex justify-end">
                  <Button type="button" variant="ghost" size="sm" onClick={() => void remove(id)}>
                    <Trash2 className="size-3.5" /> {isDocument ? "Remove from this list" : "Remove"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {ids.length < max && (
        <div>
          <input ref={inputRef} id={INPUT_ID} type="file" className="sr-only" accept={accept} multiple={max > 1} onChange={(e) => void upload(e.target.files)} />
          <label
            htmlFor={INPUT_ID}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-line-strong bg-surface-2/50 px-6 py-8 text-center transition-colors hover:border-primary/50 hover:bg-primary-soft/30",
              "focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary",
              busy && "pointer-events-none opacity-70",
            )}
          >
            {busy ? <Loader2 className="size-6 animate-spin text-primary" /> : <ImagePlus className="size-6 text-primary" />}
            <span className="text-[14px] font-medium">{busy ? "Uploading…" : isDocument ? "Choose documents" : assetKind === "logo" ? "Choose your logo" : "Choose images"}</span>
            <span className="text-[13px] text-muted">{isDocument ? "PDF, Word, text, Markdown or CSV, up to 10 MB each" : "PNG, JPG or WebP, up to 10 MB. A white background is fine."}</span>
          </label>
        </div>
      )}
    </div>
  );
}

function AssetCard({ asset, onChange }: { asset: AssetView; onChange: (a: AssetView) => void }) {
  const api = useOnboardingApi();
  const [busy, setBusy] = React.useState(false);
  const choose = async (variant: "original" | "processed") => {
    if (variant === asset.useVariant) return;
    setBusy(true);
    const res = await api.setAssetVariant(asset.id, variant);
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    onChange({ ...asset, useVariant: variant });
  };
  const src = asset.useVariant === "processed" && asset.processedUrl ? asset.processedUrl : asset.url;
  return (
    <div className="space-y-3">
      <div className="checkerboard flex h-32 items-center justify-center overflow-hidden rounded-xl border border-line">
        {/* eslint-disable-next-line @next/next/no-img-element -- private, authenticated image route */}
        <img src={src} alt={asset.altText || "Uploaded image"} className="max-h-full max-w-full object-contain" />
      </div>
      {asset.kind === "logo" && (
        <div className="space-y-2">
          {asset.hasProcessed ? (
            <div role="radiogroup" aria-label="Logo version" className="grid grid-cols-2 gap-2">
              {(["original", "processed"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={asset.useVariant === v}
                  disabled={busy}
                  onClick={() => void choose(v)}
                  className={cn("rounded-xl border px-3 py-2 text-[13px] font-medium transition", asset.useVariant === v ? "border-primary bg-primary-soft text-primary-ink" : "border-line hover:border-line-strong")}
                >
                  {v === "original" ? "Original" : "Transparent"}
                </button>
              ))}
            </div>
          ) : null}
          {asset.processingNote && (
            <p className="flex items-start gap-1.5 text-[13px] leading-relaxed text-muted">
              <Wand2 className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {asset.processingNote}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
