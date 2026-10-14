"use client";

import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowRight, ChevronLeft, ChevronRight,Star } from "lucide-react";
import { Badge, Card } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Chip } from "@/components/projects/common";
import { FOUNDER_ATTRIBUTION, PORTFOLIO_STATUS_LABEL, type PortfolioStatus } from "@/lib/projects";
import type { PortfolioAssetView, PortfolioCard } from "@/server/portfolio/service";
import { cn } from "@/lib/utils";
import { ProjectMediaPlaceholder,TechnologyPill } from "@/components/projects/visuals";

const statusTone = (s: PortfolioStatus) => (s === "built" ? "success" : "warning");
export const assetSrc = (id: string, variant: "thumb" | "full" = "full") => `/api/portfolio/assets/${id}?v=${variant}`;

export function FounderNotice({ className }: { className?: string }) {
  return (
    <p className={cn("rounded-xl border border-line bg-surface-2/70 p-3.5 text-[12.5px] leading-relaxed text-muted", className)}>
      <strong className="font-semibold text-ink-2">{FOUNDER_ATTRIBUTION}.</strong> These projects were built by iAcquire&apos;s founder, Mark Lester Acak. They show what can be built. They are not results from iAcquire clients, and they weren&apos;t contracted through iAcquire. Project names and screenshots appear only where public sharing is permitted.
    </p>
  );
}

function Cover({ id, alt, className }: { id: string | null; alt: string; className?: string }) {
  if(!id)return <ProjectMediaPlaceholder title={alt.replace(/ preview$/,"")} className={className}/>;
  return (
    <div className={cn("relative aspect-[16/10] w-full overflow-hidden bg-gradient-to-br from-primary-soft via-surface-2 to-violet-soft", className)}>
      {id ? (
        <Image src={assetSrc(id, "thumb")} alt={alt} fill unoptimized sizes="(min-width: 1280px) 400px, (min-width: 768px) 45vw, 100vw" className="object-cover object-top transition-transform duration-500 group-hover:scale-[1.03]" />
      ) : (
        <ProjectMediaPlaceholder title={alt}/>
      )}
    </div>
  );
}

