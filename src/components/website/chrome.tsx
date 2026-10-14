import * as React from "react";
import { Menu, Phone } from "lucide-react";
import { BTN_RADIUS, Heading, RADIUS_LG, SiteImage, Wrap, type RenderContext } from "./parts";
import { Details, displayPhone, telHref } from "./contact";

const navLinkClass = "inline-flex min-h-11 items-center px-3 text-[0.95rem] font-medium text-[color:var(--s-ink)] no-underline hover:text-[color:var(--s-primary-text)] aria-[current=page]:font-semibold aria-[current=page]:text-[color:var(--s-primary-text)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--s-primary-text)]";

function Brand({ ctx, size = "md", plate = false }: { ctx: RenderContext; size?: "md" | "lg"; plate?: boolean }) {
  const b = ctx.content.business;
  const logo = ctx.resolveAsset(ctx.content.brand.logoAssetId, ctx.content.brand.logoVariant);
  const home = ctx.hrefFor("home");
  return (
    <a href={home} className="inline-flex min-h-11 items-center gap-2.5 no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--s-primary-text)]" aria-label={`${b.name}, home`}>
      {logo ? (
        // Owners upload logos designed for light backgrounds. On a dark template the logo sits on a light plate so it can never disappear.
        <span className={ctx.spec.tone === "dark" || plate ? "inline-flex rounded-[var(--s-r)] bg-white px-2.5 py-1.5" : "inline-flex"}>
          <SiteImage asset={{ ...logo, alt: "" }} eager className={`${size === "lg" ? "max-h-14" : "max-h-10"} w-auto max-w-[11rem] object-contain`} />
        </span>
      ) : (
        <span className={`${size === "lg" ? "text-2xl" : "text-xl"} font-[var(--s-weight)] leading-none text-[color:var(--s-ink)] [font-family:var(--s-font-h)] [letter-spacing:var(--s-track)] ${ctx.spec.type.upper ? "uppercase" : ""}`}>{b.name}</span>
      )}
      {logo && <span className="sr-only">{b.name}</span>}
    </a>
  );
}

/** A header or footer landmark, or a plain container when the page is embedded in another page that has its own landmarks. */
function Landmark({ as, ctx, ...rest }: React.HTMLAttributes<HTMLElement> & { as: "header" | "footer"; ctx: RenderContext }) {
  return ctx.embedded ? <div {...rest} /> : React.createElement(as, rest);
}

function navPages(ctx: RenderContext) {
  return ctx.content.pages.filter((p) => p.showInNav);
}

