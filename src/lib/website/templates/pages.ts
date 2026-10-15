// The inner pages (About, Services, FAQ, Gallery, Contact) every variation builds the same way: a page title, then its content.
import type { PageItem } from "../doc";
import type { Recipe, TemplateCtx } from "./types";

export const compact = (xs: Array<PageItem | null | undefined>) => xs.filter((x): x is PageItem => Boolean(x));

/** The pages every variation shares in structure; the variation supplies the look. */
export function innerPages(ctx: TemplateCtx, o: {
  title: (t: string, lede?: string) => PageItem;
  services: PageItem | null;
  about: PageItem | null;
  process: PageItem | null;
  faq: PageItem | null;
  gallery: PageItem | null;
  cta: PageItem;
  contact: PageItem;
}): Pick<Recipe, "about" | "services" | "faq" | "gallery" | "contact"> {
  const plain = (s?: string) => s?.replace(/\*/g, "");
  return {
    about: compact([o.title("About us", plain(ctx.d.tagline)), o.about, o.process, o.cta]),
    services: compact([o.title("Services", "How we can help."), o.services, o.process, o.cta]),
    faq: compact([o.title("Questions", "Answers to what people ask us most."), o.faq, o.cta]),
    gallery: compact([o.title("Gallery", "A closer look."), o.gallery, o.cta]),
    contact: compact([o.title("Get in touch", "Tell us what you're looking for."), o.contact]),
  };
}
