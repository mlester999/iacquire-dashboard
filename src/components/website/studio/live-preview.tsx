"use client";

import * as React from "react";
import { SiteRenderer } from "@/components/website/site-renderer";
import type { ResolvedAsset } from "@/components/website/parts";
import type { SiteContent } from "@/lib/website/schema";
import type { AssetView } from "@/server/assets/service";

export type Device = "desktop" | "tablet" | "mobile";
export const DEVICE_WIDTH: Record<Device, number> = { desktop: 1280, tablet: 820, mobile: 390 };

export function previewResolver(assets: AssetView[]): (id: string | null | undefined, variant?: "original" | "processed") => ResolvedAsset | null {
  const byId = new Map(assets.map((a) => [a.id.toLowerCase(), a]));
  return (id, variant) => {
    const a = id ? byId.get(id.toLowerCase()) : undefined;
    if (!a) return null;
    return { src: variant === "processed" && a.processedUrl ? a.processedUrl : a.url, width: a.width, height: a.height, alt: a.altText };
  };
}

/**
 * The real site renderer in a frame of the chosen device width, so what you see is exactly what a visitor will get. Layout
 * inside the frame responds to the frame's width (container queries), not the editor's window. Clicking a section selects it.
 */
export function LivePreview({
  content, templateKey, pageSlug, assets, device, selectedId, year, onSelectSection, onSelectSite, onNavigatePage,
}: {
  content: SiteContent; templateKey: string; pageSlug: string; assets: AssetView[]; device: Device; selectedId: string | null; year: number;
  onSelectSection: (id: string) => void; onSelectSite: () => void; onNavigatePage: (slug: string) => void;
}) {
  const box = React.useRef<HTMLDivElement>(null);
  const [available, setAvailable] = React.useState(0);
  React.useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvailable(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const resolve = React.useMemo(() => previewResolver(assets), [assets]);
  const width = DEVICE_WIDTH[device];
  const zoom = available > 0 ? Math.min(1, (available - 2) / width) : 1;
  const safeId = selectedId && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(selectedId) ? selectedId : null;

  const onClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const link = target.closest("a");
    if (link) {
      e.preventDefault();
      const href = link.getAttribute("href") ?? "";
      if (href.startsWith("#page:")) onNavigatePage(href.slice(6));
    }
    const section = target.closest("[data-site-main] > section[id]");
    if (section) onSelectSection(section.id);
    else if (target.closest("header, footer")) onSelectSite();
  };

  return (
    <div ref={box} className="min-w-0">
      {safeId && <style>{`[data-live-preview] section[id="${safeId}"]{outline:3px solid #2c5bff;outline-offset:-3px;box-shadow:inset 0 0 0 6px rgb(44 91 255 / .12)}`}</style>}
      <div
        data-live-preview
        role="region"
        aria-label={`Preview of the ${pageSlug === "home" ? "home" : pageSlug} page at ${device} width`}
        onClickCapture={onClick}
        className="mx-auto overflow-hidden rounded-xl border border-line bg-white shadow-card"
        style={{ width, zoom, maxWidth: "none" }}
      >
        <SiteRenderer
          content={content}
          templateKey={templateKey}
          pageSlug={pageSlug}
          resolveAsset={resolve}
          mode="preview"
          embedded
          formAction={null}
          hrefFor={(slug) => `#page:${slug}`}
          year={year}
        />
      </div>
    </div>
  );
}
