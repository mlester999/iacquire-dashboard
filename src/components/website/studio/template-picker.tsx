"use client";

import * as React from "react";
import { Check, Eye, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Dialog, Segmented } from "@/components/ui/overlays";
import { LivePreview, type Device } from "@/components/website/studio/live-preview";
import { TemplateThumb } from "@/components/website/template-thumb";
import { generateSiteContent, type SiteDetails } from "@/lib/website/generate";
import { ALL_TEMPLATE_KEYS, FAMILIES, familiesForIndustry, templateKey } from "@/lib/website/templates";
import type { SiteContent } from "@/lib/website/schema";
import { cn } from "@/lib/utils";

const PAGE_W = 1280;
const PAGE_H = 760;

/**
 * Ten families, five styles each. Every preview is built from the business's own details, so the choice is made on their
 * real words and colours, and the page they pick is exactly what they'll get.
 */
export function TemplatePicker({
  details, industry, current, onChoose, busy, chooseLabel = "Use this style",
}: {
  details: SiteDetails; industry: string; current?: string; onChoose: (key: string) => void; busy?: boolean; chooseLabel?: string;
}) {
  const families = React.useMemo(() => familiesForIndustry(industry), [industry]);
  const [open, setOpen] = React.useState<string>(current?.split(".")[0] ?? families[0].id);
  const [preview, setPreview] = React.useState<string | null>(null);
  const [device, setDevice] = React.useState<Device>("desktop");
  const [page, setPage] = React.useState("home");
  // Every style is written from the same details. Generating is quick; only the styles on screen are ever drawn.
  const contents = React.useMemo(() => new Map(ALL_TEMPLATE_KEYS.map((k) => [k, generateSiteContent(details, k)] as const)), [details]);
  const contentFor = (key: string) => contents.get(key)!;
  const recommended = new Set(FAMILIES.filter((f) => f.industries.includes(industry)).map((f) => f.id));
  const active = FAMILIES.find((f) => f.id === open)!;
  const previewContent = preview ? contentFor(preview) : null;

  return (
    <div className="space-y-8">
      <section aria-labelledby="tp-families">
        <h2 id="tp-families" className="sr-only">
          Style families
        </h2>
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Style families">
          {families.map((f) => {
            const key = templateKey(f.id, f.variations[0].id);
            const selected = open === f.id;
            return (
              <li key={f.id}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setOpen(f.id)}
                  className={cn("group block w-full rounded-2xl border bg-surface p-3 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary", selected ? "border-primary shadow-card ring-2 ring-primary/20" : "border-line hover:border-line-strong")}
                >
                  <FitThumb templateKey={key} content={contentFor(key)} />
                  <span className="mt-3 flex items-start justify-between gap-2 px-1">
                    <span>
                      <span className="block text-[15px] font-semibold">{f.name}</span>
                      <span className="mt-0.5 block text-[12.5px] leading-snug text-muted">{f.tagline}</span>
                    </span>
                    {recommended.has(f.id) && (
                      <Badge tone="primary">
                        <Sparkles className="size-3" aria-hidden /> Suggested
                      </Badge>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="tp-styles" className="rounded-3xl border border-line bg-surface-2/50 p-4 sm:p-6">
        <h2 id="tp-styles" className="text-[18px] font-semibold tracking-tight">
          {active.name} styles
        </h2>
        <p className="mt-1 text-[13.5px] text-muted">Five different layouts and moods. Your colours, words and images go into whichever you choose, and you can switch later without losing anything.</p>
        <ul className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {active.variations.map((v) => {
            const key = templateKey(active.id, v.id);
            const isCurrent = current === key;
            return (
              <li key={key} className={cn("rounded-2xl border bg-surface p-3", isCurrent ? "border-primary" : "border-line")}>
                <FitThumb templateKey={key} content={contentFor(key)} />
                <div className="mt-3 px-1">
                  <p className="flex items-center gap-2 text-[14.5px] font-semibold">
                    {v.name}
                    {isCurrent && (
                      <Badge tone="success">
                        <Check className="size-3" aria-hidden /> Current
                      </Badge>
                    )}
                  </p>
                  <p className="mt-0.5 text-[12.5px] leading-snug text-muted">{v.description}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button type="button" variant="secondary" size="sm" onClick={() => { setPage("home"); setPreview(key); }}>
                      <Eye className="size-3.5" /> Preview
                    </Button>
                    <Button type="button" variant={isCurrent ? "ghost" : "brand"} size="sm" disabled={busy || isCurrent} onClick={() => onChoose(key)}>
                      {chooseLabel}
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <Dialog
        open={preview !== null}
        onOpenChange={(o) => !o && setPreview(null)}
        title={preview ? `${resolveName(preview)} preview` : "Preview"}
        description="Built from your own details. Nothing is published."
        size="xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPreview(null)}>
              Close
            </Button>
            <Button variant="brand" disabled={busy || preview === current} onClick={() => preview && onChoose(preview)}>
              {chooseLabel}
            </Button>
          </>
        }
      >
        {previewContent && preview && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Segmented id="tp-device" ariaLabel="Preview width" value={device} onChange={setDevice} options={[{ value: "desktop", label: "Desktop" }, { value: "tablet", label: "Tablet" }, { value: "mobile", label: "Phone" }]} />
              <Segmented id="tp-page" ariaLabel="Page" value={page} onChange={setPage} options={previewContent.pages.slice(0, 5).map((p) => ({ value: p.slug, label: p.navLabel || p.title }))} />
            </div>
            <div className="max-h-[62dvh] overflow-auto rounded-2xl bg-surface-3 p-2">
              <LivePreview content={previewContent} templateKey={preview} pageSlug={page} assets={[]} device={device} selectedId={null} year={2026} onSelectSection={() => undefined} onSelectSite={() => undefined} onNavigatePage={setPage} />
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

/** A thumbnail that fills the card it's in, whatever the screen, by scaling the real page down to the measured width. */
function FitThumb({ templateKey: key, content }: { templateKey: string; content: SiteContent }) {
  const box = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(0);
  React.useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} className="w-full" style={{ aspectRatio: `${PAGE_W} / ${PAGE_H}` }}>
      {width > 0 && <TemplateThumb templateKey={key} content={content} scale={width / PAGE_W} width={PAGE_W} height={PAGE_H} maxSections={2} />}
    </div>
  );
}

function resolveName(key: string) {
  const [f, v] = key.split(".");
  const fam = FAMILIES.find((x) => x.id === f);
  return `${fam?.name ?? ""} ${fam?.variations.find((x) => x.id === v)?.name ?? ""}`.trim();
}