function DesktopNav({ ctx, className = "" }: { ctx: RenderContext; className?: string }) {
  return (
    <nav aria-label="Main" className={`hidden @3xl:block ${className}`}>
      <ul className="flex items-center">
        {navPages(ctx).map((p) => (
          <li key={p.slug}>
            <a href={ctx.hrefFor(p.slug)} aria-current={p.slug === ctx.page.slug ? "page" : undefined} className={navLinkClass}>
              {p.navLabel || p.title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** A no-JavaScript mobile menu built on <details>, which is keyboard and screen-reader accessible. */
function MobileMenu({ ctx }: { ctx: RenderContext }) {
  return (
    <details className="group relative @3xl:hidden">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-sm font-semibold text-[color:var(--s-ink)] focus-visible:outline-2 focus-visible:outline-[color:var(--s-primary-text)] [&::-webkit-details-marker]:hidden" aria-label="Menu">
        <Menu className="size-5" aria-hidden /> Menu
      </summary>
      <nav aria-label="Main (mobile)" className={`absolute right-0 top-full z-30 mt-2 w-56 border border-[color:var(--s-line)] bg-[var(--s-surface)] p-2 shadow-[var(--s-shadow)] ${RADIUS_LG}`}>
        <ul>
          {navPages(ctx).map((p) => (
            <li key={p.slug}>
              <a href={ctx.hrefFor(p.slug)} aria-current={p.slug === ctx.page.slug ? "page" : undefined} className={`${navLinkClass} w-full`}>
                {p.navLabel || p.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </details>
  );
}

function HeaderCta({ ctx }: { ctx: RenderContext }) {
  const phone = ctx.content.business.phone;
  const contact = ctx.content.pages.find((p) => p.slug === "contact");
  if (phone)
    return (
      <a href={telHref(phone)} className={`hidden min-h-11 items-center gap-2 bg-[var(--s-primary)] px-4 text-[0.95rem] font-semibold text-[color:var(--s-on-primary)] no-underline hover:brightness-110 @2xl:inline-flex ${BTN_RADIUS}`}>
        <Phone className="size-4" aria-hidden /> {displayPhone(phone)}
      </a>
    );
  if (contact)
    return (
      <a href={ctx.hrefFor("contact")} className={`hidden min-h-11 items-center bg-[var(--s-primary)] px-4 text-[0.95rem] font-semibold text-[color:var(--s-on-primary)] no-underline hover:brightness-110 @2xl:inline-flex ${BTN_RADIUS}`}>
        Contact us
      </a>
    );
  return null;
}

export function SiteHeader({ ctx }: { ctx: RenderContext }) {
  const kind = ctx.spec.header;
  if (kind === "centered") {
    return (
      <Landmark as="header" ctx={ctx} className="border-b border-[color:var(--s-line)] bg-[var(--s-bg)]">
        <Wrap className="flex flex-col items-center gap-1 py-3">
          <div className="flex w-full items-center justify-between @3xl:justify-center">
            <Brand ctx={ctx} size="lg" />
            <MobileMenu ctx={ctx} />
          </div>
          <DesktopNav ctx={ctx} />
        </Wrap>
      </Landmark>
    );
  }
  if (kind === "split") {
    const b = ctx.content.business;
    return (
      <Landmark as="header" ctx={ctx} className="bg-[var(--s-bg)]">
        {(b.phone || b.hours || b.email) && (
          <div className="hidden bg-[var(--s-dark)] text-[color:var(--s-on-dark)] @3xl:block">
            <Wrap className="flex items-center justify-between py-2 text-sm">
              <span>{b.hours ? b.hours.split("\n")[0] : b.tagline}</span>
              <span className="flex gap-5">
                {b.email && <a className="underline-offset-4 hover:underline" href={`mailto:${b.email}`}>{b.email}</a>}
                {b.phone && <a className="font-semibold underline-offset-4 hover:underline" href={telHref(b.phone)}>{displayPhone(b.phone)}</a>}
              </span>
            </Wrap>
          </div>
        )}
        <div className="border-b border-[color:var(--s-line)]">
          <Wrap className="flex items-center justify-between gap-4 py-2.5">
            <Brand ctx={ctx} />
            <div className="flex items-center gap-2">
              <DesktopNav ctx={ctx} />
              <MobileMenu ctx={ctx} />
            </div>
          </Wrap>
        </div>
      </Landmark>
    );
  }
  if (kind === "floating") {
    return (
      <Landmark as="header" ctx={ctx} className="sticky top-0 z-30 px-3 pt-3 @3xl:px-6">
        <div className={`mx-auto flex max-w-6xl items-center justify-between gap-3 border border-[color:var(--s-line)] bg-[var(--s-surface)]/95 px-4 py-1.5 shadow-[var(--s-shadow)] backdrop-blur ${ctx.spec.radius === "square" ? "rounded-none" : "rounded-full"}`}>
          <Brand ctx={ctx} />
          <div className="flex items-center gap-1">
            <DesktopNav ctx={ctx} />
            <HeaderCta ctx={ctx} />
            <MobileMenu ctx={ctx} />
          </div>
        </div>
      </Landmark>
    );
  }
  if (kind === "minimal") {
    return (
      <Landmark as="header" ctx={ctx} className="bg-[var(--s-bg)]">
        <Wrap className="flex items-center justify-between gap-4 py-4">
          <Brand ctx={ctx} />
          <div className="flex items-center">
            <nav aria-label="Main" className="hidden @3xl:block">
              <ul className="flex gap-1 text-sm">
                {navPages(ctx).map((p) => (
                  <li key={p.slug}>
                    <a href={ctx.hrefFor(p.slug)} aria-current={p.slug === ctx.page.slug ? "page" : undefined} className={`${navLinkClass} underline-offset-8 hover:underline aria-[current=page]:underline`}>
                      {p.navLabel || p.title}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            <MobileMenu ctx={ctx} />
          </div>
        </Wrap>
      </Landmark>
    );
  }
  return (
    <Landmark as="header" ctx={ctx} className="sticky top-0 z-30 border-b border-[color:var(--s-line)] bg-[var(--s-bg)]/95 backdrop-blur">
      <Wrap className="flex items-center justify-between gap-4 py-2.5">
        <Brand ctx={ctx} />
        <div className="flex items-center gap-2">
          <DesktopNav ctx={ctx} />
          <HeaderCta ctx={ctx} />
          <MobileMenu ctx={ctx} />
        </div>
      </Wrap>
    </Landmark>
  );
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function Socials({ ctx }: { ctx: RenderContext }) {
  const s = ctx.content.social;
  const links = (Object.entries(s) as Array<[string, string]>).filter(([, href]) => href);
  if (!links.length) return null;
  const names: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn", x: "X", youtube: "YouTube", tiktok: "TikTok" };
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1">
      {links.map(([k, href]) => (
        <li key={k}>
          <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-sm font-medium text-[color:var(--s-ink)] underline-offset-4 hover:underline">
            {names[k]}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export function SiteFooter({ ctx, year }: { ctx: RenderContext; year: number }) {
  const { footer } = ctx.spec;
  const b = ctx.content.business;
  const pages = navPages(ctx);
  const legal = (
    <p className="text-sm text-[color:var(--s-muted)]">
      © {year} {b.name}.{ctx.content.footer.note ? ` ${ctx.content.footer.note}` : ""}
      {ctx.content.footer.poweredBy && <> Website by <a className="underline-offset-4 hover:underline" href="https://iacquire.com" rel="noopener noreferrer">iAcquire</a>.</>}
    </p>
  );
  const dark = footer === "dark";
  const shell = dark ? "bg-[var(--s-dark)] text-[color:var(--s-on-dark)]" : "border-t border-[color:var(--s-line)] bg-[var(--s-bg)]";
  const darkVars = dark ? ({ "--s-ink": "var(--s-on-dark)", "--s-muted": "var(--s-on-dark-muted)", "--s-line": "color-mix(in srgb, var(--s-dark) 78%, white)", "--s-primary-text": "var(--s-on-dark-accent)", "--s-primary-soft": "color-mix(in srgb, var(--s-dark) 80%, var(--s-primary))" } as React.CSSProperties) : undefined;

  if (footer === "minimal") {
    return (
      <Landmark as="footer" ctx={ctx} className={shell}>
        <Wrap className="flex flex-col items-start justify-between gap-3 py-6 @3xl:flex-row @3xl:items-center">
          {legal}
          <Socials ctx={ctx} />
        </Wrap>
      </Landmark>
    );
  }
  if (footer === "centered") {
    return (
      <Landmark as="footer" ctx={ctx} className={shell}>
        <Wrap className="flex flex-col items-center gap-5 py-10 text-center">
          <Brand ctx={ctx} />
          {b.tagline && <p className="max-w-md text-[color:var(--s-muted)]">{b.tagline}</p>}
          <nav aria-label="Footer">
            <ul className="flex flex-wrap justify-center">
              {pages.map((p) => (
                <li key={p.slug}>
                  <a className={navLinkClass} href={ctx.hrefFor(p.slug)}>{p.navLabel || p.title}</a>
                </li>
              ))}
            </ul>
          </nav>
          <Socials ctx={ctx} />
          {legal}
        </Wrap>
      </Landmark>
    );
  }
  return (
    <Landmark as="footer" ctx={ctx} className={shell} style={darkVars}>
      <Wrap className="grid gap-10 py-12 @3xl:grid-cols-[1.3fr_1fr_1.2fr]">
        <div className="space-y-4">
          <Brand ctx={ctx} plate={dark} />
          {b.tagline && <p className="max-w-xs text-[color:var(--s-muted)]">{b.tagline}</p>}
          <Socials ctx={ctx} />
        </div>
        <nav aria-label="Footer">
          <Heading level={2} ctx={ctx} size="h3" className="!text-[color:var(--s-ink)]">Pages</Heading>
          <ul className="mt-3">
            {pages.map((p) => (
              <li key={p.slug}>
                <a className={`${navLinkClass} !px-0`} href={ctx.hrefFor(p.slug)}>{p.navLabel || p.title}</a>
              </li>
            ))}
          </ul>
        </nav>
        <div>
          <Heading level={2} ctx={ctx} size="h3" className="!text-[color:var(--s-ink)]">Get in touch</Heading>
          <Details ctx={ctx} className="mt-4" />
        </div>
      </Wrap>
      <div className="border-t border-[color:var(--s-line)]">
        <Wrap className="py-5">{legal}</Wrap>
      </div>
    </Landmark>
  );
}

