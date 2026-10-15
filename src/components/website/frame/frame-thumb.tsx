"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

const W = 1280;
const H = 800;

/** A still of the top of a page, drawn by the real renderer in an isolated frame and scaled to fit. Loads when it scrolls into view. */
export function FrameThumb({ src, title, className, ratio = "aspect-[16/10]" }: { src: string; title: string; className?: string; ratio?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  // The still always covers its box: scaled to the larger of the two fits, and centred across when the box is taller than it is wide.
  const [fit, setFit] = React.useState({ scale: 0.2, x: 0 });
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const scale = Math.max(el.clientWidth / W, el.clientHeight / H);
      setFit({ scale, x: Math.min(0, (el.clientWidth - W * scale) / 2) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className={cn("relative w-full overflow-hidden bg-surface-3", ratio, className)}>
      <iframe title={title} src={src} loading="lazy" tabIndex={-1} aria-hidden scrolling="no" className="absolute left-0 top-0 origin-top-left border-0 bg-white" style={{ width: W, height: H, transform: `translateX(${fit.x}px) scale(${fit.scale})`, pointerEvents: "none" }} />
    </div>
  );
}
