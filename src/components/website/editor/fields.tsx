"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, ChevronDown, ImageIcon, Copy, Plus, Trash2, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import { Icon } from "@/components/website/render/icons";
import { Art } from "@/components/website/render/art";
import { defaultsFor, ICONS, type FieldSpec } from "@/lib/website/catalog";
import { safeHref, type ImageSrc } from "@/lib/website/doc";
import { templateImageDefault, withTemplateImageDefault } from "@/lib/website/template-images";
import { templateImageUrl } from "@/lib/website/template-image-assets";
import { SafeImage } from "@/components/website/render/safe-image";
import { pagePath } from "@/lib/website/doc";
import { defaultCalendar, durationLabel } from "@/lib/website/booking";
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
    if (a) return <SafeImage key={a.id} src={assetUrl(a.id)} fallbackSrc={src.default ? templateImageUrl(src.default.id) : undefined} alt="" className={cn("object-cover", className)} />;
    if (src.default) return <SafeImage key={src.default.id} src={templateImageUrl(src.default.id)} alt="" className={cn("object-cover", className)} />;
    return <span className={cn("flex items-center justify-center bg-warning-soft text-[9px] text-warning-ink", className)}>Missing</span>;
  }
  if (src.kind === "template") return <SafeImage key={src.id} src={templateImageUrl(src.id)} alt="" className={cn("object-cover", className)} />;
  return <span className={cn("block overflow-hidden", className)} style={{ ["--c-primary" as string]: design.colors.primary, ["--c-accent" as string]: design.colors.accent }}><Art scene={src.scene} tone={src.tone} seed={src.seed} className="size-full" /></span>;
}

