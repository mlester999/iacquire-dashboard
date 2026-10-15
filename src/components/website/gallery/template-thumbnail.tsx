"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import type { GalleryCard } from "@/lib/website/gallery";
import { THUMBNAIL_VIEWPORT } from "@/lib/website/thumbnail-contract";

const FRAME_W = THUMBNAIL_VIEWPORT.width;
const FRAME_H = THUMBNAIL_VIEWPORT.height;

/** A still of the top of a template's home page. The frame loads only when it scrolls into view. */
export function TemplateThumb({ card, frameBase, className, priority = false, draft = false }: { card: Pick<GalleryCard, "key" | "name" | "thumbnail" | "version" | "revision">; frameBase: string; className?: string; priority?: boolean; draft?: boolean }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [scale, setScale] = React.useState(0.25);
  const [nearby, setNearby] = React.useState(false);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || card.thumbnail) return;
    const observer = new IntersectionObserver(([entry]) => setNearby(entry.isIntersecting), { rootMargin: "200px" });
    observer.observe(el);
    const measure = () => setScale(el.clientWidth / FRAME_W);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { ro.disconnect(); observer.disconnect(); };
  }, [card.thumbnail]);
  return (
    <div ref={ref} data-thumbnail-key={card.key} data-thumbnail-version={card.thumbnail?.version ?? card.version} data-thumbnail-signature={card.thumbnail?.signature} className={cn("relative aspect-[16/10] w-full overflow-hidden bg-surface-3", className)}>
      {card.thumbnail ? (
        // Pre-encoded canonical screenshots; responsive WebP files avoid an image optimizer request per card.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={card.thumbnail.src} srcSet={card.thumbnail.srcSet} sizes="(max-width: 639px) 95vw, (max-width: 1023px) 46vw, (max-width: 1535px) 30vw, 440px" width={card.thumbnail.width} height={card.thumbnail.height} alt={`${card.name} website, home page`} loading={priority ? "eager" : "lazy"} fetchPriority={priority ? "high" : "auto"} decoding="async" className="absolute inset-0 h-full w-full object-cover" />
      ) : nearby && <iframe
        title={`${card.name} template, home page`} src={`${frameBase}?key=${encodeURIComponent(card.key)}&thumb=1${draft ? "&draft=1" : ""}&v=${card.version ?? 0}&r=${card.revision ?? 0}`} loading="lazy" tabIndex={-1} aria-hidden scrolling="no"
        className="absolute left-0 top-0 origin-top-left border-0 bg-white" style={{ width: FRAME_W, height: FRAME_H, transform: `scale(${scale})`, pointerEvents: "none" }}
      />}
    </div>
  );
}

