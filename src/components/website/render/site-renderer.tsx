import * as React from "react";
import { siteCss } from "@/lib/website/css";
import { findPage, isRef, resolveItem, type ElementNode, type SiteContent } from "@/lib/website/doc";
import { FONT_CLASSES } from "@/lib/website/fonts";
import "./site.css";
import type { EditBridge, RenderCtx, ResolvedAsset } from "./ctx";
import { MenuCloser, MotionRoot } from "./islands";
import { SectionView } from "./section";

export interface SiteRendererProps {
  content: SiteContent;
  pageSlug: string;
  resolveAsset: RenderCtx["resolveAsset"];
  mode: "published" | "preview" | "edit";
  /** Where the enquiry form posts. Pass null in preview. */
  formAction: string | null;
  formToken?: string;
  hrefFor: (slug: string) => string;
  year?: number;
  /** Marks the markup with the publication being served, so a health check can confirm exactly which version is live. */
  publicationId?: string;
  /** Drawn inside another page (the editor, a template thumbnail): no skip link or main landmark of its own. */
  embedded?: boolean;
  /** The pixel height of the frame it is drawn in, so "full screen" sections fill the frame and not the browser window. */
  viewportHeight?: number;
  edit?: EditBridge;
  nonce?: string;
  /** Draw only the first n visible sections (thumbnails). */
  limitSections?: number;
  /** Keeps this site's styles from touching another site drawn on the same page (gallery thumbnails). */
  scope?: string;
}

/** The first level-1 heading among these elements, in the order they are drawn. */
function firstH1(nodes: ElementNode[]): string | null {
  for (const e of nodes) {
    if (e.type === "heading" && String(e.props.level) === "1") return e.id;
    const inner = e.children ? firstH1(e.children) : null;
    if (inner) return inner;
  }
  return null;
}

/**
 * The one renderer behind template previews, the visual editor and published sites. It receives plain, validated content and draws it;
 * nothing it receives is HTML, script or CSS.
 */
export function SiteRenderer(props: SiteRendererProps) {
  const { content } = props;
  const page = findPage(content, props.pageSlug) ?? content.pages[0];
  const editing = props.mode === "edit";
  const editingNow = props.mode === "edit";
  const visibleSections = page.items
    .map((item) => resolveItem(content, item))
    .filter((sec): sec is NonNullable<typeof sec> => sec !== null && (editingNow || !sec.hidden));
  const drawnInOrder = [...(content.header ? [content.header] : []), ...visibleSections, ...(content.footer ? [content.footer] : [])];
  const h1Id = firstH1(drawnInOrder.flatMap((sec) => sec.columns.flatMap((c) => c.elements)));
  const ctx: RenderCtx = {
    content, page, resolveAsset: props.resolveAsset, mode: props.mode, formAction: props.formAction, formToken: props.formToken ?? "", hrefFor: props.hrefFor,
    embedded: props.embedded === true, h1Id, edit: props.edit, nonce: props.nonce,
  };
  const visible = page.items
    .map((item) => ({ item, sec: resolveItem(content, item) }))
    .filter((x): x is { item: typeof x.item; sec: NonNullable<typeof x.sec> } => x.sec !== null && (editing || !x.sec.hidden));
  const shown = props.limitSections ? visible.slice(0, props.limitSections) : visible;
  const pageHasH1 = h1Id !== null;
  const css = siteCss(content, page, { scope: props.scope, edit: editing }).replace(/</g, "\\3c ");
  const d = content.design;
  const year = props.year ?? new Date().getUTCFullYear();
  void year;
  const MainTag = props.embedded ? "div" : "main";

  return (
    <div
      className={`iq-site ${FONT_CLASSES}`}
      style={{ "--vh": props.viewportHeight ? `${props.viewportHeight}px` : "100svh" } as React.CSSProperties}
      data-iq=""
      data-s={props.scope ? props.scope.replace(/[^a-z0-9-]/gi, "").slice(0, 40) : undefined}
      data-emph={d.heading.emphasis}
      data-btn={d.buttons.style}
      data-btn-hover={d.buttons.hover}
      data-btn-caps={d.buttons.caps ? "" : undefined}
      data-links={d.links}
      data-grain={d.grain ? "" : undefined}
      data-motion-level={d.motion}
      data-mode={d.mode}
      data-site-page={page.slug}
      data-site-publication={props.publicationId}
      data-edit={editing ? "" : undefined}
    >
      <style nonce={props.nonce} dangerouslySetInnerHTML={{ __html: css }} />
      {!props.embedded && <a href="#main" className="iq-skip">Skip to content</a>}
      {content.header && <SectionView sec={content.header} ctx={ctx} role="header" />}
      <MainTag id={props.embedded ? undefined : "main"} data-site-main="">
        {!pageHasH1 && <h1 className="iq-sr">{page.title}</h1>}
        {shown.map(({ item, sec }) => (
          <SectionView key={item.id} sec={sec} ctx={ctx} shared={isRef(item) ? item.ref : undefined} />
        ))}
      </MainTag>
      {content.footer && <SectionView sec={content.footer} ctx={ctx} role="footer" />}
      {!editing && <MotionRoot enabled={d.motion !== "none"} />}
      {!editing && <MenuCloser />}
    </div>
  );
}

export type { ResolvedAsset };
