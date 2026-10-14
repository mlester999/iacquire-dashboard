import * as React from "react";
import { ArrowRight, Check, MapPin } from "lucide-react";
import type { SiteSection } from "@/lib/website/schema";
import {
  Anchor, BRAND_GRADIENT, CARD, Decor, GAP, Heading, Icon, Lede, itemLevel, RADIUS, RADIUS_LG, SectionHead, SectionShell, SiteImage, Wrap, hasLink, headingLevel,
  type Band, type RenderContext,
} from "./parts";

type Props = { ctx: RenderContext; section: SiteSection; band: Band; index: number };
const num = (i: number) => String(i + 1).padStart(2, "0");

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

interface ServiceItem { title: string; description: string; icon: string; link: { label: string; href: string } }
interface ServicesData { heading: string; intro: string; items: ServiceItem[] }

function MoreLink({ ctx, link }: { ctx: RenderContext; link: ServiceItem["link"] }) {
  if (!hasLink(link)) return null;
  return (
    <Anchor ctx={ctx} href={link.href} className="mt-4 inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-[color:var(--s-primary-text)] hover:underline">
      {link.label} <ArrowRight className="size-4" aria-hidden />
    </Anchor>
  );
}

export function Services({ ctx, section, band }: Props) {
  const d = section.data as unknown as ServicesData;
  const { services, surface, density, decor } = ctx.spec;
  const lvl = itemLevel(ctx, section.id, d.heading);
  const card = `${CARD[surface]} ${RADIUS}`;
  const items = d.items;
  let body: React.ReactNode;

  if (services === "rows") {
    body = (
      <ul className="divide-y divide-[color:var(--s-line)] border-y border-[color:var(--s-line)]">
        {items.map((s, i) => (
          <li key={i} className="grid gap-3 py-6 @3xl:grid-cols-[3.5rem_1fr_auto] @3xl:items-center @3xl:gap-8">
            <span className={`flex size-12 items-center justify-center bg-[var(--s-primary-soft)] text-[color:var(--s-primary-text)] ${RADIUS}`}>
              <Icon name={s.icon} className="size-6" />
            </span>
            <div>
              <Heading level={lvl} ctx={ctx} size="h3">{s.title}</Heading>
              <p className="mt-1 max-w-2xl whitespace-pre-line text-[color:var(--s-muted)]">{s.description}</p>
            </div>
            <MoreLink ctx={ctx} link={s.link} />
          </li>
        ))}
      </ul>
    );
  } else if (services === "numbered") {
    body = (
      <ol className={`grid ${GAP[density]} @2xl:grid-cols-2`}>
        {items.map((s, i) => (
          <li key={i} className="border-t-2 border-[color:var(--s-ink)] pt-5">
            <span className="text-[length:var(--s-h2)] font-[var(--s-weight)] leading-none text-[color:var(--s-primary-text)] [font-family:var(--s-font-h)]">{num(i)}</span>
            <Heading level={lvl} ctx={ctx} size="h3" className="mt-4">{s.title}</Heading>
            <p className="mt-2 whitespace-pre-line text-[color:var(--s-muted)]">{s.description}</p>
            <MoreLink ctx={ctx} link={s.link} />
          </li>
        ))}
      </ol>
    );
  } else if (services === "alternating") {
    body = (
      <ul className="space-y-10 @3xl:space-y-14">
        {items.map((s, i) => (
          <li key={i} className="grid items-center gap-6 @3xl:grid-cols-2 @3xl:gap-14">
            <div className={i % 2 ? "@3xl:order-2" : ""}>
              <p className="text-sm font-semibold tracking-widest text-[color:var(--s-primary-text)]">{num(i)}</p>
              <Heading level={lvl} ctx={ctx} size="h2" className="mt-2">{s.title}</Heading>
              <p className="mt-3 whitespace-pre-line text-[1.05rem] leading-relaxed text-[color:var(--s-muted)]">{s.description}</p>
              <MoreLink ctx={ctx} link={s.link} />
            </div>
            <div aria-hidden className={`${BRAND_GRADIENT} flex aspect-[16/9] items-center justify-center text-white ${RADIUS_LG} ${i % 2 ? "@3xl:order-1" : ""}`}>
              <Icon name={s.icon} className="size-16 opacity-90" />
            </div>
          </li>
        ))}
      </ul>
    );
  } else if (services === "bento" && items.length >= 3) {
    body = (
      <ul className={`grid ${GAP[density]} @2xl:grid-cols-2 @4xl:grid-cols-4`}>
        {items.map((s, i) => {
          const hero = i === 0;
          return (
            <li key={i} className={`${hero ? `${BRAND_GRADIENT} text-white @4xl:col-span-2 @4xl:row-span-2 @4xl:p-10` : card} flex flex-col p-6 ${hero ? RADIUS_LG : ""}`}>
              <span className={`flex size-11 items-center justify-center ${hero ? "bg-white/15 text-white" : "bg-[var(--s-primary-soft)] text-[color:var(--s-primary-text)]"} ${RADIUS}`}>
                <Icon name={s.icon} className="size-5" />
              </span>
              <Heading level={lvl} ctx={ctx} size={hero ? "h2" : "h3"} className={`mt-5 ${hero ? "!text-white" : ""}`}>{s.title}</Heading>
              <p className={`mt-2 whitespace-pre-line ${hero ? "text-white/85" : "text-[color:var(--s-muted)]"}`}>{s.description}</p>
              {!hero && <MoreLink ctx={ctx} link={s.link} />}
            </li>
          );
        })}
      </ul>
    );
  } else if (services === "iconCards") {
    body = (
      <ul className={`grid ${GAP[density]} @2xl:grid-cols-2 @4xl:grid-cols-3`}>
        {items.map((s, i) => (
          <li key={i} className={`${card} p-7 text-center`}>
            <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-[var(--s-primary-soft)] text-[color:var(--s-primary-text)]">
              <Icon name={s.icon} className="size-7" />
            </span>
            <Heading level={lvl} ctx={ctx} size="h3" className="mt-5">{s.title}</Heading>
            <p className="mt-2 whitespace-pre-line text-[color:var(--s-muted)]">{s.description}</p>
            <MoreLink ctx={ctx} link={s.link} />
          </li>
        ))}
      </ul>
    );
  } else {
    body = (
      <ul className={`grid ${GAP[density]} @2xl:grid-cols-2 @4xl:grid-cols-3`}>
        {items.map((s, i) => (
          <li key={i} className={`${card} p-6`}>
            <span className={`flex size-11 items-center justify-center bg-[var(--s-primary-soft)] text-[color:var(--s-primary-text)] ${RADIUS}`}>
              <Icon name={s.icon} className="size-5" />
            </span>
            <Heading level={lvl} ctx={ctx} size="h3" className="mt-5">{s.title}</Heading>
            <p className="mt-2 whitespace-pre-line text-[color:var(--s-muted)]">{s.description}</p>
            <MoreLink ctx={ctx} link={s.link} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <SectionShell ctx={ctx} id={section.id} band={band}>
      {band === "base" && <Decor kind={decor === "blobs" ? "none" : decor} />}
      <Wrap>
        <SectionHead ctx={ctx} id={section.id} heading={d.heading} intro={d.intro} />
        {body}
      </Wrap>
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Process
// ---------------------------------------------------------------------------

interface ProcessData { heading: string; intro: string; steps: Array<{ title: string; description: string }> }
export function Process({ ctx, section, band }: Props) {
  const d = section.data as unknown as ProcessData;
  const { process, surface, density } = ctx.spec;
  const lvl = itemLevel(ctx, section.id, d.heading);
  let body: React.ReactNode;
  if (process === "timeline") {
    body = (
      <ol className="relative ml-4 space-y-8 border-l-2 border-[color:var(--s-line)] pl-8 @3xl:ml-6 @3xl:pl-12">
        {d.steps.map((s, i) => (
          <li key={i} className="relative">
            <span className="absolute -left-[3.15rem] top-0 flex size-9 items-center justify-center rounded-full bg-[var(--s-primary)] text-sm font-bold text-[color:var(--s-on-primary)] @3xl:-left-[4.15rem]">{i + 1}</span>
            <Heading level={lvl} ctx={ctx} size="h3">{s.title}</Heading>
            <p className="mt-1 max-w-xl whitespace-pre-line text-[color:var(--s-muted)]">{s.description}</p>
          </li>
        ))}
      </ol>
    );
  } else if (process === "cards") {
    body = (
      <ol className={`grid ${GAP[density]} @2xl:grid-cols-2 @4xl:grid-cols-3`}>
        {d.steps.map((s, i) => (
          <li key={i} className={`${CARD[surface]} ${RADIUS} p-6`}>
            <span className="text-3xl font-bold text-[color:var(--s-primary-text)] [font-family:var(--s-font-h)]">{num(i)}</span>
            <Heading level={lvl} ctx={ctx} size="h3" className="mt-3">{s.title}</Heading>
            <p className="mt-2 whitespace-pre-line text-[color:var(--s-muted)]">{s.description}</p>
          </li>
        ))}
      </ol>
    );
  } else {
    body = (
      <ol className={`grid ${GAP[density]} @2xl:grid-cols-2 @4xl:grid-flow-col @4xl:auto-cols-fr`}>
        {d.steps.map((s, i) => (
          <li key={i}>
            <span className="flex size-12 items-center justify-center rounded-full bg-[var(--s-primary)] text-lg font-bold text-[color:var(--s-on-primary)]">{i + 1}</span>
            <Heading level={lvl} ctx={ctx} size="h3" className="mt-4">{s.title}</Heading>
            <p className="mt-2 whitespace-pre-line text-[color:var(--s-muted)]">{s.description}</p>
          </li>
        ))}
      </ol>
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
// About
// ---------------------------------------------------------------------------

interface AboutData { heading: string; body: string; image: string | null; points: string[] }
function Points({ items, className = "" }: { items: string[]; className?: string }) {
  if (!items.length) return null;
  return (
    <ul className={`space-y-2.5 ${className}`}>
      {items.map((p) => (
        <li key={p} className="flex items-start gap-2.5">
          <Check className="mt-1 size-4 shrink-0 text-[color:var(--s-primary-text)]" aria-hidden strokeWidth={2.5} />
          <span>{p}</span>
        </li>
      ))}
    </ul>
  );
}

export function About({ ctx, section, band }: Props) {
  const d = section.data as unknown as AboutData;
  const { about, surface } = ctx.spec;
  const level = headingLevel(ctx, section.id);
  const asset = ctx.resolveAsset(d.image);
  const heading = d.heading && (
    <Heading level={level} ctx={ctx} size={level === 1 ? "h1" : "h2"}>
      {d.heading}
    </Heading>
  );
  const bodyText = d.body && <p className="mt-5 whitespace-pre-line text-[1.05rem] leading-relaxed text-[color:var(--s-muted)] text-pretty">{d.body}</p>;

  if (about === "centered") {
    return (
      <SectionShell ctx={ctx} id={section.id} band={band}>
        <Wrap narrow className="text-center">
          {heading}
          {bodyText}
          {d.points.length > 0 && (
            <ul className="mt-8 flex flex-wrap justify-center gap-2.5">
              {d.points.map((p) => (
                <li key={p} className={`${CARD[surface]} rounded-full px-4 py-2 text-sm font-medium`}>
                  {p}
                </li>
              ))}
            </ul>
          )}
        </Wrap>
      </SectionShell>
    );
  }
  if (about === "story") {
    return (
      <SectionShell ctx={ctx} id={section.id} band={band}>
        <Wrap narrow>
          <div className="border-l-4 border-[color:var(--s-primary)] pl-6 @3xl:pl-8">
            {heading}
            {bodyText}
          </div>
          <Points items={d.points} className="mt-8 text-[color:var(--s-ink)]" />
          {asset && <SiteImage asset={asset} className={`mt-8 aspect-[16/9] w-full object-cover ${RADIUS_LG}`} />}
        </Wrap>
      </SectionShell>
    );
  }
  if (about === "statsRow") {
    return (
      <SectionShell ctx={ctx} id={section.id} band={band}>
        <Wrap className="grid gap-10 @3xl:grid-cols-[1.2fr_1fr] @3xl:items-center @3xl:gap-14">
          <div>
            {heading}
            {bodyText}
          </div>
          <ul className="grid gap-3 @2xl:grid-cols-2 @3xl:grid-cols-1">
            {d.points.length ? d.points.map((p, i) => (
              <li key={p} className={`${CARD[surface]} ${RADIUS} flex items-center gap-4 p-4`}>
                <span className="text-2xl font-bold text-[color:var(--s-primary-text)] [font-family:var(--s-font-h)]">{num(i)}</span>
                <span className="font-medium">{p}</span>
              </li>
            )) : <SiteImage asset={asset} className={`aspect-[4/3] w-full object-cover ${RADIUS_LG}`} />}
          </ul>
        </Wrap>
      </SectionShell>
    );
  }
  return (
    <SectionShell ctx={ctx} id={section.id} band={band}>
      <Wrap className="grid items-center gap-10 @3xl:grid-cols-2 @3xl:gap-14">
        <div>
          {heading}
          {bodyText}
          <Points items={d.points} className="mt-6" />
        </div>
        {asset ? (
          <SiteImage asset={asset} className={`aspect-[4/3] w-full object-cover ${RADIUS_LG}`} />
        ) : (
          <div aria-hidden className={`${BRAND_GRADIENT} aspect-[4/3] w-full ${RADIUS_LG}`} />
        )}
      </Wrap>
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Stats, areas, team, free text
// ---------------------------------------------------------------------------

export function Stats({ ctx, section, band }: Props) {
  const d = section.data as unknown as { items: Array<{ value: string; label: string }> };
  const { surface } = ctx.spec;
  return (
    <SectionShell ctx={ctx} id={section.id} band={band} className="!py-8 @3xl:!py-12">
      <Wrap>
        <dl className="grid gap-4 @2xl:grid-cols-2 @4xl:grid-flow-col @4xl:auto-cols-fr">
          {d.items.map((s, i) => (
            <div key={i} className={`${CARD[surface]} ${RADIUS} flex flex-col-reverse p-5 text-center`}>
              <dt className="mt-2 text-sm font-medium text-[color:var(--s-muted)]">{s.label}</dt>
              <dd className="text-[length:var(--s-h2)] font-[var(--s-weight)] leading-none text-[color:var(--s-primary-text)] [font-family:var(--s-font-h)]">{s.value}</dd>
            </div>
          ))}
        </dl>
      </Wrap>
    </SectionShell>
  );
}

export function Areas({ ctx, section, band }: Props) {
  const d = section.data as unknown as { heading: string; intro: string; areas: string[] };
  const { surface } = ctx.spec;
  return (
    <SectionShell ctx={ctx} id={section.id} band={band}>
      <Wrap>
        <SectionHead ctx={ctx} id={section.id} heading={d.heading} intro={d.intro} />
        <ul className="flex flex-wrap gap-2.5">
          {d.areas.map((a) => (
            <li key={a} className={`${CARD[surface]} inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium`}>
              <MapPin className="size-3.5 text-[color:var(--s-primary-text)]" aria-hidden />
              {a}
            </li>
          ))}
        </ul>
      </Wrap>
    </SectionShell>
  );
}

export function Team({ ctx, section, band }: Props) {
  const d = section.data as unknown as { heading: string; members: Array<{ name: string; role: string; photo: string | null; bio: string }> };
  const { surface, density } = ctx.spec;
  const lvl = itemLevel(ctx, section.id, d.heading);
  return (
    <SectionShell ctx={ctx} id={section.id} band={band}>
      <Wrap>
        <SectionHead ctx={ctx} id={section.id} heading={d.heading} />
        <ul className={`grid ${GAP[density]} @2xl:grid-cols-2 @4xl:grid-cols-4`}>
          {d.members.map((m, i) => {
            const photo = ctx.resolveAsset(m.photo);
            return (
              <li key={i} className={`${CARD[surface]} ${RADIUS} overflow-hidden`}>
                {photo ? <SiteImage asset={photo} className="aspect-square w-full object-cover" /> : <div aria-hidden className={`${BRAND_GRADIENT} flex aspect-square items-center justify-center text-4xl font-bold text-white/90`}>{m.name.slice(0, 1)}</div>}
                <div className="p-5">
                  <Heading level={lvl} ctx={ctx} size="h3">{m.name}</Heading>
                  <p className="text-sm font-medium text-[color:var(--s-primary-text)]">{m.role}</p>
                  {m.bio && <p className="mt-2 text-sm text-[color:var(--s-muted)]">{m.bio}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      </Wrap>
    </SectionShell>
  );
}

export function RichText({ ctx, section, band }: Props) {
  const d = section.data as unknown as { heading: string; body: string };
  return (
    <SectionShell ctx={ctx} id={section.id} band={band}>
      <Wrap narrow>
        <SectionHead ctx={ctx} id={section.id} heading={d.heading} />
        <Lede className="text-[color:var(--s-ink)]">{d.body}</Lede>
      </Wrap>
    </SectionShell>
  );
}
