import * as React from "react";
import { Check } from "lucide-react";
import type { SiteSection } from "@/lib/website/schema";
import { BRAND_GRADIENT, ButtonLink, CARD, Decor, Eyebrow, Heading, Lede, RADIUS_LG, SiteImage, SectionShell, Wrap, headingLevel, type Band, type RenderContext } from "./parts";

interface HeroData {
  eyebrow: string; headline: string; subheadline: string;
  primaryCta: { label: string; href: string }; secondaryCta: { label: string; href: string };
  image: string | null; badges: string[];
}

function Badges({ items, className = "" }: { items: string[]; className?: string }) {
  if (!items.length) return null;
  return (
    <ul className={`flex flex-wrap gap-x-5 gap-y-2 ${className}`}>
      {items.map((b) => (
        <li key={b} className="flex items-center gap-1.5 text-sm font-medium text-[color:var(--s-ink)]">
          <Check className="size-4 shrink-0 text-[color:var(--s-primary-text)]" aria-hidden strokeWidth={2.5} />
          {b}
        </li>
      ))}
    </ul>
  );
}

function Buttons({ ctx, d, inverse = false }: { ctx: RenderContext; d: HeroData; inverse?: boolean }) {
  if (!d.primaryCta.label && !d.secondaryCta.label) return null;
  return (
    <div className="mt-7 flex flex-wrap gap-3">
      <ButtonLink ctx={ctx} link={d.primaryCta} variant={inverse ? "onDark" : "primary"} />
      <ButtonLink ctx={ctx} link={d.secondaryCta} variant="secondary" />
    </div>
  );
}

function Copy({ ctx, id, d, align = "left", inverse = false, maxW = "max-w-xl" }: { ctx: RenderContext; id: string; d: HeroData; align?: "left" | "center"; inverse?: boolean; maxW?: string }) {
  const level = headingLevel(ctx, id);
  const centered = align === "center";
  return (
    <div className={`${maxW} ${centered ? "mx-auto text-center" : ""}`}>
      <Eyebrow className="mb-4">{d.eyebrow}</Eyebrow>
      <Heading level={level} ctx={ctx} size="h1">
        {d.headline || ctx.content.business.name}
      </Heading>
      <Lede className="mt-5">{d.subheadline}</Lede>
      <div className={centered ? "flex flex-col items-center" : ""}>
        <Buttons ctx={ctx} d={d} inverse={inverse} />
      </div>
      <Badges items={d.badges} className={`mt-7 ${centered ? "justify-center" : ""}`} />
    </div>
  );
}

/** When no photo has been uploaded, a branded panel stands in so the layout still looks finished. */
function Visual({ ctx, d, className = "", tall = false }: { ctx: RenderContext; d: HeroData; className?: string; tall?: boolean }) {
  const asset = ctx.resolveAsset(d.image);
  if (asset) return <SiteImage asset={asset} eager sizes="(min-width: 768px) 50vw, 100vw" className={`size-full object-cover ${className}`} />;
  return (
    <div aria-hidden className={`${BRAND_GRADIENT} relative size-full ${tall ? "min-h-80" : "min-h-56"} overflow-hidden ${className}`}>
      <div className="absolute -right-10 -top-10 size-48 rounded-full bg-white/10" />
      <div className="absolute -bottom-16 left-6 size-56 rounded-full bg-[var(--s-accent)] opacity-30 blur-2xl" />
      <div className="absolute left-8 top-8 size-16 rounded-[var(--s-r)] border border-white/30" />
    </div>
  );
}

