import * as React from "react";
import { isExternalHref, pagePath, type ImageSrc } from "@/lib/website/doc";
import { Icon, SocialIcon } from "./icons";
import { CountUp, VideoFacade } from "./islands";
import { Art } from "./art";
import { displayPhone, ImageEl, imageShows, isIllustration, isTemplateStarter, pad2, Paras, rootProps, telHref, Txt } from "./parts";
import { Inline_ } from "./parts";
import type { ElementProps, RenderCtx } from "./ctx";

const s = (v: unknown) => (typeof v === "string" ? v : "");
const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
type P = ElementProps & { index?: number };

function Empty({ el, ctx, index, label }: { el: P["el"]; ctx: RenderCtx; index?: number; label: string }) {
  if (ctx.mode !== "edit") return null;
  return <div {...rootProps(el, ctx, "iq-empty-el", index)}>{label}</div>;
}

const Linked = ({ link, className, children }: { link?: { label: string; href: string }; className?: string; children: React.ReactNode }) =>
  link && link.href ? (
    <a className={className} href={link.href} {...(isExternalHref(link.href) ? { rel: "noopener noreferrer" } : {})}>
      {children}
    </a>
  ) : (
    <>{children}</>
  );

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

interface Svc { title: string; text: string; icon: string; image: ImageSrc; link: { label: string; href: string } }

