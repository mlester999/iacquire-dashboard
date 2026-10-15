"use client";

import * as React from "react";
import { Check, ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import { FONTS, FONT_KEYS, type FontKey } from "@/lib/website/font-keys";
import { type Design, type SiteContent } from "@/lib/website/doc";
import { cn } from "@/lib/utils";
import { AreaControl, Group, HexControl, NumberControl, Row, Seg, SelectControl, TextControl, Toggle } from "./controls";
import { FieldEditor } from "./fields";
import { useDraft } from "./hooks";

type Commit = (doc: SiteContent, o?: { coalesce?: string }) => void;

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

function FontPicker({ value, onChange, label }: { value: FontKey; onChange: (k: FontKey) => void; label: string }) {
  const [q, setQ] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const list = FONT_KEYS.filter((k) => FONTS[k].label.toLowerCase().includes(q.toLowerCase()));
  const groups = (["serif", "sans", "display", "mono"] as const).map((c) => ({ c, items: list.filter((k) => FONTS[k].category === c) })).filter((g) => g.items.length);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`${label}: ${FONTS[value].label}`} className="flex h-9 w-full items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-left hover:border-line-strong">
          <span className="min-w-0 flex-1 truncate text-[14px]" style={{ fontFamily: `var(${FONTS[value].variable}), ${FONTS[value].fallback}` }}>{FONTS[value].label}</span>
          <ChevronDown className="size-3.5 text-muted" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <TextControl aria-label="Search fonts" placeholder="Search fonts" value={q} onChange={(e) => setQ(e.target.value)} className="mb-2" autoFocus />
        <div className="max-h-72 overflow-y-auto">
          {groups.map((g) => (
            <div key={g.c} className="mb-1">
              <p className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">{g.c === "serif" ? "Serif" : g.c === "sans" ? "Sans serif" : g.c === "display" ? "Display" : "Monospace"}</p>
              {g.items.map((k) => (
                <button key={k} type="button" onClick={() => { onChange(k); setOpen(false); }} className={cn("flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[15px] hover:bg-surface-3", k === value && "bg-primary-soft text-primary-ink")} style={{ fontFamily: `var(${FONTS[k].variable}), ${FONTS[k].fallback}` }}>
                  {FONTS[k].label}
                  {k === value && <Check className="size-3.5" aria-hidden />}
                </button>
              ))}
            </div>
          ))}
          {!groups.length && <p className="py-4 text-center text-[12px] text-muted">No fonts match.</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const PAIRINGS: Array<{ name: string; heading: FontKey; body: FontKey; accent: FontKey }> = [
  { name: "Editorial", heading: "cormorant", body: "jost", accent: "jost" },
  { name: "Modern serif", heading: "fraunces", body: "inter", accent: "inter" },
  { name: "Classic", heading: "playfair", body: "lora", accent: "inter" },
  { name: "Clean", heading: "inter", body: "inter", accent: "inter" },
  { name: "Technical", heading: "grotesk", body: "dmsans", accent: "dmmono" },
  { name: "Friendly", heading: "outfit", body: "figtree", accent: "outfit" },
  { name: "Bold", heading: "bricolage", body: "manrope", accent: "syne" },
  { name: "Refined", heading: "instrument", body: "hanken", accent: "hanken" },
];

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

const PALETTES: Array<{ name: string; primary: string; accent: string }> = [
  { name: "Harbour", primary: "#1f4d4a", accent: "#d6a85c" }, { name: "Cobalt", primary: "#2c5bff", accent: "#12c9a5" }, { name: "Ember", primary: "#b4401c", accent: "#f2a65a" },
  { name: "Ink", primary: "#111827", accent: "#c8a24a" }, { name: "Orchard", primary: "#2f6f3e", accent: "#e9b949" }, { name: "Plum", primary: "#5b2a86", accent: "#ff7a90" },
  { name: "Slate", primary: "#334155", accent: "#38bdf8" }, { name: "Clay", primary: "#8a5a44", accent: "#e8c9a0" },
];

// ---------------------------------------------------------------------------
// Design panel
// ---------------------------------------------------------------------------

export function DesignPanel({ doc, commit }: { doc: SiteContent; commit: Commit }) {
  const d = doc.design;
  const set = (patch: Partial<Design>, coalesce?: string) => commit({ ...doc, design: { ...d, ...patch } }, coalesce ? { coalesce: `design:${coalesce}` } : undefined);
  const color = (k: keyof Design["colors"], v: string) => commit({ ...doc, design: { ...d, colors: { ...d.colors, [k]: v } } }, { coalesce: `design:color:${k}` });
  const weights: number[] = FONTS[d.fonts.heading as FontKey].weights;
  return (
    <div>
      <Group title="Colours" hint="Your brand colours. Text and buttons adjust automatically so they stay readable.">
        <Row label="Main colour"><HexControl label="Main colour" value={d.colors.primary} onChange={(v) => color("primary", v)} /></Row>
        <Row label="Accent colour"><HexControl label="Accent colour" value={d.colors.accent} onChange={(v) => color("accent", v)} /></Row>
        <Row label="Ready-made palettes">
          <div className="grid grid-cols-4 gap-1.5">
            {PALETTES.map((p) => (
              <button key={p.name} type="button" title={p.name} aria-label={`Use the ${p.name} palette`} onClick={() => commit({ ...doc, design: { ...d, colors: { ...d.colors, primary: p.primary, accent: p.accent } } })} className="flex h-8 overflow-hidden rounded-lg border border-line hover:border-line-strong focus-visible:outline-2 focus-visible:outline-primary">
                <span className="flex-1" style={{ background: p.primary }} /><span className="w-3" style={{ background: p.accent }} />
              </button>
            ))}
          </div>
        </Row>
        <Row label="Mode"><Seg label="Colour mode" value={d.mode} onChange={(v) => set({ mode: v })} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} /></Row>
        <details className="group rounded-lg border border-line">
          <summary className="flex min-h-8 cursor-pointer items-center justify-between px-2.5 text-[12px] font-medium text-ink-2">More colours<ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden /></summary>
          <div className="space-y-3 border-t border-line p-2.5">
            {([["bg", "Page background"], ["surface", "Cards"], ["surface2", "Soft panels"], ["ink", "Text"], ["muted", "Quiet text"], ["line", "Lines"], ["dark", "Dark sections"]] as const).map(([k, label]) => (
              <Row key={k} label={label}><HexControl label={label} value={d.colors[k]} onChange={(v) => color(k, v)} /></Row>
            ))}
          </div>
        </details>
      </Group>
      <Group title="Fonts">
        <Row label="Headings"><FontPicker label="Heading font" value={d.fonts.heading as FontKey} onChange={(k) => set({ fonts: { ...d.fonts, heading: k } })} /></Row>
        <Row label="Body text"><FontPicker label="Body font" value={d.fonts.body as FontKey} onChange={(k) => set({ fonts: { ...d.fonts, body: k } })} /></Row>
        <Row label="Accent text" hint="Small labels and buttons."><FontPicker label="Accent font" value={d.fonts.accent as FontKey} onChange={(k) => set({ fonts: { ...d.fonts, accent: k } })} /></Row>
        <Row label="Pairings">
          <div className="grid grid-cols-2 gap-1.5">
            {PAIRINGS.map((p) => (
              <button key={p.name} type="button" onClick={() => set({ fonts: { ...d.fonts, heading: p.heading, body: p.body, accent: p.accent } })} className="rounded-lg border border-line bg-surface px-2 py-1.5 text-left hover:border-line-strong">
                <span className="block text-[15px] leading-tight" style={{ fontFamily: `var(${FONTS[p.heading].variable}), ${FONTS[p.heading].fallback}` }}>{p.name}</span>
                <span className="block text-[11px] text-muted" style={{ fontFamily: `var(${FONTS[p.body].variable}), ${FONTS[p.body].fallback}` }}>{FONTS[p.heading].label} + {FONTS[p.body].label}</span>
              </button>
            ))}
          </div>
        </Row>
      </Group>
      <Group title="Headings" defaultOpen={false}>
        <Row label="Weight"><SelectControl label="Heading weight" value={String(d.heading.weight)} onChange={(v) => set({ heading: { ...d.heading, weight: Number(v) } }, "hw")} options={weights.map((w) => ({ value: String(w), label: String(w) }))} /></Row>
        <Row label="Letter spacing"><SelectControl label="Heading letter spacing" value={d.heading.ls} onChange={(v) => set({ heading: { ...d.heading, ls: v } })} options={(["tighter", "tight", "normal", "wide", "wider"] as const).map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))} /></Row>
        <Row label="Line height"><SelectControl label="Heading line height" value={d.heading.lh} onChange={(v) => set({ heading: { ...d.heading, lh: v } })} options={(["none", "tight", "snug", "normal", "relaxed"] as const).map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))} /></Row>
        <Row label="Capitals"><Seg label="Heading capitals" value={d.heading.transform} onChange={(v) => set({ heading: { ...d.heading, transform: v } })} options={[{ value: "none", label: "Normal" }, { value: "uppercase", label: "ALL CAPS" }]} /></Row>
        <Row label="*Emphasised* words" hint="Wrap a word in asterisks in a heading to emphasise it."><SelectControl label="Emphasis style" value={d.heading.emphasis} onChange={(v) => set({ heading: { ...d.heading, emphasis: v } })} options={[{ value: "italic", label: "Italic" }, { value: "accent", label: "Accent colour" }, { value: "both", label: "Italic and accent" }, { value: "underline", label: "Underline" }]} /></Row>
        <Row label="Text size"><Seg label="Text scale" value={d.scale} onChange={(v) => set({ scale: v })} options={[{ value: "compact", label: "Compact" }, { value: "regular", label: "Regular" }, { value: "grand", label: "Grand" }, { value: "display", label: "Display" }]} size="sm" /></Row>
      </Group>
      <Group title="Buttons" defaultOpen={false}>
        <Row label="Style"><SelectControl label="Button style" value={d.buttons.style} onChange={(v) => set({ buttons: { ...d.buttons, style: v } })} options={[{ value: "solid", label: "Solid" }, { value: "outline", label: "Outline" }, { value: "gradient", label: "Gradient" }, { value: "glass", label: "Glass" }, { value: "soft", label: "Soft" }]} /></Row>
        <Row label="Hover"><Seg label="Button hover" value={d.buttons.hover} onChange={(v) => set({ buttons: { ...d.buttons, hover: v } })} options={[{ value: "lift", label: "Lift" }, { value: "shine", label: "Shine" }, { value: "invert", label: "Invert" }, { value: "none", label: "None" }]} size="sm" /></Row>
        <Row label="Weight"><NumberControl label="Button weight" value={d.buttons.weight} min={400} max={800} step={100} onChange={(v) => set({ buttons: { ...d.buttons, weight: v } }, "bw")} /></Row>
        <Toggle label="Capital letters" checked={d.buttons.caps} onChange={(v) => set({ buttons: { ...d.buttons, caps: v } })} />
      </Group>
      <Group title="Shape and space" defaultOpen={false}>
        <Row label="Corners"><Seg label="Corners" value={d.radius} onChange={(v) => set({ radius: v })} options={[{ value: "square", label: "Square" }, { value: "soft", label: "Soft" }, { value: "round", label: "Round" }, { value: "pill", label: "Pill" }]} size="sm" /></Row>
        <Row label="Spacing"><Seg label="Spacing" value={d.spacing} onChange={(v) => set({ spacing: v })} options={[{ value: "tight", label: "Tight" }, { value: "regular", label: "Regular" }, { value: "airy", label: "Airy" }, { value: "luxe", label: "Luxe" }]} size="sm" /></Row>
        <Row label="Content width"><Seg label="Content width" value={d.width} onChange={(v) => set({ width: v })} options={[{ value: "narrow", label: "Narrow" }, { value: "regular", label: "Regular" }, { value: "wide", label: "Wide" }]} /></Row>
        <Row label="Shadows"><Seg label="Shadows" value={d.shadow} onChange={(v) => set({ shadow: v })} options={[{ value: "none", label: "None" }, { value: "soft", label: "Soft" }, { value: "crisp", label: "Crisp" }, { value: "dramatic", label: "Deep" }]} size="sm" /></Row>
      </Group>
      <Group title="Links and motion" defaultOpen={false}>
        <Row label="Links in text"><Seg label="Links" value={d.links} onChange={(v) => set({ links: v })} options={[{ value: "underline", label: "Underlined" }, { value: "plain", label: "Plain" }, { value: "accent", label: "Accent" }]} size="sm" /></Row>
        <Row label="Motion" hint="How lively the page feels. Always off for visitors who prefer reduced motion."><Seg label="Motion" value={d.motion} onChange={(v) => set({ motion: v })} options={[{ value: "none", label: "None" }, { value: "subtle", label: "Subtle" }, { value: "smooth", label: "Smooth" }, { value: "dramatic", label: "Bold" }]} size="sm" /></Row>
        <Toggle label="Film grain" hint="A faint texture over the whole page." checked={d.grain} onChange={(v) => set({ grain: v })} />
      </Group>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Validated text: holds what is typed and commits only once it would save