export function Hero({ ctx, section, band }: { ctx: RenderContext; section: SiteSection; band: Band; index: number }) {
  const d = section.data as unknown as HeroData;
  const { hero, decor } = ctx.spec;
  const id = section.id;
  const imageAsset = ctx.resolveAsset(d.image);

  if (hero === "fullbleed" || hero === "overlayCard") {
    const card = hero === "overlayCard";
    return (
      <SectionShell ctx={ctx} id={id} band="inverse" bleed>
        <div className={`relative flex min-h-[28rem] @3xl:min-h-[36rem] ${card ? "items-center" : "items-end"}`}>
          {imageAsset ? <SiteImage asset={imageAsset} eager decorative className="absolute inset-0 size-full object-cover" /> : <div aria-hidden className={`absolute inset-0 ${BRAND_GRADIENT}`} />}
          <div aria-hidden className={`absolute inset-0 ${card ? "bg-[rgb(8_10_18/.45)]" : "bg-[linear-gradient(to_top,rgb(8_10_18/.84),rgb(8_10_18/.42))]"}`} />
          <Wrap className="relative py-14 @3xl:py-20">
            {card ? (
              <div className={`max-w-xl border border-[color:var(--s-line)] bg-[var(--s-bg)] p-6 text-[color:var(--s-ink)] shadow-[var(--s-shadow)] @3xl:p-10 ${RADIUS_LG}`} style={{ ["--s-ink" as string]: "#0f1419", ["--s-muted" as string]: "#4b5563", ["--s-primary-text" as string]: "var(--s-primary)" }}>
                <Copy ctx={ctx} id={id} d={d} />
              </div>
            ) : (
              <Copy ctx={ctx} id={id} d={d} inverse maxW="max-w-2xl" />
            )}
          </Wrap>
        </div>
      </SectionShell>
    );
  }

  if (hero === "split" || hero === "splitReverse") {
    const reverse = hero === "splitReverse";
    return (
      <SectionShell ctx={ctx} id={id} band={band}>
        <Decor kind={decor} />
        <Wrap className="grid items-center gap-10 @3xl:grid-cols-2 @3xl:gap-14">
          <div className={reverse ? "@3xl:order-2" : ""}>
            <Copy ctx={ctx} id={id} d={d} />
          </div>
          <div className={`overflow-hidden ${RADIUS_LG} ${CARD[ctx.spec.surface]} aspect-[4/3] @3xl:aspect-auto @3xl:h-[26rem] ${reverse ? "@3xl:order-1" : ""}`}>
            <Visual ctx={ctx} d={d} tall />
          </div>
        </Wrap>
      </SectionShell>
    );
  }

  if (hero === "centered") {
    return (
      <SectionShell ctx={ctx} id={id} band={band}>
        <Decor kind={decor} />
        <Wrap>
          <Copy ctx={ctx} id={id} d={d} align="center" maxW="max-w-3xl" />
          <div className={`mx-auto mt-10 aspect-[16/8] max-w-4xl overflow-hidden ${RADIUS_LG} ${CARD[ctx.spec.surface]}`}>
            <Visual ctx={ctx} d={d} />
          </div>
        </Wrap>
      </SectionShell>
    );
  }

  if (hero === "editorial") {
    const level = headingLevel(ctx, id);
    return (
      <SectionShell ctx={ctx} id={id} band={band}>
        <Decor kind={decor} />
        <Wrap>
          <div className="border-t-2 border-[color:var(--s-ink)] pt-6">
            <div className="grid gap-8 @3xl:grid-cols-[1.6fr_1fr] @3xl:items-end @3xl:gap-14">
              <div>
                <Eyebrow className="mb-4">{d.eyebrow}</Eyebrow>
                <Heading level={level} ctx={ctx} size="h1">
                  {d.headline || ctx.content.business.name}
                </Heading>
              </div>
              <div>
                <Lede>{d.subheadline}</Lede>
                <Buttons ctx={ctx} d={d} />
              </div>
            </div>
          </div>
          <div className={`mt-10 aspect-[21/8] overflow-hidden ${RADIUS_LG}`}>
            <Visual ctx={ctx} d={d} />
          </div>
          <Badges items={d.badges} className="mt-6" />
        </Wrap>
      </SectionShell>
    );
  }

  if (hero === "stacked") {
    return (
      <SectionShell ctx={ctx} id={id} band={band}>
        <Decor kind={decor} />
        <Wrap>
          <Copy ctx={ctx} id={id} d={d} maxW="max-w-4xl" />
          <div className={`mt-10 grid gap-4 @3xl:grid-cols-3`}>
            <div className={`col-span-full overflow-hidden ${RADIUS_LG} aspect-[16/7] @3xl:col-span-3`}>
              <Visual ctx={ctx} d={d} />
            </div>
          </div>
        </Wrap>
      </SectionShell>
    );
  }

  // framed: a bordered panel with a technical, ruled look
  return (
    <SectionShell ctx={ctx} id={id} band={band}>
      <Decor kind={decor} />
      <Wrap>
        <div className={`grid border-2 border-[color:var(--s-ink)] @3xl:grid-cols-[1.2fr_1fr] ${ctx.spec.radius === "square" ? "" : "rounded-[var(--s-r)]"} overflow-hidden`}>
          <div className="p-6 @3xl:p-12">
            <Copy ctx={ctx} id={id} d={d} />
          </div>
          <div className="min-h-56 border-t-2 border-[color:var(--s-ink)] @3xl:border-l-2 @3xl:border-t-0">
            <Visual ctx={ctx} d={d} tall />
          </div>
        </div>
      </Wrap>
    </SectionShell>
  );
}
