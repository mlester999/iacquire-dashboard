import * as React from "react";
import { findPage, type SiteContent, type SitePage, type SiteSection } from "@/lib/website/schema";
import { DEFAULT_TEMPLATE_KEY, resolveTemplate } from "@/lib/website/templates";
import { deriveTheme } from "@/lib/website/theme";
import { SiteFooter, SiteHeader } from "./chrome";
import { Contact } from "./contact";
import { About, Areas, Process, RichText, Services, Stats, Team } from "./content-sections";
import { Cta, Faq, Gallery, Pricing, Testimonials } from "./engage-sections";
import { Hero } from "./hero";
import { bandFor, type RenderContext, type ResolvedAsset } from "./parts";

export interface SiteRendererProps {
  content: SiteContent;
  templateKey: string;
  pageSlug: string;
  resolveAsset: RenderContext["resolveAsset"];
  mode: "published" | "preview";
  /** Where the enquiry form posts. Pass null in preview. */
  formAction: string | null;
  /** Signed spam-control token for the enquiry form. */
  formToken?: string;
  hrefFor: (slug: string) => string;
  year?: number;
  /** Marks the markup with the publication being served, so a health check can confirm exactly which version is live. */
  publicationId?: string;
  /**
   * True when the page is drawn inside another page (the editor's preview, a template thumbnail). The host page already has its
   * own main landmark and skip link, so this one draws plain containers instead of duplicating them. Layout is unchanged.
   */
  embedded?: boolean;
}

const SECTION_COMPONENTS: Record<SiteSection["type"], React.ComponentType<{ ctx: RenderContext; section: SiteSection; band: ReturnType<typeof bandFor>; index: number }>> = {
  hero: Hero, services: Services, about: About, process: Process, testimonials: Testimonials, faq: Faq, cta: Cta, gallery: Gallery,
  contact: Contact, pricing: Pricing, areas: Areas, stats: Stats, team: Team, richText: RichText,
};

/** Whether a section will actually draw something. Used to decide which section owns the page's h1. */
function willRender(section: SiteSection, ctx: Pick<RenderContext, "mode" | "resolveAsset">): boolean {
  const data = section.data as Record<string, unknown>;
  switch (section.type) {
    case "testimonials":
      return (data.items as Array<{ quote: string; confirmedReal: boolean }>).some((t) => t.quote && (ctx.mode === "preview" || t.confirmedReal));
    case "gallery":
      return (data.images as Array<{ image: string | null }>).some((g) => ctx.resolveAsset(g.image));
    default:
      return true;
  }
}

const hasHeading = (s: SiteSection) => s.type === "hero" || (typeof (s.data as { heading?: unknown }).heading === "string" && Boolean((s.data as { heading: string }).heading));

export function visibleSections(page: SitePage, ctx: Pick<RenderContext, "mode" | "resolveAsset">) {
  return page.sections.filter((s) => !s.hidden && willRender(s, ctx));
}

/**
 * The one renderer behind template previews, the editor's live preview and published sites.
 * It receives plain, validated content and draws it; nothing it receives is HTML.
 */
export function SiteRenderer(props: SiteRendererProps) {
  const resolved = resolveTemplate(props.templateKey) ?? resolveTemplate(DEFAULT_TEMPLATE_KEY)!;
  const page = findPage(props.content, props.pageSlug) ?? props.content.pages[0];
  const { spec } = resolved;
  const probe = { mode: props.mode, resolveAsset: props.resolveAsset };
  const sections = visibleSections(page, probe);
  // The h1 belongs to the first section on the page, and only if that section has a heading of its own. Otherwise the page
  // gets a visually hidden h1 (its title) at the top, so no heading ever appears before the h1 and no level is skipped.
  const h1Owner = sections[0] && hasHeading(sections[0]) ? sections[0] : null;
  const ctx: RenderContext = {
    content: props.content,
    spec,
    templateKey: resolved.key,
    page,
    resolveAsset: props.resolveAsset,
    mode: props.mode,
    formAction: props.formAction,
    formToken: props.formToken ?? "",
    hrefFor: props.hrefFor,
    h1SectionId: h1Owner?.id ?? null,
    embedded: props.embedded === true,
  };
  const vars = deriveTheme(props.content.brand, spec) as React.CSSProperties;
  const year = props.year ?? new Date().getUTCFullYear();
  const layout = `header:${spec.header} hero:${spec.hero} services:${spec.services} about:${spec.about} faq:${spec.faq} cta:${spec.cta} footer:${spec.footer}`;

  return (
    <div
      className="@container [font-family:var(--s-font-b)] min-h-full bg-[var(--s-bg)] text-[color:var(--s-ink)] antialiased [text-rendering:optimizeLegibility]"
      style={vars}
      data-site-template={resolved.key}
      data-site-layout={layout}
      data-site-page={page.slug}
      data-site-publication={props.publicationId}
    >
      {!props.embedded && <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-[var(--s-surface)] focus:px-4 focus:py-2 focus:font-semibold focus:text-[color:var(--s-ink)] focus:shadow-lg">
        Skip to content
      </a>}
      <SiteHeader ctx={ctx} />
      <Main embedded={props.embedded}>
        {!h1Owner && <h1 className="sr-only">{page.title}</h1>}
        {sections.map((section, index) => {
          const Cmp = SECTION_COMPONENTS[section.type];
          return <Cmp key={section.id} ctx={ctx} section={section} band={section.type === "hero" ? "base" : bandFor(spec, index)} index={index} />;
        })}
      </Main>
      <SiteFooter ctx={ctx} year={year} />
    </div>
  );
}

function Main({ embedded, children }: { embedded?: boolean; children: React.ReactNode }) {
  return embedded ? <div data-site-main>{children}</div> : <main id="main">{children}</main>;
}

export type { ResolvedAsset };