export function PortfolioGallery({ projects }: { projects: PortfolioCard[] }) {
  const reduce = useReducedMotion();
  const categories = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of projects) for (const c of p.categories) counts.set(c, (counts.get(c) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c]) => c);
  }, [projects]);
  const [filter, setFilter] = React.useState<string>("All");
  const shown = projects.filter((p) => filter === "All" || p.categories.includes(filter));
  return (
    <div className="space-y-6">
      <div role="tablist" aria-label="Project categories" className="scrollbar-thin -mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
        {["All", ...categories].map((c) => {
          const active = filter === c;
          return (
            <button key={c} role="tab" aria-selected={active} onClick={() => setFilter(c)} className={cn("relative shrink-0 rounded-xl px-3.5 py-2 text-[13px] font-medium transition-colors", active ? "text-ink" : "text-muted hover:text-ink")}>
              {active && <motion.span layoutId="pf-filter" className="absolute inset-0 rounded-xl border border-line bg-surface shadow-soft" transition={{ type: "spring", stiffness: 520, damping: 40 }} />}
              <span className="relative">{c}</span>
            </button>
          );
        })}
      </div>
      <motion.ul layout={!reduce} className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        <AnimatePresence mode="popLayout" initial={false}>
          {shown.map((p,i) => (
            <motion.li key={p.id} className={cn("min-w-0",p.featured&&i===0&&"md:col-span-2")} layout={!reduce} initial={reduce ? false : { opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={reduce ? undefined : { opacity: 0, scale: 0.97 }} transition={{ type: "spring", stiffness: 420, damping: 36 }}>
              <Link href={`/our-work/${p.slug}`} className="group block h-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
                <Card className="flex h-full flex-col overflow-hidden transition-all duration-200 group-hover:-translate-y-0.5 group-hover:shadow-card">
                  <div className="relative"><Cover id={p.coverAssetId} alt={`${p.title} preview`} className={p.featured&&i===0?"aspect-auto h-60 sm:h-72":undefined}/>{p.featured&&<span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-lg border border-white/15 bg-black/40 px-2 py-1 text-[10px] font-semibold text-amber-200 backdrop-blur-sm"><Star className="size-3 fill-current"/> Featured work</span>}</div>
                  <div className="flex flex-1 flex-col p-5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={statusTone(p.status)}>{p.statusLabel || PORTFOLIO_STATUS_LABEL[p.status]}</Badge>
                      {p.categories.slice(0, 2).map((c) => (
                        <Chip key={c}>{c}</Chip>
                      ))}
                    </div>
                    <h3 className="mt-3 text-[16px] font-semibold leading-snug tracking-tight">{p.title}</h3>
                    <p className="mt-1.5 line-clamp-3 text-[13px] leading-relaxed text-muted">{p.summary}</p>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {p.technologies.slice(0, 4).map((t) => <TechnologyPill key={t} name={t}/>)}
                    </div>
                    <p className="mt-auto inline-flex items-center gap-1 pt-4 text-[13px] font-medium text-primary">
                      Read the case study <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                    </p>
                  </div>
                </Card>
              </Link>
            </motion.li>
          ))}
        </AnimatePresence>
      </motion.ul>
      {shown.length === 0 && <div className="rounded-2xl border border-dashed border-line-strong p-8 text-center"><h3 className="text-base font-semibold">A new story is on its way</h3><p className="mt-2 text-sm text-muted">No published projects in this category yet. Only reviewed work appears here.</p>{filter!=="All"&&<Button className="mt-4" variant="secondary" size="sm" onClick={()=>setFilter("All")}>View all selected work</Button>}</div>}
    </div>
  );
}

export function ImageGallery({ assets, title }: { assets: PortfolioAssetView[]; title: string }) {
  const [index, setIndex] = React.useState<number | null>(null);
  if (assets.length === 0) return null;
  const hero = assets[0];
  const rest = assets.slice(1);
  const step = (d: number) => setIndex((i) => (i === null ? i : (i + d + assets.length) % assets.length));
  return (
    <div className="space-y-3">
      <button type="button" onClick={() => setIndex(0)} className="group relative block aspect-[16/9] w-full overflow-hidden rounded-2xl border border-line bg-surface-2 shadow-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" aria-label={`Open image gallery for ${title}`}>
        <Image src={assetSrc(hero.id)} alt={hero.alt || title} fill unoptimized priority sizes="(min-width: 1024px) 900px, 100vw" className="object-cover object-top transition-transform duration-500 group-hover:scale-[1.02]" />
      </button>
      {rest.length > 0 && (
        <ul className="scrollbar-thin flex gap-2.5 overflow-x-auto pb-1" aria-label="More images">
          {rest.map((a, i) => (
            <li key={a.id} className="shrink-0">
              <button type="button" onClick={() => setIndex(i + 1)} className="relative block h-20 w-32 overflow-hidden rounded-xl border border-line bg-surface-2 transition hover:border-primary focus-visible:outline-2 focus-visible:outline-primary" aria-label={a.alt || `Image ${i + 2}`}>
                <Image src={assetSrc(a.id, "thumb")} alt={a.alt || ""} fill unoptimized sizes="128px" className="object-cover object-top" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={index !== null}
        onOpenChange={(o) => !o && setIndex(null)}
        title={title}
        description={index !== null ? `${index + 1} of ${assets.length}` : undefined}
        size="xl"
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => step(-1)} disabled={assets.length < 2}>
              <ChevronLeft className="size-4" /> Previous
            </Button>
            <Button variant="secondary" size="sm" onClick={() => step(1)} disabled={assets.length < 2}>
              Next <ChevronRight className="size-4" />
            </Button>
          </>
        }
      >
        {index !== null && (
          <figure className="space-y-3">
            <div className="relative aspect-[16/10] w-full overflow-hidden rounded-xl bg-surface-2">
              <Image key={assets[index].id} src={assetSrc(assets[index].id)} alt={assets[index].alt || title} fill unoptimized sizes="900px" className="object-contain" />
            </div>
            {(assets[index].caption || assets[index].alt) && <figcaption className="text-[13px] text-muted">{assets[index].caption ?? assets[index].alt}{assets[index].anonymized ? " · anonymized" : ""}</figcaption>}
          </figure>
        )}
      </Dialog>
    </div>
  );
}
