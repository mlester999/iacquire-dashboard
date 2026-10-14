"use client";

import * as React from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowRight, Bot, Check, Clock, Code2, Compass, Globe, Info, Layers, Plug, Search, ShoppingBag, Sparkles, Star, Workflow, X,LayoutGrid,List as ListIcon } from "lucide-react";
import { TechnologyPill } from "@/components/projects/visuals";
import { Badge, Card } from "@/components/ui/primitives";
import { Button, ButtonLink } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Chip } from "@/components/projects/common";
import {
  CORE_OFFER, MARKETPLACE_FILTERS, PORTFOLIO_STATUS_LABEL, formatDelivery, formatMoney, formatPrice, priceCaption,
  type MarketplaceFilterId, type ServiceView,
} from "@/lib/projects";
import { cn } from "@/lib/utils";

function ServiceIcon({ tag, className }: { tag: string | undefined; className?: string }) {
  switch (tag) {
    case "ai-automation":
      return <Workflow className={className} />;
    case "ai-agents":
      return <Bot className={className} />;
    case "crm-integrations":
      return <Plug className={className} />;
    case "websites-funnels":
      return <Globe className={className} />;
    case "custom-development":
      return <Code2 className={className} />;
    case "shopify":
      return <ShoppingBag className={className} />;
    default:
      return <Sparkles className={className} />;
  }
}

const AVAILABILITY_LABEL = { available: null, coming_soon: "Coming soon", unavailable: "Currently unavailable" } as const;

function requestHref(slug?: string) {
  return slug ? `/projects/new?service=${encodeURIComponent(slug)}` : "/projects/new";
}

