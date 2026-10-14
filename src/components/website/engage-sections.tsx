import * as React from "react";
import { Check, ChevronDown, Quote } from "lucide-react";
import type { SiteSection } from "@/lib/website/schema";
import {
  Anchor, ButtonLink, CARD, GAP, Heading, Lede, itemLevel, RADIUS, RADIUS_LG, SectionHead, SectionShell, SiteImage, Wrap, hasLink, headingLevel,
  type Band, type RenderContext,
} from "./parts";

type Props = { ctx: RenderContext; section: SiteSection; band: Band; index: number };

// ---------------------------------------------------------------------------
// Testimonials: only ever real, owner-confirmed words
// ---------------------------------------------------------------------------

interface Testimonial { quote: string; author: string; role: string; confirmedReal: boolean }

export function Testimonials({ ctx, section, band }: Props) {
  const d = section.data as unknown as { heading: string; items: Testimonial[] };
  const preview = ctx.mode === "preview";
  // The live site never shows a testimonial the owner has not confirmed as real, whatever the stored content says.
  const items = d.items.filter((t) => t.quote && (preview || t.confirmedReal));
  if (!items.length) return null;
  const { testimonials, surface, density } = ctx.spec;
  const attribution = (t: Testimonial) => (
    <figcaption className="mt-4 text-sm">
      <span className="font-semibold text-[color:var(--s-ink)]">{t.author || "Customer"}</span>
      {t.role && <span className="text-[color:var(--s-muted)]"> · {t.role}</span>}
      {preview && !t.confirmedReal && !ctx.content.isSample && <span className="mt-1 block rounded bg-[#fff4dc] px-2 py-1 text-xs font-medium text-[#8f5b00]">Not confirmed. This won&apos;t appear on your live site.</span>}
    </figcaption>
  );
  let body: React.ReactNode;
  if (testimonials === "quote") {
    const [first, ...rest] = items;
    body = (
      <div className="grid gap-8 @4xl:grid-cols-[1.4fr_1fr] @4xl:gap-12">
        <figure>
          <Quote className="size-10 text-[color:var(--s-primary-text)] opacity-70" aria-hidden />
          <blockquote className="mt-4 whitespace-pre-line text-[length:var(--s-h3)] font-medium leading-snug text-[color:var(--s-ink)] [font-family:var(--s-font-h)] @3xl:text-[length:var(--s-h2)]">“{first.quote}”</blockquote>
          {attribution(first)}
        </figure>
        {rest.length > 0 && (
          <ul className="space-y-5">
            {rest.map((t, i) => (
              <li key={i} className={`${CARD[surface]} ${RADIUS} p-5`}>
                <figure>
                  <blockquote className="whitespace-pre-line text-[color:var(--s-ink)]">“{t.quote}”</blockquote>
                  {attribution(t)}
                </figure>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  } else if (testimonials === "wall") {
    body = (
      <ul className="gap-5 [column-fill:balance] @2xl:columns-2 @4xl:columns-3">
        {items.map((t, i) => (
          <li key={i} className={`${CARD[surface]} ${RADIUS} mb-5 break-inside-avoid p-5`}>
            <figure>
              <blockquote className="whitespace-pre-line text-[color:var(--s-ink)]">“{t.quote}”</blockquote>
              {attribution(t)}
            </figure>
          </li>
        ))}
      </ul>
    );
  } else {
    body = (
      <ul className={`grid ${GAP[density]} @2xl:grid-cols-2 @4xl:grid-cols-3`}>
        {items.map((t, i) => (
          <li key={i} className={`${CARD[surface]} ${RADIUS} flex flex-col p-6`}>
            <Quote className="size-6 text-[color:var(--s-primary-text)] opacity-70" aria-hidden />
            <figure className="mt-3 flex-1">
              <blockquote className="whitespace-pre-line text-[color:var(--s-ink)]">{t.quote}</blockquote>
              {attribution(t)}
            </figure>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <SectionShell ctx={ctx} id={section.id} band={band}>
      <Wrap>
        <SectionHead ctx={ctx} id={section.id} heading={d.heading} />
        {body}
      </Wrap>
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// FAQ: native <details>, so it works without JavaScript and is keyboard accessible
// ---------------------------------------------------------------------------

interface FaqItem { question: string; answer: string }
export function Faq({ ctx, section, band }: Props) {
  const d = section.data as unknown as { heading: string; intro: string; items: FaqItem[] };
  const { faq, surface, density } = ctx.spec;
  const summary = "flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 py-4 text-left font-semibold text-[color:var(--s-ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--s-primary-text)] [&::-webkit-details-marker]:hidden";
  const chevron = <ChevronDown className="size-5 shrink-0 text-[color:var(--s-primary-text)] motion-safe:transition-transform group-open:rotate-180" aria-hidden />;
  let body: React.ReactNode;
  if (faq === "columns") {
    body = (
      <dl className="grid gap-x-12 gap-y-8 @3xl:grid-cols-2">
        {d.items.map((f, i) => (
          <div key={i}>
            <dt className="font-semibold text-[color:var(--s-ink)] [font-family:var(--s-font-h)] text-[length:var(--s-h3)]">{f.question}</dt>
            <dd className="mt-2 whitespace-pre-line text-[color:var(--s-muted)]">{f.answer}</dd>
          </div>
        ))}
      </dl>
    );
  } else if (faq === "cards") {
    body = (
      <ul className={`grid ${GAP[density]} @3xl:grid-cols-2`}>
        {d.items.map((f, i) => (
          <li key={i}>
            <details className={`group ${CARD[surface]} ${RADIUS} px-5`}>
              <summary className={summary}>
                {f.question}
                {chevron}
              </summary>
              <p className="whitespace-pre-line pb-5 text-[color:var(--s-muted)]">{f.answer}</p>
            </details>
          </li>
        ))}
      </ul>
    );
  } else {
    body = (
      <ul className="mx-auto max-w-3xl divide-y divide-[color:var(--s-line)] border-y border-[color:var(--s-line)]">
        {d.items.map((f, i) => (
          <li key={i}>
            <details className="group">
              <summary className={summary}>
                {f.question}
                {chevron}
              </summary>
              <p className="whitespace-pre-line pb-5 pr-9 text-[color:var(--s-muted)]">{f.answer}</p>
            </details>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <SectionShell ctx={ctx} id={section.id} band={band}>
      <Wrap>
        <SectionHead ctx={ctx} id={section.id} heading={d.heading} intro={d.intro} align={faq === "accordion" ? "center" : "left"} />
        {body}
      </Wrap>
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Call to action
// ---------------------------------------------------------------------------

interface CtaData { heading: string; body: string; button: { label: string; href: string }; secondary: { label: string; href: string } }
export function Cta({ ctx, section, band }: Props) {
  const d = section.data as unknown as CtaData;
  const { cta, surface } = ctx.spec;
  const level = headingLevel(ctx, section.id);
  const heading = d.heading && (
    <Heading level={level} ctx={ctx} size="h2" className="!text-[color:inherit]">
      {d.heading}
    </Heading>
  );
  if (cta === "card") {
    return (
      <SectionShell ctx={ctx} id={section.id} band={band}>
        <Wrap narrow>
          <div className={`${CARD[surface]} ${RADIUS_LG} px-6 py-10 text-center shadow-[var(--s-shadow)] @3xl:px-12 @3xl:py-14`}>
            {d.heading && (
              <Heading level={level} ctx={ctx} size="h2">
                {d.heading}
              </Heading>
            )}
            <Lede className="mx-auto mt-4 max-w-xl">{d.body}</Lede>
            <div className="mt-7 flex flex-wrap justify-center gap-3">
              <ButtonLink ctx={ctx} link={d.button} />
              <ButtonLink ctx={ctx} link={d.secondary} variant="secondary" />
            </div>
          </div>
        </Wrap>
      </SectionShell>
    );
  }
  if (cta === "split") {
    return (
      <SectionShell ctx={ctx} id={section.id} band={band === "base" ? "alt" : band}>
        <Wrap className="grid items-center gap-6 @3xl:grid-cols-[1.5fr_1fr] @3xl:gap-12">
          <div>
            {d.heading && (
              <Heading level={level} ctx={ctx} size="h2">
                {d.heading}
              </Heading>
            )}
            <Lede className="mt-3 max-w-xl">{d.body}</Lede>
          </div>
          <div className="flex flex-wrap gap-3 @3xl:justify-end">
            <ButtonLink ctx={ctx} link={d.button} />
            <ButtonLink ctx={ctx} link={d.secondary} variant="secondary" />
          </div>
        </Wrap>
      </SectionShell>
    );
  }
  if (cta === "minimal") {
    return (
      <SectionShell ctx={ctx} id={section.id} band={band}>
        <Wrap narrow className="text-center">
          {d.heading && (
            <Heading level={level} ctx={ctx} size="h2">
              {d.heading}
            </Heading>
          )}
          <Lede className="mt-3">{d.body}</Lede>
          {hasLink(d.button) && (
            <Anchor ctx={ctx} href={d.button.href} className="mt-6 inline-flex min-h-11 items-center border-b-2 border-[color:var(--s-primary)] pb-0.5 text-lg font-semibold text-[color:var(--s-ink)] hover:text-[color:var(--s-primary-text)]">
              {d.button.label} →
            </Anchor>
          )}
        </Wrap>
      </SectionShell>
    );
  }
  // band: full-width brand colour
  return (
    <section id={section.id} className="relative overflow-hidden bg-[var(--s-primary)] py-12 text-[color:var(--s-on-primary)] @3xl:py-16">
      <div aria-hidden className="absolute -right-16 -top-16 size-64 rounded-full bg-white/10" />
      <Wrap className="relative flex flex-col items-center gap-6 text-center @3xl:flex-row @3xl:justify-between @3xl:text-left">
        <div className="max-w-2xl">
          {heading}
          {d.body && <p className="mt-3 whitespace-pre-line text-lg opacity-90">{d.body}</p>}
        </div>
        <div className="flex flex-wrap justify-center gap-3">
          <ButtonLink ctx={ctx} link={d.button} variant="onPrimary" />
          {hasLink(d.secondary) && (
            <Anchor ctx={ctx} href={d.secondary.href} className={`inline-flex min-h-11 items-center justify-center border-2 border-current px-5 py-2.5 text-[0.95rem] font-semibold no-underline rounded-[var(--s-r-btn)]`}>
              {d.secondary.label}
            </Anchor>
          )}
        </div>
      </Wrap>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

export function Gallery({ ctx, section, band }: Props) {
  const d = section.data as unknown as { heading: string; intro: string; images: Array<{ image: string | null; caption: string }> };
  const items = d.images.map((g) => ({ asset: ctx.resolveAsset(g.image), caption: g.caption })).filter((g) => g.asset);
  if (!items.length) return null;
  const { gallery, density } = ctx.spec;
  let body: React.ReactNode;
  if (gallery === "masonry") {
    body = (
      <ul className="gap-4 @2xl:columns-2 @4xl:columns-3">
        {items.map((g, i) => (
          <li key={i} className="mb-4 break-inside-avoid">
            <figure className={`overflow-hidden ${RADIUS}`}>
              <SiteImage asset={g.asset} className="w-full object-cover" />
              {g.caption && <figcaption className="bg-[var(--s-surface)] px-4 py-2.5 text-sm text-[color:var(--s-muted)]">{g.caption}</figcaption>}
            </figure>
          </li>
        ))}
      </ul>
    );
  } else if (gallery === "strip") {
    body = (
      <ul tabIndex={0} aria-label="Gallery images, scroll sideways" className="-mx-5 flex snap-x snap-mandatory gap-4 overflow-x-auto px-5 pb-4 focus-visible:outline-2 focus-visible:outline-[color:var(--s-primary-text)] @3xl:-mx-8 @3xl:px-8">
        {items.map((g, i) => (
          <li key={i} className="w-[78%] shrink-0 snap-start @2xl:w-[46%] @4xl:w-[32%]">
            <figure className={`overflow-hidden ${RADIUS}`}>
              <SiteImage asset={g.asset} className="aspect-[4/3] w-full object-cover" />
              {g.caption && <figcaption className="mt-2 text-sm text-[color:var(--s-muted)]">{g.caption}</figcaption>}
            </figure>
          </li>
        ))}
      </ul>
    );
  } else {
    body = (
      <ul className={`grid ${GAP[density]} @2xl:grid-cols-2 @4xl:grid-cols-3`}>
        {items.map((g, i) => (
          <li key={i}>
            <figure className={`overflow-hidden ${RADIUS}`}>
              <SiteImage asset={g.asset} className="aspect-[4/3] w-full object-cover" />
              {g.caption && <figcaption className="mt-2 text-sm text-[color:var(--s-muted)]">{g.caption}</figcaption>}
            </figure>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <SectionShell ctx={ctx} id={section.id} band={band}>
      <Wrap>
        <SectionHead ctx={ctx} id={section.id} heading={d.heading} intro={d.intro} />
        {body}
      </Wrap>
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Pricing: only prices the owner entered
// ---------------------------------------------------------------------------

interface Plan { name: string; price: string; description: string; features: string[]; cta: { label: string; href: string } }
export function Pricing({ ctx, section, band }: Props) {
  const d = section.data as unknown as { heading: string; intro: string; plans: Plan[]; note: string };
  const { services, surface, density } = ctx.spec;
  const lvl = itemLevel(ctx, section.id, d.heading);
  const rows = services === "rows" || services === "numbered";
  return (
    <SectionShell ctx={ctx} id={section.id} band={band}>
      <Wrap>
        <SectionHead ctx={ctx} id={section.id} heading={d.heading} intro={d.intro} />
        {rows ? (
          <ul className="divide-y divide-[color:var(--s-line)] border-y border-[color:var(--s-line)]">
            {d.plans.map((p, i) => (
              <li key={i} className="grid gap-3 py-6 @3xl:grid-cols-[1fr_auto_auto] @3xl:items-center @3xl:gap-10">
                <div>
                  <Heading level={lvl} ctx={ctx} size="h3">{p.name}</Heading>
                  <p className="mt-1 text-[color:var(--s-muted)]">{p.description}</p>
                  {p.features.length > 0 && <p className="mt-2 text-sm text-[color:var(--s-muted)]">{p.features.join(" · ")}</p>}
                </div>
                <p className="text-2xl font-bold text-[color:var(--s-ink)] [font-family:var(--s-font-h)]">{p.price}</p>
                <ButtonLink ctx={ctx} link={p.cta} />
              </li>
            ))}
          </ul>
        ) : (
          <ul className={`grid ${GAP[density]} @2xl:grid-cols-2 @4xl:grid-cols-3`}>
            {d.plans.map((p, i) => (
              <li key={i} className={`${CARD[surface]} ${RADIUS} flex flex-col p-6`}>
                <Heading level={lvl} ctx={ctx} size="h3">{p.name}</Heading>
                <p className="mt-3 text-3xl font-bold text-[color:var(--s-ink)] [font-family:var(--s-font-h)]">{p.price}</p>
                <p className="mt-2 text-[color:var(--s-muted)]">{p.description}</p>
                <ul className="mt-4 flex-1 space-y-2">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-sm">
                      <Check className="mt-0.5 size-4 shrink-0 text-[color:var(--s-primary-text)]" aria-hidden strokeWidth={2.5} />
                      {f}
                    </li>
                  ))}
                </ul>
                <ButtonLink ctx={ctx} link={p.cta} className="mt-6" />
              </li>
            ))}
          </ul>
        )}
        {d.note && <p className="mt-6 text-sm text-[color:var(--s-muted)]">{d.note}</p>}
      </Wrap>
    </SectionShell>
  );
}