function ImageField({ value, onChange, label }: { value: ImageSrc; onChange: (v: ImageSrc) => void; label: string }) {
  const { openMedia } = useServices();
  const fallback = templateImageDefault(value);
  const fieldLabel = fallback?.label ?? label;
  const art = value?.kind === "art";
  const starter = value?.kind === "template";
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-surface p-2">
      <ImageThumb src={value} className="size-14 shrink-0 rounded-lg" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="truncate text-[12px] font-medium text-ink-2">{!value ? "No image yet" : starter ? `Starter image · ${fieldLabel}` : art ? `Built-in artwork · ${fieldLabel}` : `Your image · ${fieldLabel}`}</p>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" aria-label={`${fieldLabel}: ${value ? "replace" : "choose"} image`} onClick={() => openMedia({ current: value, onPick: (picked) => onChange(withTemplateImageDefault(picked, value)), title: fieldLabel })} className="h-6 rounded-md bg-primary-soft px-2 text-[11.5px] font-medium text-primary-ink hover:bg-primary/15">{value ? "Replace" : "Choose image"}</button>
          {fallback && !starter && <button type="button" onClick={() => onChange(fallback)} className="h-6 rounded-md px-2 text-[11.5px] font-medium text-primary-ink hover:bg-primary-soft">Restore default</button>}
          {value && !fallback && <button type="button" onClick={() => onChange(null)} className="h-6 rounded-md px-2 text-[11.5px] font-medium text-muted hover:bg-surface-3 hover:text-ink">Remove</button>}
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
// Booking: the calendar and appointment type a booking element offers
// ---------------------------------------------------------------------------

const linkBtn = "text-[11.5px] font-medium text-primary-ink underline-offset-2 hover:underline";

function BookingWarning({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg bg-warning-soft px-2.5 py-2 text-[11.5px] leading-relaxed text-warning-ink">{children}</p>;
}

/**
 * The native CRM form a form element uses, by key (a key stays the same when a form is renamed), or the built-in enquiry form. A draft can
 * be chosen ahead of time but is flagged: until it is published, visitors see the built-in form.
 */
function FormPicker({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const { forms, refreshForms } = useServices();
  if (!forms) {
    return value
      ? <div className="flex items-center gap-2 text-[11.5px] text-muted"><span className="min-w-0 flex-1 truncate">Uses the CRM form &ldquo;{value}&rdquo; where a workspace has one.</span><button type="button" className={linkBtn} onClick={() => onChange("")}>Use the built-in form</button></div>
      : <p className="text-[11.5px] leading-relaxed text-muted">Uses the built-in enquiry form. A client&apos;s own CRM forms can be chosen on their website.</p>;
  }
  if (forms.state === "loading") return <p role="status" className="text-[11.5px] text-muted">Loading your forms…</p>;
  if (forms.state === "error") {
    return <div className="space-y-1"><p role="alert" className="text-[11.5px] text-danger-ink">{forms.message}</p><button type="button" className={linkBtn} onClick={refreshForms}>Try again</button></div>;
  }
  const o = forms.options;
  const chosen = value ? o.forms.find((f) => f.key === value) ?? null : null;
  const options = [
    { value: "", label: "Built-in enquiry form" },
    ...o.forms.map((f) => ({ value: f.key, label: `${f.name}${f.def ? "" : " (draft)"}` })),
    ...(value && !chosen ? [{ value, label: `${value} (not found)` }] : []),
  ];
  const warn = !o.available
    ? o.reason ?? "CRM forms can't be used on this website."
    : value && !chosen
      ? "This form doesn't exist in this workspace (or was archived), so visitors see the built-in enquiry form. Choose another one."
      : chosen && !chosen.def
        ? `“${chosen.name}” isn't published yet, so visitors see the built-in enquiry form until it is.`
        : null;
  return (
    <div className="space-y-1.5">
      <SelectControl<string> label={label} value={value} options={options} onChange={onChange} />
      {warn && <BookingWarning>{warn}</BookingWarning>}
      {chosen?.def && <p className="text-[11.5px] leading-relaxed text-muted">{chosen.def.questions.length} {chosen.def.questions.length === 1 ? "question" : "questions"}, version {chosen.def.version}. Questions, consent wording and what happens after sending are edited in the CRM. After sending, visitors see your website&apos;s thank-you page.</p>}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <a href={o.manageHref} target="_blank" rel="noreferrer" className={linkBtn}>Manage forms</a>
        <button type="button" onClick={refreshForms} className={linkBtn}>Refresh the list</button>
      </div>
    </div>
  );
}

/** Calendars come from the workspace, by slug (a slug stays the same when a calendar is renamed). Private ones can be chosen but are flagged, and publishing refuses them. */
function CalendarPicker({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const { booking, refreshBooking } = useServices();
  if (!booking) {
    return value
      ? <div className="flex items-center gap-2 text-[11.5px] text-muted"><span className="min-w-0 flex-1 truncate">Uses the calendar &ldquo;{value}&rdquo;.</span><button type="button" className={linkBtn} onClick={() => onChange("")}>Use the default</button></div>
      : <p className="text-[11.5px] leading-relaxed text-muted">Uses each client&apos;s default public calendar, so this works on any client&apos;s website.</p>;
  }
  if (booking.state === "loading") return <p role="status" className="text-[11.5px] text-muted">Loading your calendars…</p>;
  if (booking.state === "error") {
    return <div className="space-y-1"><p role="alert" className="text-[11.5px] text-danger-ink">{booking.message}</p><button type="button" className={linkBtn} onClick={refreshBooking}>Try again</button></div>;
  }
  const o = booking.options;
  const def = defaultCalendar(o.site);
  const chosen = value ? o.calendars.find((c) => c.slug === value) ?? null : null;
  const options = [
    { value: "", label: def ? `Default calendar (${def.name})` : "Default calendar" },
    ...o.calendars.map((c) => ({ value: c.slug, label: `${c.name}${c.public ? "" : " (private)"}` })),
    ...(value && !chosen ? [{ value, label: `${value} (no longer exists)` }] : []),
  ];
  const warn = !o.site.available
    ? o.unavailable
    : value && !chosen
      ? "This calendar no longer exists. Choose another one."
      : chosen && !chosen.public
        ? `"${chosen.name}" is private, so visitors can't book it. Make it public in the CRM, or choose another calendar.`
        : chosen && !o.site.calendars.some((c) => c.slug === chosen.slug)
          ? `"${chosen.name}" has no public appointment types yet.`
          : !value && !def
            ? "There's no public calendar with a public appointment type yet. Set one up in the CRM."
            : null;
  return (
    <div className="space-y-1.5">
      <SelectControl<string> label={label} value={value} options={options} onChange={onChange} />
      {warn && <BookingWarning>{warn} Your website can&apos;t be published until this is fixed.</BookingWarning>}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <a href={o.manageHref} target="_blank" rel="noreferrer" className={linkBtn}>Manage calendars</a>
        <button type="button" onClick={refreshBooking} className={linkBtn}>Refresh the list</button>
      </div>
    </div>
  );
}

function TypePicker({ label, value, calendar, onChange }: { label: string; value: string; calendar: string; onChange: (v: string) => void }) {
  const { booking } = useServices();
  if (!booking) {
    return value
      ? <div className="flex items-center gap-2 text-[11.5px] text-muted"><span className="min-w-0 flex-1 truncate">Offers only &ldquo;{value}&rdquo;.</span><button type="button" className={linkBtn} onClick={() => onChange("")}>Offer every type</button></div>
      : <p className="text-[11.5px] leading-relaxed text-muted">Offers every public appointment type in that calendar.</p>;
  }
  if (booking.state !== "ready") return null;
  const o = booking.options;
  const slug = calendar || defaultCalendar(o.site)?.slug || "";
  const cal = o.calendars.find((c) => c.slug === slug);
  if (!cal) return <p className="text-[11.5px] text-muted">Choose a calendar first.</p>;
  const chosen = value ? cal.types.find((t) => t.slug === value) ?? null : null;
  const options = [
    { value: "", label: "Every public type" },
    ...cal.types.map((t) => ({ value: t.slug, label: `${t.name} · ${durationLabel(t.durationMinutes)}${t.public ? "" : " (private)"}` })),
    ...(value && !chosen ? [{ value, label: `${value} (not in this calendar)` }] : []),
  ];
  const offered = chosen ? (chosen.public ? [chosen] : []) : cal.types.filter((t) => t.public);
  const warn = value && !chosen
    ? "This type isn't in the chosen calendar. Choose another one."
    : chosen && !chosen.public
      ? `"${chosen.name}" is private, so visitors can't book it.`
      : null;
  return (
    <div className="space-y-1.5">
      <SelectControl<string> label={label} value={value} options={options} onChange={onChange} />
      {warn && <BookingWarning>{warn}</BookingWarning>}
      {offered.length > 0 && <p className="text-[11px] leading-relaxed text-muted">Visitors can book: {offered.map((t) => `${t.name} (${durationLabel(t.durationMinutes)})`).join(", ")}.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One field
// ---------------------------------------------------------------------------

const counter = (v: string, max: number) => (v.length > max * 0.8 ? <span className={cn("text-[10.5px] tabular-nums", v.length >= max ? "text-danger-ink" : "text-muted")}>{v.length}/{max}</span> : null);

/** One field of an element. `siblings` are the element's other values, for fields that depend on another (an appointment type on its calendar). */
export function FieldEditor({ spec, value, onChange, scope, siblings }: { spec: FieldSpec; value: unknown; onChange: (v: unknown) => void; scope: string; siblings?: Rec }) {
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
    case "calendarRef":
      return <Row label={spec.label} hint={spec.hint}><CalendarPicker label={spec.label} value={str(value)} onChange={onChange} /></Row>;
    case "formRef":
      return <Row label={spec.label} hint={spec.hint}><FormPicker label={spec.label} value={str(value)} onChange={onChange} /></Row>;
    case "bookingTypeRef":
      return <Row label={spec.label} hint={spec.hint}><TypePicker label={spec.label} value={str(value)} calendar={str(siblings?.[spec.calendarKey])} onChange={onChange} /></Row>;
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
