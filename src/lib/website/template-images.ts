import type { ImageSrc, Section, SiteContent } from "./doc";
import { templateImageForKey, templateImagesForFamily, type TemplateImageId } from "./template-image-assets";

export type TemplateImageRef = Extract<ImageSrc, { kind: "template" }>;

export function templateImageRef(id: TemplateImageId, label: string): TemplateImageRef {
  return { kind: "template", id, label };
}

/** The immutable default attached to a built-in image source, if it has one. */
export function templateImageDefault(src: ImageSrc): TemplateImageRef | null {
  if (!src) return null;
  if (src.kind === "template") return { kind: "template", id: src.id, label: src.label };
  return src.default ?? null;
}

/** Preserve the template slot when the owner chooses an upload or built-in artwork. Clearing it restores the starter. */
export function withTemplateImageDefault(picked: ImageSrc, current: ImageSrc): ImageSrc {
  const fallback = templateImageDefault(current);
  if (!picked) return fallback;
  if (picked.kind === "template" || !fallback) return picked;
  return { ...picked, default: fallback };
}

function sectionById(content: SiteContent, id: string | undefined): Section | null {
  if (!id) return null;
  const global = content.globals[id];
  if (global) return global;
  for (const page of content.pages) for (const item of page.items) if (item.type === "section" && item.id === id) return item;
  return null;
}

interface WalkContext {
  pageSlug: string | null;
  sectionId: string | null;
  elementType: string | null;
  index: number | null;
  isHero: boolean;
}

function sourceLabel(ctx: WalkContext, path: string, n: number): string {
  const p = path.toLowerCase();
  if (ctx.isHero) return `Hero image${n > 1 ? ` ${n}` : ""}`;
  if (ctx.elementType === "gallery") return `Gallery image ${(ctx.index ?? 0) + 1}`;
  if (ctx.elementType === "collage") return `Gallery image ${(ctx.index ?? 0) + 1}`;
  if (ctx.elementType === "services") return `Service image ${(ctx.index ?? 0) + 1}`;
  if (ctx.pageSlug === "about" || p.includes("about")) return "About image";
  return `Section image ${n}`;
}

/**
 * Replaces the hand-drawn scene artwork in built-in templates with generated, family-matched local photos.
 * The home hero always gets its variation's own image. Supporting photo slots draw from the other variations
 * in the same family, keeping galleries coherent and avoiding a single repeated photo on each site.
 */
export function applyTemplateImages(content: SiteContent, key: string): SiteContent {
  const own = templateImageForKey(key);
  if (!own) return content;
  const pool = templateImagesForFamily(own.family);
  const ownIndex = pool.findIndex((item) => item.id === own.id);
  const home = content.pages.find((page) => page.slug === "home") ?? content.pages[0];
  const first = home?.items[0];
  const heroId = first?.type === "ref" ? first.ref : first?.id;
  let heroSourceCount = 0;
  let secondaryCount = 0;

  const replace = (value: unknown, path: string, ctx: WalkContext): unknown => {
    if (Array.isArray(value)) return value.map((item, index) => replace(item, `${path}.${index}`, { ...ctx, index }));
    if (!value || typeof value !== "object") return value;

    const raw = value as Record<string, unknown>;
    if (raw.kind === "art" && typeof raw.scene === "string") {
      // People must supply real portraits. Keep the clearly drawn silhouette until they do.
      if (raw.scene === "portrait" || ctx.elementType === "team" || ctx.elementType === "testimonials") return value;
      const isHero = ctx.isHero || (ctx.sectionId === heroId && ctx.pageSlug === "home");
      const labelIndex = isHero ? ++heroSourceCount : ++secondaryCount;
      const image = isHero && labelIndex === 1
        ? own
        : pool[(ownIndex + 1 + (isHero ? labelIndex - 2 : secondaryCount - 1)) % pool.length];
      return templateImageRef(image.id, sourceLabel(ctx, path, labelIndex));
    }

    const nextCtx: WalkContext = {
      pageSlug: typeof raw.slug === "string" ? raw.slug : ctx.pageSlug,
      sectionId: raw.type === "section" && typeof raw.id === "string" ? raw.id : ctx.sectionId,
      elementType: typeof raw.type === "string" && "props" in raw ? raw.type : ctx.elementType,
      index: ctx.index,
      isHero: raw.type === "section" && typeof raw.id === "string" ? raw.id === heroId : ctx.isHero,
    };
    const out: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(raw)) {
      const childCtx = name === "items" && Array.isArray(child) && nextCtx.elementType ? { ...nextCtx, index: null } : nextCtx;
      out[name] = replace(child, `${path}.${name}`, childCtx);
    }
    return out;
  };

  const result = replace(content, "", { pageSlug: null, sectionId: null, elementType: null, index: null, isHero: false }) as SiteContent;
  if (heroSourceCount > 0 || !heroId) return result;

  // Text-led built-ins still get a real starter hero. Blend it over the original color/gradient/pattern
  // so the photo adds depth without discarding the template's visual system.
  const hero = sectionById(result, heroId);
  if (!hero) return result;
  const previous = hero.bg;
  const base = previous.kind === "image" ? previous.base ?? { kind: "none" as const } : previous;
  hero.bg = {
    kind: "image",
    src: templateImageRef(own.id, "Hero image"),
    // These heroes were designed around text/forms. Keep the photograph subordinate
    // to their original surface so body copy remains readable over detailed scenes.
    overlay: { color: "bg", opacity: key === "local.corner" ? 90 : result.design.mode === "dark" ? 66 : 78, dir: "flat" },
    pos: { x: 50, y: 50 },
    parallax: false,
    strength: 46,
    base,
  };
  return result;
}