export function Services({ el, ctx, p, index }: P) {
  const items = list<Svc>(p.items).filter((it) => ctx.mode !== "published" || it.title);
  if (!items.length) return <Empty el={el} ctx={ctx} index={index} label="Services: add your services in the panel" />;
  const style = s(p.style) || "grid";
  const showImage = style === "imageCards" || style === "alternating";
  const showIcon = style === "grid" || style === "iconCards" || style === "bento" || style === "rows" || style === "columns";
  return (
    <div {...rootProps(el, ctx, "iq-services", index)} data-style={style} data-cols={s(p.cols) || "3"}>
      {items.map((it, i) => (
        <article key={i} className="iq-svc" data-i={i % 12}>
          {showImage && imageShows(ctx, it.image) && (
            <div className="iq-svc-img" {...(isIllustration(it.image) ? { "data-illustration": "" } : {})} {...(isTemplateStarter(it.image) ? { "data-starter-image": "" } : {})}>
              <ImageEl ctx={ctx} o={{ src: it.image, alt: "", className: "iq-fill", sizes: "(max-width: 768px) 100vw, 40vw" }} />
            </div>
          )}
          {showIcon && it.icon && <span className="iq-svc-ic"><Icon name={it.icon} /></span>}
          {style === "numbered" && <span className="iq-svc-n" aria-hidden>{pad2(i + 1)}</span>}
          <div className="iq-svc-body">
            <Txt ctx={ctx} id={el.id} path={`items.${i}.title`} value={it.title} as="h3" className="iq-svc-t" plain placeholder="Service name" />
            {(it.text || ctx.edit) && <Paras ctx={ctx} id={el.id} path={`items.${i}.text`} value={it.text} className="iq-svc-x" placeholder="Describe it" />}
            {it.link?.href && (
              <Linked link={it.link} className="iq-svc-l">
                {it.link.label || "Learn more"} <Icon name="arrow-right" className="iq-svc-arrow" />
              </Linked>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Process
// ---------------------------------------------------------------------------

export function Steps({ el, ctx, p, index }: P) {
  const items = list<{ title: string; text: string }>(p.items).filter((it) => ctx.mode !== "published" || it.title);
  if (!items.length) return <Empty el={el} ctx={ctx} index={index} label="Process: add steps in the panel" />;
  const style = s(p.style) || "timeline";
  return (
    <ol {...rootProps(el, ctx, "iq-steps", index)} data-style={style}>
      {items.map((it, i) => (
        <li key={i} className="iq-step">
          <span className="iq-step-n" aria-hidden>{style === "numbered" ? pad2(i + 1) : i + 1}</span>
          <div className="iq-step-body">
            <Txt ctx={ctx} id={el.id} path={`items.${i}.title`} value={it.title} as="h3" className="iq-step-t" plain placeholder="Step" />
            {(it.text || ctx.edit) && <Paras ctx={ctx} id={el.id} path={`items.${i}.text`} value={it.text} className="iq-step-x" placeholder="What happens" />}
          </div>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// FAQ
// ---------------------------------------------------------------------------

export function Faq({ el, ctx, p, index }: P) {
  const items = list<{ q: string; a: string }>(p.items).filter((it) => ctx.mode !== "published" || (it.q && it.a));
  if (!items.length) return <Empty el={el} ctx={ctx} index={index} label="FAQ: add questions in the panel" />;
  const style = s(p.style) || "accordion";
  return (
    <div {...rootProps(el, ctx, "iq-faq", index)} data-style={style}>
      {items.map((it, i) => (
        <details key={i} className="iq-qa" open={p.openFirst === true && i === 0 ? true : undefined}>
          <summary>
            <Txt ctx={ctx} id={el.id} path={`items.${i}.q`} value={it.q} as="span" className="iq-q" plain placeholder="Question" />
            <span className="iq-qa-ic" aria-hidden><i /><i /></span>
          </summary>
          <Paras ctx={ctx} id={el.id} path={`items.${i}.a`} value={it.a} className="iq-a" placeholder="Answer" />
        </details>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Testimonials, numbers, logos, team, pricing
// ---------------------------------------------------------------------------

interface Tm { quote: string; author: string; role: string; avatar: ImageSrc; confirmedReal: boolean }

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("");

export function Testimonials({ el, ctx, p, index }: P) {
  // On a live page only quotes the owner confirmed are real, with permission, are ever drawn.
  const items = list<Tm>(p.items).filter((t) => t.quote && (ctx.mode !== "published" || t.confirmedReal));
  if (!items.length) return <Empty el={el} ctx={ctx} index={index} label="Testimonials: add real customer words in the panel" />;
  const style = s(p.style) || "cards";
  return (
    <div {...rootProps(el, ctx, "iq-testi", index)} data-style={style} data-n={Math.min(items.length, 4)}>
      {items.map((t, i) => (
        <figure key={i} className="iq-tm">
          <Icon name="quote" className="iq-tm-q" />
          <Paras ctx={ctx} id={el.id} path={`items.${i}.quote`} value={t.quote} className="iq-tm-t" placeholder="What they said" />
          <figcaption>
            {imageShows(ctx, t.avatar) ? (
              <span className="iq-av"><ImageEl ctx={ctx} o={{ src: t.avatar, alt: "", className: "iq-fill", sizes: "56px" }} /></span>
            ) : (
              <span className="iq-av iq-av-i" aria-hidden>{initials(t.author) || "·"}</span>
            )}
            <span className="iq-tm-who">
              <Txt ctx={ctx} id={el.id} path={`items.${i}.author`} value={t.author} as="strong" plain placeholder="Name" />
              {(t.role || ctx.edit) && <Txt ctx={ctx} id={el.id} path={`items.${i}.role`} value={t.role} as="span" plain placeholder="Who they are" />}
            </span>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

export function Stats({ el, ctx, p, index }: P) {
  const items = list<{ value: string; prefix: string; suffix: string; label: string }>(p.items).filter((it) => ctx.mode !== "published" || (it.value && it.label));
  if (!items.length) return <Empty el={el} ctx={ctx} index={index} label="Numbers: add figures you can verify in the panel" />;
  const style = s(p.style) || "row";
  return (
    <dl {...rootProps(el, ctx, "iq-stats", index)} data-style={style} data-n={Math.min(items.length, 4)}>
      {items.map((it, i) => (
        <div key={i} className="iq-stat">
          <dd className="iq-stat-v">
            {ctx.edit ? (
              <Txt ctx={ctx} id={el.id} path={`items.${i}.value`} value={it.value} plain placeholder="0" />
            ) : p.countUp === true ? (
              <CountUp value={it.value} prefix={it.prefix} suffix={it.suffix} />
            ) : (
              <>{it.prefix}{it.value}{it.suffix}</>
            )}
          </dd>
          <dt className="iq-stat-l"><Txt ctx={ctx} id={el.id} path={`items.${i}.label`} value={it.label} plain placeholder="Label" /></dt>
        </div>
      ))}
    </dl>
  );
}

export function Logos({ el, ctx, p, index }: P) {
  const items = list<{ name: string; image: ImageSrc }>(p.items).filter((it) => ctx.mode !== "published" || it.name || imageShows(ctx, it.image));
  if (!items.length) return <Empty el={el} ctx={ctx} index={index} label="Logos: add partners or accreditations in the panel" />;
  const style = s(p.style) || "row";
  const track = (dup: boolean) =>
    items.map((it, i) => (
      <li key={`${dup ? "d" : "a"}${i}`} className="iq-logo-i" aria-hidden={dup ? true : undefined}>
        {imageShows(ctx, it.image) ? <ImageEl ctx={ctx} o={{ src: it.image, alt: dup ? "" : it.name, className: "iq-logo-img", sizes: "160px" }} /> : <span className="iq-logo-t">{it.name}</span>}
      </li>
    ));
  return (
    <div {...rootProps(el, ctx, "iq-logos", index)} data-style={style} data-gray={p.grayscale === true ? "" : undefined}>
      <ul className="iq-logos-track">
        {track(false)}
        {style === "marquee" && track(true)}
      </ul>
    </div>
  );
}

export function Team({ el, ctx, p, index }: P) {
  const members = list<{ name: string; role: string; photo: ImageSrc; bio: string }>(p.members).filter((m) => ctx.mode !== "published" || m.name);
  if (!members.length) return <Empty el={el} ctx={ctx} index={index} label="Team: add people in the panel" />;
  return (
    <div {...rootProps(el, ctx, "iq-team", index)} data-style={s(p.style) || "cards"} data-cols={s(p.cols) || "3"}>
      {members.map((m, i) => (
        <article key={i} className="iq-member">
          <div className="iq-member-ph" {...(isIllustration(m.photo) ? { "data-illustration": "" } : {})}>
            {imageShows(ctx, m.photo) ? <ImageEl ctx={ctx} o={{ src: m.photo, alt: m.name, className: "iq-fill", sizes: "(max-width: 768px) 60vw, 25vw" }} /> : <span className="iq-av-i">{initials(m.name) || "·"}</span>}
          </div>
          <Txt ctx={ctx} id={el.id} path={`members.${i}.name`} value={m.name} as="h3" className="iq-member-n" plain placeholder="Name" />
          {(m.role || ctx.edit) && <Txt ctx={ctx} id={el.id} path={`members.${i}.role`} value={m.role} as="p" className="iq-member-r" plain placeholder="Role" />}
          {(m.bio || ctx.edit) && <Paras ctx={ctx} id={el.id} path={`members.${i}.bio`} value={m.bio} className="iq-member-b" placeholder="A short bio" />}
        </article>
      ))}
    </div>
  );
}

export function Pricing({ el, ctx, p, index }: P) {
  const plans = list<{ name: string; price: string; period: string; text: string; features: string[]; cta: { label: string; href: string }; featured: boolean }>(p.plans).filter((pl) => ctx.mode !== "published" || pl.name);
  if (!plans.length) return <Empty el={el} ctx={ctx} index={index} label="Pricing: add plans in the panel" />;
  return (
    <div {...rootProps(el, ctx, "iq-pricing", index)} data-n={plans.length}>
      <div className="iq-plans">
        {plans.map((pl, i) => (
          <article key={i} className="iq-plan" data-featured={pl.featured ? "" : undefined}>
            <Txt ctx={ctx} id={el.id} path={`plans.${i}.name`} value={pl.name} as="h3" className="iq-plan-n" plain placeholder="Plan" />
            <p className="iq-plan-p">
              <Txt ctx={ctx} id={el.id} path={`plans.${i}.price`} value={pl.price} as="strong" plain placeholder="$0" />
              {(pl.period || ctx.edit) && <span className="iq-plan-per">/ <Txt ctx={ctx} id={el.id} path={`plans.${i}.period`} value={pl.period} plain placeholder="month" /></span>}
            </p>
            {(pl.text || ctx.edit) && <Paras ctx={ctx} id={el.id} path={`plans.${i}.text`} value={pl.text} className="iq-plan-x" placeholder="Describe the plan" />}
            {pl.features.length > 0 && (
              <ul className="iq-list" data-style="check">
                {pl.features.map((f, j) => (
                  <li key={j}><Icon name="check" className="iq-li-ic" strokeWidth={2.4} /><Txt ctx={ctx} id={el.id} path={`plans.${i}.features.${j}`} value={f} placeholder="Feature" /></li>
                ))}
              </ul>
            )}
            {pl.cta?.label && <a className="iq-btn" data-v={pl.featured ? "primary" : "outline"} data-s="m" href={pl.cta.href || "#"}><span className="iq-btn-l">{pl.cta.label}</span></a>}
          </article>
        ))}
      </div>
      {s(p.note) && <p className="iq-note">{s(p.note)}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

/** In a four-column mosaic the first picture takes a 2 by 2 block; the last one stretches so the final row has no gap. */
function mosaicTail(n: number): number {
  const rest = n - 1 - 4;
  if (rest <= 0) return 1;
  const left = rest % 4;
  return left === 0 ? 1 : 4 - left + 1;
}

export function Gallery({ el, ctx, p, index }: P) {
  const items = list<{ src: ImageSrc; alt: string; caption: string }>(p.items).filter((it) => ctx.mode !== "published" || imageShows(ctx, it.src));
  if (!items.length) return <Empty el={el} ctx={ctx} index={index} label="Gallery: add images in the panel" />;
  const layout = s(p.layout) || "grid";
  const aspect = s(p.aspect) || "4/3";
  return (
    <div {...rootProps(el, ctx, "iq-gal", index)} {...(layout === "strip" && ctx.mode !== "edit" ? { tabIndex: 0, role: "region", "aria-label": "Gallery. Scrolls sideways; use the arrow keys." } : {})} data-layout={layout} data-cols={s(p.cols) || "3"} data-gap={s(p.gap) || "s"} style={{ ...((rootProps(el, ctx, "", index).style as object) ?? {}), "--ar": aspect === "auto" ? "4 / 3" : aspect.replace("/", " / ") } as React.CSSProperties}>
      {items.map((it, i) => (
        <figure key={i} className="iq-gi" data-i={i % 9} style={layout === "mosaic" && i === items.length - 1 && i > 0 ? { gridColumn: `span ${mosaicTail(items.length)}` } : undefined} {...(isIllustration(it.src) ? { "data-illustration": "" } : {})} {...(isTemplateStarter(it.src) ? { "data-starter-image": "" } : {})}>
          <div className="iq-gi-in"><ImageEl ctx={ctx} o={{ src: it.src, alt: it.alt || it.caption, className: "iq-fill", sizes: "(max-width: 768px) 80vw, 33vw" }} /></div>
          {(it.caption || ctx.edit) && <Txt ctx={ctx} id={el.id} path={`items.${i}.caption`} value={it.caption} as="figcaption" className="iq-cap" plain placeholder="Caption" />}
        </figure>
      ))}
    </div>
  );
}

export function Collage({ el, ctx, p, index }: P) {
  const items = list<{ src: ImageSrc; alt: string }>(p.items).filter((it) => ctx.mode !== "published" || imageShows(ctx, it.src)).slice(0, 4);
  if (!items.length) return <Empty el={el} ctx={ctx} index={index} label="Collage: add images in the panel" />;
  return (
    <div {...rootProps(el, ctx, "iq-collage", index)} data-layout={s(p.layout) || "trio"} data-n={items.length}>
      {items.map((it, i) => (
        <div key={i} className="iq-ci" data-i={i} {...(isIllustration(it.src) ? { "data-illustration": "" } : {})} {...(isTemplateStarter(it.src) ? { "data-starter-image": "" } : {})}>
          <ImageEl ctx={ctx} o={{ src: it.src, alt: it.alt, className: "iq-fill", sizes: "(max-width: 768px) 70vw, 30vw", priority: i === 0 }} />
        </div>
      ))}
    </div>
  );
}

export function Video({ el, ctx, p, index }: P) {
  const id = s(p.videoId);
  if (!id) return <Empty el={el} ctx={ctx} index={index} label="Video: add the video's ID in the panel" />;
  const aspect = s(p.aspect) || "16/9";
  const poster = p.poster as ImageSrc;
  const root = rootProps(el, ctx, "iq-video", index);
  return (
    <div {...root} style={{ ...((root.style as object) ?? {}), aspectRatio: aspect === "auto" ? "16 / 9" : aspect.replace("/", " / ") }}>
      {ctx.edit ? (
        <div className="iq-video-play" aria-hidden>
          {imageShows(ctx, poster) && <ImageEl ctx={ctx} o={{ src: poster, alt: "", className: "iq-fill" }} />}
          <span className="iq-play"><svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M8 5.5v13l11-6.5-11-6.5Z" /></svg></span>
        </div>
      ) : (
        <VideoFacade provider={s(p.provider) === "vimeo" ? "vimeo" : "youtube"} videoId={id} title={s(p.title)}>
          {imageShows(ctx, poster) && <ImageEl ctx={ctx} o={{ src: poster, alt: "", className: "iq-fill" }} />}
        </VideoFacade>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Business
// ---------------------------------------------------------------------------

export function ContactInfo({ el, ctx, p, index }: P) {
  const b = ctx.content.business;
  const rows = [
    p.phone === true && b.phone && { key: "phone", icon: "phone", label: "Phone", node: <a href={telHref(b.phone)}>{displayPhone(b.phone)}</a> },
    p.email === true && b.email && { key: "email", icon: "mail", label: "Email", node: <a href={`mailto:${b.email}`}>{b.email}</a> },
    p.address === true && b.address && { key: "address", icon: "map-pin", label: "Address", node: <span className="iq-pre">{b.address}</span> },
    p.hours === true && b.hours && { key: "hours", icon: "clock", label: "Hours", node: <span className="iq-pre">{b.hours}</span> },
  ].filter(Boolean) as Array<{ key: string; icon: string; label: string; node: React.ReactNode }>;
  if (!rows.length) return <Empty el={el} ctx={ctx} index={index} label="Contact details: add your phone, email or address in Site settings" />;
  return (
    <dl {...rootProps(el, ctx, "iq-cinfo", index)} data-layout={s(p.layout) || "stack"}>
      {rows.map((r) => (
        <div key={r.key} className="iq-ci-row">
          <dt><span className="iq-ci-ic"><Icon name={r.icon} /></span><span className="iq-ci-l">{r.label}</span></dt>
          <dd>{r.node}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Social({ el, ctx, p, index }: P) {
  const soc = ctx.content.social;
  const nets = (["facebook", "instagram", "linkedin", "x", "youtube", "tiktok"] as const).filter((k) => soc[k]);
  if (!nets.length) return <Empty el={el} ctx={ctx} index={index} label="Social links: add your pages in Site settings" />;
  const LABEL: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn", x: "X", youtube: "YouTube", tiktok: "TikTok" };
  const style = s(p.style) || "icons";
  return (
    <ul {...rootProps(el, ctx, "iq-social", index)} data-style={style} data-size={s(p.size) || "m"}>
      {nets.map((k) => (
        <li key={k}>
          <a href={soc[k]} rel="noopener noreferrer" aria-label={LABEL[k]}>
            <SocialIcon network={k} className="iq-soc-ic" />
            {style === "links" && <span>{LABEL[k]}</span>}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function MapEl({ el, ctx, p, index }: P) {
  const address = (s(p.address) || ctx.content.business.address).trim();
  if (!address) return <Empty el={el} ctx={ctx} index={index} label="Location: add your address in Site settings" />;
  const q = encodeURIComponent(address.replace(/\n/g, ", "));
  const style = s(p.style) || "card";
  return (
    <div {...rootProps(el, ctx, "iq-map", index)} data-style={style}>
      {style === "art" && <Art scene="streets" className="iq-map-art" />}
      <div className="iq-map-card">
        <span className="iq-map-pin"><Icon name="map-pin" /></span>
        <p className="iq-pre">{address}</p>
        <a className="iq-btn" data-v="outline" data-s="s" href={`https://www.google.com/maps/search/?api=1&query=${q}`} rel="noopener noreferrer"><span className="iq-btn-l">{s(p.label) || "Open in maps"}</span><Icon name="arrow-up-right" className="iq-btn-ic iq-btn-arrow" /></a>
      </div>
    </div>
  );
}

export function Marquee({ el, ctx, p, index }: P) {
  const items = list<string>(p.items).filter(Boolean);
  if (!items.length) return <Empty el={el} ctx={ctx} index={index} label="Scrolling words: add words in the panel" />;
  const speed = s(p.speed) || "normal";
  const style = s(p.style) || "text";
  const run = (dup: boolean) => (
    <ul className="iq-mq-run" aria-hidden={dup ? true : undefined}>
      {items.map((t, i) => (
        <li key={i}>{dup ? t : <Txt ctx={ctx} id={el.id} path={`items.${i}`} value={t} plain placeholder="Word" />}<span className="iq-mq-sep" aria-hidden>✦</span></li>
      ))}
    </ul>
  );
  return (
    <div {...rootProps(el, ctx, "iq-marquee", index)} data-speed={speed} data-style={style}>
      <div className="iq-mq-track">{run(false)}{run(true)}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Navigation, logo, form
// ---------------------------------------------------------------------------

export function Logo({ el, ctx, p, index }: P) {
  const b = ctx.content.business;
  const asset = ctx.content.brand.logoAssetId ? ctx.resolveAsset(ctx.content.brand.logoAssetId, ctx.content.brand.logoVariant) : null;
  const variant = s(p.variant) || "auto";
  const showImg = asset && variant !== "text";
  const showName = !showImg || variant === "both";
  return (
    <a {...rootProps(el, ctx, "iq-logo", index)} href={ctx.hrefFor("home")} data-size={s(p.size) || "m"} aria-label={b.name || "Home"}>
      {showImg && asset && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={asset.src} width={asset.width ?? undefined} height={asset.height ?? undefined} alt="" className="iq-logo-mark" decoding="async" />
      )}
      {showName && <span className="iq-logo-name">{b.name || "Your business"}</span>}
      {p.tagline === true && b.tagline && <span className="iq-logo-tag">{b.tagline}</span>}
    </a>
  );
}

export function Nav({ el, ctx, p, index }: P) {
  const pages = ctx.content.pages.filter((pg) => pg.showInNav && pg.kind !== "thanks");
  const extra = list<{ label: string; href: string }>(p.extra).filter((x) => x.label && x.href);
  const links = [...pages.map((pg) => ({ key: pg.slug, label: pg.navLabel || pg.title, href: ctx.hrefFor(pg.slug), current: pg.slug === ctx.page.slug })), ...extra.map((x) => ({ key: x.href + x.label, label: x.label, href: x.href, current: false }))];
  const cta = (p.cta ?? { label: "", href: "" }) as { label: string; href: string };
  const showCta = p.showCta === true && cta.label;
  const items = links.map((l) => (
    <li key={l.key}>
      <a href={l.href} {...(l.current ? { "aria-current": "page" as const } : {})} {...(isExternalHref(l.href) ? { rel: "noopener noreferrer" } : {})}>{l.label}</a>
    </li>
  ));
  const ctaEl = showCta ? <a className="iq-btn" data-v="primary" data-s="s" href={cta.href || "/contact"}><span className="iq-btn-l">{cta.label}</span></a> : null;
  return (
    <nav {...rootProps(el, ctx, "iq-nav", index)} aria-label={ctx.region === "footer" ? "Footer" : "Main"} data-style={s(p.style) || "links"} data-align={s(p.align) || "end"}>
      <ul className="iq-nav-list">
        {items}
        {ctaEl && <li className="iq-nav-cta">{ctaEl}</li>}
      </ul>
      <details className="iq-menu">
        <summary aria-label="Menu"><span className="iq-burger" aria-hidden><i /><i /><i /></span></summary>
        <div className="iq-menu-panel">
          <ul>{items}</ul>
          {ctaEl}
        </div>
      </details>
    </nav>
  );
}

export function FormEl({ el, ctx, p, index }: P) {
  const f = ctx.content.form;
  if (!f.enabled) return <Empty el={el} ctx={ctx} index={index} label="Enquiry form: turn the form on in Site settings" />;
  const preview = ctx.formAction === null;
  const mode = (k: "phone" | "message" | "service") => (s(p[k]) || f.fields[k]) as "required" | "optional" | "hidden";
  const req = (m: string) => m === "required";
  const phone = mode("phone");
  const message = mode("message");
  const serviceMode = mode("service");
  const services = list<string>(p.services).length ? list<string>(p.services) : f.services;
  const fid = (k: string) => `f-${el.id}-${k}`;
  const layout = s(p.layout) || "card";
  return (
    <form {...rootProps(el, ctx, "iq-form", index)} data-layout={layout} method="post" action={ctx.formAction ?? "#"} aria-label="Enquiry form" onSubmit={undefined}>
      <fieldset disabled={preview}>
        <input type="hidden" name="p" value={ctx.page.slug} />
        <input type="hidden" name="t" value={ctx.formToken} />
        <input type="hidden" name="k" value={s(p.purpose) || "contact"} />
        <input type="hidden" name="e" value={el.id} />
        <div aria-hidden className="iq-trap"><label>Leave this field empty<input type="text" name="company_website" tabIndex={-1} autoComplete="off" /></label></div>
        <div className="iq-fields">
          <div className="iq-fld"><label htmlFor={fid("name")}>Your name</label><input id={fid("name")} name="name" required maxLength={120} autoComplete="name" /></div>
          <div className="iq-fld"><label htmlFor={fid("email")}>Email</label><input id={fid("email")} name="email" type="email" required maxLength={320} autoComplete="email" /></div>
          {phone !== "hidden" && <div className="iq-fld"><label htmlFor={fid("phone")}>Phone{!req(phone) && <span className="iq-opt"> (optional)</span>}</label><input id={fid("phone")} name="phone" type="tel" inputMode="tel" required={req(phone)} maxLength={30} autoComplete="tel" /></div>}
          {serviceMode !== "hidden" && services.length > 0 && (
            <div className="iq-fld"><label htmlFor={fid("service")}>What do you need?{!req(serviceMode) && <span className="iq-opt"> (optional)</span>}</label>
              <select id={fid("service")} name="service" required={req(serviceMode)} defaultValue=""><option value="">Choose one</option>{services.map((sv) => <option key={sv} value={sv}>{sv}</option>)}</select></div>
          )}
          {message !== "hidden" && <div className="iq-fld iq-fld-wide"><label htmlFor={fid("message")}>How can we help?{!req(message) && <span className="iq-opt"> (optional)</span>}</label><textarea id={fid("message")} name="message" rows={4} required={req(message)} maxLength={2000} /></div>}
        </div>
        <label className="iq-check"><input type="checkbox" name="consent" value="yes" required /><span>{f.consentText}</span></label>
        {f.marketingOptIn && <label className="iq-check iq-check-soft"><input type="checkbox" name="marketing" value="yes" /><span>{f.marketingText}</span></label>}
        <button type="submit" className="iq-btn" data-v="primary" data-s="l" data-full=""><span className="iq-btn-l">{s(p.submitLabel) || "Send message"}</span></button>
        {s(p.helper) && <p className="iq-note">{s(p.helper)}</p>}
      </fieldset>
      {preview && <p className="iq-note">Preview only: the form is switched off here and works on your live site.</p>}
    </form>
  );
}

export { Inline_, pagePath };
