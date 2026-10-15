"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, ChevronDown, ImageIcon, Copy, Plus, Trash2, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import { Icon } from "@/components/website/render/icons";
import { Art } from "@/components/website/render/art";
import { defaultsFor, ICONS, type FieldSpec } from "@/lib/website/catalog";
import { safeHref, type ImageSrc } from "@/lib/website/doc";
import { pagePath } from "@/lib/website/doc";
import { cn } from "@/lib/utils";
import { AreaControl, ColorControl, IconButton, NumberControl, Row, Seg, SelectControl, TextControl, Toggle } from "./controls";
import { useServices } from "./context";
import { useDraft } from "./hooks";

type Rec = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Moves one item in a list a place earlier or later. */
export function moveItem<T>(rows: T[], index: number, delta: -1 | 1): T[] {
  const j = index + delta;
  if (j < 0 || j >= rows.length) return rows;
  const next = [...rows];
  [next[index], next[j]] = [next[j], next[index]];
  return next;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

type LinkKind = "none" | "page" | "phone" | "email" | "custom";

function kindOf(href: string, pages: Array<{ slug: string }>): LinkKind {
  if (!href) return "none";
  if (href.startsWith("tel:")) return "phone";
  if (href.startsWith("mailto:")) return "email";
  const path = href.split("#")[0];
  if (href.startsWith("/") && pages.some((p) => pagePath(p.slug) === (path === "" ? "/" : path))) return "page";
  return "custom";
}

/** Where a link goes: one of the site's pages, the business phone or email, or any address. Invalid addresses are explained, not saved. */
export function HrefControl({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const { pages, business } = useServices();
  // "A web address…" stays chosen while it is being typed, even if what is typed looks like a page.
  const [forceCustom, setForceCustom] = React.useState(false);
  const [draft, setDraft] = useDraft(value);
  const mode: LinkKind = forceCustom ? "custom" : kindOf(value, pages);
  const options: Array<{ value: LinkKind | string; label: string }> = [
    { value: "none", label: "No link" },
    ...pages.map((p) => ({ value: `page:${p.slug}`, label: `Page: ${p.title}` })),
    ...(business.phone ? [{ value: "phone", label: "Call the business phone" }] : []),
    ...(business.email ? [{ value: "email", label: "Email the business" }] : []),
    { value: "custom", label: "A web address…" },
  ];
  const current = mode === "page" ? `page:${pages.find((p) => pagePath(p.slug) === (value.split("#")[0] || "/"))?.slug ?? ""}` : mode;
  const check = safeHref(draft);
  const choose = (v: string) => {
    if (v === "custom") {
      setForceCustom(true);
      setDraft(value.startsWith("http") || value.startsWith("#") ? value : "https://");
      return;
    }
    setForceCustom(false);
    if (v === "none") return onChange("");
    if (v.startsWith("page:")) return onChange(pagePath(v.slice(5)));
    if (v === "phone") return onChange(`tel:${business.phone}`);
    if (v === "email") return onChange(`mailto:${business.email}`);
  };
  return (
    <div className="space-y-1.5">
      <SelectControl<string> label={label} value={current} options={options} onChange={choose} />
      {mode === "custom" && (
        <>
          <TextControl
            aria-label={`${label}: address`} value={draft} placeholder="https://… or #section" maxLength={300} aria-invalid={check === null}
            onChange={(e) => { setDraft(e.target.value); const ok = safeHref(e.target.value); if (ok !== null) onChange(ok); }}
          />
          {check === null && draft && <p role="alert" className="text-[11px] text-danger-ink">Use https://…, mailto:, tel:, a page like /about, or #anchor.</p>}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/** A small preview of whatever an image field holds. */
export function ImageThumb({ src, className }: { src: ImageSrc; className?: string }) {
  const { assets, assetUrl, design } = useServices();
  if (!src) return <span className={cn("flex items-center justify-center bg-surface-3 text-faint", className)}><ImageIcon className="size-4" aria-hidden /></span>;
  if (src.kind === "asset") {
    const a = assets.find((x) => x.id.toLowerCase() === src.id.toLowerCase());
    // eslint-disable-next-line @next/next/no-img-element
    return a ? <img src={assetUrl(a.id)} alt="" className={cn("object-cover", className)} /> : <span className={cn("flex items-center justify-center bg-warning-soft text-[9px] text-warning-ink", className)}>Missing</span>;
  }
  return <span className={cn("block overflow-hidden", className)} style={{ ["--c-primary" as string]: design.colors.primary, ["--c-accent" as string]: design.colors.accent }}><Art scene={src.scene} tone={src.tone} seed={src.seed} className="size-full" /></span>;
}

function ImageField({ value, onChange, label }: { value: ImageSrc; onChange: (v: ImageSrc) => void; label: string }) {
  const { openMedia } = useServices();
  const art = value?.kind === "art";
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-surface p-2">
      <ImageThumb src={value} className="size-14 shrink-0 rounded-lg" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="truncate text-[12px] font-medium text-ink-2">{!value ? "No image yet" : art ? "Built-in artwork" : "Your image"}</p>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" aria-label={`${label}: ${value ? "replace" : "choose"} image`} onClick={() => openMedia({ current: value, onPick: onChange, title: label })} className="h-6 rounded-md bg-primary-soft px-2 text-[11.5px] font-medium text-primary-ink hover:bg-primary/15">{value ? "Replace" : "Choose image"}</button>
          {value && <button type="button" onClick={() => onChange(null)} className="h-6 rounded-md px-2 text-[11.5px] font-medium text-muted hover:bg-surface-3 hover:text-ink">Remove</button>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function IconField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const [q, setQ] = React.useState("");
  const list = ICONS.filter((i) => i.includes(q.toLowerCase().trim()));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`${label}: ${value}`} className="flex h-8 w-full items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:border-line-strong">
          <Icon name={value} className="size-4 text-primary" />
          <span className="flex-1 truncate text-left capitalize">{value.replace(/-/g, " ")}</span>
          <ChevronDown className="size-3.5 text-muted" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <TextControl aria-label="Search icons" placeholder="Search icons" value={q} onChange={(e) => setQ(e.target.value)} className="mb-2" />
        <div className="grid max-h-56 grid-cols-7 gap-1 overflow-y-auto">
          {list.map((i) => (
            <button key={i} type="button" title={i.replace(/-/g, " ")} aria-label={i.replace(/-/g, " ")} aria-pressed={i === value} onClick={() => onChange(i)} className={cn("flex size-8 items-center justify-center rounded-lg hover:bg-surface-3", i === value && "bg-primary-soft text-primary-ink")}>
              <Icon name={i} className="size-4" />
            </button>
          ))}
          {!list.length && <p className="col-span-7 py-4 text-center text-[12px] text-muted">No icons match.</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// One field
// ---------------------------------------------------------------------------

const counter = (v: string, max: number) => (v.length > max * 0.8 ? <span className={cn("text-[10.5px] tabular-nums", v.length >= max ? "text-danger-ink" : "text-muted")}>{v.length}/{max}</span> : null);

export function FieldEditor({ spec, value, onChange, scope }: { spec: FieldSpec; value: unknown; onChange: (v: unknown) => void; scope: string }) {
  const id = `${scope}-${spec.key}`;
  const { design } = useServices();
  switch (spec.type) {
    case "text":
      return <Row label={spec.label} hint={spec.hint} htmlFor={id}><div className="space-y-1"><TextControl id={id} value={str(value)} maxLength={spec.max} placeholder={spec.placeholder} onChange={(e) => onChange(e.target.value)} />{counter(str(value), spec.max)}</div></Row>;
    case "longtext":
    case "markup":
      return (
        <Row label={spec.label} hint={spec.type === "markup" ? spec.hint ?? "Use **bold**, *emphasis* and [label](link)." : spec.hint} htmlFor={id}>
          <div className="space-y-1"><AreaControl id={id} rows={spec.rows ?? 3} value={str(value)} maxLength={spec.max} placeholder={spec.placeholder} onChange={(e) => onChange(e.target.value)} />{counter(str(value), spec.max)}</div>
        </Row>
      );
    case "link": {
      const v = (value ?? { label: "", href: "" }) as { label: string; href: string };
      return (
        <Row label={spec.label} hint={spec.hint}>
          <div className="space-y-1.5">
            <TextControl aria-label={`${spec.label}: text`} placeholder="Text" value={v.label} maxLength={60} onChange={(e) => onChange({ ...v, label: e.target.value })} />
            <HrefControl label={`${spec.label}: destination`} value={v.href} onChange={(href) => onChange({ ...v, href })} />
          </div>
        </Row>
      );
    }
    case "href":
      return <Row label={spec.label} hint={spec.hint}><HrefControl label={spec.label} value={str(value)} onChange={onChange} /></Row>;
    case "image":
      return <Row label={spec.label} hint={spec.hint}><ImageField label={spec.label} value={(value ?? null) as ImageSrc} onChange={onChange} /></Row>;
    case "select": {
      const seg = spec.ui === "segmented" || (spec.options.length <= 3 && spec.options.every((o) => o.label.length <= 12));
      return <Row label={spec.label} hint={spec.hint} htmlFor={id}>{seg ? <Seg label={spec.label} value={str(value)} options={spec.options} onChange={onChange} /> : <SelectControl id={id} value={str(value)} options={spec.options} onChange={onChange} />}</Row>;
    }
    case "toggle":
      return <Toggle label={spec.label} hint={spec.hint} checked={value === true} onChange={onChange} />;
    case "number":
      return <Row label={spec.label} hint={spec.hint}><NumberControl label={spec.label} value={typeof value === "number" ? value : spec.min} min={spec.min} max={spec.max} step={spec.step} unit={spec.unit} onChange={onChange} /></Row>;
    case "color": {
      return <Row label={spec.label} hint={spec.hint}><ColorControl label={spec.label} design={design} value={str(value) as never} onChange={(c) => onChange(c ?? "primary")} allowNone={false} /></Row>;
    }
    case "icon":
      return <Row label={spec.label} hint={spec.hint}><IconField label={spec.label} value={str(value) || "sparkles"} onChange={onChange} /></Row>;
    case "textlist": {
      const rows = Array.isArray(value) ? (value as string[]) : [];
      return (
        <Row label={spec.label} hint={spec.hint}>
          <ul className="space-y-1.5">
            {rows.map((t, i) => (
              <li key={i} className="flex items-center gap-1">
                <TextControl aria-label={`${spec.itemLabel} ${i + 1}`} value={t} maxLength={spec.itemMax} onChange={(e) => onChange(rows.map((r, k) => (k === i ? e.target.value : r)))} />
                <IconButton label={`Move ${spec.itemLabel} ${i + 1} up`} onClick={() => onChange(moveItem(rows, i, -1))} disabled={i === 0} className="size-7"><ArrowUp className="size-3.5" /></IconButton>
                <IconButton label={`Move ${spec.itemLabel} ${i + 1} down`} onClick={() => onChange(moveItem(rows, i, 1))} disabled={i === rows.length - 1} className="size-7"><ArrowDown className="size-3.5" /></IconButton>
                <IconButton label={`Remove ${spec.itemLabel} ${i + 1}`} onClick={() => onChange(rows.filter((_, k) => k !== i))} className="size-7"><X className="size-3.5" /></IconButton>
              </li>
            ))}
          </ul>
          {rows.length < spec.max && <button type="button" onClick={() => onChange([...rows, ""])} className="mt-1 inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[12px] font-medium text-primary-ink hover:bg-primary-soft"><Plus className="size-3.5" /> Add {spec.itemLabel}</button>}
        </Row>
      );
    }
    case "list": {
      const rows = (Array.isArray(value) ? value : []) as Rec[];
      return <ListEditor spec={spec} rows={rows} onChange={onChange} scope={id} />;
    }
  }
}

function ListEditor({ spec, rows, onChange, scope }: { spec: Extract<FieldSpec, { type: "list" }>; rows: Rec[]; onChange: (v: unknown) => void; scope: string }) {
  const [open, setOpen] = React.useState<number | null>(rows.length === 1 ? 0 : null);
  const summary = (r: Rec, i: number) => {
    const raw = spec.summary ? r[spec.summary] : undefined;
    const t = typeof raw === "string" ? raw.replace(/[*[\]]/g, "") : "";
    return t.trim() || `${spec.itemLabel[0].toUpperCase()}${spec.itemLabel.slice(1)} ${i + 1}`;
  };
  return (
    <Row label={spec.label} hint={spec.hint}>
      <ul className="space-y-1.5">
        {rows.map((r, i) => {
          const isOpen = open === i;
          return (
            <li key={i} className="overflow-hidden rounded-xl border border-line bg-surface">
              <div className="flex items-center gap-0.5 pr-1">
                <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : i)} className="flex min-h-9 flex-1 items-center gap-1.5 px-2.5 text-left text-[12.5px] font-medium text-ink-2 hover:text-ink">
                  <ChevronDown className={cn("size-3.5 shrink-0 text-muted transition-transform", !isOpen && "-rotate-90")} aria-hidden />
                  <span className="truncate">{summary(r, i)}</span>
                </button>
                <IconButton label={`Move ${spec.itemLabel} ${i + 1} up`} onClick={() => onChange(moveItem(rows, i, -1))} disabled={i === 0} className="size-7"><ArrowUp className="size-3.5" /></IconButton>
                <IconButton label={`Move ${spec.itemLabel} ${i + 1} down`} onClick={() => onChange(moveItem(rows, i, 1))} disabled={i === rows.length - 1} className="size-7"><ArrowDown className="size-3.5" /></IconButton>
                <IconButton label={`Duplicate ${spec.itemLabel} ${i + 1}`} onClick={() => rows.length < spec.max && onChange([...rows.slice(0, i + 1), structuredClone(r), ...rows.slice(i + 1)])} disabled={rows.length >= spec.max} className="size-7"><Copy className="size-3.5" /></IconButton>
                <IconButton label={`Remove ${spec.itemLabel} ${i + 1}`} onClick={() => { onChange(rows.filter((_, k) => k !== i)); setOpen(null); }} className="size-7"><Trash2 className="size-3.5" /></IconButton>
              </div>
              {isOpen && (
                <div className="space-y-3 border-t border-line bg-surface-2/50 p-3">
                  {spec.item.filter((f) => showField(f, r)).map((f) => (
                    <FieldEditor key={f.key} spec={f} scope={`${scope}-${i}`} value={r[f.key]} onChange={(v) => onChange(rows.map((x, k) => (k === i ? { ...x, [f.key]: v } : x)))} />
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {rows.length < spec.max && (
        <button type="button" onClick={() => { onChange([...rows, defaultsFor(spec.item)]); setOpen(rows.length); }} className="mt-1 inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[12px] font-medium text-primary-ink hover:bg-primary-soft">
          <Plus className="size-3.5" /> Add {spec.itemLabel}
        </button>
      )}
      <p className="text-[10.5px] text-muted">{rows.length} of {spec.max}</p>
    </Row>
  );
}

/** Whether a field's condition (`when`) is met by the values beside it. */
export function showField(f: FieldSpec, data: Rec): boolean {
  if (!f.when) return true;
  return f.when.in.includes(String(data[f.when.key]));
}
