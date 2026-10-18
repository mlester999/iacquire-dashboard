import type * as React from "react";
import type { ElementNode, SiteContent, SitePage } from "@/lib/website/doc";
import type { SiteBookingData } from "@/lib/website/booking";
import type { PublicFormDef } from "@/lib/crm/forms/spec";

export interface ResolvedAsset {
  src: string;
  /** Other sizes of the same picture, so the browser can fetch only what it needs. */
  srcSet?: string;
  width: number | null;
  height: number | null;
  alt: string;
}

/** What the visual editor plugs into the renderer. Absent on every published page, so no editor code is ever part of a public site. */
export interface EditBridge {
  selectedId: string | null;
  /** Draws text that can be typed into in place. */
  Text: React.ComponentType<{
    nodeId: string;
    path: string;
    value: string;
    as?: React.ElementType;
    className?: string;
    multiline?: boolean;
    rootProps?: Record<string, unknown>;
    placeholder?: string;
    plain?: boolean;
  }>;
  /** Called when an empty column or section wants something to be added to it. */
  onAddToEmpty?: (parentId: string) => void;
}

export interface RenderCtx {
  content: SiteContent;
  page: SitePage;
  resolveAsset: (id: string | null | undefined, variant?: "original" | "processed") => ResolvedAsset | null;
  /** published: a live visitor. preview: the owner looking at a draft or a template. edit: inside the visual editor. */
  mode: "published" | "preview" | "edit";
  /** Where the enquiry form posts. Null in preview and the editor, where the form is shown but switched off. */
  formAction: string | null;
  formToken: string;
  hrefFor: (slug: string) => string;
  /** Drawn inside another page (editor, thumbnails): no landmarks or skip link of its own. */
  embedded: boolean;
  /** Which part of the page an element is drawn in, so repeated landmarks (the header and footer menus) can have distinct names. */
  region?: "header" | "footer";
  /** The one heading drawn as the page's h1. Any other level-1 heading is drawn as an h2, so a page never has two. */
  h1Id: string | null;
  edit?: EditBridge;
  nonce?: string;
  /** The workspace's public calendars, for booking elements. Filled on live pages and in the editor; absent in template previews. */
  booking?: SiteBookingData | null;
  /**
   * The workspace's live native CRM forms by key, for form elements that name one. Filled on live pages and in the editor; absent in
   * template previews. A form element whose key isn't here draws the built-in enquiry form.
   */
  forms?: Record<string, PublicFormDef> | null;
}

export const isEditing = (ctx: RenderCtx) => ctx.mode === "edit";

/** Attributes every node carries in the editor and previews, so the canvas can find, select and measure it. Live pages carry none. */
export function nodeAttrs(ctx: RenderCtx, id: string, type: string): Record<string, string> {
  return ctx.mode === "published" ? {} : { "data-nid": id, "data-ntype": type };
}

export type ElementProps<T extends Record<string, unknown> = Record<string, unknown>> = { el: ElementNode; ctx: RenderCtx; p: T };