// ---------------------------------------------------------------------------

const E164 = /^\+[1-9][0-9]{6,14}$/;
const EMAIL = /^[^\s@<>()[\]\\,;:]+@[^\s@<>()[\]\\,;:]+\.[^\s@<>()[\]\\,;:]{2,}$/;
function socialOk(v: string, hosts: string[]) {
  if (!v.trim()) return true;
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" && hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`)) && !u.username;
  } catch {
    return false;
  }
}

function Validated({ label, value, onCommit, check, message, placeholder, multiline, max, type }: { label: string; value: string; onCommit: (v: string) => void; check: (v: string) => boolean; message: string; placeholder?: string; multiline?: boolean; max: number; type?: string }) {
  const [v, setV] = useDraft(value);
  const ok = check(v);
  const id = React.useId();
  return (
    <Row label={label} htmlFor={id}>
      {multiline
        ? <AreaControl id={id} rows={3} value={v} maxLength={max} placeholder={placeholder} aria-invalid={!ok} onChange={(e) => { setV(e.target.value); if (check(e.target.value)) onCommit(e.target.value); }} />
        : <TextControl id={id} type={type} value={v} maxLength={max} placeholder={placeholder} aria-invalid={!ok} onChange={(e) => { setV(e.target.value); if (check(e.target.value)) onCommit(e.target.value); }} />}
      {!ok && <p role="alert" className="text-[11px] text-danger-ink">{message}</p>}
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------

export function SettingsPanel({ doc, commit }: { doc: SiteContent; commit: Commit }) {
  const b = doc.business;
  const setBiz = (patch: Partial<typeof b>, c: string) => commit({ ...doc, business: { ...b, ...patch } }, { coalesce: `biz:${c}` });
  const setSeo = (patch: Partial<typeof doc.seo>, c: string) => commit({ ...doc, seo: { ...doc.seo, ...patch } }, { coalesce: `seo:${c}` });
  const setSocial = (k: keyof typeof doc.social, v: string) => commit({ ...doc, social: { ...doc.social, [k]: v.trim() } }, { coalesce: `social:${k}` });
  const f = doc.form;
  const setForm = (patch: Partial<typeof f>, c: string) => commit({ ...doc, form: { ...f, ...patch } }, { coalesce: `form:${c}` });
  const modes = [{ value: "required", label: "Required" }, { value: "optional", label: "Optional" }, { value: "hidden", label: "Not asked" }] as const;
  return (
    <div>
      <Group title="Business details" hint="Shown in the header, footer and contact blocks.">
        <Validated label="Business name" value={b.name} max={120} check={(v) => v.trim().length >= 2} message="Add your business name." onCommit={(v) => setBiz({ name: v }, "name")} />
        <Row label="Tagline" htmlFor="b-tag"><TextControl id="b-tag" value={b.tagline} maxLength={140} onChange={(e) => setBiz({ tagline: e.target.value }, "tag")} /></Row>
        <Validated label="Phone number" value={b.phone} max={24} placeholder="+1 512 555 0100" check={(v) => !v.trim() || E164.test(v.replace(/[\s().-]/g, ""))} message="Enter the number with its country code, like +1 512 555 0100." onCommit={(v) => setBiz({ phone: v.replace(/[\s().-]/g, "") }, "phone")} type="tel" />
        <Validated label="Email address" value={b.email} max={320} check={(v) => !v.trim() || EMAIL.test(v.trim().toLowerCase())} message="That email address doesn't look right." onCommit={(v) => setBiz({ email: v.trim().toLowerCase() }, "email")} type="email" />
        <Row label="Address" htmlFor="b-addr"><AreaControl id="b-addr" rows={2} value={b.address} maxLength={200} onChange={(e) => setBiz({ address: e.target.value }, "addr")} /></Row>
        <Row label="Opening hours" htmlFor="b-hours"><AreaControl id="b-hours" rows={3} value={b.hours} maxLength={300} placeholder="Mon–Fri 9:00–17:00" onChange={(e) => setBiz({ hours: e.target.value }, "hours")} /></Row>
      </Group>
      <Group title="Logo" defaultOpen={false}>
        <FieldEditor scope="logo" spec={{ key: "logo", label: "Logo", type: "image", hint: "Upload a logo in the Media tab, then choose it here." }} value={doc.brand.logoAssetId ? { kind: "asset", id: doc.brand.logoAssetId } : null}
          onChange={(v) => commit({ ...doc, brand: { ...doc.brand, logoAssetId: v && (v as { kind: string }).kind === "asset" ? (v as { id: string }).id : null } })} />
        <Row label="Version"><Seg label="Logo version" value={doc.brand.logoVariant} onChange={(v) => commit({ ...doc, brand: { ...doc.brand, logoVariant: v } })} options={[{ value: "original", label: "Original" }, { value: "processed", label: "No background" }]} /></Row>
      </Group>
      <Group title="Search and sharing" defaultOpen={false}>
        <Row label="Site title" htmlFor="s-title"><TextControl id="s-title" value={doc.seo.title} maxLength={70} onChange={(e) => setSeo({ title: e.target.value }, "title")} /></Row>
        <Row label="Description" htmlFor="s-desc"><AreaControl id="s-desc" rows={3} value={doc.seo.description} maxLength={160} onChange={(e) => setSeo({ description: e.target.value }, "desc")} /></Row>
        <FieldEditor scope="seo" spec={{ key: "og", label: "Sharing image", type: "image", hint: "Shown when someone shares a link to your site." }} value={doc.seo.ogImage} onChange={(v) => setSeo({ ogImage: v as typeof doc.seo.ogImage }, "og")} />
        <Toggle label="Ask search engines not to list this site" hint="Useful while you are still building." checked={doc.seo.noindex} onChange={(v) => setSeo({ noindex: v }, "noindex")} />
      </Group>
      <Group title="Social links" defaultOpen={false}>
        {([["facebook", "Facebook", ["facebook.com"]], ["instagram", "Instagram", ["instagram.com"]], ["linkedin", "LinkedIn", ["linkedin.com"]], ["x", "X", ["x.com", "twitter.com"]], ["youtube", "YouTube", ["youtube.com"]], ["tiktok", "TikTok", ["tiktok.com"]]] as const).map(([k, label, hosts]) => (
          <Validated key={k} label={label} value={doc.social[k]} max={300} placeholder={`https://${hosts[0]}/…`} check={(v) => socialOk(v, [...hosts])} message={`Use your ${hosts[0]} page address (https://…).`} onCommit={(v) => setSocial(k, v)} />
        ))}
      </Group>
      <Group title="Enquiry forms" defaultOpen={false} hint="Every enquiry form on the site shares these settings. Answers arrive in your contacts.">
        <Toggle label="Take enquiries from the website" checked={f.enabled} onChange={(v) => setForm({ enabled: v }, "enabled")} />
        <Row label="Phone number"><Seg label="Phone number" value={f.fields.phone} onChange={(v) => setForm({ fields: { ...f.fields, phone: v } }, "phone")} options={modes.map((m) => ({ ...m }))} size="sm" /></Row>
        <Row label="Message"><Seg label="Message" value={f.fields.message} onChange={(v) => setForm({ fields: { ...f.fields, message: v } }, "msg")} options={modes.map((m) => ({ ...m }))} size="sm" /></Row>
        <Row label="What they need"><Seg label="Service choice" value={f.fields.service} onChange={(v) => setForm({ fields: { ...f.fields, service: v } }, "svc")} options={modes.map((m) => ({ ...m }))} size="sm" /></Row>
        <FieldEditor scope="form" spec={{ key: "services", label: "Choices for “what do you need?”", type: "textlist", max: 12, itemMax: 60, itemLabel: "choice" }} value={f.services} onChange={(v) => setForm({ services: v as string[] }, "services")} />
        <Row label="Thank-you message" htmlFor="f-ok"><TextControl id="f-ok" value={f.successMessage} maxLength={200} onChange={(e) => setForm({ successMessage: e.target.value }, "ok")} /></Row>
        <Row label="Consent wording" hint="Recorded as the visitor's agreement. Have it reviewed for your region." htmlFor="f-consent"><AreaControl id="f-consent" rows={2} value={f.consentText} maxLength={240} onChange={(e) => setForm({ consentText: e.target.value }, "consent")} /></Row>
        <Toggle label="Offer an optional “send me updates” box" hint="Off by default. Offers go only to people who tick it." checked={f.marketingOptIn} onChange={(v) => setForm({ marketingOptIn: v }, "mkt")} />
        {f.marketingOptIn && <Row label="Wording of that box" htmlFor="f-mk"><TextControl id="f-mk" value={f.marketingText} maxLength={240} onChange={(e) => setForm({ marketingText: e.target.value }, "mkt-t")} /></Row>}
      </Group>
    </div>
  );
}