export function Marketplace({
  services,
  canRequest,
  maintenancePrice,
}: {
  services: ServiceView[];
  canRequest: boolean;
  /** Published maintenance price, e.g. "$299/month". */
  maintenancePrice: string | null;
}) {
  const reduce = useReducedMotion();
  const [filter, setFilter] = React.useState<MarketplaceFilterId>("all");
  const [query, setQuery] = React.useState("");
  const [detail, setDetail] = React.useState<ServiceView | null>(null);
  const [layout,setLayout]=React.useState<"grid"|"list">("grid");

  const q = query.trim().toLowerCase();
  const visible = services.filter(
    (s) =>
      (filter === "all" || s.tags.includes(filter)) &&
      (!q || `${s.name} ${s.tagline} ${s.platforms.join(" ")} ${s.keywords.join(" ")}`.toLowerCase().includes(q)),
  );
  const groups = visible.reduce<Array<{ code: string; name: string; items: ServiceView[] }>>((acc, s) => {
    const g = acc.find((x) => x.code === s.categoryCode);
    if (g) g.items.push(s);
    else acc.push({ code: s.categoryCode, name: s.categoryName, items: [s] });
    return acc;
  }, []);
  const counts = (id: MarketplaceFilterId) => (id === "all" ? services.length : services.filter((s) => s.tags.includes(id)).length);

  return (
    <div className="space-y-6">
      {/* Core vs optional */}
      <Card className="relative overflow-hidden border-primary/20 bg-gradient-to-br from-primary-soft/60 via-surface to-surface p-5 sm:p-6">
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-20 size-64 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative grid gap-5 sm:grid-cols-3">
          <div>
            <Badge tone="success">Already yours</Badge>
            <p className="mt-2.5 text-[14px] font-semibold">{CORE_OFFER.name}</p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted">Your core system and its standard AI employees are covered by your agreement. Nothing on this page is needed to use them.</p>
          </div>
          <div>
            <Badge tone="primary">Optional</Badge>
            <p className="mt-2.5 text-[14px] font-semibold">Add-ons &amp; custom projects</p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted">Separately scoped work beyond your package. Always quoted in writing first. You are never charged automatically.</p>
          </div>
          <div>
            <Badge tone="violet">Optional</Badge>
            <p className="mt-2.5 text-[14px] font-semibold">Managed maintenance{maintenancePrice ? ` · ${maintenancePrice}` : ""}</p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
              Ongoing monitoring and reasonable changes.{" "}
              <Link href="/maintenance" className="font-medium text-primary hover:underline">
                See what&apos;s included
              </Link>
              .
            </p>
          </div>
        </div>
      </Card>

      {/* Filters */}
      <div className="flex min-w-0 flex-col gap-3">
        <div role="tablist" aria-label="Service categories" className="scrollbar-thin -mx-1 flex gap-1 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible">
          {MARKETPLACE_FILTERS.map((f, index) => {
            const active = filter === f.id;
            return (
              <button
                key={f.id}
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onKeyDown={(event) => {
                  const next = event.key === "ArrowRight" ? (index + 1) % MARKETPLACE_FILTERS.length : event.key === "ArrowLeft" ? (index + MARKETPLACE_FILTERS.length - 1) % MARKETPLACE_FILTERS.length : event.key === "Home" ? 0 : event.key === "End" ? MARKETPLACE_FILTERS.length - 1 : null;
                  if (next === null) return;
                  event.preventDefault();
                  setFilter(MARKETPLACE_FILTERS[next].id);
                  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
                }}
                onClick={() => setFilter(f.id)}
                className={cn("relative shrink-0 rounded-xl px-3.5 py-2 text-[13px] font-medium transition-colors", active ? "text-ink" : "text-muted hover:text-ink")}
              >
                {active && <motion.span layoutId="mk-filter" className="absolute inset-0 rounded-xl border border-line bg-surface shadow-soft" transition={{ type: "spring", stiffness: 520, damping: 40 }} />}
                <span className="relative">
                  {f.label} <span className="ml-1 text-[11.5px] tabular-nums text-faint">{counts(f.id)}</span>
                </span>
              </button>
            );
          })}
        </div>
        <label className="relative block w-full self-end sm:w-80">
          <span className="sr-only">Search services</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search services or tools"
            className="h-10 w-full rounded-xl border border-line-strong bg-surface pl-9 pr-9 text-[14px] shadow-soft outline-none transition placeholder:text-faint focus:border-primary focus:ring-4 focus:ring-primary/12"
          />
          {query && (
            <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted hover:text-ink">
              <X className="size-3.5" />
            </button>
          )}
        </label>
      </div>
      <div className="flex items-center justify-between gap-3"><p className="text-xs text-muted" aria-live="polite">{visible.length} service{visible.length===1?"":"s"} to explore</p><div className="flex gap-1 rounded-lg border border-line bg-surface p-1"><Button variant={layout==="grid"?"soft":"ghost"} size="icon-sm" aria-pressed={layout==="grid"} aria-label="Grid view" onClick={()=>setLayout("grid")}><LayoutGrid className="size-4"/></Button><Button variant={layout==="list"?"soft":"ghost"} size="icon-sm" aria-pressed={layout==="list"} aria-label="List view" onClick={()=>setLayout("list")}><ListIcon className="size-4"/></Button></div></div>

      {!canRequest && (
        <p className="flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-[13px] text-muted">
          <Info className="mt-0.5 size-4 shrink-0" /> You can browse everything here. A workspace owner or admin submits requests.
        </p>
      )}

      {/* Groups */}
      {groups.length === 0 ? (
        <Card className="px-6 py-12 text-center">
          <p className="text-[15px] font-semibold">No services match that search</p>
          <p className="mt-1 text-[13.5px] text-muted">Try a different filter, or tell us what you&apos;re after and we&apos;ll scope it with you.</p>
          {canRequest?<ButtonLink href={requestHref()} variant="brand" className="mt-5">Request a Custom Project <ArrowRight className="size-4" /></ButtonLink>:<Button variant="secondary" className="mt-5" onClick={()=>{setQuery("");setFilter("all");}}>Show all services</Button>}
        </Card>
      ) : (
        <div className="space-y-10">
          {groups.map((g) => {
            const meta = g.items[0];
            return (
              <section key={g.code} aria-labelledby={`cat-${g.code}`}>
                <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h2 id={`cat-${g.code}`} className="text-[18px] font-semibold tracking-tight">
                    {g.name}
                  </h2>
                  <Badge tone={meta.kind === "custom_build" ? "violet" : "neutral"}>{meta.kind === "custom_build" ? "Custom build · quoted" : "Ready-to-use"}</Badge>
                </div>
                <motion.ul layout={!reduce} className={layout==="grid"?"grid gap-4 md:grid-cols-2 xl:grid-cols-3":"space-y-3"}>
                  <AnimatePresence mode="popLayout" initial={false}>
                    {g.items.map((s) => (
                      <motion.li
                        key={s.id}
                        layout={!reduce}
                        initial={false}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={reduce ? undefined : { opacity: 0, scale: 0.97 }}
                        transition={{ type: "spring", stiffness: 420, damping: 36 }}
                        className="flex"
                      >
                        <ServiceCard service={s} canRequest={canRequest} onDetails={() => setDetail(s)} compact={layout==="list"}/>
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </motion.ul>
              </section>
            );
          })}
        </div>
      )}

      {/* Custom */}
      <Card className="relative overflow-hidden border-primary/20 bg-gradient-to-br from-primary-soft/70 via-surface to-surface p-6 sm:p-8">
        <div aria-hidden className="pointer-events-none absolute -bottom-24 -left-10 size-72 rounded-full bg-violet/10 blur-3xl" />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-xl">
            <span className="mb-3 inline-flex size-10 items-center justify-center rounded-2xl bg-surface text-primary shadow-card">
              <Compass className="size-5" />
            </span>
            <h2 className="text-[22px] font-semibold tracking-tight">Need something more specific?</h2>
            <p className="mt-2 text-[14.5px] leading-relaxed text-ink-2">
              Tell us what you want to build. Our team can design custom AI, automation, integration and software solutions around your business.
            </p>
            <p className="mt-2 text-[12.5px] text-muted">Free to ask. We review every request and reply with questions or a written quote. You&apos;re never charged automatically.</p>
          </div>
          {canRequest ? (
            <ButtonLink href={requestHref()} variant="brand" size="lg" className="shrink-0">
              Request a Custom Project <ArrowRight className="size-4" />
            </ButtonLink>
          ) : (
            <p className="max-w-[220px] text-[12.5px] text-muted">Ask a workspace owner or admin to submit a request.</p>
          )}
        </div>
      </Card>

      <ServiceDetail service={detail} canRequest={canRequest} onClose={() => setDetail(null)} />
    </div>
  );
}

function ServiceCard({ service: s, canRequest, onDetails,compact=false }: { service: ServiceView; canRequest: boolean; onDetails: () => void;compact?:boolean }) {
  const delivery = formatDelivery(s.deliveryMinDays, s.deliveryMaxDays);
  const available = s.availability === "available";
  if(compact)return <Card className="grid w-full gap-4 p-4 sm:grid-cols-[42px_minmax(0,1fr)_auto] sm:items-center"><span className="flex size-10 items-center justify-center rounded-xl bg-primary-soft text-primary"><ServiceIcon tag={s.tags[0]} className="size-5"/></span><div className="min-w-0"><p className="flex flex-wrap items-center gap-2 text-sm font-semibold">{s.name}{s.featured&&<Star className="size-3.5 fill-warning text-warning" aria-label="Featured"/>}</p><p className="mt-1 text-xs leading-relaxed text-muted">{s.tagline}</p><p className="mt-2 text-xs font-medium">{formatPrice(s.price)}<span className="ml-2 font-normal text-muted">{delivery}</span></p></div><div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="secondary" onClick={onDetails}>Details</Button>{available&&canRequest?<ButtonLink href={requestHref(s.slug)} size="sm" variant="primary">Request service <ArrowRight className="size-3.5"/></ButtonLink>:<Button disabled size="sm" variant="soft">{available?"Owner or admin required":AVAILABILITY_LABEL[s.availability]}</Button>}</div></Card>;
  return (
    <Card className={cn("group flex w-full min-w-0 flex-col p-5 transition-all duration-200 motion-safe:hover:-translate-y-0.5 hover:shadow-card", !available && "opacity-80")}>
      <div className="flex items-start justify-between gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary-soft text-primary transition-transform duration-200 group-hover:scale-105">
          <ServiceIcon tag={s.tags[0]} className="size-5" />
        </span>
        <div className="flex flex-wrap justify-end gap-1.5">
          {s.featured && available && (
            <Badge tone="warning">
              <Star className="size-3" /> Popular
            </Badge>
          )}
          {AVAILABILITY_LABEL[s.availability] && <Badge tone="neutral">{AVAILABILITY_LABEL[s.availability]}</Badge>}
        </div>
      </div>
      <h3 className="mt-4 text-[16px] font-semibold leading-snug tracking-tight">{s.name}</h3>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{s.tagline}</p>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-3 rounded-xl bg-surface-2 px-3.5 py-3">
        <div className="min-w-0">
          <p className="text-[20px] font-semibold tabular-nums tracking-tight">{formatPrice(s.price)}</p>
          <p className="text-[11.5px] leading-snug text-muted">{priceCaption(s)}</p>
        </div>
        {delivery && (
          <p className="flex shrink-0 items-center gap-1 text-[12px] text-ink-2">
            <Clock className="size-3.5 text-muted" /> {delivery}
          </p>
        )}
      </div>

      {s.accomplishes.length > 0 && (
        <ul className="mt-4 space-y-1.5">
          {s.accomplishes.slice(0, 3).map((a) => (
            <li key={a} className="flex items-start gap-2 text-[12.5px] leading-snug text-ink-2">
              <Check className="mt-0.5 size-3.5 shrink-0 text-success" /> {a}
            </li>
          ))}
        </ul>
      )}

      {s.useCases[0] && (
        <p className="mt-3 text-[12px] leading-relaxed text-muted">
          <span className="font-medium text-ink-2">Example:</span> {s.useCases[0]}
        </p>
      )}

      {s.platforms.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {s.platforms.slice(0, 5).map((p) => (
            <TechnologyPill key={p} name={p}/>
          ))}
          {s.platforms.length > 5 && <Chip>+{s.platforms.length - 5}</Chip>}
        </div>
      )}

      {s.portfolio.length > 0 && (
        <p className="mt-4 text-[12px] leading-relaxed text-muted">
          Related work:{" "}
          {s.portfolio.slice(0, 2).map((p, i) => (
            <React.Fragment key={p.slug}>
              {i > 0 && ", "}
              <Link href={`/our-work/${p.slug}`} className="font-medium text-primary hover:underline">
                {p.title.split(":")[0]}
              </Link>
            </React.Fragment>
          ))}
        </p>
      )}

      <div className="mt-auto flex flex-wrap gap-2 pt-5">
        <Button variant="secondary" size="sm" onClick={onDetails}>
          Details
        </Button>
        {available && canRequest ? (
          <ButtonLink href={requestHref(s.slug)} variant="brand" size="sm" className="flex-1 sm:flex-none">
            Request This Service <ArrowRight className="size-3.5" />
          </ButtonLink>
        ) : (
          <Button size="sm" disabled variant="soft" title={available ? "Only owners and admins can request" : "Not open for requests right now"}>
            {available ? "Request This Service" : AVAILABILITY_LABEL[s.availability]}
          </Button>
        )}
      </div>
    </Card>
  );
}

function List({ title, items, icon }: { title: string; items: string[]; icon?: "check" | "dot" }) {
  if (!items.length) return null;
  return (
    <div>
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[.08em] text-muted">{title}</h3>
      <ul className="space-y-1.5">
        {items.map((i) => (
          <li key={i} className="flex items-start gap-2 text-[13.5px] leading-snug text-ink-2">
            {icon === "dot" ? <span className="mt-2 size-1 shrink-0 rounded-full bg-faint" /> : <Check className="mt-0.5 size-4 shrink-0 text-success" />} {i}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ServiceDetail({ service: s, canRequest, onClose }: { service: ServiceView | null; canRequest: boolean; onClose: () => void }) {
  const delivery = s ? formatDelivery(s.deliveryMinDays, s.deliveryMaxDays) : null;
  return (
    <Dialog
      open={!!s}
      onOpenChange={(o) => !o && onClose()}
      title={s?.name ?? "Service"}
      description={s?.tagline}
      size="xl"
      footer={
        s && (
          <>
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            {s.availability === "available" && canRequest && (
              <ButtonLink href={requestHref(s.slug)} variant="brand">
                Request This Service <ArrowRight className="size-4" />
              </ButtonLink>
            )}
          </>
        )
      }
    >
      {s && (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl bg-surface-2 p-3.5">
              <p className="text-[11.5px] font-medium uppercase tracking-[.08em] text-muted">Price</p>
              <p className="mt-1 text-[20px] font-semibold tabular-nums">{formatPrice(s.price)}</p>
              <p className="mt-0.5 text-[11.5px] leading-snug text-muted">{s.price?.note ?? priceCaption(s)}</p>
            </div>
            <div className="rounded-xl bg-surface-2 p-3.5">
              <p className="text-[11.5px] font-medium uppercase tracking-[.08em] text-muted">Typical delivery</p>
              <p className="mt-1 text-[20px] font-semibold">{delivery ?? "Scoped with you"}</p>
              <p className="mt-0.5 text-[11.5px] text-muted">A written scope and timeline come before any work starts.</p>
            </div>
            <div className="rounded-xl bg-surface-2 p-3.5">
              <p className="text-[11.5px] font-medium uppercase tracking-[.08em] text-muted">How it&apos;s billed</p>
              <p className="mt-1 text-[14px] font-semibold">Quoted first</p>
              <p className="mt-0.5 text-[11.5px] text-muted">Requesting is free. Nothing is charged automatically.</p>
            </div>
          </div>

          {s.coreOverlapNote && (
            <p className="flex items-start gap-2 rounded-xl border border-primary/20 bg-primary-soft/50 p-3.5 text-[13px] leading-relaxed text-ink-2">
              <Layers className="mt-0.5 size-4 shrink-0 text-primary" /> {s.coreOverlapNote}
            </p>
          )}

          {s.description && s.description !== s.tagline && <p className="text-[14px] leading-relaxed text-ink-2">{s.description}</p>}

          {s.problemSolved && (
            <div>
              <h3 className="mb-1.5 text-[12px] font-semibold uppercase tracking-[.08em] text-muted">The problem it solves</h3>
              <p className="text-[14px] leading-relaxed text-ink-2">{s.problemSolved}</p>
            </div>
          )}

          <div className="grid gap-6 md:grid-cols-2">
            <List title="What it can accomplish" items={s.accomplishes} />
            <List title="What you get" items={s.deliverables} />
            <List title="Example use cases" items={s.useCases} icon="dot" />
            <List title="Optional upgrades" items={s.optionalUpgrades} icon="dot" />
          </div>

          {s.platforms.length > 0 && (
            <div>
              <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[.08em] text-muted">Platforms supported</h3>
              <div className="flex flex-wrap gap-1.5">
                {s.platforms.map((p) => (
                  <Chip key={p}>{p}</Chip>
                ))}
              </div>
            </div>
          )}

          <List title="Not included" items={s.exclusions} icon="dot" />

          {s.portfolio.length > 0 && (
            <div>
              <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[.08em] text-muted">Relevant work from our founder</h3>
              <ul className="space-y-1.5">
                {s.portfolio.map((p) => (
                  <li key={p.slug}>
                    <Link href={`/our-work/${p.slug}`} className="inline-flex items-center gap-2 text-[13.5px] font-medium text-primary hover:underline">
                      {p.title} <ArrowRight className="size-3.5" />
                    </Link>
                    {p.status !== "built" && <Badge tone="warning" className="ml-2">{PORTFOLIO_STATUS_LABEL[p.status]}</Badge>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-[12px] leading-relaxed text-faint">
            Published prices are starting prices or typical ranges for the standard system. Whether your project fits is decided after our team reviews it, and the final price is confirmed in writing
            {s.kind === "custom_build" ? ` after discovery (from ${formatMoney(s.price?.minCents)})` : ""}.
          </p>
        </div>
      )}
    </Dialog>
  );
}
