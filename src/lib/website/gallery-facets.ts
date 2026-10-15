import type { SiteContent } from "./doc";
import { FONTS, type FontKey } from "./font-keys";
import type { GalleryCard } from "./gallery";

/** Discovery facets come from the document that is actually rendered. */
export function contentFacets(content: SiteContent): Pick<GalleryCard, "layout" | "typography"> {
  const item = content.pages.find((page) => page.slug === "home")?.items[0];
  const hero = item?.type === "ref" ? content.globals[item.ref] : item;
  const layout = hero?.bg.kind === "image" ? "immersive" : (hero?.columns.length ?? 0) > 1 ? "split" : hero?.columns[0]?.align === "center" ? "centered" : "stacked";
  return { layout, typography: FONTS[content.design.fonts.heading as FontKey]?.category ?? "sans" };
}
